import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import dgram from 'node:dgram';
import http from 'node:http';
import { createServer } from '../server.mjs';
import { withCrc } from '../lib/modbus.mjs';

test('service integrates shared readings, history persistence, CSV, configs and CSRF guards', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'loam-service-'));
  let runtime = await createServer({port:0,host:'127.0.0.1',dataDir:directory,polling:false});
  t.after(async()=>{await runtime.close(); fs.rmSync(directory,{recursive:true,force:true});});
  let base = `http://127.0.0.1:${runtime.port}`;
  const call = async (route,input) => {
    const response = await fetch(`${base}/api/${route}`,input===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-Loam-Request':'1'},body:JSON.stringify(input)});
    return { status:response.status, data: await response.json() };
  };
  assert.equal((await call('state')).data.config.address,2);
  const reads = await Promise.all(Array.from({length:6},()=>call('read',{})));
  assert.ok(reads.every(r=>r.status===200 && r.data.source==='demo'));
  assert.equal(new Set(reads.map(r=>r.data.id)).size,6);
  assert.equal((await call('history')).data.samples.length,6);
  const csv = await (await fetch(`${base}/api/export.csv`)).text(); assert.match(csv,/timestamp,source,host,address/); assert.match(csv,/"demo"/);
  const sensor = (await call('sensor/config',{})).data; assert.equal(sensor.address,2); assert.equal(sensor.dataBits,8);
  assert.equal((await call('sensor/write',{parameter:'address',value:3})).status,400);
  assert.equal((await call('sensor/write',{parameter:'address',value:3,confirm:true})).status,200);
  assert.equal((await call('state')).data.config.address,3);
  assert.equal((await call('read',{})).data.address,3);
  const serial = await call('sensor/write',{parameter:'stopBits',value:2,confirm:true}); assert.equal(serial.data.pollingPaused,true);
  assert.equal((await call('sensor/config',{})).data.stopBits,2);
  assert.equal((await call('gateway/read',{})).status,400);
  assert.equal((await call('config',{address:0})).status,400);
  assert.equal((await call('config',{host:'8.8.8.8'})).status,400);
  assert.equal((await call('registers/read',{start:65535,count:2})).status,400);
  const csrf = await fetch(`${base}/api/config`,{method:'POST',headers:{'Content-Type':'application/json','X-Loam-Request':'1',Origin:'https://evil.example'},body:'{}'}); assert.equal(csrf.status,403);
  const blind = await fetch(`${base}/api/read`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}); assert.equal(blind.status,403);
  const reboundStatus = await new Promise((resolve,reject) => {
    const request = http.get(`${base}/api/state`, { headers: { Host: `untrusted.example:${runtime.port}` } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error',reject);
  });
  assert.equal(reboundStatus,403);
  assert.equal((await fetch(`${base}/data/settings.json`)).status,404);
  assert.equal((await fetch(`${base}/`)).status,200);
  for (const asset of ['i18n.mjs','locales.mjs']) {
    const moduleResponse = await fetch(`${base}/${asset}`); assert.equal(moduleResponse.status,200); assert.match(moduleResponse.headers.get('content-type'),/javascript/);
  }
  await runtime.close(); runtime = await createServer({port:0,host:'127.0.0.1',dataDir:directory,polling:false}); base = `http://127.0.0.1:${runtime.port}`;
  assert.equal((await call('state')).data.config.address,3);
  assert.equal((await call('history')).data.samples.length,1);
});

