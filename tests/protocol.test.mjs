import test from 'node:test';
import assert from 'node:assert/strict';
import { crc16, withCrc, validCrc, readRequest, writeRequest, parseResponse, decodeRegisters, extractFrame } from '../lib/modbus.mjs';
import { gatewayPlan, escapeAt, lanHost, discover } from '../lib/gateway.mjs';

test('CRC matches canonical vector and the independently supplied vendor frame', () => {
  assert.equal(crc16(Buffer.from('123456789')), 0x4b37);
  assert.equal(readRequest(2).toString('hex'), '020300000008443f');
  const frame = Buffer.from('020310012c00a3004f00270005000700120042d222','hex');
  assert.ok(validCrc(frame));
  const raw = parseResponse(frame, readRequest(2));
  assert.deepEqual(decodeRegisters(raw).values, { temperature: 30, moisture: 16.3, ec: 79, salinity: 39, nitrogen: 5, phosphorus: 7, potassium: 18, ph: 6.6 });
  // The baud-change example in the PDF has an incorrect CRC; do not copy it.
  assert.equal(validCrc(Buffer.from('021000810001021920bf99','hex')), false);
});
test('signed temperature, scale, disabled and out-of-range measurements', () => {
  const values = decodeRegisters([0xff9c,163,79,39,5,7,18,66]).values;
  assert.equal(values.temperature, -10); assert.equal(values.moisture,16.3);
  assert.equal(decodeRegisters([66],7,['ph']).values.ph,6.6);
  assert.equal(decodeRegisters([66],7,['ph']).values.nitrogen,null);
  assert.equal(decodeRegisters([900,1001,20001,0,0,0,0,20]).warnings.length,4);
});
test('invalid CRC, unexpected address/count and Modbus exception are rejected', () => {
  const request = readRequest(2,0,1), good = withCrc(Buffer.from([2,3,2,1,44]));
  const bad = Buffer.from(good); bad[3] ^= 1;
  assert.throws(() => parseResponse(bad,request),{ code: 'CRC' });
  assert.throws(() => parseResponse(withCrc(Buffer.from([3,3,2,1,44])),request),{ code: 'ADDRESS' });
  assert.throws(() => parseResponse(good,readRequest(2,0,8)),{ code: 'LENGTH' });
  assert.throws(() => parseResponse(withCrc(Buffer.from([2,0x83,2])),request),{ code: 'MODBUS_EXCEPTION' });
});
test('standard and vendor echo write acknowledgements are validated', () => {
  const request = writeRequest(2,0x80,[3]);
  assert.equal(request.length,11);
  assert.equal(parseResponse(withCrc(request.subarray(0,6)),request).acknowledgement,'standard');
  assert.equal(parseResponse(request,request).acknowledgement,'vendor-echo');
  assert.throws(() => parseResponse(withCrc(Buffer.from([2,16,0,129,0,1])),request),{ code: 'WRITE_ACK' });
});
test('RTU framing handles noise, fragmentation, glued packets and exception frames', () => {
  const request = readRequest(2,0,1), frame = withCrc(Buffer.from([2,3,2,0,25]));
  assert.equal(extractFrame(frame.subarray(0,4),request),null);
  assert.deepEqual(extractFrame(Buffer.concat([Buffer.from('noise'),frame,frame]),request),frame);
  const write = writeRequest(2,128,[3]);
  assert.equal(extractFrame(write.subarray(0,8),write),null);
  assert.deepEqual(extractFrame(write,write),write);
  const exception = withCrc(Buffer.from([2,0x83,2]));
  assert.deepEqual(extractFrame(exception,request),exception);
});
test('broadcast writes, invalid ranges and fractional values are blocked', () => {
  assert.throws(() => writeRequest(0,128,[3]),{ code:'VALIDATION' });
  assert.throws(() => readRequest(2,65535,2),{ code:'VALIDATION' });
  assert.throws(() => writeRequest(2,65535,[1,2]),{ code:'VALIDATION' });
  assert.throws(() => readRequest(2.1),{ code:'VALIDATION' });
  assert.throws(() => readRequest(2,0,126),{ code:'VALIDATION' });
});
test('gateway AT plans follow this manual, escape delimiters and reject injection', () => {
  const plan = gatewayPlan({ uart:{ baud:9600,parity:'NONE',stopBits:1 }, wifi:{ ssid:'test,=?',password:'pass,=?word',mode:'APSTA' }, packet:{ intervalMs:20,bytes:1400 } });
  assert.equal(plan.commands[0].command,'AT+UART=9600,8,1,NONE,NFC');
  assert.equal(plan.commands[1].command,'AT+WSSSID=test\\2C\\3D\\3F');
  assert.equal(plan.commands[2].command,'AT+WSKEY=pass\\2C\\3D\\3Fword');
  assert.equal(plan.commands[2].sensitive,true);
  assert.equal(escapeAt('a\\b'),'a\\5Cb');
  assert.throws(() => gatewayPlan({wifi:{ssid:'x\rAT+Z',password:'12345678',mode:'STA'}}),{code:'VALIDATION'});
  assert.throws(() => gatewayPlan({ip:{mode:'static',address:'192.168.1.50',mask:'255.0.255.0',gateway:'192.168.1.1'}}),{code:'VALIDATION'});
  assert.throws(() => lanHost('8.8.8.8'),{code:'VALIDATION'});
  assert.throws(() => lanHost('10.0.0.1/path'),{code:'VALIDATION'});
});
test('searching on a non-local interface reports a bind error without crashing the service', async () => {
  await assert.rejects(discover({ localAddress:'192.168.255.253' }),error => ['EADDRNOTAVAIL','EINVAL'].includes(error.code));
});
