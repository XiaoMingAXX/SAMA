import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DeviceError, extractFrame, parseResponse, readRequest, decodeRegisters, METRICS, hex } from '../lib/modbus.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.CLOUD_DATA_DIR || path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 18899);
const HOST = process.env.HOST || '0.0.0.0';
const WEB_ROOT = path.join(ROOT, 'public');
const VERSION = '0.1.0';
const DEFAULT_DEVICE = { id: 'probe-01', label: 'Soil probe 01', address: 2, metrics: METRICS.map(m => m.key), intervalMs: 5000 };

function ensureData() { fs.mkdirSync(DATA_DIR, { recursive: true }); }
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); } catch { return fallback; }
}
function saveJson(file, value) {
  ensureData(); const target = path.join(DATA_DIR, file), temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2)); fs.renameSync(temp, target);
}
function validateDevice(input, previous = {}) {
  const id = String(input.id ?? previous.id ?? '').trim();
  const label = String(input.label ?? previous.label ?? '').trim();
  const address = Number(input.address ?? previous.address ?? 2);
  const intervalMs = Number(input.intervalMs ?? previous.intervalMs ?? 5000);
  const metrics = input.metrics ?? previous.metrics ?? DEFAULT_DEVICE.metrics;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,31}$/.test(id)) throw new DeviceError('设备 ID 需为 2–32 个字母、数字、下划线或短横线', 'VALIDATION');
  if (!label || label.length > 60) throw new DeviceError('设备名称应为 1–60 个字符', 'VALIDATION');
  if (!Number.isInteger(address) || address < 1 || address > 247) throw new DeviceError('传感器地址必须是 1–247 之间的整数', 'VALIDATION');
  if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 3600000) throw new DeviceError('采样间隔必须是 1000–3600000 之间的整数', 'VALIDATION');
  if (!Array.isArray(metrics) || !metrics.length || metrics.some(key => !METRICS.some(m => m.key === key)) || new Set(metrics).size !== metrics.length)
    throw new DeviceError('请选择有效测量参数', 'VALIDATION');
  return { id, label, address, metrics, intervalMs };
}

class DeviceLink {
  constructor(socket, manager) {
    this.socket = socket; this.manager = manager; this.device = null; this.buffer = Buffer.alloc(0); this.pending = null; this.closed = false;
    socket.setNoDelay(true); socket.setKeepAlive(true, 10000);
    socket.on('data', chunk => this.onData(chunk));
    socket.on('error', error => this.fail(new DeviceError(`网关连接错误：${error.code || error.message}`, 'CONNECTION')));
    socket.on('close', () => this.close());
    this.identifyTimer = setTimeout(() => {
      if (!this.device) {
        const candidate = this.buffer.toString('utf8').trim();
        if (candidate.startsWith('LOAM:')) {
          this.buffer = Buffer.alloc(0);
          this.manager.attach(this, candidate.slice(5).trim());
        }
      }
      if (!this.device && manager.attachUnidentified(this)) this.manager.log('warn', '网关未发送注册包，已暂时分配给首个可用设备');
    }, 2200);
  }
  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > 8192) return this.fail(new DeviceError('网关缓冲区超过限制', 'OVERFLOW'));
    if (!this.device) {
      const marker = this.buffer.indexOf('\n');
      if (marker >= 0) {
        const line = this.buffer.subarray(0, marker + 1).toString('utf8').trim();
        if (line.startsWith('LOAM:')) {
          this.buffer = this.buffer.subarray(marker + 1);
          if (!this.manager.attach(this, line.slice(5).trim())) return this.fail(new DeviceError('未知的 LOAM 设备注册包', 'IDENTITY'));
        }
      }
    }
    if (!this.pending || !this.device) return;
    const pending = this.pending;
    const frame = extractFrame(this.buffer, pending.request);
    if (!frame) return;
    const offset = this.buffer.indexOf(frame);
    this.buffer = this.buffer.subarray(offset + frame.length);
    try { pending.finish(null, { result: parseResponse(frame, pending.request), frame }); }
    catch (error) { pending.finish(error); }
  }
  exchange(request, timeoutMs = 4500) {
    if (this.closed || !this.device) return Promise.reject(new DeviceError('网关尚未注册连接', 'OFFLINE'));
    if (this.pending) return Promise.reject(new DeviceError('串口请求尚未完成', 'BUSY'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new DeviceError('传感器响应超时，请检查网关和 RS485 接线', 'TIMEOUT')), timeoutMs);
      const finish = (error, value) => {
        if (this.pending?.finish !== finish) return;
        clearTimeout(timer); this.pending = null;
        if (error) reject(error); else resolve(value);
      };
      this.pending = { request, finish }; this.manager.log('tx', hex(request), this.device.id);
      this.socket.write(request, error => { if (error) finish(error); });
    });
  }
  fail(error) { this.pending?.finish(error); if (!this.closed) { this.manager.detach(this); this.socket.destroy(); } }
  close() {
    if (this.closed) return; this.closed = true; clearTimeout(this.identifyTimer); this.pending?.finish(new DeviceError('网关连接已断开', 'CONNECTION'));
    this.manager.detach(this);
  }
}

