import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DeviceError, integer, readRequest, writeRequest, decodeRegisters, METRICS, hex } from './lib/modbus.mjs';
import { RtuTcpTransport, Simulator } from './lib/transport.mjs';
import { lanHost, networkAddresses, discover, gatewayPlan, GatewaySession, GATEWAY_QUERIES } from './lib/gateway.mjs';
import { Store } from './lib/store.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULTS = { mode: 'demo', host: '10.10.100.254', port: 8899, address: 2, timeoutMs: 2500, pollIntervalMs: 5000, polling: true, label: 'Soil probe 01', metrics: METRICS.map(m => m.key) };
export function validateConfig(input) {
  const c = { ...DEFAULTS, ...input };
  if (!['demo','hardware'].includes(c.mode) || typeof c.polling !== 'boolean') throw new DeviceError('运行模式无效', 'VALIDATION');
  lanHost(c.host); integer(c.port, 1, 65535, 'TCP 端口'); integer(c.address, 1, 247, '传感器地址');
  integer(c.timeoutMs, 500, 15000, '超时时间'); integer(c.pollIntervalMs, 1000, 3600000, '采样间隔');
  if (typeof c.label !== 'string' || !c.label.trim() || c.label.length > 60) throw new DeviceError('设备名称应为 1–60 个字符', 'VALIDATION');
  if (!Array.isArray(c.metrics) || !c.metrics.length || c.metrics.some(key => !METRICS.some(m => m.key === key)) || new Set(c.metrics).size !== c.metrics.length)
    throw new DeviceError('请选择有效测量参数', 'VALIDATION');
  return Object.fromEntries(Object.keys(DEFAULTS).map(key => [key, c[key]]));
}
export class Observatory {
  constructor(store, config, publish = () => {}) {
    this.store = store; this.config = validateConfig(config); this.publish = publish;
    this.transport = new RtuTcpTransport(this.config, entry => this.log(entry));
    this.simulator = new Simulator(); this.simulator.address = this.config.address; this.simulator.settings[0] = this.config.address;
    this.latest = null; this.logs = []; this.status = 'idle'; this.lastError = null;
    this.successCount = 0; this.errorCount = 0; this.queue = Promise.resolve(); this.queued = 0;
    this.timer = null; this.closed = false; this.failures = 0;
  }
  state() { return { config: this.config, latest: this.latest, status: this.status, lastError: this.lastError, successCount: this.successCount, errorCount: this.errorCount, queued: this.queued, nextPollAt: this.nextPollAt || null }; }
  emitState() { this.publish('state', this.state()); }
  log(entry) {
    const row = { id: randomUUID(), timestamp: new Date().toISOString(), ...entry };
    this.logs.push(row); if (this.logs.length > 300) this.logs.shift(); this.publish('log', row);
  }
  exclusive(fn) {
    if (this.queued >= 32) throw new DeviceError('请求过多，请稍后再试', 'BUSY');
    this.queued++;
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {}).finally(() => { this.queued--; });
    return result;
  }
  async exchange(request) {
    await new Promise(resolve => setTimeout(resolve, 40));
    if (this.config.mode === 'demo') {
      this.log({ kind: 'tx', message: hex(request), source: 'demo' });
      const response = this.simulator.exchange(request);
      this.log({ kind: 'rx', message: hex(response.frame), source: 'demo' });
      return response;
    }
    return this.transport.exchange(request);
  }
  async read() {
    this.status = 'reading'; this.emitState();
    try {
      const selected = METRICS.filter(m => this.config.metrics.includes(m.key)).map(m => m.register);
      const groups = [];
      for (const reg of selected) {
        const last = groups.at(-1);
        if (last && last.start + last.count === reg) last.count++; else groups.push({ start: reg, count: 1 });
      }
      const registers = Array(8), frames = [];
      for (const group of groups) {
        const { result, frame } = await this.exchange(readRequest(this.config.address, group.start, group.count));
        result.forEach((value, i) => registers[group.start + i] = value); frames.push(hex(frame));
      }
      const sample = { id: randomUUID(), timestamp: new Date().toISOString(), source: this.config.mode,
        host: this.config.mode === 'hardware' ? this.config.host : 'simulator', address: this.config.address,
        ...decodeRegisters(registers, 0, this.config.metrics), registers: registers.map(v => v ?? null), frames };
      this.store.add(sample); this.latest = sample; this.status = 'online'; this.lastError = null;
      this.failures = 0; this.successCount++; this.publish('sample', sample); this.emitState();
      return sample;
    } catch (error) {
      this.status = 'error'; this.lastError = { code: error.code || 'ERROR', message: error.message, timestamp: new Date().toISOString() };
      this.errorCount++; this.failures++; this.log({ kind: 'error', message: error.message }); this.emitState(); throw error;
    }
  }
  schedule(delay) {
    clearTimeout(this.timer); this.nextPollAt = null;
    if (!this.config.polling || this.closed) return;
    const wait = delay ?? Math.max(this.config.pollIntervalMs, Math.min(30000, this.failures ? 1000 * 2 ** Math.min(this.failures, 5) : 0));
    this.nextPollAt = new Date(Date.now() + wait).toISOString();
    this.timer = setTimeout(async () => {
      try { await this.exclusive(() => this.config.polling && !this.closed ? this.read() : null); } catch { /* Status and packet log already contain the failure. */ }
      this.schedule();
    }, wait);
  }
  async configure(patch) {
    const next = validateConfig({ ...this.config, ...patch });
    const identityChanged = ['mode','host','port','address'].some(k => next[k] !== this.config[k]) || JSON.stringify(next.metrics) !== JSON.stringify(this.config.metrics);
    this.store.saveSettings(next); this.transport.close(); this.config = next; this.transport.config = next;
    if (identityChanged) { this.latest = null; this.status = 'idle'; this.lastError = null; this.failures = 0; }
    this.simulator.address = next.address; this.simulator.settings[0] = next.address;
    this.schedule(next.polling ? 100 : undefined); this.emitState(); return this.state();
  }
  async readSensorConfig() {
    const { result, frame } = await this.exchange(readRequest(this.config.address, 0x80, 5));
    return { address: result[0], baudRegister: result[1], parity: result[2], dataBits: result[3], stopBits: result[4], raw: hex(frame), source: this.config.mode };
  }
  async writeSensor({ parameter, value, confirm }) {
    if (confirm !== true) throw new DeviceError('请在配置预览后确认写入', 'VALIDATION');
    const registers = { address: 0x80, baudRegister: 0x81, parity: 0x82, dataBits: 0x83, stopBits: 0x84 };
    if (!(parameter in registers)) throw new DeviceError('不支持的传感器配置项', 'VALIDATION');
    integer(value, 0, 65535, '配置值');
    if (parameter === 'address') integer(value, 1, 247, '设备地址');
    if (parameter === 'parity' && ![0,1,2].includes(value)) throw new DeviceError('校验值只支持 0 / 1 / 2', 'VALIDATION');
    if (parameter === 'dataBits' && value !== 8) throw new DeviceError('FTX-W80 与传感器兼容的数据位是 8', 'VALIDATION');
    if (parameter === 'stopBits' && ![1,2].includes(value)) throw new DeviceError('停止位只支持 1 / 2', 'VALIDATION');
    const request = writeRequest(this.config.address, registers[parameter], [value]);
    try {
      const { result, frame } = await this.exchange(request);
      if (parameter === 'address') await this.configure({ address: value });
      else {
        // A UART change may take effect immediately. Never retry a write or assume
        // the old serial settings still work; let the user align the gateway first.
        await this.configure({ polling: false });
      }
      this.log({ kind: 'info', message: `传感器 ${parameter} 写入已应答：${value}（${result.acknowledgement}）；请读取配置验证` });
      return { ...result, raw: hex(frame), verificationRequired: true, pollingPaused: parameter !== 'address' };
    } catch (error) {
      if (this.config.mode === 'hardware') await this.configure({ polling: false });
      throw new DeviceError(`写入结果未确认，未自动重试。设备可能已生效：${parameter}=${value}。请同步网关串口参数后读取验证。${error.message}`, error.code || 'WRITE_UNCERTAIN');
    }
  }
  history(options = {}) {
    return this.store.history({ source: this.config.mode, host: this.config.mode === 'hardware' ? this.config.host : 'simulator', address: this.config.address, ...options });
  }
  close() { this.closed = true; clearTimeout(this.timer); this.transport.close(); }
}

