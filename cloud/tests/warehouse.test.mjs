import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import net from "node:net";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { withCrc } from "../../lib/modbus.mjs";
import { createCloudServer } from "../server.mjs";
import { passwordHash, token } from "../lib/common.mjs";

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sama-warehouse-"));
  const errors = [];
  const server = await createCloudServer({
    dataDir: directory,
    webPort: 0,
    tcpPort: 0,
    host: "127.0.0.1",
    env: {},
    maintenance: false,
    testMode: true,
    onError: (e) => errors.push(e),
  });
  t.after(async () => {
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const admin = await server.db.call("createUser", {
    bootstrap: true,
    input: { username: "administrator" },
    hash: await passwordHash("admin-password-2026"),
  });
  const base = `http://127.0.0.1:${server.webPort}`;
  function client() {
    let cookie = "",
      csrf = "";
    return {
      async request(
        url,
        body,
        method = body === undefined ? "GET" : "POST",
        extra = {},
      ) {
        const response = await fetch(base + "/api/v1/" + url, {
          method,
          headers: {
            ...(cookie ? { Cookie: cookie } : {}),
            ...(body === undefined
              ? {}
              : {
                  "Content-Type": "application/json",
                  "X-Sama-Request": "1",
                  "X-CSRF-Token": csrf,
                }),
            ...extra.headers,
          },
          body:
            body === undefined
              ? undefined
              : Buffer.isBuffer(body)
                ? body
                : JSON.stringify(body),
          signal: AbortSignal.timeout(10000),
        });
        if (response.headers.get("set-cookie"))
          cookie = response.headers.get("set-cookie").split(";")[0];
        const type = response.headers.get("content-type") ?? "",
          data = type.includes("json")
            ? await response.json()
            : await response.text();
        if (data?.csrf) csrf = data.csrf;
        return { status: response.status, data, response };
      },
      headers() {
        return { Cookie: cookie, "X-Sama-Request": "1", "X-CSRF-Token": csrf };
      },
    };
  }
  const root = client();
  assert.equal(
    (
      await root.request("auth/login", {
        username: admin.username,
        password: "admin-password-2026",
      })
    ).status,
    200,
  );
  return { server, root, client, admin, base, errors };
}
async function register(c, name) {
  assert.equal(
    (
      await c.request("auth/register", {
        username: name,
        password: "strong-password-2026",
        role: "admin",
      })
    ).status,
    201,
  );
  const r = await c.request("auth/login", {
    username: name,
    password: "strong-password-2026",
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.role, "user");
  return r.data.user;
}

test("self registration, admin controls, CSRF, password resets and tenant boundaries", async (t) => {
  const { root, client, base } = await fixture(t),
    alice = client(),
    bob = client(),
    a = await register(alice, "alice"),
    b = await register(bob, "bob-user");
  const plant = (
    await alice.request("plants", {
      name: "Alice orchid",
      profile: { substrate: "bark" },
    })
  ).data;
  assert.equal((await bob.request("plants/" + plant.id)).status, 404);
  assert.equal(
    (await bob.request("plants/" + plant.id, { name: "stolen" }, "PATCH"))
      .status,
    404,
  );
  assert.equal((await bob.request("plants")).data.total, 0);
  assert.equal((await alice.request("admin/users")).status, 403);
  assert.equal(
    (await alice.request("admin/gateways", { name: "not allowed" })).status,
    403,
  );
  assert.equal((await root.request("plants")).data.total, 1);
  const blind = await fetch(base + "/api/v1/plants", {
    method: "POST",
    headers: {
      ...alice.headers(),
      "X-CSRF-Token": "wrong",
      "Content-Type": "application/json",
    },
    body: '{"name":"bad"}',
  });
  assert.equal(blind.status, 403);
  const cross = await fetch(base + "/api/v1/plants", {
    method: "POST",
    headers: {
      ...alice.headers(),
      Origin: "https://attacker.example",
      "Content-Type": "application/json",
    },
    body: '{"name":"bad"}',
  });
  assert.equal(cross.status, 403);
  assert.equal((await fetch(base + "/api/state")).status, 404);
  assert.equal((await fetch(base + "/data-v2/warehouse.sqlite")).status, 404);
  assert.equal(
    (
      await root.request(
        "admin/users/" + b.id,
        { password: "replacement-password-2026" },
        "PATCH",
      )
    ).status,
    200,
  );
  assert.equal((await bob.request("auth/me")).status, 401);
  assert.equal(
    (
      await bob.request("auth/login", {
        username: b.username,
        password: "strong-password-2026",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await bob.request("auth/login", {
        username: b.username,
        password: "replacement-password-2026",
      })
    ).status,
    200,
  );
  assert.equal(
    (await root.request("admin/users/" + a.id, { active: false }, "PATCH"))
      .status,
    200,
  );
  assert.equal((await alice.request("auth/me")).status, 401);
});

test("measurement ownership survives a sensor handover and archives remain readable after hot deletion", async (t) => {
  const { server, root, client } = await fixture(t),
    alice = client(),
    bob = client(),
    a = await register(alice, "alice"),
    b = await register(bob, "bob-user");
  const gateway = (
    await root.request("admin/gateways", {
      name: "Mock gateway",
      simulated: true,
    })
  ).data;
  const sensor = (
    await root.request("admin/sensors", {
      gatewayId: gateway.id,
      ownerId: a.id,
      name: "Shared physical probe",
      intervalMs: 1000,
    })
  ).data;
  assert.ok(sensor.id);
  const pa = (await alice.request("plants", { name: "A" })).data,
    pb = (await bob.request("plants", { name: "B" })).data;
  assert.equal(
    (await bob.request("sensors/" + sensor.id + "/bind", { plantId: pb.id }))
      .status,
    404,
  );
  assert.equal(
    (await alice.request("sensors/" + sensor.id + "/bind", { plantId: pa.id }))
      .status,
    200,
  );
  const one = await alice.request(
    "sensors/" + sensor.id + "/manual",
    {},
    "POST",
    { headers: { "Idempotency-Key": "capture-00000001" } },
  );
  assert.equal(one.status, 201, JSON.stringify(one.data));
  assert.equal(one.data.sample.plantId, pa.id);
  const again = await alice.request(
    "sensors/" + sensor.id + "/manual",
    {},
    "POST",
    { headers: { "Idempotency-Key": "capture-00000001" } },
  );
  assert.equal(again.status, 200);
  assert.equal(again.data.sample.id, one.data.sample.id);
  const rec = await alice.request("recordings", {
    sensorId: sensor.id,
    name: "A batch",
    intervalMs: 1000,
    fullResolution: true,
  });
  assert.equal(rec.status, 201, JSON.stringify(rec.data));
  await server.hub.read(sensor);
  assert.equal(
    (
      await root.request("sensors/" + sensor.id + "/transfer", {
        ownerId: b.id,
      })
    ).status,
    200,
  );
  assert.equal((await alice.request("sensors")).data.sensors.length, 0);
  assert.equal((await bob.request("sensors")).data.sensors[0].latest, null);
  assert.ok(
    (await alice.request("recordings")).data.recordings.every(
      (r) => !["running", "scheduled"].includes(r.status),
    ),
  );
  assert.equal(
    (await bob.request("sensors/" + sensor.id + "/bind", { plantId: pb.id }))
      .status,
    200,
  );
  const two = await bob.request("sensors/" + sensor.id + "/manual", {});
  assert.equal(two.status, 201);
  assert.equal(two.data.sample.plantId, pb.id);
  assert.equal(
    (await alice.request("measurements?plantId=" + pa.id)).data.samples.every(
      (s) => s.ownerId === a.id && s.plantId === pa.id,
    ),
    true,
  );
  assert.equal(
    (await bob.request("measurements?plantId=" + pa.id)).status,
    404,
  );
  for (let i = 0; i < 5; i++) {
    if (!(await server.history.archive()).archived) break;
  }
  await server.db.call("prune", { before: "2099-01-01T00:00:00.000Z" });
  assert.equal(
    (await alice.request("measurements?plantId=" + pa.id)).data.samples.length,
    0,
  );
  const rows = await server.history.lock(async () => {
    const out = [];
    for await (const r of server.history.scan(
      { id: a.id, role: "user" },
      { plantId: pa.id },
    ))
      out.push(r);
    return out;
  });
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((r) => r.plantId === pa.id && r.ownerId === a.id));
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
});

test("photo validation, per-sample attachments, scoped exports and stable AI snapshots", async (t) => {
  const { server, root, client } = await fixture(t),
    alice = client(),
    bob = client(),
    a = await register(alice, "alice");
  await register(bob, "bob-user");
  const g = (
      await root.request("admin/gateways", { name: "sim", simulated: true })
    ).data,
    s = (
      await root.request("admin/sensors", {
        gatewayId: g.id,
        ownerId: a.id,
        name: "probe",
        intervalMs: 1000,
      })
    ).data,
    p = (
      await alice.request("plants", {
        name: "Orchid",
        profile: { species: "Phalaenopsis" },
      })
    ).data;
  await alice.request("sensors/" + s.id + "/bind", { plantId: p.id });
  const sample = (await alice.request("sensors/" + s.id + "/manual", {})).data
    .sample;
  const photo = await alice.request("assets", {
    plantId: p.id,
    category: "sample",
    sampleId: sample.id,
    caption: "Leaf at capture",
    capturedAt: sample.timestamp,
  });
  assert.equal(photo.status, 201);
  const bytes = await sharp({
    create: {
      width: 40,
      height: 30,
      channels: 3,
      background: { r: 50, g: 120, b: 70 },
    },
  })
    .png()
    .toBuffer();
  const upload = await alice.request(
    "assets/" + photo.data.id + "/content",
    bytes,
    "PUT",
    { headers: { "Content-Type": "image/png" } },
  );
  assert.equal(upload.status, 200, JSON.stringify(upload.data));
  assert.equal(
    (await bob.request("assets/" + photo.data.id + "/content")).status,
    404,
  );
  assert.equal(
    (await alice.request("assets/" + photo.data.id + "/content")).status,
    200,
  );
  const invalid = (
    await alice.request("assets", { plantId: p.id, category: "profile" })
  ).data;
  assert.equal(
    (
      await alice.request(
        "assets/" + invalid.id + "/content",
        Buffer.from("<svg/>"),
        "PUT",
      )
    ).status,
    400,
  );
  const job = await alice.request("exports", { plantId: p.id, format: "csv" });
  assert.equal(job.status, 202);
  assert.equal((await bob.request("jobs/" + job.data.id)).status, 404);
  await server.pump();
  const ready = await alice.request("jobs/" + job.data.id);
  assert.equal(ready.data.status, "ready", JSON.stringify(ready.data));
  const csv = await alice.request("jobs/" + job.data.id + "/download");
  assert.equal(csv.status, 200);
  assert.match(csv.data, /timestamp_utc/);
  assert.match(csv.data, new RegExp(sample.id));
  assert.equal(
    (await bob.request("jobs/" + job.data.id + "/download")).status,
    404,
  );
  const context = await alice.request(
    "plants/" + p.id + "/context-snapshots",
    {},
  );
  assert.equal(context.status, 202);
  await server.pump();
  const cj = (await alice.request("jobs/" + context.data.id)).data;
  assert.equal(cj.status, "ready", JSON.stringify(cj));
  const snapshot = await alice.request(
    "context-snapshots/" + cj.result.snapshotId,
  );
  assert.equal(snapshot.data.schema_version, "sama.plant-context.v1");
  assert.equal(snapshot.data.plant_id, p.id);
  assert.ok(snapshot.data.photos.some((x) => x.id === photo.data.id));
  assert.equal(
    (await bob.request("context-snapshots/" + cj.result.snapshotId)).status,
    404,
  );
  const zip = (
    await alice.request("exports", {
      plantId: p.id,
      format: "zip",
      includePhotos: true,
    })
  ).data;
  await server.pump();
  assert.equal((await alice.request("jobs/" + zip.id)).data.status, "ready");
});

test("unregistered gateways cannot claim a device and failed object uploads do not prune samples", async (t) => {
  const { server, root, client } = await fixture(t),
    alice = client(),
    a = await register(alice, "alice"),
    g = (await root.request("admin/gateways", { name: "sim", simulated: true }))
      .data,
    s = (
      await root.request("admin/sensors", {
        gatewayId: g.id,
        ownerId: a.id,
        name: "probe",
        intervalMs: 1000,
      })
    ).data,
    p = (await alice.request("plants", { name: "Orchid" })).data;
  await alice.request("sensors/" + s.id + "/bind", { plantId: p.id });
  await alice.request("sensors/" + s.id + "/manual", {});
  const put = server.objects.put;
  server.objects.put = async () => {
    throw new Error("Injected object outage");
  };
  await assert.rejects(() => server.history.archive(), /outage/);
  assert.ok((await alice.request("measurements")).data.samples.length > 0);
  assert.equal((await server.db.call("segments", { user: a })).length, 0);
  server.objects.put = put;
  assert.ok((await server.history.archive()).archived > 0);
  assert.equal(
    await server.db.call("gatewayIdentity", { id: g.id, secret: "wrong" }),
    null,
  );
});

test("archive recovery survives recording budget exhaustion and backups preserve the disk reserve", async (t) => {
  const { server, admin } = await fixture(t);
  clearInterval(server.hub.timer);
  await server.db.call("importLegacy", {
    user: admin,
    rows: [
      {
        id: crypto.randomUUID(),
        deviceId: "old-probe",
        timestamp: "2020-01-01T00:00:00.000Z",
        source: "hardware",
        values: { moisture: 42 },
      },
    ],
  });
  const freeBytes = server.history.freeBytes;
  server.history.freeBytes = async () => 32 * 1024 * 1024;
  server.history.maxDatabaseBytes = 1;
  await assert.rejects(() => server.history.storageCheck(), /Storage reserve/);
  assert.equal((await server.history.archive()).archived, 1);
  assert.equal((await server.db.call("stats", { user: admin })).samplesHot, 0);
  const samples = [];
  for await (const row of server.history.scan(admin)) samples.push(row);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].values.moisture, 42);
  await assert.rejects(() => server.history.backup(), /Storage reserve/);
  server.history.freeBytes = freeBytes;
  await assert.rejects(() => server.history.storageCheck(), /Database budget/);
  // Backups remain available even when the recording database budget was reached.
  assert.ok(
    (await server.history.backup()).key.startsWith("soil-studio/backups/"),
  );
});

test("real Modbus byte stream shares one serial queue across two sensors and rejects an unknown gateway", async (t) => {
  const { server, root } = await fixture(t),
    user = server ? (await root.request("auth/me")).data.user : null;
  clearInterval(server.hub.timer);
  const gateway = (
    await root.request("admin/gateways", { name: "Wire-test gateway" })
  ).data;
  const sensors = [];
  for (const address of [2, 3]) {
    const sensor = (
      await root.request("admin/sensors", {
        gatewayId: gateway.id,
        ownerId: user.id,
        name: "Sensor " + address,
        address,
        intervalMs: 60000,
      })
    ).data;
    const plant = (await root.request("plants", { name: "Plant " + address }))
      .data;
    await root.request("sensors/" + sensor.id + "/bind", { plantId: plant.id });
    await root.request("recordings", {
      sensorId: sensor.id,
      intervalMs: 60000,
      fullResolution: true,
    });
    sensors.push(sensor);
  }
  const socket = net.connect(server.tcpPort, "127.0.0.1");
  socket.on("error", () => {});
  t.after(() => socket.destroy());
  await once(socket, "connect");
  socket.write(gateway.registration + "\n");
  let pending = Buffer.alloc(0),
    active = 0,
    maxActive = 0,
    corrupt = false;
  socket.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 8) {
      const request = pending.subarray(0, 8);
      pending = pending.subarray(8);
      active++;
      maxActive = Math.max(maxActive, active);
      const start = request.readUInt16BE(2),
        count = request.readUInt16BE(4),
        registers = [65501, 0, 410, 80, 16, 8, 35, 65],
        body = Buffer.alloc(3 + count * 2);
      body[0] = request[0];
      body[1] = 3;
      body[2] = count * 2;
      for (let i = 0; i < count; i++)
        body.writeUInt16BE(registers[start + i], 3 + i * 2);
      const frame = withCrc(body);
      if (corrupt) {
        frame[frame.length - 1] ^= 1;
        corrupt = false;
      }
      setTimeout(() => {
        socket.write(frame.subarray(0, 4));
        setTimeout(() => {
          active--;
          socket.write(frame.subarray(4));
        }, 5);
      }, 5);
    }
  });
  for (let i = 0; i < 100 && !server.hub.links.has(gateway.id); i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.ok(server.hub.links.has(gateway.id));
  const results = await Promise.all([
    server.hub.read(sensors[0]),
    server.hub.read(sensors[1]),
    server.hub.read(sensors[0]),
  ]);
  assert.equal(maxActive, 1);
  assert.ok(
    results.every(
      (r) =>
        r.sample.source === "hardware" &&
        r.sample.values.temperature === -3.5 &&
        r.sample.values.moisture === 0,
    ),
  );
  assert.ok(results.every((r) => r.saved));
  corrupt = true;
  await assert.rejects(
    () => server.hub.read(sensors[0]),
    (e) => e.code === "CRC",
  );
  const impostor = net.connect(server.tcpPort, "127.0.0.1");
  impostor.on("error", () => {});
  await once(impostor, "connect");
  impostor.write(`SAMA:${gateway.id}:${"x".repeat(43)}\n`);
  await Promise.race([
    once(impostor, "close"),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Unknown gateway was not rejected")),
        2000,
      ).unref(),
    ),
  ]);
  assert.ok(server.hub.links.has(gateway.id));
  const backup = await server.history.backup(),
    snapshot = new DatabaseSync(server.objects.target(backup.key), {
      readOnly: true,
    });
  assert.equal(
    snapshot.prepare("PRAGMA integrity_check").get().integrity_check,
    "ok",
  );
  assert.ok(snapshot.prepare("SELECT count(*) n FROM samples").get().n >= 3);
  snapshot.close();
});

