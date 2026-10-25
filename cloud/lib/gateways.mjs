import net from "node:net";
import { randomUUID } from "node:crypto";
import {
  DeviceError,
  extractFrame,
  parseResponse,
  readRequest,
  decodeRegisters,
  METRICS,
  hex,
  withCrc,
} from "../../lib/modbus.mjs";
import { check, now } from "./common.mjs";

class GatewayLink {
  constructor(socket, hub) {
    this.socket = socket;
    this.hub = hub;
    this.buffer = Buffer.alloc(0);
    this.pending = null;
    this.id = null;
    this.identifying = false;
    this.closed = false;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10000);
    this.timer = setTimeout(() => {
      if (!this.id)
        this.close(
          new DeviceError("Registered gateway identity required", "IDENTITY"),
        );
    }, 5000);
    socket.on("data", (chunk) => this.data(chunk));
    socket.on("error", () =>
      this.close(new DeviceError("Gateway connection failed", "CONNECTION")),
    );
    socket.on("close", () => this.close());
  }
  async identify(match) {
    this.identifying = true;
    try {
      const gateway = await this.hub.db.call("gatewayIdentity", {
        id: match[1],
        secret: match[2],
      });
      check(gateway, "Unknown gateway identity", 403);
      if (this.closed) return;
      this.buffer = this.buffer.subarray(Buffer.byteLength(match[0]));
      this.id = gateway.id;
      clearTimeout(this.timer);
      this.hub.links
        .get(this.id)
        ?.close(new DeviceError("Gateway reconnected", "REPLACED"));
      this.hub.links.set(this.id, this);
    } catch {
      this.close(new DeviceError("Gateway identity rejected", "IDENTITY"));
    }
  }
  data(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > 8192)
      return this.close(new DeviceError("Gateway buffer exceeded", "OVERFLOW"));
    if (!this.id) {
      if (!this.identifying) {
        const match = this.buffer
          .toString("utf8")
          .match(/^SAMA:([A-Za-z0-9_-]{2,40}):([A-Za-z0-9_-]{43})(?:\r?\n)?/);
        if (match) this.identify(match);
        else if (this.buffer.length > 180)
          this.close(new DeviceError("Invalid registration", "IDENTITY"));
      }
      return;
    }
    if (!this.pending) return;
    const pending = this.pending,
      frame = extractFrame(this.buffer, pending.request);
    if (!frame) return;
    const offset = this.buffer.indexOf(frame);
    this.buffer = this.buffer.subarray(offset + frame.length);
    try {
      pending.finish(null, {
        result: parseResponse(frame, pending.request),
        frame,
      });
    } catch (e) {
      pending.finish(e);
    }
  }
  exchange(request) {
    check(!this.closed && this.id, "Gateway offline", 409);
    check(!this.pending, "Gateway busy", 409);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.close(new DeviceError("Sensor response timeout", "TIMEOUT")),
        4500,
      );
      const finish = (error, value) => {
        if (this.pending?.finish !== finish) return;
        clearTimeout(timer);
        this.pending = null;
        if (error) reject(error);
        else resolve(value);
      };
      this.pending = { request, finish };
      this.socket.write(request, (e) => {
        if (e) finish(e);
      });
    });
  }
  close(error = new DeviceError("Gateway disconnected", "CONNECTION")) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.pending?.finish(error);
    if (this.id && this.hub.links.get(this.id) === this)
      this.hub.links.delete(this.id);
    this.hub.sockets.delete(this);
    this.socket.destroy();
  }
}
export class GatewayHub {
  constructor(
    db,
    { onSample = async () => {}, onError = () => {}, onStatus = () => {} } = {},
  ) {
    this.db = db;
    this.onSample = onSample;
    this.onError = onError;
    this.links = new Map();
    this.sockets = new Set();
    this.queues = new Map();
    this.queueDepth = new Map();
    this.live = new Map();
    this.next = new Map();
    this.pending = new Set();
    this.lastOffline = new Map();
    this.onStatus = onStatus;
    this.statuses = new Map();
    this.closed = false;
    this.refreshing = false;
    this.server = net.createServer((socket) => {
      if (this.sockets.size >= 30) {
        socket.destroy();
        return;
      }
      const link = new GatewayLink(socket, this);
      this.sockets.add(link);
    });
  }
  lock(gatewayId, fn) {
    const depth = this.queueDepth.get(gatewayId) ?? 0;
    check(depth < 16, "Gateway request queue is full", 429);
    this.queueDepth.set(gatewayId, depth + 1);
    const previous = this.queues.get(gatewayId) ?? Promise.resolve(),
      result = previous
        .then(fn)
        .finally(() =>
          this.queueDepth.set(
            gatewayId,
            (this.queueDepth.get(gatewayId) ?? 1) - 1,
          ),
        );
    this.queues.set(
      gatewayId,
      result.catch(() => {}),
    );
    return result;
  }
  async listen(port, host) {
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, resolve);
    });
    this.port = this.server.address().port;
    this.timer = setInterval(() => this.tick().catch(this.onError), 250);
    this.timer.unref();
    return this.port;
  }
  async tick() {
    if (this.closed || this.refreshing) return;
    this.refreshing = true;
    try {
      await this.db.call("tick");
      const sensors = await this.db.call("collectors");
      for (const s of sensors) {
        const connected = !!s.simulated || !!this.links.get(s.gateway_id),
          signature = s.owner_id + ":" + connected;
        if (this.statuses.get(s.id) !== signature) {
          this.statuses.set(s.id, signature);
          await this.onStatus({ sensorId: s.id, connected }, s.owner_id);
        }
        if (this.pending.has(s.id) || (this.next.get(s.id) ?? 0) > Date.now())
          continue;
        this.next.set(s.id, Date.now() + s.interval_ms);
        this.pending.add(s.id);
        this.read(s)
          .catch((e) => {
            if (this.closed) return;
            if (Date.now() - (this.lastOffline.get(s.id) ?? 0) > 10000) {
              this.lastOffline.set(s.id, Date.now());
              this.db
                .call("failRead", {
                  sensor: s,
                  code: e.code ?? "OFFLINE",
                  message: e.message,
                })
                .catch(this.onError);
            }
          })
          .finally(() => this.pending.delete(s.id));
      }
    } finally {
      this.refreshing = false;
    }
  }
  async read(requested, flags = {}) {
    return this.lock(requested.gateway_id, async () => {
      check(!this.closed, "Collector stopped", 503);
      const s = (await this.db.call("collectors")).find(
        (v) => v.id === requested.id && v.owner_id === requested.owner_id,
      );
      check(s, "Sensor is no longer assigned to this account", 409);
      const startedAt = now();
      let registers = Array(8),
        frames = [];
      if (s.simulated) {
        const seconds = Date.now() / 1000;
        registers = [
          Math.round(250 + 20 * Math.sin(seconds / 120)),
          Math.round(380 + 30 * Math.sin(seconds / 80)),
          410,
          80,
          16,
          8,
          35,
          65,
        ];
        const frame = Buffer.alloc(19);
        frame[0] = s.address;
        frame[1] = 3;
        frame[2] = 16;
        registers.forEach((v, i) => frame.writeUInt16BE(v, 3 + i * 2));
        frames = [hex(withCrc(frame))];
      } else {
        const link = this.links.get(s.gateway_id);
        check(link && !link.closed, "Gateway offline", 409);
        const groups = [];
        for (const register of METRICS.filter((m) =>
          s.metrics.includes(m.key),
        ).map((m) => m.register)) {
          const last = groups.at(-1);
          if (last && last.start + last.count === register) last.count++;
          else groups.push({ start: register, count: 1 });
        }
        for (const group of groups) {
          const { result, frame } = await link.exchange(
            readRequest(s.address, group.start, group.count),
          );
          result.forEach((v, i) => (registers[group.start + i] = v));
          frames.push(hex(frame));
        }
      }
      const sample = {
        id: randomUUID(),
        timestamp: now(),
        startedAt,
        source: s.simulated ? "demo" : "hardware",
        address: s.address,
        ...decodeRegisters(registers, 0, s.metrics),
        registers: registers.map((v) => v ?? null),
        frames,
        sensorId: s.id,
        gatewayId: s.gateway_id,
        ownerId: s.owner_id,
        plantId: s.plant_id ?? null,
      };
      this.live.set(s.id, sample);
      let saved = null;
      try {
        saved = await this.onSample(sample, s, flags);
      } catch (e) {
        this.onError(e);
        await this.db.call("storageFailure", {
          sensorId: s.id,
          ownerId: s.owner_id,
          message: e.message,
        });
      }
      return { sample, saved };
    });
  }
  status(s) {
    const latest = this.live.get(s.id);
    return {
      connected: !!s.simulated || !!this.links.get(s.gateway_id),
      latest: latest?.ownerId === s.owner_id ? latest : null,
      simulated: !!s.simulated,
    };
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    for (const link of this.sockets) link.close();
    while (this.refreshing)
      await new Promise((resolve) => setTimeout(resolve, 10));
    await Promise.all([...this.queues.values()]);
    if (this.server.listening)
      await new Promise((resolve) => this.server.close(resolve));
  }
}
