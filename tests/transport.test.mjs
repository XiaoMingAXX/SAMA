import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { RtuTcpTransport } from '../lib/transport.mjs';
import { readRequest, writeRequest, withCrc } from '../lib/modbus.mjs';

async function bridge(t, handler) {
  const sockets = new Set(); let count = 0;
  const server = net.createServer(socket => {
    count++; sockets.add(socket); socket.on('close',()=>sockets.delete(socket));
    socket.on('error',()=>{}); socket.on('data',request => handler(socket,request,count));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const transport = new RtuTcpTransport({host:'127.0.0.1',port:server.address().port,timeoutMs:120});
  t.after(async () => { transport.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return transport;
}
test('actual TCP fragmented response is assembled without packet-boundary assumptions', async t => {
  const transport = await bridge(t,(socket) => {
    const frame = withCrc(Buffer.from([2,3,2,1,44])); socket.write(Buffer.from('startup'));
    socket.write(frame.subarray(0,2)); setTimeout(()=>socket.write(frame.subarray(2,5)),10); setTimeout(()=>socket.write(frame.subarray(5)),25);
  });
  const result = await transport.exchange(readRequest(2,0,1)); assert.deepEqual(result.result,[300]);
});
test('CRC failure destroys connection and the next request reconnects', async t => {
  const transport = await bridge(t,(socket,request,count) => {
    const frame = withCrc(Buffer.from([2,3,2,0,42])); if(count===1) frame[3] ^= 1; socket.write(frame);
  });
  await assert.rejects(transport.exchange(readRequest(2,0,1)),{code:'CRC'});
  assert.deepEqual((await transport.exchange(readRequest(2,0,1))).result,[42]);
});
test('timeout discards a late response and reconnects before next transaction', async t => {
  const transport = await bridge(t,(socket,request,count) => {
    const frame = withCrc(Buffer.from([2,3,2,0,count]));
    if(count===1) setTimeout(()=>{if(!socket.destroyed) socket.write(frame);},200); else socket.write(frame);
  });
  await assert.rejects(transport.exchange(readRequest(2,0,1)),{code:'TIMEOUT'});
  assert.deepEqual((await transport.exchange(readRequest(2,0,1))).result,[2]);
});
test('write acknowledgement can arrive in fragments with vendor echo format', async t => {
  const transport = await bridge(t,(socket,request) => { socket.write(request.subarray(0,8)); setTimeout(()=>socket.write(request.subarray(8)),20); });
  const response = await transport.exchange(writeRequest(2,128,[3])); assert.equal(response.result.acknowledgement,'vendor-echo');
});