test("SSE only emits the current tenant and revocation closes its subscription", async (t) => {
  const { server, root, client, base } = await fixture(t),
    alice = client(),
    bob = client(),
    a = await register(alice, "alice"),
    b = await register(bob, "bob-user"),
    g = (
      await root.request("admin/gateways", {
        name: "Shared gateway",
        simulated: true,
      })
    ).data;
  const sensors = [];
  for (const [owner, actor] of [
    [a, alice],
    [b, bob],
  ]) {
    const s = (
        await root.request("admin/sensors", {
          gatewayId: g.id,
          ownerId: owner.id,
          name: owner.username,
          address: sensors.length + 2,
          intervalMs: 60000,
        })
      ).data,
      p = (await actor.request("plants", { name: owner.username + " plant" }))
        .data;
    await actor.request("sensors/" + s.id + "/bind", { plantId: p.id });
    sensors.push(s);
  }
  const abort = new AbortController();
  t.after(() => abort.abort());
  const response = await fetch(base + "/api/v1/events", {
      headers: bob.headers(),
      signal: abort.signal,
    }),
    reader = response.body.getReader();
  let received = "";
  const aSample = await server.hub.read(sensors[0]),
    bSample = await server.hub.read(sensors[1]);
  for (;;) {
    const part = await reader.read();
    assert.ok(!part.done);
    received += Buffer.from(part.value).toString();
    if (received.includes(bSample.sample.id)) break;
  }
  assert.equal(received.includes(aSample.sample.id), false);
  assert.equal(received.includes(sensors[0].id), false);
  await root.request("admin/users/" + b.id, { active: false }, "PATCH");
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
  }
  await reader.cancel();
});