class Device {
  constructor(manager, config) {
    this.manager = manager; this.config = validateDevice(config); this.link = null; this.timer = null; this.queue = Promise.resolve(); this.busy = false;
    this.status = 'offline'; this.latest = null; this.lastError = null; this.successCount = 0; this.errorCount = 0; this.lastSeenAt = null; this.lastConnectedAt = null; this.logs = [];
  }
  summary() { return { ...this.config, status: this.status, latest: this.latest, lastError: this.lastError, successCount: this.successCount, errorCount: this.errorCount, lastSeenAt: this.lastSeenAt, lastConnectedAt: this.lastConnectedAt, connected: Boolean(this.link && !this.link.closed) }; }
  update(config) { this.config = validateDevice(config, this.config); this.manager.persist(); this.schedule(100); this.emit(); }
  emit() { this.manager.publish('device', this.summary()); }
  setLink(link) {
    if (this.link && this.link !== link) this.link.fail(new DeviceError('设备建立了新的连接', 'REPLACED'));
    this.link = link; link.device = this; this.status = 'online'; this.lastConnectedAt = new Date().toISOString(); this.lastSeenAt = this.lastConnectedAt; this.lastError = null; this.emit(); this.manager.log('connect', `设备 ${this.config.label} 已连接`, this.config.id); this.schedule(300);
  }
  clearLink(link) { if (this.link !== link) return; this.link = null; this.status = 'offline'; this.lastSeenAt = new Date().toISOString(); this.emit(); this.manager.log('disconnect', `设备 ${this.config.label} 已断开`, this.config.id); clearTimeout(this.timer); }
  run(fn) { const result = this.queue.then(fn); this.queue = result.catch(() => {}); return result; }
  async read() {
    if (!this.link || this.link.closed) throw new DeviceError('设备当前不在线', 'OFFLINE');
    this.busy = true; this.status = 'reading'; this.emit();
    try {
      const selected = METRICS.filter(m => this.config.metrics.includes(m.key)).map(m => m.register), groups = [];
      for (const reg of selected) { const last = groups.at(-1); if (last && last.start + last.count === reg) last.count++; else groups.push({ start: reg, count: 1 }); }
      const registers = Array(8), frames = [];
      for (const group of groups) { const request = readRequest(this.config.address, group.start, group.count); const { result, frame } = await this.link.exchange(request); result.forEach((value, i) => registers[group.start + i] = value); frames.push(hex(frame)); }
      const sample = { id: randomUUID(), deviceId: this.config.id, timestamp: new Date().toISOString(), source: 'hardware', address: this.config.address, ...decodeRegisters(registers, 0, this.config.metrics), registers: registers.map(v => v ?? null), frames };
      this.latest = sample; this.lastError = null; this.status = 'online'; this.lastSeenAt = sample.timestamp; this.successCount++;
      this.manager.storeSample(sample); this.manager.publish('sample', sample); this.emit(); return sample;
    } catch (error) {
      this.status = this.link && !this.link.closed ? 'error' : 'offline'; this.lastError = { code: error.code || 'ERROR', message: error.message, timestamp: new Date().toISOString() }; this.errorCount++; this.manager.log('error', error.message, this.config.id); this.emit(); throw error;
    } finally { this.busy = false; }
  }
  schedule(delay = this.config.intervalMs) {
    clearTimeout(this.timer); if (!this.link || this.link.closed) return;
    this.timer = setTimeout(async () => { try { await this.run(() => this.read()); } catch {} this.schedule(this.config.intervalMs); }, delay);
  }
  close() { clearTimeout(this.timer); this.link?.socket.destroy(); }
}

