import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} from "node:worker_threads";
import { DatabaseSync, backup } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  AppError,
  check,
  text,
  integer,
  date,
  now,
  digest,
  username,
  safeUser,
} from "./common.mjs";
import { METRICS } from "../../lib/modbus.mjs";

const json = (value) => JSON.stringify(value);
const parse = (value) => (value ? JSON.parse(value) : null);
const metricKeys = METRICS.map((m) => m.key);
function unpack(row) {
  if (!row) return null;
  const value = { ...row };
  for (const k of [
    "profile",
    "payload",
    "settings",
    "values",
    "registers",
    "frames",
    "warnings",
    "metrics",
    "filter",
    "result",
  ])
    if (k in value && typeof value[k] === "string") value[k] = parse(value[k]);
  return value;
}

class Warehouse {
  constructor(directory) {
    fs.mkdirSync(directory, { recursive: true });
    this.directory = directory;
    this.db = new DatabaseSync(path.join(directory, "warehouse.sqlite"));
    this.db.exec(
      `PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000; PRAGMA cache_size=-8192;`,
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','user')), active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_sessions(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gateways(id TEXT PRIMARY KEY, name TEXT NOT NULL, secret_hash TEXT NOT NULL, simulated INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sensors(id TEXT PRIMARY KEY, gateway_id TEXT NOT NULL REFERENCES gateways(id), owner_id TEXT REFERENCES users(id), name TEXT NOT NULL, address INTEGER NOT NULL CHECK(address BETWEEN 1 AND 247), metrics TEXT NOT NULL, interval_ms INTEGER NOT NULL, created_at TEXT NOT NULL, UNIQUE(gateway_id,address));
      CREATE TABLE IF NOT EXISTS plants(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, code TEXT NOT NULL, profile TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS plants_owner ON plants(owner_id,archived,name);
      CREATE TABLE IF NOT EXISTS plant_revisions(id TEXT PRIMARY KEY, plant_id TEXT NOT NULL REFERENCES plants(id), owner_id TEXT NOT NULL REFERENCES users(id), revision INTEGER NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assignments(id TEXT PRIMARY KEY, sensor_id TEXT NOT NULL REFERENCES sensors(id), plant_id TEXT NOT NULL REFERENCES plants(id), owner_id TEXT NOT NULL REFERENCES users(id), started_at TEXT NOT NULL, ended_at TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_assignment ON assignments(sensor_id) WHERE ended_at IS NULL;
      CREATE TABLE IF NOT EXISTS recordings(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), sensor_id TEXT NOT NULL REFERENCES sensors(id), plant_id TEXT NOT NULL REFERENCES plants(id), assignment_id TEXT NOT NULL REFERENCES assignments(id), name TEXT NOT NULL, start_at TEXT NOT NULL, end_at TEXT, stopped_at TEXT, status TEXT NOT NULL, interval_ms INTEGER NOT NULL, full_resolution INTEGER NOT NULL, settings TEXT NOT NULL, last_slot INTEGER NOT NULL DEFAULT -1, count INTEGER NOT NULL DEFAULT 0, selected_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS recordings_due ON recordings(status,sensor_id,start_at);
      CREATE TABLE IF NOT EXISTS samples(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL REFERENCES users(id), plant_id TEXT REFERENCES plants(id), sensor_id TEXT, gateway_id TEXT, assignment_id TEXT, recording_id TEXT, timestamp TEXT NOT NULL, stored_at TEXT NOT NULL, source TEXT NOT NULL, selected INTEGER NOT NULL, payload TEXT NOT NULL, segment_id TEXT);
      CREATE INDEX IF NOT EXISTS samples_owner_time ON samples(owner_id,timestamp,seq);
      CREATE INDEX IF NOT EXISTS samples_plant_time ON samples(plant_id,timestamp,seq);
      CREATE INDEX IF NOT EXISTS samples_pending ON samples(segment_id,seq);
      CREATE TABLE IF NOT EXISTS segments(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), plant_id TEXT, sensor_id TEXT, recording_id TEXT, object_key TEXT NOT NULL, first_seq INTEGER NOT NULL, last_seq INTEGER NOT NULL, first_at TEXT NOT NULL, last_at TEXT NOT NULL, count INTEGER NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS segments_owner_time ON segments(owner_id,first_at,last_at);
      CREATE TABLE IF NOT EXISTS sample_anchors(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, plant_id TEXT, timestamp TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS observations(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), plant_id TEXT NOT NULL REFERENCES plants(id), kind TEXT NOT NULL, happened_at TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS observations_plant_time ON observations(plant_id,happened_at);
      CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), plant_id TEXT NOT NULL REFERENCES plants(id), sample_id TEXT, recording_id TEXT, observation_id TEXT, category TEXT NOT NULL, object_key TEXT NOT NULL, thumb_key TEXT NOT NULL, content_type TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0, sha256 TEXT, caption TEXT NOT NULL, captured_at TEXT, created_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending');
      CREATE INDEX IF NOT EXISTS assets_plant ON assets(plant_id,status,created_at);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL, status TEXT NOT NULL, filter TEXT NOT NULL, result TEXT, error TEXT, progress INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, finished_at TEXT, expires_at TEXT);
      CREATE INDEX IF NOT EXISTS jobs_owner ON jobs(owner_id,created_at);
      CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), plant_id TEXT NOT NULL REFERENCES plants(id), payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS idempotency(owner_id TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, recording_id TEXT, sample_id TEXT, PRIMARY KEY(owner_id,key));
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, owner_id TEXT, action TEXT NOT NULL, target_id TEXT, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS service_events(id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT, sensor_id TEXT, recording_id TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS service_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      PRAGMA user_version=1;
    `);
    if (
      !this.all("PRAGMA table_info(sensors)").some((c) => c.name === "profile")
    )
      this.db.exec(
        "ALTER TABLE sensors ADD COLUMN profile TEXT NOT NULL DEFAULT '{}'",
      );
    const sqlite = this.get("SELECT sqlite_version() v")
      .v.split(".")
      .map(Number);
    check(
      sqlite[0] > 3 ||
        (sqlite[0] === 3 &&
          (sqlite[1] > 51 || (sqlite[1] === 51 && sqlite[2] >= 3))),
      "SQLite 3.51.3+ with the WAL-reset fix is required",
      500,
    );
    this.db
      .prepare(
        "UPDATE jobs SET status='queued',error=NULL WHERE status='running'",
      )
      .run();
    this.db
      .prepare("DELETE FROM auth_sessions WHERE expires_at < ?")
      .run(now());
    this.event(null, null, null, "service_restart", {
      message:
        "Collectors resume from current time; missed readings are not backfilled.",
    });
  }
  get(sql, ...args) {
    return this.db.prepare(sql).get(...args);
  }
  all(sql, ...args) {
    return this.db.prepare(sql).all(...args);
  }
  run(sql, ...args) {
    return this.db.prepare(sql).run(...args);
  }
  tx(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const v = fn();
      this.db.exec("COMMIT");
      return v;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  admin(user) {
    check(user?.role === "admin", "Administrator required", 403);
  }
  owned(table, id, user) {
    const allowed = [
      "plants",
      "sensors",
      "recordings",
      "assets",
      "jobs",
      "snapshots",
      "observations",
      "assignments",
    ];
    check(allowed.includes(table), "Invalid resource");
    const row = this.get(`SELECT * FROM ${table} WHERE id=?`, id);
    check(
      row && (row.owner_id === user.id || user.role === "admin"),
      "Resource not found",
      404,
    );
    return unpack(row);
  }
  owner(user, ownerId) {
    const id = user.role === "admin" && ownerId ? ownerId : user.id;
    check(
      this.get("SELECT id FROM users WHERE id=? AND active=1", id),
      "Active owner required",
    );
    return id;
  }
  ownedPublic({ user, table, id }) {
    return this.owned(table, id, user);
  }
  audit(user, action, id, payload = {}, owner = user?.id) {
    this.run(
      "INSERT INTO audit(actor_id,owner_id,action,target_id,payload,created_at) VALUES(?,?,?,?,?,?)",
      user?.id ?? null,
      owner ?? null,
      action,
      id ?? null,
      json(payload),
      now(),
    );
  }
  event(owner, sensor, recording, kind, payload) {
    this.run(
      "INSERT INTO service_events(owner_id,sensor_id,recording_id,kind,payload,created_at) VALUES(?,?,?,?,?,?)",
      owner,
      sensor,
      recording,
      kind,
      json(payload),
      now(),
    );
    this.run(
      "DELETE FROM service_events WHERE id < (SELECT COALESCE(MAX(id),0)-10000 FROM service_events)",
    );
  }
  userCount() {
    return this.get("SELECT count(*) AS n FROM users").n;
  }
  createUser({ input, actor = null, hash, bootstrap = false }) {
    if (bootstrap)
      check(
        this.get("SELECT count(*) n FROM users WHERE role='admin'").n === 0,
        "An administrator already exists",
        409,
      );
    else if (actor) this.admin(actor);
    const name = username(input.username),
      id = randomUUID(),
      role = bootstrap
        ? "admin"
        : actor && input.role === "admin"
          ? "admin"
          : "user";
    check(
      !this.get("SELECT id FROM users WHERE username=?", name),
      "Username already exists",
      409,
    );
    this.run(
      "INSERT INTO users VALUES(?,?,?,?,?,?,?)",
      id,
      name,
      text(input.name || name, 80, true),
      hash,
      role,
      1,
      now(),
    );
    this.audit(
      actor,
      bootstrap ? "bootstrap_admin" : actor ? "create_user" : "self_register",
      id,
      { username: name, role },
      id,
    );
    return safeUser(this.get("SELECT * FROM users WHERE id=?", id));
  }
  loginUser({ name }) {
    return this.get("SELECT * FROM users WHERE username=?", username(name));
  }
  listUsers({ user }) {
    this.admin(user);
    return this.all(
      "SELECT id,username,name,role,active,created_at FROM users ORDER BY created_at",
    );
  }
  changeUser({ user, id, input, hash }) {
    const target = this.get("SELECT * FROM users WHERE id=?", id);
    check(target, "User not found", 404);
    check(user.role === "admin" || user.id === id, "Forbidden", 403);
    if (input.active !== undefined || input.role !== undefined)
      this.admin(user);
    const active =
        input.active === undefined ? target.active : input.active ? 1 : 0,
      role = input.role ?? target.role;
    check(["admin", "user"].includes(role), "Invalid role");
    if (target.role === "admin" && (!active || role !== "admin"))
      check(
        this.get(
          "SELECT count(*) n FROM users WHERE role='admin' AND active=1 AND id<>?",
          id,
        ).n > 0,
        "Cannot remove the last administrator",
      );
    return this.tx(() => {
      this.run(
        "UPDATE users SET name=?,active=?,role=?,password_hash=? WHERE id=?",
        text(input.name ?? target.name, 80, true),
        active,
        role,
        hash ?? target.password_hash,
        id,
      );
      if (hash || !active || role !== target.role)
        this.run("DELETE FROM auth_sessions WHERE user_id=?", id);
      if (!active || role !== target.role)
        this.run(
          "UPDATE jobs SET status='cancelled' WHERE owner_id=? AND status IN ('queued','running')",
          id,
        );
      if (!active)
        for (const s of this.all("SELECT id FROM sensors WHERE owner_id=?", id))
          this.endSensor(s.id, "owner_disabled");
      this.audit(
        user,
        hash ? "password_reset" : "update_user",
        id,
        { active, role },
        id,
      );
      return safeUser(this.get("SELECT * FROM users WHERE id=?", id));
    });
  }
  createAuth({ userId, hash, csrf, expiresAt }) {
    this.run(
      "INSERT INTO auth_sessions VALUES(?,?,?,?)",
      hash,
      userId,
      csrf,
      expiresAt,
    );
  }
  authenticate({ hash }) {
    const row = this.get(
      "SELECT u.*,a.csrf,a.expires_at FROM auth_sessions a JOIN users u ON u.id=a.user_id WHERE a.hash=? AND a.expires_at>? AND u.active=1",
      hash,
      now(),
    );
    return safeUser(row);
  }
  logout({ hash }) {
    this.run("DELETE FROM auth_sessions WHERE hash=?", hash);
  }
  createGateway({ user, input, secret }) {
    this.admin(user);
    const id = input.id || randomUUID();
    check(/^[A-Za-z0-9_-]{2,40}$/.test(id), "Invalid gateway ID");
    check(
      !this.get("SELECT id FROM gateways WHERE id=?", id),
      "Gateway ID already exists",
      409,
    );
    this.run(
      "INSERT INTO gateways VALUES(?,?,?,?,?)",
      id,
      text(input.name, 80, true),
      digest(secret),
      input.simulated ? 1 : 0,
      now(),
    );
    this.audit(user, "create_gateway", id);
    return {
      id,
      name: input.name,
      simulated: !!input.simulated,
      registration: `SAMA:${id}:${secret}`,
    };
  }
  gateways({ user }) {
    this.admin(user);
    return this.all("SELECT id,name,simulated,created_at FROM gateways");
  }
  gatewayIdentity({ id, secret }) {
    const row = this.get(
      "SELECT * FROM gateways WHERE id=? AND secret_hash=? AND simulated=0",
      id,
      digest(secret),
    );
    return row ? { id: row.id, name: row.name } : null;
  }
  resetGateway({ user, id, secret }) {
    this.admin(user);
    check(
      this.get("SELECT id FROM gateways WHERE id=?", id),
      "Gateway not found",
      404,
    );
    this.run(
      "UPDATE gateways SET secret_hash=? WHERE id=?",
      digest(secret),
      id,
    );
    this.audit(user, "rotate_gateway_key", id);
    return { registration: `SAMA:${id}:${secret}` };
  }
  sensorList({ user }) {
    const rows = this.all(
      `SELECT s.*,g.name gateway_name,g.simulated,u.username owner_name,a.id assignment_id,a.plant_id,p.name plant_name FROM sensors s JOIN gateways g ON g.id=s.gateway_id LEFT JOIN users u ON u.id=s.owner_id LEFT JOIN assignments a ON a.sensor_id=s.id AND a.ended_at IS NULL LEFT JOIN plants p ON p.id=a.plant_id ${user.role === "admin" ? "" : "WHERE s.owner_id=?"} ORDER BY s.name`,
      ...(user.role === "admin" ? [] : [user.id]),
    );
    return rows.map(unpack);
  }
  collectors() {
    return this.all(
      "SELECT s.*,g.simulated,a.id assignment_id,a.plant_id FROM sensors s JOIN gateways g ON g.id=s.gateway_id JOIN users u ON u.id=s.owner_id AND u.active=1 LEFT JOIN assignments a ON a.sensor_id=s.id AND a.ended_at IS NULL",
    ).map(unpack);
  }
  createSensor({ user, input }) {
    this.admin(user);
    check(
      this.get("SELECT id FROM gateways WHERE id=?", input.gatewayId),
      "Gateway not found",
    );
    const id = randomUUID(),
      owner = input.ownerId ? this.owner(user, input.ownerId) : null;
    const metrics = input.metrics ?? metricKeys;
    check(
      Array.isArray(metrics) &&
        metrics.length &&
        new Set(metrics).size === metrics.length &&
        metrics.every((k) => metricKeys.includes(k)),
      "Invalid metrics",
    );
    this.run(
      "INSERT INTO sensors(id,gateway_id,owner_id,name,address,metrics,interval_ms,created_at,profile) VALUES(?,?,?,?,?,?,?,?,?)",
      id,
      input.gatewayId,
      owner,
      text(input.name, 80, true),
      integer(input.address ?? 2, 1, 247),
      json(metrics),
      integer(input.intervalMs ?? 5000, 1000, 3600000),
      now(),
      json(this.sensorProfile(input.profile)),
    );
    this.audit(user, "create_sensor", id, { ownerId: owner });
    return this.owned("sensors", id, user);
  }
  sensorProfile(input = {}) {
    return {
      model: text(input.model, 120),
      serialNumber: text(input.serialNumber, 120),
      calibrationDate: text(input.calibrationDate, 40),
      calibrationNotes: text(input.calibrationNotes, 1000),
    };
  }
  endSensor(id, reason) {
    const stamp = now();
    for (const r of this.all(
      "SELECT * FROM recordings WHERE sensor_id=? AND status IN ('scheduled','running')",
      id,
    )) {
      this.run(
        "UPDATE recordings SET status='stopped',stopped_at=? WHERE id=?",
        stamp,
        r.id,
      );
      this.event(r.owner_id, id, r.id, reason, {});
    }
    this.run(
      "UPDATE assignments SET ended_at=? WHERE sensor_id=? AND ended_at IS NULL",
      stamp,
      id,
    );
  }
  transferSensor({ user, id, input }) {
    this.admin(user);
    const s = this.owned("sensors", id, user),
      owner = input.ownerId ? this.owner(user, input.ownerId) : null;
    return this.tx(() => {
      this.endSensor(id, "device_transferred");
      this.run("UPDATE sensors SET owner_id=? WHERE id=?", owner, id);
      this.audit(
        user,
        "transfer_sensor",
        id,
        { from: s.owner_id, to: owner },
        s.owner_id,
      );
      return this.owned("sensors", id, user);
    });
  }
  configureSensor({ user, id, input }) {
    const s = this.owned("sensors", id, user);
    const interval = integer(input.intervalMs ?? s.interval_ms, 1000, 3600000);
    const running = this.get(
      "SELECT min(interval_ms) n FROM recordings WHERE sensor_id=? AND status IN ('scheduled','running')",
      id,
    ).n;
    check(
      !running || interval <= running,
      "Polling interval exceeds an active recording interval",
    );
    this.run(
      "UPDATE sensors SET name=?,interval_ms=?,profile=? WHERE id=?",
      text(input.name ?? s.name, 80, true),
      interval,
      json(
        input.profile && user.role === "admin"
          ? this.sensorProfile(input.profile)
          : s.profile,
      ),
      id,
    );
    this.audit(
      user,
      "configure_sensor",
      id,
      { intervalMs: interval },
      s.owner_id,
    );
    return this.owned("sensors", id, user);
  }
  plantList({ user, input = {} }) {
    const owner =
      input.ownerId && user.role === "admin"
        ? input.ownerId
        : user.role === "admin"
          ? null
          : user.id;
    const clauses = [],
      args = [];
    if (owner) {
      clauses.push("owner_id=?");
      args.push(owner);
    }
    if (!input.archived) clauses.push("archived=0");
    if (input.q) {
      clauses.push("(name LIKE ? OR code LIKE ?)");
      args.push(`%${text(input.q, 100)}%`, `%${text(input.q, 100)}%`);
    }
    const limit = integer(input.limit ?? 60, 1, 100),
      offset = integer(input.offset ?? 0, 0, 100000);
    const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
    return {
      plants: this.all(
        `SELECT *, (SELECT id FROM assets WHERE plant_id=plants.id AND status='ready' ORDER BY CASE WHEN category='profile' THEN 0 ELSE 1 END,created_at DESC LIMIT 1) cover_asset_id FROM plants ${where} ORDER BY name,id LIMIT ? OFFSET ?`,
        ...args,
        limit,
        offset,
      ).map(unpack),
      total: this.get(`SELECT count(*) n FROM plants ${where}`, ...args).n,
    };
  }
  createPlant({ user, input }) {
    const id = randomUUID(),
      owner = this.owner(user, input.ownerId),
      stamp = now(),
      profile = this.profile(input.profile);
    this.run(
      "INSERT INTO plants VALUES(?,?,?,?,?,0,1,?,?)",
      id,
      owner,
      text(input.name, 100, true),
      text(input.code, 60),
      json(profile),
      stamp,
      stamp,
    );
    this.audit(user, "create_plant", id, {}, owner);
    return this.owned("plants", id, user);
  }
  profile(input = {}) {
    check(
      input && typeof input === "object" && !Array.isArray(input),
      "Invalid profile",
    );
    const out = {};
    for (const k of [
      "species",
      "cultivar",
      "substrate",
      "pot",
      "location",
      "plantedAt",
      "notes",
      "growthStage",
    ])
      out[k] = text(input[k], k === "notes" ? 4000 : 250);
    return out;
  }
  updatePlant({ user, id, input }) {
    const p = this.owned("plants", id, user);
    return this.tx(() => {
      this.run(
        "INSERT INTO plant_revisions VALUES(?,?,?,?,?,?)",
        randomUUID(),
        id,
        p.owner_id,
        p.revision,
        json(p),
        now(),
      );
      if (input.archived)
        for (const a of this.all(
          "SELECT sensor_id FROM assignments WHERE plant_id=? AND ended_at IS NULL",
          id,
        ))
          this.endSensor(a.sensor_id, "plant_archived");
      this.run(
        "UPDATE plants SET name=?,code=?,profile=?,archived=?,revision=revision+1,updated_at=? WHERE id=?",
        text(input.name ?? p.name, 100, true),
        text(input.code ?? p.code, 60),
        json(input.profile ? this.profile(input.profile) : p.profile),
        input.archived === undefined ? p.archived : input.archived ? 1 : 0,
        now(),
        id,
      );
      this.audit(user, "update_plant", id, {}, p.owner_id);
      return this.owned("plants", id, user);
    });
  }
  plantDetail({ user, id }) {
    const plant = this.owned("plants", id, user);
    return {
      plant,
      assignments: this.all(
        "SELECT a.*,s.name sensor_name FROM assignments a JOIN sensors s ON s.id=a.sensor_id WHERE a.plant_id=? ORDER BY started_at DESC LIMIT 300",
        id,
      ),
      observations: this.all(
        "SELECT * FROM observations WHERE plant_id=? ORDER BY happened_at DESC LIMIT 300",
        id,
      ).map(unpack),
      assets: this.all(
        "SELECT * FROM assets WHERE plant_id=? AND status='ready' ORDER BY created_at DESC LIMIT 300",
        id,
      ).map(unpack),
      revisions: this.all(
        "SELECT revision,created_at FROM plant_revisions WHERE plant_id=? ORDER BY revision DESC",
        id,
      ),
    };
  }
  bindSensor({ user, id, input }) {
    const s = this.owned("sensors", id, user);
    if (!input.plantId)
      return this.tx(() => {
        this.endSensor(id, "sensor_unbound");
        this.audit(user, "unbind_sensor", id, {}, s.owner_id);
        return { unbound: true };
      });
    const p = this.owned("plants", input.plantId, user);
    check(
      s.owner_id && p.owner_id === s.owner_id && !p.archived,
      "Plant and sensor must have the same active owner",
    );
    return this.tx(() => {
      this.endSensor(id, "plant_changed");
      const aid = randomUUID();
      this.run(
        "INSERT INTO assignments VALUES(?,?,?,?,?,NULL)",
        aid,
        id,
        p.id,
        p.owner_id,
        now(),
      );
      this.audit(user, "bind_sensor", id, { plantId: p.id }, p.owner_id);
      return { id: aid, sensorId: id, plantId: p.id };
    });
  }
  recordingList({ user, input = {} }) {
    const clauses = [],
      args = [];
    if (user.role !== "admin") {
      clauses.push("r.owner_id=?");
      args.push(user.id);
    }
    if (input.plantId) {
      this.owned("plants", input.plantId, user);
      clauses.push("r.plant_id=?");
      args.push(input.plantId);
    }
    return this.all(
      `SELECT r.*,p.name plant_name,s.name sensor_name FROM recordings r JOIN plants p ON p.id=r.plant_id JOIN sensors s ON s.id=r.sensor_id ${clauses.length ? "WHERE " + clauses.join(" AND ") : ""} ORDER BY r.created_at DESC LIMIT 300`,
      ...args,
    ).map(unpack);
  }
  createRecording({ user, input, key = null }) {
    const s = this.owned("sensors", input.sensorId, user),
      a = this.get(
        "SELECT * FROM assignments WHERE sensor_id=? AND ended_at IS NULL",
        s.id,
      );
    check(a && a.owner_id === s.owner_id, "Bind this sensor to a plant first");
    const p = this.owned("plants", a.plant_id, user);
    check(!p.archived, "Plant is archived");
    const start = date(input.startAt, now()),
      end = date(input.endAt);
    check(!end || end > start, "End must be after start");
    check(
      !input.startAt || Date.parse(start) > Date.now() - 10000,
      "Start time must not be in the past",
    );
    const interval = integer(input.intervalMs ?? 60000, 1000, 86400000);
    check(
      interval >= s.interval_ms,
      "Recording interval must be at least the polling interval",
    );
    const stable = integer(input.stabilizeSeconds ?? 0, 0, 3600),
      settings = {
        stabilizeSeconds: stable,
        notes: text(input.notes, 2000),
        oneShot: !!input.oneShot,
        pollIntervalMs: s.interval_ms,
        metricDefinitions: METRICS,
        parserVersion: "modbus-v1",
        sensorSnapshot: {
          id: s.id,
          name: s.name,
          gatewayId: s.gateway_id,
          address: s.address,
          metrics: s.metrics,
          profile: s.profile,
        },
      };
    const fingerprint = digest(json({ sensor: s.id, plant: p.id, input }));
    if (key) {
      check(/^[A-Za-z0-9_-]{8,100}$/.test(key), "Invalid idempotency key");
      const previous = this.get(
        "SELECT * FROM idempotency WHERE owner_id=? AND key=?",
        p.owner_id,
        key,
      );
      if (previous) {
        check(
          previous.fingerprint === fingerprint,
          "Idempotency key used for another request",
          409,
        );
        return {
          ...this.owned("recordings", previous.recording_id, user),
          reused: true,
          sampleId: previous.sample_id,
        };
      }
    }
    if (input.oneShot) {
      const active = this.get(
        "SELECT * FROM recordings WHERE sensor_id=? AND assignment_id=? AND status='running' AND start_at<=? AND (end_at IS NULL OR end_at>?)",
        s.id,
        a.id,
        now(),
        now(),
      );
      if (active) {
        if (key)
          this.run(
            "INSERT INTO idempotency VALUES(?,?,?,?,NULL)",
            p.owner_id,
            key,
            fingerprint,
            active.id,
          );
        return { ...unpack(active), manualCapture: true };
      }
    }
    const effective = new Date(Date.parse(start) + stable * 1000).toISOString();
    check(!end || end > effective, "End is before stabilization finishes");
    check(
      !this.get(
        "SELECT id FROM recordings WHERE sensor_id=? AND status IN ('scheduled','running') AND start_at < ? AND COALESCE(end_at,'9999') > ?",
        s.id,
        end ?? "9999",
        start,
      ),
      "Overlapping recording for this sensor",
      409,
    );
    const id = randomUUID(),
      stamp = now();
    this.run(
      "INSERT INTO recordings(id,owner_id,sensor_id,plant_id,assignment_id,name,start_at,end_at,status,interval_ms,full_resolution,settings,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id,
      p.owner_id,
      s.id,
      p.id,
      a.id,
      text(input.name || "Observation", 100, true),
      effective,
      end,
      effective > stamp ? "scheduled" : "running",
      interval,
      input.fullResolution ? 1 : 0,
      json(settings),
      stamp,
    );
    if (key)
      this.run(
        "INSERT INTO idempotency VALUES(?,?,?,?,NULL)",
        p.owner_id,
        key,
        fingerprint,
        id,
      );
    this.event(p.owner_id, s.id, id, "recording_created", {
      startAt: effective,
      endAt: end,
    });
    this.audit(user, "create_recording", id, {}, p.owner_id);
    return this.owned("recordings", id, user);
  }
  stopRecording({ user, id }) {
    const r = this.owned("recordings", id, user);
    this.run(
      "UPDATE recordings SET status='stopped',stopped_at=? WHERE id=? AND status IN ('scheduled','running')",
      now(),
      id,
    );
    this.event(r.owner_id, r.sensor_id, id, "recording_stopped", {});
    return this.owned("recordings", id, user);
  }
  tick({ stamp = now() } = {}) {
    this.run(
      "UPDATE recordings SET status='completed',stopped_at=end_at WHERE status IN ('scheduled','running') AND end_at IS NOT NULL AND end_at<=?",
      stamp,
    );
    this.run(
      "UPDATE recordings SET status='running' WHERE status='scheduled' AND start_at<=? AND (end_at IS NULL OR end_at>?)",
      stamp,
      stamp,
    );
    return this.all("SELECT * FROM recordings WHERE status='running'").map(
      unpack,
    );
  }
  saveSample({
    sample,
    sensor,
    force = false,
    manualKey = null,
    recordingId = null,
  }) {
    // Ownership/assignment are captured before the hardware read, then revalidated at commit.
    const current = this.get(
      "SELECT owner_id FROM sensors WHERE id=?",
      sensor.id,
    );
    if (!current || current.owner_id !== sensor.owner_id) return null;
    const a = this.get(
      "SELECT * FROM assignments WHERE id=? AND ended_at IS NULL",
      sensor.assignment_id ?? "",
    );
    if (!a || a.owner_id !== sensor.owner_id) return null;
    const r = this.get(
      "SELECT * FROM recordings WHERE sensor_id=? AND assignment_id=? AND status='running' AND start_at<=? AND (end_at IS NULL OR end_at>?) AND (json_extract(settings,'$.oneShot')=0 OR id=?)",
      sensor.id,
      a.id,
      sample.startedAt,
      sample.timestamp,
      recordingId ?? "",
    );
    if (!r) return null;
    const slot = Math.floor(
        (Date.parse(sample.timestamp) - Date.parse(r.start_at)) / r.interval_ms,
      ),
      selected = force || slot > r.last_slot;
    if (!selected && !r.full_resolution) return null;
    const record = {
      ...sample,
      ownerId: r.owner_id,
      plantId: r.plant_id,
      sensorId: sensor.id,
      gatewayId: sensor.gateway_id,
      assignmentId: a.id,
      recordingId: r.id,
      selected,
      captureReason: force ? "manual" : "scheduled",
      metricDefinitions: METRICS.filter((m) => sensor.metrics.includes(m.key)),
      parserVersion: "modbus-v1",
      sensorProfile: sensor.profile,
      calibrationStatus: sensor.profile?.calibrationDate
        ? "documented_not_verified"
        : "unknown",
    };
    return this.tx(() => {
      const res = this.run(
        "INSERT OR IGNORE INTO samples(id,owner_id,plant_id,sensor_id,gateway_id,assignment_id,recording_id,timestamp,stored_at,source,selected,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        sample.id,
        r.owner_id,
        r.plant_id,
        sensor.id,
        sensor.gateway_id,
        a.id,
        r.id,
        sample.timestamp,
        now(),
        sample.source,
        selected ? 1 : 0,
        json(record),
      );
      if (!res.changes) return null;
      this.run(
        "UPDATE recordings SET count=count+1,selected_count=selected_count+?,last_slot=MAX(last_slot,?) WHERE id=?",
        selected ? 1 : 0,
        slot,
        r.id,
      );
      if (manualKey)
        this.run(
          "UPDATE idempotency SET sample_id=? WHERE recording_id=? AND owner_id=? AND key=? AND sample_id IS NULL",
          sample.id,
          r.id,
          r.owner_id,
          manualKey,
        );
      if (parse(r.settings).oneShot)
        this.run(
          "UPDATE recordings SET status='completed',stopped_at=? WHERE id=?",
          sample.timestamp,
          r.id,
        );
      return { ...record, seq: Number(res.lastInsertRowid) };
    });
  }
  failRead({ sensor, code, message }) {
    this.event(sensor.owner_id, sensor.id, null, "read_error", {
      code,
      message,
    });
  }
  storageFailure({ sensorId, ownerId, message }) {
    this.run(
      "UPDATE recordings SET status='failed',stopped_at=? WHERE sensor_id=? AND status='running'",
      now(),
      sensorId,
    );
    this.event(ownerId, sensorId, null, "storage_error", { message });
  }
  sampleFilter(user, input = {}, alias = "") {
    if (user.role !== "admin" && input.ownerId)
      check(input.ownerId === user.id, "Resource not found", 404);
    const clauses = [],
      args = [],
      p = alias ? alias + "." : "";
    if (user.role !== "admin") {
      clauses.push(`${p}owner_id=?`);
      args.push(user.id);
    } else if (input.ownerId) {
      clauses.push(`${p}owner_id=?`);
      args.push(input.ownerId);
    }
    for (const [key, column, table] of [
      ["plantId", "plant_id", "plants"],
      ["sensorId", "sensor_id", "sensors"],
      ["recordingId", "recording_id", "recordings"],
    ])
      if (input[key]) {
        if (key === "sensorId" && user.role !== "admin")
          check(
            this.get(
              "SELECT id FROM sensors WHERE id=? AND owner_id=?",
              input[key],
              user.id,
            ) ||
              this.get(
                "SELECT id FROM recordings WHERE sensor_id=? AND owner_id=? LIMIT 1",
                input[key],
                user.id,
              ),
            "Resource not found",
            404,
          );
        else this.owned(table, input[key], user);
        clauses.push(`${p}${column}=?`);
        args.push(input[key]);
      }
    if (input.since) {
      clauses.push(`${p}timestamp>=?`);
      args.push(date(input.since));
    }
    if (input.until) {
      clauses.push(`${p}timestamp<=?`);
      args.push(date(input.until));
    }
    if (input.selectedOnly === true || input.selectedOnly === "true")
      clauses.push(`${p}selected=1`);
    return { clauses, args };
  }
  samplePage({ user, input = {} }) {
    const { clauses, args } = this.sampleFilter(user, input);
    const reverse = input.latest === true || input.latest === "true",
      cursor = integer(
        reverse
          ? (input.before ?? Number.MAX_SAFE_INTEGER)
          : (input.after ?? 0),
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      limit = integer(input.limit ?? 300, 1, 1000);
    clauses.push(reverse ? "seq<?" : "seq>?");
    args.push(cursor);
    if (input.unarchivedOnly) clauses.push("segment_id IS NULL");
    if (input.maxSeq !== undefined) {
      clauses.push("seq<=?");
      args.push(integer(input.maxSeq, 0, Number.MAX_SAFE_INTEGER));
    }
    const rows = this.all(
      `SELECT seq,payload,segment_id FROM samples WHERE ${clauses.join(" AND ")} ORDER BY seq ${reverse ? "DESC" : "ASC"} LIMIT ?`,
      ...args,
      limit,
    );
    const next = rows.length === limit ? rows.at(-1).seq : null;
    if (reverse) rows.reverse();
    return {
      samples: rows.map((r) => ({ ...parse(r.payload), seq: r.seq })),
      next,
    };
  }
  maxSeq() {
    return this.get(
      "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='samples'),0) n",
    ).n;
  }
  storageUsage() {
    const pages = this.get("PRAGMA page_count").page_count,
      free = this.get("PRAGMA freelist_count").freelist_count,
      size = this.get("PRAGMA page_size").page_size;
    return { activeBytes: (pages - free) * size, fileBytes: pages * size };
  }
  maintenanceState({ key, value }) {
    check(
      ["lastBackup", "lastCleanup"].includes(key),
      "Invalid maintenance key",
    );
    if (value !== undefined)
      this.run(
        "INSERT INTO service_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        key,
        String(value),
      );
    return (
      this.get("SELECT value FROM service_state WHERE key=?", key)?.value ??
      null
    );
  }
  expiredObjects() {
    return {
      jobs: this.all(
        "SELECT * FROM jobs WHERE status='ready' AND expires_at<? LIMIT 20",
        now(),
      ).map(unpack),
      assets: this.all(
        "SELECT * FROM assets WHERE status='failed' OR (status='pending' AND created_at<?) LIMIT 20",
        new Date(Date.now() - 3600000).toISOString(),
      ).map(unpack),
    };
  }
  cleanupDone({ jobId = null, assetId = null }) {
    if (jobId)
      this.run(
        "UPDATE jobs SET status='expired',result=NULL WHERE id=? AND status='ready'",
        jobId,
      );
    if (assetId)
      this.run(
        "UPDATE assets SET status='cleaned' WHERE id=? AND status IN ('pending','failed')",
        assetId,
      );
  }
  findSample({ user, id, plantId }) {
    let row =
      this.get(
        "SELECT owner_id,plant_id,payload FROM samples WHERE id=?",
        id,
      ) ||
      this.get(
        "SELECT owner_id,plant_id,payload FROM sample_anchors WHERE id=?",
        id,
      );
    check(
      row &&
        (row.owner_id === user.id || user.role === "admin") &&
        (!plantId || row.plant_id === plantId),
      "Sample not found",
      404,
    );
    return parse(row.payload);
  }
  anchor({ user, sample }) {
    check(
      sample.ownerId === user.id || user.role === "admin",
      "Forbidden",
      403,
    );
    this.run(
      "INSERT OR IGNORE INTO sample_anchors VALUES(?,?,?,?,?)",
      sample.id,
      sample.ownerId,
      sample.plantId,
      sample.timestamp,
      json(sample),
    );
  }
  segments({ user, input = {} }) {
    const { clauses, args } = this.sampleFilter(user, {
      ...input,
      selectedOnly: false,
    });
    const mapped = clauses.map((c) =>
      c
        .replace("timestamp>=", "last_at>=")
        .replace("timestamp<=", "first_at<="),
    );
    return this.all(
      `SELECT * FROM segments ${mapped.length ? "WHERE " + mapped.join(" AND ") : ""} ORDER BY first_seq`,
      ...args,
    );
  }
  archiveBatch({ limit = 500 }) {
    const first = this.get(
      "SELECT * FROM samples WHERE segment_id IS NULL ORDER BY seq LIMIT 1",
    );
    if (!first) return null;
    const rows = this.all(
      "SELECT seq,payload FROM samples WHERE segment_id IS NULL AND owner_id=? AND COALESCE(recording_id,'')=COALESCE(?,'') ORDER BY seq LIMIT ?",
      first.owner_id,
      first.recording_id,
      integer(limit, 1, 1000),
    );
    return {
      ownerId: first.owner_id,
      plantId: first.plant_id,
      sensorId: first.sensor_id,
      recordingId: first.recording_id,
      rows: rows.map((r) => ({ ...parse(r.payload), seq: r.seq })),
    };
  }
  commitSegment({ input }) {
    return this.tx(() => {
      const {
        id,
        ownerId,
        plantId,
        sensorId,
        recordingId,
        key,
        rows,
        sha256,
        bytes,
      } = input;
      check(rows.length > 0 && rows.length <= 1000, "Invalid archive");
      this.run(
        "INSERT INTO segments VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        id,
        ownerId,
        plantId,
        sensorId,
        recordingId,
        key,
        rows[0].seq,
        rows.at(-1).seq,
        rows.reduce(
          (v, r) => (r.timestamp < v ? r.timestamp : v),
          rows[0].timestamp,
        ),
        rows.reduce(
          (v, r) => (r.timestamp > v ? r.timestamp : v),
          rows[0].timestamp,
        ),
        rows.length,
        sha256,
        bytes,
        now(),
      );
      for (const row of rows)
        this.run(
          "UPDATE samples SET segment_id=? WHERE seq=? AND owner_id=?",
          id,
          row.seq,
          ownerId,
        );
      return { id };
    });
  }
  prune({ before, maxRows = 2000 }) {
    const result = this.run(
      "DELETE FROM samples WHERE seq IN (SELECT seq FROM samples WHERE segment_id IS NOT NULL AND timestamp<? ORDER BY seq LIMIT ?)",
      date(before),
      integer(maxRows, 1, 10000),
    );
    return { removed: result.changes };
  }
  observation({ user, input }) {
    const p = this.owned("plants", input.plantId, user),
      kind = text(input.kind, 40, true);
    check(
      [
        "status",
        "watering",
        "fertilizing",
        "repotting",
        "moving",
        "note",
      ].includes(kind),
      "Invalid observation kind",
    );
    const id = randomUUID(),
      payload = {
        notes: text(input.notes, 4000),
        amount:
          input.amount === undefined || input.amount === ""
            ? null
            : Number(input.amount),
        unit: text(input.unit, 40),
        growthStage: text(input.growthStage, 200),
      };
    check(
      payload.amount === null ||
        (Number.isFinite(payload.amount) && payload.amount >= 0),
      "Invalid amount",
    );
    this.run(
      "INSERT INTO observations VALUES(?,?,?,?,?,?,?)",
      id,
      p.owner_id,
      p.id,
      kind,
      date(input.happenedAt, now()),
      json(payload),
      now(),
    );
    return this.owned("observations", id, user);
  }
  createAsset({ user, input, sample = null }) {
    const p = this.owned("plants", input.plantId, user);
    check(
      this.get(
        "SELECT count(*) n FROM assets WHERE owner_id=? AND status='pending'",
        p.owner_id,
      ).n < 10,
      "Too many unfinished photo uploads",
      429,
    );
    check(
      this.get(
        "SELECT COALESCE(sum(bytes),0) n FROM assets WHERE owner_id=? AND status='ready'",
        p.owner_id,
      ).n <
        2 * 1024 ** 3,
      "Photo quota of 2 GiB reached",
      413,
    );
    check(
      ["profile", "status", "sample"].includes(input.category),
      "Invalid photo category",
    );
    if (input.category === "sample")
      check(
        sample && sample.plantId === p.id && sample.ownerId === p.owner_id,
        "Sample photo must reference a sample of this plant",
      );
    if (input.recordingId) {
      const r = this.owned("recordings", input.recordingId, user);
      check(r.plant_id === p.id, "Recording belongs to a different plant");
    }
    if (input.observationId) {
      const o = this.owned("observations", input.observationId, user);
      check(o.plant_id === p.id, "Observation belongs to a different plant");
    }
    const id = randomUUID(),
      key = `soil-studio/media/${p.owner_id}/${id}.webp`,
      thumb = `soil-studio/media/${p.owner_id}/${id}-thumb.webp`;
    this.run(
      "INSERT INTO assets(id,owner_id,plant_id,sample_id,recording_id,observation_id,category,object_key,thumb_key,content_type,caption,captured_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id,
      p.owner_id,
      p.id,
      sample?.id ?? null,
      input.recordingId ?? null,
      input.observationId ?? null,
      input.category,
      key,
      thumb,
      "image/webp",
      text(input.caption, 1000),
      date(input.capturedAt),
      now(),
    );
    if (sample) this.anchor({ user, sample });
    return this.owned("assets", id, user);
  }
  readyAsset({ user, id, input }) {
    const a = this.owned("assets", id, user);
    this.run(
      "UPDATE assets SET status='ready',bytes=?,sha256=? WHERE id=?",
      input.bytes,
      input.sha256,
      id,
    );
    return this.owned("assets", id, user);
  }
  failAsset({ id }) {
    this.run(
      "UPDATE assets SET status='failed' WHERE id=? AND status='pending'",
      id,
    );
  }
  createJob({ user, kind = "export", input = {} }) {
    this.sampleFilter(user, input);
    check(["export", "history", "context"].includes(kind), "Invalid job");
    check(
      this.get(
        "SELECT count(*) n FROM jobs WHERE owner_id=? AND status IN ('queued','running')",
        user.id,
      ).n < 3,
      "Too many pending jobs",
      429,
    );
    check(
      ["csv", "ndjson", "zip", undefined].includes(input.format),
      "Invalid export format",
    );
    const id = randomUUID(),
      filter = {
        ...input,
        maxSeq:
          input.maxSeq === undefined
            ? this.maxSeq()
            : Math.min(
                this.maxSeq(),
                integer(input.maxSeq, 0, Number.MAX_SAFE_INTEGER),
              ),
        until: date(input.until, now()),
      };
    if (filter.since) date(filter.since);
    check(
      !filter.since || date(filter.since) <= filter.until,
      "Invalid time range",
    );
    this.run(
      "INSERT INTO jobs(id,owner_id,kind,status,filter,created_at) VALUES(?,?,?,'queued',?,?)",
      id,
      user.id,
      kind,
      json(filter),
      now(),
    );
    return this.owned("jobs", id, user);
  }
  jobs({ user }) {
    return this.all(
      `SELECT * FROM jobs ${user.role === "admin" ? "" : "WHERE owner_id=?"} ORDER BY created_at DESC LIMIT 100`,
      ...(user.role === "admin" ? [] : [user.id]),
    ).map(unpack);
  }
  nextJob() {
    const row = this.get(
      "SELECT j.*,u.role,u.active FROM jobs j JOIN users u ON u.id=j.owner_id WHERE j.status='queued' ORDER BY j.created_at LIMIT 1",
    );
    if (!row) return null;
    if (!row.active) {
      this.run("UPDATE jobs SET status='cancelled' WHERE id=?", row.id);
      return null;
    }
    this.run("UPDATE jobs SET status='running' WHERE id=?", row.id);
    return unpack(row);
  }
  updateJob({ id, status, progress = 0, result = null, error = null }) {
    const job = this.get("SELECT status FROM jobs WHERE id=?", id);
    if (!job || job.status === "cancelled") return { cancelled: true };
    this.run(
      "UPDATE jobs SET status=?,progress=?,result=?,error=?,finished_at=?,expires_at=? WHERE id=?",
      status,
      progress,
      result ? json(result) : null,
      error,
      status === "ready" || status === "failed" ? now() : null,
      status === "ready"
        ? new Date(Date.now() + 7 * 86400000).toISOString()
        : null,
      id,
    );
    return { cancelled: false };
  }
  cancelJob({ user, id }) {
    this.owned("jobs", id, user);
    this.run(
      "UPDATE jobs SET status='cancelled' WHERE id=? AND status IN ('queued','running')",
      id,
    );
    return this.owned("jobs", id, user);
  }
  snapshot({ user, plantId, payload }) {
    const p = this.owned("plants", plantId, user),
      id = randomUUID();
    this.run(
      "INSERT INTO snapshots VALUES(?,?,?,?,?)",
      id,
      p.owner_id,
      p.id,
      json(payload),
      now(),
    );
    return { id, ...payload };
  }
  contextBase({ user, plantId }) {
    const detail = this.plantDetail({ user, id: plantId });
    return {
      ...detail,
      recordings: this.recordingList({ user, input: { plantId } }),
      sensors: this.sensorList({ user }).filter((s) =>
        detail.assignments.some((a) => a.sensor_id === s.id),
      ),
      revisions: this.all(
        "SELECT * FROM plant_revisions WHERE plant_id=? ORDER BY revision",
        plantId,
      ).map(unpack),
    };
  }
  auditList({ user }) {
    this.admin(user);
    return this.all("SELECT * FROM audit ORDER BY id DESC LIMIT 200").map(
      unpack,
    );
  }
  events({ user, input = {} }) {
    const args = [],
      clauses = [];
    if (user.role !== "admin") {
      clauses.push("owner_id=?");
      args.push(user.id);
    }
    if (input.sensorId) {
      this.owned("sensors", input.sensorId, user);
      clauses.push("sensor_id=?");
      args.push(input.sensorId);
    }
    return this.all(
      `SELECT * FROM service_events ${clauses.length ? "WHERE " + clauses.join(" AND ") : ""} ORDER BY id DESC LIMIT 100`,
      ...args,
    ).map(unpack);
  }
  stats({ user }) {
    const owner = user.role === "admin" ? null : user.id,
      where = owner ? " WHERE owner_id=?" : "",
      args = owner ? [owner] : [];
    return {
      plants: this.get(`SELECT count(*) n FROM plants${where}`, ...args).n,
      samplesHot: this.get(`SELECT count(*) n FROM samples${where}`, ...args).n,
      archivedSamples: this.get(
        `SELECT COALESCE(sum(count),0) n FROM segments${where}`,
        ...args,
      ).n,
      sqliteVersion: this.get("SELECT sqlite_version() v").v,
    };
  }
  importLegacy({ user, rows }) {
    this.admin(user);
    let imported = 0;
    this.tx(() => {
      for (const row of rows) {
        check(row.id && row.timestamp && row.values, "Malformed legacy sample");
        const payload = {
          ...row,
          ownerId: user.id,
          plantId: null,
          sensorId: null,
          gatewayId: null,
          recordingId: null,
          legacyDeviceId: row.deviceId,
          provenance: "legacy_unassigned",
          selected: true,
        };
        const r = this.run(
          "INSERT OR IGNORE INTO samples(id,owner_id,timestamp,stored_at,source,selected,payload) VALUES(?,?,?,?,?,?,?)",
          row.id,
          user.id,
          date(row.timestamp),
          now(),
          row.source ?? "unknown",
          1,
          json(payload),
        );
        imported += r.changes;
      }
      this.audit(user, "import_legacy", null, { imported });
    });
    return { imported };
  }
  async backup({ destination }) {
    await backup(this.db, destination);
    return { path: destination };
  }
  close() {
    this.db.close();
  }
}

export class Database {
  constructor(directory) {
    this.worker = new Worker(new URL(import.meta.url), {
      workerData: { directory },
    });
    this.pending = new Map();
    this.serial = 0;
    this.ready = new Promise((resolve, reject) => {
      this.worker.once("online", resolve);
      this.worker.once("error", reject);
    });
    this.worker.on("message", (message) => {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) {
        const e = new AppError(
          message.error.message,
          message.error.status,
          message.error.code,
        );
        entry.reject(e);
      } else entry.resolve(message.value);
    });
    this.worker.on("error", (e) => {
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
    });
  }
  async call(method, args = {}) {
    await this.ready;
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method, args });
    });
  }
  async close() {
    await this.call("close");
    await this.worker.terminate();
  }
}
if (!isMainThread) {
  let warehouse;
  try {
    warehouse = new Warehouse(workerData.directory);
  } catch (e) {
    throw e;
  }
  parentPort.on("message", async (message) => {
    try {
      check(
        typeof warehouse[message.method] === "function" &&
          !["get", "all", "run", "tx", "owned", "owner", "admin"].includes(
            message.method,
          ),
        "Invalid operation",
      );
      const value = await warehouse[message.method](message.args);
      parentPort.postMessage({ id: message.id, value });
    } catch (e) {
      parentPort.postMessage({
        id: message.id,
        error: {
          message: e.code?.startsWith("ERR_SQLITE")
            ? "Database constraint rejected the operation"
            : e.message,
          status: e.status ?? (e.code?.startsWith("ERR_SQLITE") ? 409 : 500),
          code: e.code ?? "ERROR",
        },
      });
    }
  });
}