function json(response, status, value) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); }
async function body(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new DeviceError('请求需要 JSON', 'VALIDATION');
  const chunks = []; let length = 0;
  for await (const chunk of request) { length += chunk.length; if (length > 16384) throw new DeviceError('请求体太大', 'VALIDATION'); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString()); if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(); return value; }
  catch { throw new DeviceError('JSON 格式无效', 'VALIDATION'); }
}
function csvValue(value) { const s = String(value ?? ''); return `"${s.replaceAll('"', '""')}"`; }
export async function createServer({ port = 3000, host = '0.0.0.0', dataDir = path.join(ROOT, 'data'), polling } = {}) {
  const store = new Store(dataDir); await store.load();
  const clients = new Set();
  const publish = (event, data) => {
    for (const client of clients) {
      if (client.writableLength > 262144) { client.destroy(); clients.delete(client); continue; }
      client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };
  const saved = store.settings();
  const app = new Observatory(store, { ...saved, ...(polling === undefined ? {} : { polling }) }, publish);
  let listeningPort = port;
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'");
    try {
      // Browser origins alone do not prevent DNS rebinding to a local service.
      const allowedHosts = ['localhost','127.0.0.1', ...networkAddresses(listeningPort).map(a => a.address)];
      if (!allowedHosts.some(name => request.headers.host === `${name}:${listeningPort}` || (listeningPort === 80 && request.headers.host === name)))
        return json(response, 403, { error: 'HOST', message: '请使用 localhost 或本机局域网 IP 访问' });
      const url = new URL(request.url, 'http://localhost');
      if (!['GET','POST'].includes(request.method)) return json(response, 405, { error: 'METHOD', message: '不支持的方法' });
      if (request.method === 'POST') {
        if (request.headers['x-loam-request'] !== '1' || (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`))
          return json(response, 403, { error: 'ORIGIN', message: '请通过本服务页面操作设备' });
      }
      const route = `${request.method} ${url.pathname}`;
      if (route === 'GET /api/state') return json(response, 200, app.state());
      if (route === 'GET /api/info') return json(response, 200, { name: 'LOAM', version: '1.1.0', addresses: networkAddresses(listeningPort), metrics: METRICS, historyLimit: 10000, gatewayCompatibility: 'HF UDP 48899 尚未在你的实机验证' });
      if (route === 'GET /api/events') {
        if (clients.size >= 64) return json(response, 503, { message: '实时订阅已达到 64 个连接' });
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        response.write(`event: state\ndata: ${JSON.stringify(app.state())}\n\n`); clients.add(response);
        response.on('close', () => clients.delete(response)); return;
      }
      if (route === 'GET /api/history' || route === 'GET /api/export.csv') {
        const since = url.searchParams.has('since') ? Date.parse(url.searchParams.get('since')) : 0;
        if (!Number.isFinite(since)) throw new DeviceError('时间筛选无效', 'VALIDATION');
        const rows = app.history({ since });
        if (route.endsWith('history')) return json(response, 200, { samples: rows, limit: 10000 });
        response.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="loam-soil-observations.csv"' });
        const keys = ['timestamp','source','host','address', ...METRICS.map(m => m.key)];
        response.end('\ufeff' + keys.join(',') + '\r\n' + rows.map(row => keys.map(k => csvValue(row.values[k] ?? row[k])).join(',')).join('\r\n')); return;
      }
      if (route === 'GET /api/logs') return json(response, 200, { logs: app.logs });
      if (route === 'POST /api/config') { const input = await body(request); return json(response, 200, await app.exclusive(() => app.configure(input))); }
      if (route === 'POST /api/read') { await body(request); return json(response, 200, await app.exclusive(() => app.read())); }
      if (route === 'POST /api/sensor/config') { await body(request); return json(response, 200, await app.exclusive(() => app.readSensorConfig())); }
      if (route === 'POST /api/sensor/write') { const input = await body(request); return json(response, 200, await app.exclusive(() => app.writeSensor(input))); }
      if (route === 'POST /api/registers/read') {
        const { start, count } = await body(request);
        return json(response, 200, await app.exclusive(async () => {
          const { result, frame } = await app.exchange(readRequest(app.config.address, start, count)); return { start, values: result, raw: hex(frame) };
        }));
      }
      if (route === 'POST /api/gateway/discover') { const input = await body(request); return json(response, 200, { devices: await discover(input), compatibility: 'HF UDP 48899 兼容模式；无结果不代表设备离线' }); }
      if (route === 'POST /api/gateway/plan') { const input = await body(request); return json(response, 200, gatewayPlan(input)); }
      if (route === 'POST /api/gateway/read' || route === 'POST /api/gateway/apply' || route === 'POST /api/gateway/restart') {
        const input = await body(request);
        if (route !== 'POST /api/gateway/read' && input.confirm !== true) throw new DeviceError('请先预览并确认网关操作', 'VALIDATION');
        const plan = route === 'POST /api/gateway/apply' ? gatewayPlan(input.settings || {}) : null;
        return json(response, 200, await app.exclusive(async () => {
          if (app.config.mode === 'demo') throw new DeviceError('网关操作需要切换到真实设备模式；模拟模式不访问硬件', 'VALIDATION');
          const session = new GatewaySession(app.config.host, input.key);
          const completed = [];
          try {
            await session.open();
            if (route === 'POST /api/gateway/read') {
              const values = {};
              for (const key of GATEWAY_QUERIES) { try { values[key] = await session.command(`AT+${key}`); } catch (err) { if (err.code === 'GATEWAY_TIMEOUT') throw err; values[key] = err.message; } }
              return { values, compatibility: '当前设备已响应 HF UDP 网络 AT 通道' };
            }
            await app.configure({ polling: false });
            if (plan) for (const item of plan.commands) {
              await session.command(item.command); completed.push(item.command.split('=')[0]);
              app.log({ kind: 'info', message: `网关已确认 ${item.command.split('=')[0]}（参数未记入日志）` });
              await new Promise(resolve => setTimeout(resolve, 80));
            }
            if (route.endsWith('restart') || input.restart === true) await session.restart();
            app.transport.close();
            return { completed, restartSent: route.endsWith('restart') || input.restart === true, verificationRequired: true, message: '配置指令已应答，采集已暂停。重启后重新搜索 IP 并读取验证。重启命令发出不代表设备已重启成功。' };
          } catch (error) {
            throw new DeviceError(`${error.message}${completed.length ? ` 已完成：${completed.join('、')}；其他步骤未确认，请重新读取设备配置。` : ''}`, error.code || 'GATEWAY');
          } finally { session.close(); }
        }));
      }
      if (url.pathname.startsWith('/api/')) return json(response, 404, { message: 'API 不存在' });
      const files = { '/': ['index.html','text/html'], '/app.js': ['app.js','text/javascript'], '/i18n.mjs': ['i18n.mjs','text/javascript'], '/locales.mjs': ['locales.mjs','text/javascript'], '/styles.css': ['styles.css','text/css'], '/probe.svg': ['probe.svg','image/svg+xml'] };
      const file = files[url.pathname];
      if (!file) return json(response, 404, { message: '页面不存在' });
      response.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8`, 'Cache-Control': 'no-cache' });
      fs.createReadStream(path.join(ROOT, 'public', file[0])).pipe(response);
    } catch (error) {
      if (!response.headersSent) json(response, error.code === 'VALIDATION' ? 400 : error.code === 'BUSY' ? 429 : 502, { error: error.code || 'ERROR', message: error.message });
    }
  });
  server.requestTimeout = 60000;
  const heartbeat = setInterval(() => { for (const client of clients) client.write(': heartbeat\n\n'); }, 15000);
  server.on('close', () => { clearInterval(heartbeat); app.close(); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  listeningPort = server.address().port; app.schedule(100);
  return { server, app, port: listeningPort, close: async () => {
    app.close(); clearInterval(heartbeat); for (const client of clients) client.end();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  integer(port, 1, 65535, '服务端口');
  const runtime = await createServer({ port, host: process.env.HOST || '0.0.0.0', dataDir: process.env.LOAM_DATA_DIR || path.join(ROOT, 'data') });
  console.log(`\n  LOAM / 土壤观测站\n  本机：http://localhost:${runtime.port}\n`);
  for (const address of networkAddresses(runtime.port)) console.log(`  ${address.name}：${address.url}`);
  console.log('\n  默认模拟模式。浏览器 → 设备配置 → 真实设备，可接入传感器。\n  Ctrl+C 停止服务。');
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => runtime.close().then(() => process.exit(0)));
}