class CloudManager {
  constructor() {
    this.devices = new Map(); this.links = new Set(); this.clients = new Set(); this.logs = []; this.history = readJson('samples.ndjson.json', []);
    const configs = readJson('devices.json', [DEFAULT_DEVICE]); for (const config of configs) { try { const device = new Device(this, config); this.devices.set(device.config.id, device); } catch (error) { this.log('error', error.message); } }
  }
  persist() { saveJson('devices.json', [...this.devices.values()].map(device => device.config)); }
  storeSample(sample) { this.history.push(sample); if (this.history.length > 10000) this.history.splice(0, this.history.length - 10000); saveJson('samples.ndjson.json', this.history); }
  log(kind, message, deviceId = null) { const row = { id: randomUUID(), timestamp: new Date().toISOString(), kind, message, deviceId }; this.logs.push(row); if (this.logs.length > 300) this.logs.shift(); this.publish('log', row); }
  publish(event, data) { for (const client of this.clients) client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
  attach(link, id) { const device = this.devices.get(id); if (!device) return false; if (link.device) return true; link.device = device; this.links.add(link); device.setLink(link); return true; }
  attachUnidentified(link) {
    const device = [...this.devices.values()].find(item => !item.link); if (!device) return false; this.links.add(link); device.setLink(link); return true;
  }
  detach(link) { this.links.delete(link); if (link.device) link.device.clearLink(link); }
  find(id) { const device = this.devices.get(id); if (!device) throw new DeviceError('设备不存在', 'NOT_FOUND'); return device; }
  list() { return [...this.devices.values()].map(device => device.summary()); }
  state() { return { version: VERSION, server: 'cloud', devices: this.list(), online: this.list().filter(device => device.connected).length }; }
  close() { for (const device of this.devices.values()) device.close(); for (const client of this.clients) client.end(); }
}

const manager = new CloudManager();
function json(response, status, value) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); }
async function body(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new DeviceError('请求需要 JSON', 'VALIDATION');
  const chunks = []; let length = 0; for await (const chunk of request) { length += chunk.length; if (length > 16384) throw new DeviceError('请求体太大', 'VALIDATION'); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString()); if (!value || Array.isArray(value)) throw new Error(); return value; } catch { throw new DeviceError('JSON 格式无效', 'VALIDATION'); }
}
function file(response, pathname) {
  if (pathname === '/favicon.ico') { response.writeHead(204); return response.end(); }
  const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'] }, entry = files[pathname];
  if (!entry) return json(response, 404, { error: 'NOT_FOUND', message: '页面不存在' });
  response.writeHead(200, { 'Content-Type': `${entry[1]}; charset=utf-8`, 'Cache-Control': 'no-cache' }); fs.createReadStream(path.join(WEB_ROOT, entry[0])).pipe(response);
}

const web = http.createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'same-origin'); response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'");
  try {
    const url = new URL(request.url, `http://${request.headers.host}`), route = `${request.method} ${url.pathname}`;
    if (route === 'GET /api/state') return json(response, 200, manager.state());
    if (route === 'GET /api/devices') return json(response, 200, { devices: manager.list() });
    if (route === 'GET /api/logs') return json(response, 200, { logs: manager.logs });
    if (route === 'GET /api/events') { if (manager.clients.size >= 100) return json(response, 503, { error: 'BUSY', message: '实时订阅已达到限制' }); response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); manager.clients.add(response); response.write(`event: state\ndata: ${JSON.stringify(manager.state())}\n\n`); request.on('close', () => manager.clients.delete(response)); return; }
    const deviceMatch = url.pathname.match(/^\/api\/devices\/([a-zA-Z0-9_-]+)(?:\/(read|history))?$/);
    if (deviceMatch) {
      const device = manager.find(deviceMatch[1]);
      if (route.startsWith('GET') && deviceMatch[2] === 'history') return json(response, 200, { samples: manager.history.filter(row => row.deviceId === device.config.id).slice(-10000) });
      if (route === `GET /api/devices/${device.config.id}`) return json(response, 200, device.summary());
      if (route === `POST /api/devices/${device.config.id}/read`) { await body(request); return json(response, 200, await device.run(() => device.read())); }
      if (route === `POST /api/devices/${device.config.id}`) { const input = await body(request); device.update({ ...device.config, ...input, id: device.config.id }); return json(response, 200, device.summary()); }
    }
    if (route === 'POST /api/devices') { const input = await body(request); const config = validateDevice(input); if (manager.devices.has(config.id)) throw new DeviceError('设备 ID 已存在', 'VALIDATION'); const device = new Device(manager, config); manager.devices.set(config.id, device); manager.persist(); manager.publish('state', manager.state()); return json(response, 201, device.summary()); }
    if (route.startsWith('/api/')) return json(response, 404, { error: 'NOT_FOUND', message: 'API 不存在' });
    if (request.method !== 'GET') return json(response, 405, { error: 'METHOD', message: '不支持的方法' });
    return file(response, url.pathname);
  } catch (error) { json(response, error.code === 'VALIDATION' ? 400 : error.code === 'NOT_FOUND' ? 404 : error.code === 'OFFLINE' ? 409 : 502, { error: error.code || 'ERROR', message: error.message }); }
});
web.requestTimeout = 60000;
const tcp = net.createServer(socket => { manager.log('connect', `收到网关连接：${socket.remoteAddress}`); new DeviceLink(socket, manager); });
tcp.on('error', error => { console.error(error); process.exitCode = 1; });
await new Promise(resolve => tcp.listen(PORT, HOST, resolve));
await new Promise(resolve => web.listen(Number(process.env.WEB_PORT || 18880), HOST, resolve));
console.log(`LOAM cloud demo TCP :${PORT}, web :${process.env.WEB_PORT || 18880}`);
process.on('SIGTERM', () => { manager.close(); tcp.close(); web.close(); });
