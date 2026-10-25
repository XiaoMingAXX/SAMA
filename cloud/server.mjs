import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import { Database } from "./lib/database.mjs";
import { createObjects, fileDigest } from "./lib/objects.mjs";
import { History } from "./lib/history.mjs";
import { GatewayHub } from "./lib/gateways.mjs";
import { acquireCollectorLock } from "./lib/collector-lock.mjs";
import {
  AppError,
  check,
  now,
  token,
  digest,
  text,
  passwordHash,
  verifyPassword,
} from "./lib/common.mjs";
import { METRICS } from "../lib/modbus.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
sharp.concurrency(1);
sharp.cache({ memory: 16, files: 0, items: 20 });
export async function createCloudServer(options = {}) {
  const directory = path.resolve(
    options.dataDir ?? process.env.CLOUD_DATA_DIR ?? path.join(ROOT, "data-v2"),
  );
  const env = options.env ?? process.env,
    production = env.NODE_ENV === "production",
    publicOrigin = options.publicOrigin ?? env.SAMA_PUBLIC_ORIGIN;
  if (production) {
    check(
      publicOrigin?.startsWith("https://"),
      "Production requires SAMA_PUBLIC_ORIGIN=https://...",
    );
    check(
      env.SAMA_OBJECT_STORE === "oss",
      "Production requires private OSS storage",
    );
  }
  const releaseLock = acquireCollectorLock(directory);
  const db = new Database(directory);
  try {
    await db.call("userCount");
  } catch (error) {
    releaseLock();
    throw error;
  }
  let objects;
  try {
    objects = options.objects ?? (await createObjects(directory, env));
  } catch (error) {
    await db.close();
    releaseLock();
    throw error;
  }
  const history = new History(db, objects, directory, options.history),
    clients = new Set(),
    limits = new Map();
  let closing = false,
    hashing = 0,
    imageBusy = false,
    pumping = false,
    lastArchive = Date.now(),
    lastBackup =
      Number(await db.call("maintenanceState", { key: "lastBackup" })) || 0,
    lastCleanup = 0,
    maintenanceError = null;
  function send(res, status, data) {
    if (res.headersSent) return;
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(data));
  }
  function expireStreams(userId, hash) {
    for (const c of clients)
      if ((userId && c.user.id === userId) || (hash && c.hash === hash)) {
        c.response.end();
        clients.delete(c);
      }
  }
  async function broadcast(event, data, ownerId) {
    for (const c of clients)
      if (c.user.role === "admin" || c.user.id === ownerId) {
        if (c.response.writableLength > 128 * 1024) {
          c.response.destroy();
          clients.delete(c);
        } else
          c.response.write(
            `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
          );
      }
  }
  const hub = new GatewayHub(db, {
    onStatus: (status, ownerId) => broadcast("sensor-status", status, ownerId),
    onSample: async (sample, sensor, flags) => {
      await broadcast("live", sample, sensor.owner_id);
      await history.storageCheck();
      const saved = await db.call("saveSample", { sample, sensor, ...flags });
      if (saved) await broadcast("saved", saved, sensor.owner_id);
      return saved;
    },
    onError: (e) => {
      maintenanceError = e.message;
    },
  });
  function rate(request, kind, max, period = 600000) {
    const address = request.socket.remoteAddress || "unknown",
      key = kind + address,
      stamp = Date.now();
    let entry = limits.get(key);
    if (!entry || entry.until < stamp)
      limits.set(key, (entry = { n: 0, until: stamp + period }));
    check(++entry.n <= max, "Too many requests; try again later", 429);
    if (limits.size > 4096)
      for (const [k, v] of limits) if (v.until < stamp) limits.delete(k);
  }
  async function hashed(password) {
    check(hashing < 2, "Password processing is busy; try again shortly", 429);
    hashing++;
    try {
      return await passwordHash(password);
    } finally {
      hashing--;
    }
  }
  async function verify(password, hash) {
    check(hashing < 2, "Password processing is busy; try again shortly", 429);
    hashing++;
    try {
      return await verifyPassword(password, hash);
    } finally {
      hashing--;
    }
  }
  async function readBody(req, max = 65536, raw = false) {
    if (!raw)
      check(
        req.headers["content-type"]?.startsWith("application/json"),
        "JSON body required",
        415,
      );
    if (req.headers["content-length"])
      check(
        Number(req.headers["content-length"]) <= max,
        "Request too large",
        413,
      );
    const chunks = [];
    let length = 0;
    for await (const c of req) {
      length += c.length;
      check(length <= max, "Request too large", 413);
      chunks.push(c);
    }
    const bytes = Buffer.concat(chunks);
    if (raw) return bytes;
    try {
      const value = JSON.parse(bytes.toString());
      check(
        value && typeof value === "object" && !Array.isArray(value),
        "JSON object required",
      );
      return value;
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError("Invalid JSON");
    }
  }
  function cookie(req) {
    const match = (req.headers.cookie || "").match(
      /(?:^|;\s*)sama_session=([A-Za-z0-9_-]{43})(?:;|$)/,
    );
    return match ? digest(match[1]) : null;
  }
  async function auth(req) {
    const hash = cookie(req);
    const user = hash ? await db.call("authenticate", { hash }) : null;
    check(user, "Please sign in", 401);
    return { user, hash };
  }
  function csrf(req, user, origin) {
    check(
      req.headers["x-sama-request"] === "1",
      "Application request header required",
      403,
    );
    if (req.headers.origin)
      check(req.headers.origin === origin, "Untrusted origin", 403);
    if (user)
      check(
        req.headers["x-csrf-token"] === user.csrf,
        "Session request token invalid",
        403,
      );
  }
  async function state(user) {
    const sensors = await db.call("sensorList", { user });
    return {
      version: "0.2.0",
      user,
      objectStore: objects.kind,
      metrics: METRICS,
      sensors: sensors.map((s) => ({ ...s, ...hub.status(s) })),
      stats: await db.call("stats", { user }),
      storage: { archiveError: history.lastArchiveError, maintenanceError },
      registrationOpen: env.SAMA_ALLOW_REGISTRATION !== "false",
    };
  }
  const web = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    try {
      check(req.url.length < 8192, "URL too long", 414);
      const host = req.headers.host ?? "";
      check(/^[A-Za-z0-9.\-\[\]:]+$/.test(host), "Invalid host", 400);
      const origin = publicOrigin ?? `http://${host}`;
      if (publicOrigin)
        check(host === new URL(publicOrigin).host, "Untrusted host", 403);
      else
        check(
          ["127.0.0.1", "localhost", "[::1]"].includes(
            host.replace(/:\d+$/, ""),
          ),
          "Configure a public origin before exposing the service",
          403,
        );
      const url = new URL(req.url, origin),
        route = `${req.method} ${url.pathname}`,
        input = Object.fromEntries(url.searchParams);
      if (route === "GET /health")
        return send(res, 200, { status: "ok", version: "0.2.0" });
      if (route === "GET /api/v1/auth/info")
        return send(res, 200, {
          registrationOpen: env.SAMA_ALLOW_REGISTRATION !== "false",
          requiresAdminSetup: (await db.call("userCount")) === 0,
        });
      if (route === "POST /api/v1/auth/register") {
        csrf(req, null, origin);
        check(
          env.SAMA_ALLOW_REGISTRATION !== "false",
          "Registration is closed",
          403,
        );
        rate(req, "register", options.testMode ? 100 : 5, 3600000);
        const body = await readBody(req),
          hash = await hashed(body.password);
        const user = await db.call("createUser", { input: body, hash });
        return send(res, 201, { user });
      }
      if (route === "POST /api/v1/auth/login") {
        csrf(req, null, origin);
        rate(req, "login", options.testMode ? 1000 : 20);
        const body = await readBody(req),
          account = await db.call("loginUser", { name: body.username });
        check(
          (await verify(body.password, account?.password_hash)) &&
            account?.active,
          "Invalid username or password",
          401,
        );
        const raw = token(),
          csrfToken = token(),
          expiresAt = new Date(Date.now() + 12 * 3600000).toISOString();
        await db.call("createAuth", {
          userId: account.id,
          hash: digest(raw),
          csrf: csrfToken,
          expiresAt,
        });
        res.setHeader(
          "Set-Cookie",
          `sama_session=${raw}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${production || publicOrigin?.startsWith("https://") ? "; Secure" : ""}`,
        );
        const user = await db.call("authenticate", { hash: digest(raw) });
        return send(res, 200, { user, csrf: csrfToken });
      }
      const staticFiles = {
        "/": ["index.html", "text/html"],
        "/app.js": ["app.js", "text/javascript"],
        "/styles.css": ["styles.css", "text/css"],
      };
      if (req.method === "GET" && staticFiles[url.pathname]) {
        const [file, type] = staticFiles[url.pathname];
        res.writeHead(200, {
          "Content-Type": type + "; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        await pipeline(
          fs.createReadStream(path.join(ROOT, "public", file)),
          res,
        );
        return;
      }
      if (route === "GET /favicon.ico") {
        res.writeHead(204);
        return res.end();
      }
      check(url.pathname.startsWith("/api/v1/"), "Not found", 404);
      const { user, hash } = await auth(req);
      if (!["GET", "HEAD"].includes(req.method)) csrf(req, user, origin);
      rate(req, "api", options.testMode ? 10000 : 1200, 60000);
      if (route === "GET /api/v1/auth/me")
        return send(res, 200, { user, csrf: user.csrf });
      if (route === "POST /api/v1/auth/logout") {
        await db.call("logout", { hash });
        expireStreams(null, hash);
        res.setHeader(
          "Set-Cookie",
          "sama_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
        );
        return send(res, 200, { ok: true });
      }
      if (route === "POST /api/v1/auth/password") {
        const body = await readBody(req),
          account = await db.call("loginUser", { name: user.username });
        check(
          await verify(body.oldPassword, account.password_hash),
          "Current password is incorrect",
          403,
        );
        const value = await db.call("changeUser", {
          user,
          id: user.id,
          input: {},
          hash: await hashed(body.password),
        });
        expireStreams(user.id);
        return send(res, 200, { user: value, signInAgain: true });
      }
      if (route === "PATCH /api/v1/auth/profile") {
        const body = await readBody(req);
        return send(res, 200, {
          user: await db.call("changeUser", {
            user,
            id: user.id,
            input: { name: body.name },
          }),
        });
      }
      if (route === "GET /api/v1/state")
        return send(res, 200, await state(user));
      if (route === "GET /api/v1/events") {
        check(clients.size < 80, "Too many live connections", 503);
        check(
          [...clients].filter((c) => c.user.id === user.id).length < 5,
          "Too many subscriptions for this account",
          429,
        );
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        const client = { user, hash, response: res };
        clients.add(client);
        res.write(
          `event: state\ndata: ${JSON.stringify(await state(user))}\n\n`,
        );
        req.on("close", () => clients.delete(client));
        return;
      }
      if (route === "GET /api/v1/plants")
        return send(res, 200, await db.call("plantList", { user, input }));
      if (route === "POST /api/v1/plants")
        return send(
          res,
          201,
          await db.call("createPlant", { user, input: await readBody(req) }),
        );
      if (route === "GET /api/v1/sensors")
        return send(res, 200, {
          sensors: (await db.call("sensorList", { user })).map((s) => ({
            ...s,
            ...hub.status(s),
          })),
        });
      if (route === "GET /api/v1/recordings")
        return send(res, 200, {
          recordings: await db.call("recordingList", { user, input }),
        });
      if (route === "POST /api/v1/recordings") {
        await history.storageCheck();
        return send(
          res,
          201,
          await db.call("createRecording", {
            user,
            input: await readBody(req),
            key: req.headers["idempotency-key"] ?? null,
          }),
        );
      }
      if (route === "GET /api/v1/measurements")
        return send(res, 200, {
          ...(await db.call("samplePage", { user, input })),
          tier: "hot",
          note: "Use a history query or export for complete archived details.",
        });
      if (route === "GET /api/v1/service-events")
        return send(res, 200, {
          events: await db.call("events", { user, input }),
        });
      if (route === "GET /api/v1/jobs")
        return send(res, 200, { jobs: await db.call("jobs", { user }) });
      if (
        ["POST /api/v1/exports", "POST /api/v1/history-queries"].includes(route)
      ) {
        const body = await readBody(req);
        return send(
          res,
          202,
          await db.call("createJob", {
            user,
            kind: route.includes("history-queries") ? "history" : "export",
            input: body,
          }),
        );
      }
      if (route === "POST /api/v1/assets") {
        const body = await readBody(req),
          sample = body.sampleId
            ? await history.findSample(
                user,
                body.sampleId,
                body.sampleReference,
              )
            : null;
        return send(
          res,
          201,
          await db.call("createAsset", { user, input: body, sample }),
        );
      }
      if (route === "GET /api/v1/admin/users")
        return send(res, 200, { users: await db.call("listUsers", { user }) });
      if (route === "POST /api/v1/admin/users") {
        check(user.role === "admin", "Administrator required", 403);
        const body = await readBody(req);
        return send(res, 201, {
          user: await db.call("createUser", {
            actor: user,
            input: body,
            hash: await hashed(body.password),
          }),
        });
      }
      if (route === "GET /api/v1/admin/gateways")
        return send(res, 200, {
          gateways: await db.call("gateways", { user }),
        });
      if (route === "POST /api/v1/admin/gateways")
        return send(
          res,
          201,
          await db.call("createGateway", {
            user,
            input: await readBody(req),
            secret: token(),
          }),
        );
      if (route === "POST /api/v1/admin/sensors")
        return send(
          res,
          201,
          await db.call("createSensor", { user, input: await readBody(req) }),
        );
      if (route === "GET /api/v1/admin/audit")
        return send(res, 200, { audit: await db.call("auditList", { user }) });
      if (route === "POST /api/v1/admin/backup") {
        check(user.role === "admin", "Administrator required", 403);
        return send(res, 200, await history.backup());
      }
      const match = url.pathname.match(
        /^\/api\/v1\/(plants|sensors|recordings|assets|jobs|context-snapshots|admin\/users|admin\/gateways)\/([A-Za-z0-9_-]+)(?:\/(bind|read|manual|transfer|stop|observations|content|download|cancel|context-snapshots|series|rotate-key))?$/,
      );
      if (match) {
        const [, type, id, action] = match;
        if (type === "plants") {
          if (req.method === "GET" && !action)
            return send(res, 200, await db.call("plantDetail", { user, id }));
          if (req.method === "PATCH" && !action)
            return send(
              res,
              200,
              await db.call("updatePlant", {
                user,
                id,
                input: await readBody(req),
              }),
            );
          if (req.method === "POST" && action === "observations")
            return send(
              res,
              201,
              await db.call("observation", {
                user,
                input: { ...(await readBody(req)), plantId: id },
              }),
            );
          if (
            req.method === "POST" &&
            ["context-snapshots", "series"].includes(action)
          )
            return send(
              res,
              202,
              await db.call("createJob", {
                user,
                kind: "context",
                input: {
                  ...(await readBody(req)),
                  plantId: id,
                  includeDemo: action === "series",
                },
              }),
            );
        }
        if (type === "sensors") {
          const sensor = await db.call("ownedPublic", {
            user,
            table: "sensors",
            id,
          });
          if (req.method === "PATCH" && !action) {
            const body = await readBody(req);
            return send(
              res,
              200,
              await hub.lock(sensor.gateway_id, () =>
                db.call("configureSensor", { user, id, input: body }),
              ),
            );
          }
          if (req.method === "POST" && ["bind", "transfer"].includes(action)) {
            const body = await readBody(req);
            const result = await hub.lock(sensor.gateway_id, () =>
              db.call(action === "bind" ? "bindSensor" : "transferSensor", {
                user,
                id,
                input: body,
              }),
            );
            hub.live.delete(id);
            await broadcast("refresh", {}, sensor.owner_id);
            if (body.ownerId) await broadcast("refresh", {}, body.ownerId);
            return send(res, 200, result);
          }
          if (req.method === "POST" && action === "read") {
            await readBody(req);
            return send(res, 200, await hub.read(sensor));
          }
          if (req.method === "POST" && action === "manual") {
            const body = await readBody(req);
            await history.storageCheck();
            const manualKey = req.headers["idempotency-key"] ?? randomUUID();
            const recording = await db.call("createRecording", {
              user,
              input: {
                name: body.name,
                notes: body.notes,
                sensorId: id,
                oneShot: true,
                intervalMs: sensor.interval_ms,
              },
              key: manualKey,
            });
            if (recording.reused && recording.sampleId)
              return send(res, 200, {
                recording,
                reused: true,
                sample: await history.findSample(user, recording.sampleId),
              });
            check(
              recording.start_at <= now(),
              "Manual capture cannot wait for a future start",
            );
            await db.call("tick");
            const result = await hub.read(sensor, {
              force: true,
              manualKey,
              recordingId: recording.id,
            });
            check(
              result.saved,
              "No reading was saved; inspect the recording status",
              409,
            );
            return send(res, 201, { recording, sample: result.saved });
          }
        }
        if (
          type === "recordings" &&
          req.method === "POST" &&
          action === "stop"
        ) {
          await readBody(req);
          return send(res, 200, await db.call("stopRecording", { user, id }));
        }
        if (type === "assets") {
          const a = await db.call("ownedPublic", { user, table: "assets", id });
          if (req.method === "GET" && action === "content") {
            check(a.status === "ready", "Photo not ready", 404);
            res.writeHead(200, {
              "Content-Type": "image/webp",
              "Cache-Control": "private, no-store",
            });
            await pipeline(
              await objects.stream(
                input.thumb === "1" ? a.thumb_key : a.object_key,
              ),
              res,
            );
            return;
          }
          if (req.method === "PUT" && action === "content") {
            check(
              !imageBusy,
              "Another photo is processing; try again shortly",
              429,
            );
            check(
              a.status === "pending",
              "Photo has already been uploaded",
              409,
            );
            imageBusy = true;
            const temporary = path.join(history.tmp, `${id}.webp`),
              thumbnail = path.join(history.tmp, `${id}-thumb.webp`);
            try {
              await history.storageCheck();
              const bytes = await readBody(req, 10 * 1024 * 1024, true),
                image = sharp(bytes, {
                  limitInputPixels: 24000000,
                  failOn: "error",
                }),
                metadata = await image.metadata().catch(() => {
                  throw new AppError(
                    "Image cannot be decoded or exceeds the pixel limit",
                  );
                });
              check(
                ["jpeg", "png", "webp"].includes(metadata.format) &&
                  (metadata.pages ?? 1) === 1,
                "Use a single JPEG, PNG or WebP image",
              );
              await image
                .rotate()
                .resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
                .webp({ quality: 85 })
                .toFile(temporary);
              await sharp(temporary)
                .resize(360, 360, { fit: "inside", withoutEnlargement: true })
                .webp({ quality: 75 })
                .toFile(thumbnail);
              const sha256 = await fileDigest(temporary);
              await objects.put(a.object_key, temporary, {
                sha256,
                type: "image/webp",
              });
              await objects.put(a.thumb_key, thumbnail, {
                sha256: await fileDigest(thumbnail),
                type: "image/webp",
              });
              return send(
                res,
                200,
                await db.call("readyAsset", {
                  user,
                  id,
                  input: { bytes: (await fsp.stat(temporary)).size, sha256 },
                }),
              );
            } catch (e) {
              await db.call("failAsset", { id });
              throw e;
            } finally {
              imageBusy = false;
              await Promise.all(
                [temporary, thumbnail].map((f) =>
                  fsp.rm(f, { force: true }).catch(() => {}),
                ),
              );
            }
          }
        }
        if (type === "jobs") {
          const job = await db.call("ownedPublic", { user, table: "jobs", id });
          if (req.method === "GET" && !action) return send(res, 200, job);
          if (req.method === "POST" && action === "cancel") {
            await readBody(req);
            return send(res, 200, await db.call("cancelJob", { user, id }));
          }
          if (req.method === "GET" && action === "download") {
            check(
              job.status === "ready" && job.result?.key,
              "Download not ready",
              409,
            );
            check(
              job.expires_at > now(),
              "Download has expired; create a new export",
              410,
            );
            res.writeHead(200, {
              "Content-Type": job.result.type,
              "Content-Disposition": `attachment; filename="${job.result.filename}"`,
              "Cache-Control": "private, no-store",
            });
            await pipeline(await objects.stream(job.result.key), res);
            return;
          }
        }
        if (type === "context-snapshots" && req.method === "GET") {
          const snapshot = await db.call("ownedPublic", {
            user,
            table: "snapshots",
            id,
          });
          return send(res, 200, { id: snapshot.id, ...snapshot.payload });
        }
        if (type === "admin/users" && req.method === "PATCH") {
          check(user.role === "admin", "Administrator required", 403);
          const body = await readBody(req),
            value = await db.call("changeUser", {
              user,
              id,
              input: body,
              hash: body.password ? await hashed(body.password) : undefined,
            });
          expireStreams(id);
          return send(res, 200, { user: value });
        }
        if (
          type === "admin/gateways" &&
          req.method === "POST" &&
          action === "rotate-key"
        ) {
          await readBody(req);
          const value = await db.call("resetGateway", {
            user,
            id,
            secret: token(),
          });
          hub.links.get(id)?.close();
          return send(res, 200, value);
        }
      }
      throw new AppError("Not found", 404);
    } catch (e) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      send(res, e.status ?? 500, {
        error: e.code ?? "ERROR",
        message: e.status
          ? e.message
          : "The operation failed; inspect the local service log",
      });
      if (!e.status) (options.onError ?? console.error)(e);
    }
  });
  web.requestTimeout = 60000;
  web.headersTimeout = 15000;
  web.maxRequestsPerSocket = 1000;
  const host = options.host ?? env.HOST ?? "127.0.0.1";
  try {
    await hub.listen(options.tcpPort ?? Number(env.PORT ?? 3189), host);
    await new Promise((resolve, reject) => {
      web.once("error", reject);
      web.listen(
        options.webPort ?? Number(env.WEB_PORT ?? 3180),
        host,
        resolve,
      );
    });
  } catch (error) {
    await hub.close();
    await db.close();
    releaseLock();
    throw error;
  }
  let heartbeatBusy = false;
  const heartbeat = setInterval(async () => {
    if (heartbeatBusy || closing) return;
    heartbeatBusy = true;
    try {
      for (const c of clients) {
        const current = await db.call("authenticate", { hash: c.hash });
        if (!current) {
          c.response.end();
          clients.delete(c);
        } else {
          c.user = current;
          c.response.write(": keepalive\n\n");
        }
      }
    } catch (error) {
      maintenanceError = error.message;
      for (const c of clients) c.response.end();
      clients.clear();
    } finally {
      heartbeatBusy = false;
    }
  }, 15000);
  heartbeat.unref();
  async function pump() {
    if (pumping || closing) return;
    pumping = true;
    try {
      const job = await db.call("nextJob");
      if (job) await history.runJob(job);
      if (Date.now() - lastArchive > (options.archiveIntervalMs ?? 300000)) {
        for (let i = 0; i < 40 && !closing; i++) {
          const result = await history.archive();
          if (!result.archived) break;
        }
        lastArchive = Date.now();
      }
      if (Date.now() - lastBackup > 86400000) {
        await history.backup();
        lastBackup = Date.now();
        await db.call("maintenanceState", {
          key: "lastBackup",
          value: lastBackup,
        });
      }
      if (Date.now() - lastCleanup > 3600000) {
        const expired = await db.call("expiredObjects");
        for (const job of expired.jobs) {
          if (job.result?.key) await objects.remove(job.result.key);
          await db.call("cleanupDone", { jobId: job.id });
        }
        for (const asset of expired.assets) {
          await objects.remove(asset.object_key);
          await objects.remove(asset.thumb_key);
          await db.call("cleanupDone", { assetId: asset.id });
        }
        lastCleanup = Date.now();
      }
    } catch (e) {
      maintenanceError = e.message;
    } finally {
      pumping = false;
    }
  }
  const maintenance =
    options.maintenance === false ? null : setInterval(pump, 1000);
  maintenance?.unref();
  return {
    db,
    hub,
    history,
    objects,
    pump,
    directory,
    webPort: web.address().port,
    tcpPort: hub.port,
    async close() {
      if (closing) return;
      closing = true;
      clearInterval(heartbeat);
      clearInterval(maintenance);
      for (const c of clients) c.response.end();
      clients.clear();
      await hub.close();
      web.closeIdleConnections();
      await new Promise((resolve) => web.close(resolve));
      while (pumping || heartbeatBusy)
        await new Promise((r) => setTimeout(r, 20));
      await history.tail;
      await db.close();
      releaseLock();
    },
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const runtime = await createCloudServer();
  console.log(
    `SAMA local warehouse http://127.0.0.1:${runtime.webPort}; gateway TCP ${runtime.tcpPort}; data ${runtime.directory}`,
  );
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      await runtime.close();
      process.exit(0);
    });
}
