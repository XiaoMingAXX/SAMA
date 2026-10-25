export class DeviceError extends Error {
  constructor(message, code = 'DEVICE_ERROR') { super(message); this.code = code; }
}
export function integer(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new DeviceError(`${name} 必须是 ${min}–${max} 之间的整数`, 'VALIDATION');
  return value;
}
export function crc16(data) {
  let crc = 0xffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xa001 : 0);
  }
  return crc;
}
export function withCrc(data) {
  const result = Buffer.alloc(data.length + 2);
  Buffer.from(data).copy(result);
  result.writeUInt16LE(crc16(data), data.length);
  return result;
}
export function validCrc(frame) {
  return frame.length >= 5 && crc16(frame.subarray(0, -2)) === frame.readUInt16LE(frame.length - 2);
}
export function hex(frame) { return Buffer.from(frame).toString('hex').match(/../g)?.join(' ').toUpperCase() || ''; }
export function readRequest(address, start = 0, count = 8) {
  integer(address, 1, 247, '设备地址'); integer(start, 0, 65535, '起始寄存器'); integer(count, 1, 125, '寄存器数量');
  if (start + count > 65536) throw new DeviceError('寄存器范围超限', 'VALIDATION');
  const data = Buffer.alloc(6); data[0] = address; data[1] = 3;
  data.writeUInt16BE(start, 2); data.writeUInt16BE(count, 4);
  return withCrc(data);
}
export function writeRequest(address, start, values) {
  integer(address, 1, 247, '设备地址'); integer(start, 0, 65535, '寄存器');
  integer(values.length, 1, 123, '数量');
  if (start + values.length > 65536) throw new DeviceError('寄存器范围超限', 'VALIDATION');
  const data = Buffer.alloc(7 + values.length * 2);
  data[0] = address; data[1] = 0x10; data.writeUInt16BE(start, 2);
  data.writeUInt16BE(values.length, 4); data[6] = values.length * 2;
  values.forEach((v, i) => { integer(v, 0, 65535, '寄存器值'); data.writeUInt16BE(v, 7 + i * 2); });
  return withCrc(data);
}
const exceptionNames = { 1: '不支持的功能码', 2: '无效寄存器地址（请检查传感器型号）', 3: '参数值无效', 4: '设备内部错误', 6: '设备忙' };
export function parseResponse(frame, request) {
  if (!validCrc(frame)) throw new DeviceError('CRC 校验失败，读数已丢弃；检查接线、波特率及透传设置', 'CRC');
  if (frame[0] !== request[0]) throw new DeviceError('响应设备地址不匹配', 'ADDRESS');
  if (frame[1] === (request[1] | 0x80))
    throw new DeviceError(`Modbus 异常 ${frame[2]}：${exceptionNames[frame[2]] || '未知错误'}`, 'MODBUS_EXCEPTION');
  if (frame[1] !== request[1]) throw new DeviceError('功能码不匹配', 'FUNCTION');
  if (frame[1] === 3) {
    const count = request.readUInt16BE(4);
    if (frame[2] !== count * 2 || frame.length !== count * 2 + 5)
      throw new DeviceError('响应长度与请求寄存器数量不一致', 'LENGTH');
    return Array.from({ length: count }, (_, i) => frame.readUInt16BE(3 + i * 2));
  }
  if (frame.length === 8 && frame.subarray(2, 6).equals(request.subarray(2, 6))) return { acknowledgement: 'standard' };
  if (frame.equals(request)) return { acknowledgement: 'vendor-echo' };
  throw new DeviceError('写入响应与请求不一致', 'WRITE_ACK');
}
// Stream framing: TCP packet boundaries are unrelated to RTU frame boundaries.
export function extractFrame(buffer, request) {
  for (let i = 0; i < buffer.length - 1; i++) {
    if (buffer[i] !== request[0]) continue;
    const fn = buffer[i + 1];
    if (fn !== request[1] && fn !== (request[1] | 0x80)) continue;
    const rest = buffer.subarray(i);
    if (rest.length < 3) return null;
    let length = fn & 0x80 ? 5 : fn === 3 ? 5 + rest[2] : 8;
    if (fn === 3 && (rest[2] > 250 || rest[2] % 2)) continue;
    if (rest.length < length) return null;
    if (fn === 0x10 && !validCrc(rest.subarray(0, 8))) {
      length = request.length;
      if (rest.length < length) return null;
    }
    return Buffer.from(rest.subarray(0, length));
  }
  return null;
}
export const METRICS = [
  { key: 'temperature', label: '土壤温度', unit: '°C', register: 0, scale: 10, signed: true, min: -40, max: 80 },
  { key: 'moisture', label: '体积含水率', unit: '%', register: 1, scale: 10, min: 0, max: 100 },
  { key: 'ec', label: '电导率', unit: 'µS/cm', register: 2, scale: 1, min: 0, max: 20000 },
  { key: 'salinity', label: '盐分', unit: 'ppm', register: 3, scale: 1 },
  { key: 'nitrogen', label: '氮 · N', unit: 'mg/kg', register: 4, scale: 1 },
  { key: 'phosphorus', label: '磷 · P', unit: 'mg/kg', register: 5, scale: 1 },
  { key: 'potassium', label: '钾 · K', unit: 'mg/kg', register: 6, scale: 1 },
  { key: 'ph', label: '酸碱度', unit: 'pH', register: 7, scale: 10, min: 3, max: 9 }
];
export function decodeRegisters(registers, start = 0, enabled = METRICS.map(m => m.key)) {
  const values = {}, warnings = [];
  for (const metric of METRICS) {
    if (!enabled.includes(metric.key)) { values[metric.key] = null; continue; }
    let raw = registers[metric.register - start];
    if (raw === undefined) { values[metric.key] = null; continue; }
    if (metric.signed && raw & 0x8000) raw -= 65536;
    const value = raw / metric.scale; values[metric.key] = value;
    if ((metric.min !== undefined && value < metric.min) || (metric.max !== undefined && value > metric.max))
      warnings.push(`${metric.label} 超出说明书量程，请检查型号及数据`);
  }
  return { values, warnings };
}