test('real TCP hardware mode and SSE deliver the same CRC-validated reading to two LAN clients', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'loam-hardware-')), sockets = new Set();
  let active = 0, maxActive = 0;
  const bridge = net.createServer(socket=>{
    sockets.add(socket); socket.on('close',()=>sockets.delete(socket)); socket.on('error',()=>{});
    socket.on('data',()=>{
      active++; maxActive=Math.max(maxActive,active);
      const frame=Buffer.from('020310012c00a3004f00270005000700120042d222','hex');
      setTimeout(()=>{socket.write(frame.subarray(0,4)); setTimeout(()=>{socket.write(frame.subarray(4)); active--;},5);},10);
    });
  });
  await new Promise(resolve=>bridge.listen(0,'127.0.0.1',resolve));
  const runtime = await createServer({port:0,host:'127.0.0.1',dataDir:directory,polling:false}), base=`http://127.0.0.1:${runtime.port}`;
  const call = async (route,input) => {const r=await fetch(`${base}/api/${route}`,{method:'POST',headers:{'Content-Type':'application/json','X-Loam-Request':'1'},body:JSON.stringify(input)}); assert.equal(r.status,200); return r.json();};
  const aborters = [new AbortController(),new AbortController()];
  t.after(async()=>{aborters.forEach(a=>a.abort()); await runtime.close(); for(const socket of sockets) socket.destroy(); await new Promise(resolve=>bridge.close(resolve)); fs.rmSync(directory,{recursive:true,force:true});});
  await call('config',{mode:'hardware',host:'127.0.0.1',port:bridge.address().port,polling:false});
  async function waitSample(response) {
    const reader=response.body.getReader(); let text='';
    for(;;){const part=await reader.read(); if(part.done)throw new Error('SSE ended'); text+=new TextDecoder().decode(part.value); const match=text.match(/event: sample\ndata: ([^\n]+)/); if(match){const sample=JSON.parse(match[1]); await reader.cancel(); return sample;}}
  }
  // Both subscriptions must be established before reads begin. Concurrent HTTP
  // requests may reach the server in a different order than the input array.
  const subscriptions=await Promise.all(aborters.map(controller=>fetch(`${base}/api/events`,{signal:controller.signal})));
  const clients=subscriptions.map(waitSample);
  const results=await Promise.all(Array.from({length:3},()=>call('read',{})));
  const streamed=await Promise.all(clients);
  assert.equal(streamed[0].id,streamed[1].id); assert.ok(results.some(sample=>sample.id===streamed[0].id));
  assert.equal(streamed[0].source,'hardware'); assert.equal(streamed[0].values.moisture,16.3);
  assert.equal(maxActive,1);
});

test('UDP configuration compatibility is tested against a fake HF gateway, including partial failure', async t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'loam-gateway-')), socket=dgram.createSocket('udp4');
  const received=[];
  socket.on('message',(data,peer)=>{
    const command=data.toString().trim(); received.push(command);
    const send=text=>socket.send(Buffer.from(text),peer.port,peer.address);
    if(command==='HF-A11ASSISTHREAD') send('127.0.0.1,AABBCCDDEEFF,FTX-W80');
    else if(command==='+ok') return;
    else if(command.startsWith('AT+UARTBUF=')) send('+ERR=-4\r\n\r\n');
    else send('+ok=mock\r\n\r\n');
  });
  await new Promise((resolve,reject)=>{socket.once('error',reject);socket.bind(48899,'127.0.0.1',resolve);});
  const runtime=await createServer({port:0,host:'127.0.0.1',dataDir:directory,polling:false}), base=`http://127.0.0.1:${runtime.port}`;
  t.after(async()=>{await runtime.close();socket.close();fs.rmSync(directory,{recursive:true,force:true});});
  const call=async(route,input)=>{const r=await fetch(`${base}/api/${route}`,{method:'POST',headers:{'Content-Type':'application/json','X-Loam-Request':'1'},body:JSON.stringify(input)});return {status:r.status,data:await r.json()};};
  await call('config',{mode:'hardware',host:'127.0.0.1',polling:false});
  const read=await call('gateway/read',{}); assert.equal(read.status,200); assert.match(read.data.values.UART,/mock/);
  const apply=await call('gateway/apply',{confirm:true,settings:{packet:{intervalMs:20,bytes:1400}}});
  assert.equal(apply.status,502);assert.match(apply.data.message,/已完成：AT\+UARTTM/);
  assert.ok(received.includes('AT+UARTTM=20')); assert.ok(received.includes('AT+UARTBUF=1400'));assert.ok(!received.includes('AT+Z'));
});
