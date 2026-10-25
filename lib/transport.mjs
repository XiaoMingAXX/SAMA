import net from 'node:net';
import { DeviceError, extractFrame, parseResponse, hex } from './modbus.mjs';

export class RtuTcpTransport {
  constructor(config, log = () => {}) { this.config = config; this.log = log; this.socket = null; this.pending = null; }
  async connect() {
    if (this.socket && !this.socket.destroyed) return;
    const socket = new net.Socket(); this.socket = socket;
    socket.setNoDelay(true); socket.setKeepAlive(true, 10000);
    socket.on('data', chunk => {
      if (this.socket !== socket || !this.pending) return;
      const p = this.pending; p.buffer = Buffer.concat([p.buffer, chunk]);
      if (p.buffer.length > 4096) return p.finish(new DeviceError('透传数据超过缓冲区限制', 'OVERFLOW'));
      const frame = extractFrame(p.buffer, p.request);
      if (frame) {
        this.log({ kind: 'rx', message: hex(frame) });
        try { p.finish(null, { result: parseResponse(frame, p.request), frame }); }
        catch (error) { p.finish(error); }
      }
    });
    socket.on('error', err => {
      if (this.socket !== socket) return;
      this.pending?.finish(new DeviceError(`网关连接错误：${err.code || err.message}`, 'CONNECTION'));
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.pending?.finish(new DeviceError('网关关闭了连接', 'CONNECTION'));
      if (this.socket === socket) this.socket = null;
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new DeviceError('无法连接网关：检查 IP、Wi-Fi 和 TCP Server 模式', 'CONNECT_TIMEOUT')); }, this.config.timeoutMs);
      const failed = err => { clearTimeout(timer); socket.off('connect', ready); reject(new DeviceError(`无法连接网关：${err.code || err.message}`, 'CONNECTION')); };
      const ready = () => { clearTimeout(timer); socket.off('error', failed); resolve(); };
      socket.once('error', failed); socket.once('connect', ready);
      socket.connect(this.config.port, this.config.host);
    });
  }
  async exchange(request) {
    if (this.pending) throw new DeviceError('串口请求尚未完成', 'BUSY');
    await this.connect();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new DeviceError('传感器响应超时：检查 A/B 接线、地址和 9600/8/N/1 设置', 'TIMEOUT')), this.config.timeoutMs);
      const finish = (error, value) => {
        if (this.pending?.finish !== finish) return;
        clearTimeout(timer); this.pending = null;
        // Closing after an error prevents a late reply from being used for the next request.
        if (error) { this.socket?.destroy(); reject(error); } else resolve(value);
      };
      this.pending = { request, buffer: Buffer.alloc(0), finish };
      this.log({ kind: 'tx', message: hex(request) });
      this.socket.write(request, error => { if (error) finish(error); });
    });
  }
  close() { this.pending?.finish(new DeviceError('连接已重置', 'CONNECTION')); this.socket?.destroy(); this.socket = null; }
}

export class Simulator {
  constructor() { this.address = 2; this.settings = [2, 9600, 0, 8, 1]; this.tick = 0; }
  exchange(request) {
    if (request[0] !== this.address) throw new DeviceError('模拟设备地址不匹配', 'ADDRESS');
    const start = request.readUInt16BE(2), count = request.readUInt16BE(4);
    if (request[1] === 0x10) {
      for (let i = 0; i < count; i++) this.settings[start - 0x80 + i] = request.readUInt16BE(7 + i * 2);
      this.address = this.settings[0];
      const ack = request.subarray(0, 6);
      return this.makeAck(ack, request);
    }
    const t = this.tick++ / 15;
    const soil = [Math.round(264 + Math.sin(t) * 7), Math.round(386 + Math.sin(t * .6) * 19),
      Math.round(842 + Math.cos(t) * 20), 421, 48, 23, 116, Math.round(65 + Math.sin(t * .4))];
    const registers = Array.from({ length: count }, (_, i) => start >= 0x80 ? this.settings[start + i - 0x80] ?? 0 : soil[start + i] ?? 0);
    const data = Buffer.alloc(3 + count * 2); data[0] = request[0]; data[1] = 3; data[2] = count * 2;
    registers.forEach((v, i) => data.writeUInt16BE(v, 3 + i * 2));
    return this.makeAck(data, request);
  }
  makeAck(data, request) {
    // Both modes pass through the same real wire encoder and decoder.
    const frame = withCrc(data);
    return { result: parseResponse(frame, request), frame };
  }
}
import { withCrc } from './modbus.mjs';
