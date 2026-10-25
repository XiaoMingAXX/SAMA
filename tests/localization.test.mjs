import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EN, translate, englishMessage } from '../public/locales.mjs';

test('every static text and accessible attribute has a complete English translation', () => {
  const html = fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const decode = value => value.replace(/&(?:amp|quot|lt|gt);|&#x27;/g, entity => ({'&amp;':'&','&quot;':'"','&lt;':'<','&gt;':'>','&#x27;':"'"}[entity]));
  const keys = [...html.matchAll(/data-i18n(?:-(?:title|aria-label|placeholder|alt))?="([^"]+)"/g)].map(match => decode(match[1]));
  assert.ok(keys.length > 200);
  for (const key of keys) { assert.ok(Object.hasOwn(EN,key),key); assert.ok(!/[\u3400-\u9fff]/.test(translate('en',key)),key); assert.equal(translate('zh',key),key); }
});
test('locale templates preserve numbers, units and device register values', () => {
  assert.equal(translate('en','每 {seconds} 秒',{seconds:5}),'Every 5 seconds');
  assert.equal(translate('zh','每 {seconds} 秒',{seconds:5}),'每 5 秒');
  assert.equal(translate('en','{metric}趋势，{count}个采样点，最新{value}{unit}',{metric:'Conductivity',count:12,value:842,unit:'µS/cm'}),'Conductivity trend, 12 samples, latest 842 µS/cm');
  const baudHint = translate('en','填写厂家确认的原始寄存器值（十进制或 0x 十六进制）。手册 19200 示例为 0x1920，其他档位编码有歧义。写入后同步设置网关并恢复采集。');
  assert.match(baudHint,/19200/); assert.match(baudHint,/0x1920/);
  assert.equal(translate('en','02 03 00 00 00 08 44 3F'),'02 03 00 00 00 08 44 3F');
  assert.equal(translate('en','orchid-bed-01'),'orchid-bed-01');
});
test('API, Modbus and uncertain-write messages retain actionable technical details in English', () => {
  assert.equal(englishMessage('设备地址 必须是 1–247 之间的整数'),'Device address must be an integer from 1–247');
  assert.match(englishMessage('Modbus 异常 2：无效寄存器地址（请检查传感器型号）'),/Modbus exception 2: Invalid register address/);
  assert.match(englishMessage('网关连接错误：ECONNREFUSED'),/ECONNREFUSED/);
  const uncertain=englishMessage('写入结果未确认，未自动重试。设备可能已生效：baudRegister=6432。请同步网关串口参数后读取验证。传感器响应超时：检查 A/B 接线、地址和 9600/8/N/1 设置');
  assert.match(uncertain,/baudRegister=6432/); assert.match(uncertain,/9600\/8\/N\/1/);assert.ok(!/[\u3400-\u9fff]/.test(uncertain));
  const partial=englishMessage('网关拒绝 AT+UARTBUF：+ERR=-4 已完成：AT+UARTTM；其他步骤未确认，请重新读取设备配置。');
  assert.match(partial,/AT\+UARTBUF: \+ERR=-4/);assert.match(partial,/Completed: AT\+UARTTM/);assert.ok(!/[\u3400-\u9fff]/.test(partial));
});