test("scheduled recording and sample IDs survive restart, and complete history paginates without duplicates", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sama-restart-"));
  let runtime = await createCloudServer({
    dataDir: directory,
    webPort: 0,
    tcpPort: 0,
    host: "127.0.0.1",
    env: {},
    maintenance: false,
  });
  t.after(async () => {
    await runtime.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const user = await runtime.db.call("createUser", {
      bootstrap: true,
      input: { username: "administrator" },
      hash: await passwordHash("strong-password-2026"),
    }),
    g = await runtime.db.call("createGateway", {
      user,
      input: { name: "sim", simulated: true },
      secret: token(),
    }),
    s = await runtime.db.call("createSensor", {
      user,
      input: {
        gatewayId: g.id,
        ownerId: user.id,
        name: "sensor",
        intervalMs: 1000,
      },
    }),
    p = await runtime.db.call("createPlant", {
      user,
      input: { name: "Restart plant" },
    });
  await runtime.db.call("bindSensor", {
    user,
    id: s.id,
    input: { plantId: p.id },
  });
  const recording = await runtime.db.call("createRecording", {
    user,
    input: {
      sensorId: s.id,
      startAt: new Date(Date.now() + 400).toISOString(),
      endAt: new Date(Date.now() + 60000).toISOString(),
      intervalMs: 1000,
      fullResolution: true,
    },
  });
  assert.equal(recording.status, "scheduled");
  await runtime.close();
  runtime = await createCloudServer({
    dataDir: directory,
    webPort: 0,
    tcpPort: 0,
    host: "127.0.0.1",
    env: {},
    maintenance: false,
  });
  await new Promise((r) => setTimeout(r, 500));
  await runtime.db.call("tick");
  const sample = await runtime.hub.read(s);
  assert.equal(sample.saved.recordingId, recording.id);
  await runtime.db.call("stopRecording", { user, id: recording.id });
  // Imported old cloud data deliberately has shuffled timestamps: manifest bounds must still be correct.
  const baseTime = Date.now() - 86400000,
    rows = Array.from({ length: 650 }, (_, i) => ({
      id: crypto.randomUUID(),
      deviceId: "legacy",
      timestamp: new Date(baseTime + (649 - i) * 1000).toISOString(),
      source: "hardware",
      values: { moisture: i % 100 },
    }));
  await runtime.db.call("importLegacy", { user, rows });
  while ((await runtime.history.archive()).archived) {}
  await runtime.db.call("prune", { before: "2099-01-01T00:00:00.000Z" });
  const seen = new Set();
  let before;
  for (let page = 0; page < 3; page++) {
    const job = await runtime.db.call("createJob", {
      user,
      kind: "history",
      input: {
        since: new Date(baseTime - 1).toISOString(),
        until: new Date(baseTime + 650000).toISOString(),
        beforeSeq: before,
      },
    });
    const next = await runtime.db.call("nextJob");
    await runtime.history.runJob(next);
    const result = (
      await runtime.db.call("ownedPublic", { user, table: "jobs", id: job.id })
    ).result;
    for (const r of result.preview) {
      assert.ok(!seen.has(r.id));
      seen.add(r.id);
    }
    before = result.nextBefore;
    if (!before) break;
  }
  assert.equal(seen.size, 650);
});
