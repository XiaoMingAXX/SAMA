import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';
import { DeviceError, integer } from './modbus.mjs';

export function lanHost(host) {
  if (typeof host !== 'string' || net.isIP(host) !== 4) throw new DeviceError('请输入局域网 IPv4 地址', 'VALIDATION');
  const p = host.split('.').map(Number);
  if (!(p[0] === 10 || p[0] === 127 || (p[0] === 192 && p[1] === 168) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 169 && p[1] === 254)))
    throw new DeviceError('设备地址必须属于本机或局域网', 'VALIDATION');
  return host;
}
function textField(value, label, max = 63, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.length) || Buffer.byteLength(value) > max || /[\x00-\x1f\x7f]/.test(value))
    throw new DeviceError(`${label} 格式或长度无效`, 'VALIDATION');
  return value;
}
export function escapeAt(value) {
  return value.replace(/[\\,=?]/g, c => `\\${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
export function gatewayPlan(input) {
  const commands = [];
  const add = (command, sensitive = false) => commands.push({ command, sensitive });
  if (input.uart) {
    const u = input.uart;
    if (![2400, 4800, 9600, 19200, 38400, 57600, 115200].includes(u.baud)) throw new DeviceError('不支持的串口波特率', 'VALIDATION');
    if (![1, 2].includes(u.stopBits) || !['NONE', 'ODD', 'EVEN'].includes(u.parity)) throw new DeviceError('串口格式无效', 'VALIDATION');
    add(`AT+UART=${u.baud},8,${u.stopBits},${u.parity},NFC`);
  }
  if (input.wifi) {
    const w = input.wifi;
    textField(w.ssid, 'SSID', 32); textField(w.password, 'Wi-Fi 密码', 63, true);
    const passwordLength = Buffer.byteLength(w.password);
    if (passwordLength && passwordLength !== 5 && passwordLength < 8) throw new DeviceError('Wi-Fi 密码应为 5 或 8–63 字节', 'VALIDATION');
    if (!['STA', 'APSTA'].includes(w.mode)) throw new DeviceError('Wi-Fi 模式无效', 'VALIDATION');
    add(`AT+WSSSID=${escapeAt(w.ssid)}`);
    add(`AT+WSKEY=${w.password ? escapeAt(w.password) : 'OPEN,NONE'}`, true);
    add(`AT+WMODE=${w.mode}`);
  }
  if (input.ip) {
    if (input.ip.mode === 'DHCP') add('AT+WANN=DHCP,0.0.0.0,0.0.0.0,0.0.0.0');
    else if (input.ip.mode === 'static') {
      const { address, mask, gateway } = input.ip; lanHost(address); lanHost(gateway);
      if (net.isIP(mask) !== 4) throw new DeviceError('子网掩码无效', 'VALIDATION');
      const bits = mask.split('.').map(x => Number(x).toString(2).padStart(8, '0')).join('');
      if (!/^1+0+$/.test(bits)) throw new DeviceError('子网掩码应是连续的 1 和 0', 'VALIDATION');
      add(`AT+WANN=static,${address},${mask},${gateway}`);
    } else throw new DeviceError('IP 模式无效', 'VALIDATION');
  }
  if (input.tcp) { integer(input.tcp.port, 1, 65535, 'TCP 端口'); add(`AT+NETP=TCP,SERVER,${input.tcp.port},${lanHost(input.tcp.address)}`); }
  if (input.packet) {
    integer(input.packet.intervalMs, 10, 1000, '串口分包间隔'); integer(input.packet.bytes, 32, 1400, '串口缓冲区');
    add(`AT+UARTTM=${input.packet.intervalMs}`); add(`AT+UARTBUF=${input.packet.bytes}`);
  }
  if (input.ap) {
    textField(input.ap.ssid, '热点名称', 32); textField(input.ap.password, '热点密码', 63, true);
    if (input.ap.password && Buffer.byteLength(input.ap.password) < 8) throw new DeviceError('热点密码至少 8 字节', 'VALIDATION');
    add(`AT+WAP=11BGN,${escapeAt(input.ap.ssid)},AUTO`);
    add(`AT+WAKEY=${input.ap.password ? `WPA2PSK,AES,${escapeAt(input.ap.password)}` : 'OPEN,NONE'}`, true);
  }
  if (!commands.length) throw new DeviceError('请至少选择一组要配置的参数', 'VALIDATION');
  return { commands, restartRequired: true, compatibility: 'HF UDP 48899 通道需实机确认；命令依据 FTX-W80 通用软件手册' };
}
export function networkAddresses(port) {
  const addresses = [];
  for (const [name, items] of Object.entries(os.networkInterfaces())) for (const item of items || []) {
    if (item.family === 'IPv4' && !item.internal && !item.address.startsWith('169.254.'))
      addresses.push({ name, address: item.address, url: `http://${item.address}:${port}` });
  }
  return addresses.sort((a,b) => /vmware|vethernet|wsl/i.test(a.name) - /vmware|vethernet|wsl/i.test(b.name));
}
function identity(message, address) {
  const parts = message.toString('utf8').trim().split(',');
  if (parts.length < 2 || net.isIP(parts[0]) !== 4 || !/^[a-f\d:.-]{12,17}$/i.test(parts[1])) return null;
  return { ip: address, reportedIp: parts[0], mac: parts[1], model: (parts[2] || 'HF Wi-Fi bridge').slice(0, 80) };
}
// HF-family UDP provisioning is a compatibility option. The supplied manual
// documents ASWD and AT commands, but does not specify the UDP transport.
export async function discover({ key = 'HF-A11ASSISTHREAD', localAddress, host } = {}) {
  textField(key, '搜索口令', 20);
  if (host) lanHost(host);
  if (localAddress) lanHost(localAddress);
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4'), found = new Map();
    let timer, finished = false;
    const finish = err => {
      if (finished) return; finished = true; clearTimeout(timer);
      try { socket.close(); } catch { /* A failed bind may leave no socket to close. */ }
      err ? reject(err) : resolve([...found.values()]);
    };
    socket.once('error', finish);
    socket.on('message', (msg, rinfo) => {
      if (rinfo.port !== 48899 || (host && rinfo.address !== host)) return;
      const item = identity(msg, rinfo.address); if (item) found.set(item.mac, item);
    });
    socket.bind(0, localAddress || '0.0.0.0', () => {
      socket.setBroadcast(true);
      timer = setTimeout(() => finish(), 1400);
      socket.send(Buffer.from(key), 48899, host || '255.255.255.255', error => { if (error) finish(error); });
    });
  });
}
export class GatewaySession {
  constructor(host, key = 'HF-A11ASSISTHREAD') { this.host = lanHost(host); this.key = textField(key, '搜索口令', 20); this.socket = null; this.pending = null; }
  async open() {
    this.socket = dgram.createSocket('udp4');
    this.socket.on('message', message => this.pending?.receive(message));
    this.socket.on('error', error => this.pending?.reject(error));
    await new Promise((resolve, reject) => { this.socket.once('error', reject); this.socket.connect(48899, this.host, () => { this.socket.off('error', reject); resolve(); }); });
    await this.request(this.key, data => identity(data, this.host) ? data : null);
    await new Promise((resolve, reject) => this.socket.send(Buffer.from('+ok'), err => err ? reject(err) : resolve()));
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  request(text, accept = data => /^[\s\S]*\+(ok|ERR)/i.test(data.toString()) ? data.toString().trim() : null, timeout = 2000) {
    return new Promise((resolve, reject) => {
      const finish = (err, value) => { clearTimeout(timer); this.pending = null; err ? reject(err) : resolve(value); };
      const timer = setTimeout(() => finish(new DeviceError('网络 AT 通道未响应。固件可能不支持 HF UDP 48899；请使用原厂网页配置。', 'GATEWAY_TIMEOUT')), timeout);
      this.pending = { receive: data => { const result = accept(data); if (result !== null) finish(null, result); }, reject: err => finish(err) };
      this.socket.send(Buffer.from(text), error => { if (error) finish(error); });
    });
  }
  async command(command) {
    const response = await this.request(`${command}\r`);
    if (/\+ERR/i.test(response)) throw new DeviceError(`网关拒绝 ${command.split('=')[0]}：${response}`, 'GATEWAY_ERROR');
    return response;
  }
  async restart() { await new Promise((resolve, reject) => this.socket.send(Buffer.from('AT+Z\r'), error => error ? reject(error) : resolve())); }
  close() { if (this.socket) { try { this.socket.close(); } catch { /* The socket can already be closed after a network error. */ } this.socket = null; } }
}
export const GATEWAY_QUERIES = ['VER', 'MID', 'WMODE', 'UART', 'NETP', 'WANN', 'WSSSID', 'WSLK', 'UARTTM', 'UARTBUF', 'LANN', 'WAP'];
