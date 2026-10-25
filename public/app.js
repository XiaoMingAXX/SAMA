import { t, getLanguage, setLanguage, applyTranslations } from './i18n.mjs';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const paths = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.4"/><rect x="14" y="3" width="7" height="7" rx="1.4"/><rect x="3" y="14" width="7" height="7" rx="1.4"/><rect x="14" y="14" width="7" height="7" rx="1.4"/>',
  chart: '<path d="M4 3v17h17M7 15l4-5 4 3 5-8"/>',
  sliders: '<path d="M4 7h5m4 0h7M4 17h9m4 0h3"/><circle cx="11" cy="7" r="2"/><circle cx="15" cy="17" r="2"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3m6 0h4"/>',
  book: '<path d="M12 5v16M12 5C9 3 6 3 3 4v15c3-1 6-1 9 2 3-3 6-3 9-2V4c-3-1-6-1-9 1Z"/>',
  refresh: '<path d="M20 7a8 8 0 1 0 0 10M20 3v5h-5"/>',
  spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/>',
  'arrow-up-right': '<path d="M6 18 18 6M6 6h12v12"/>',
  'arrow-right': '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  leaf: '<path d="M5 20C-2 6 9 3 21 3c0 12-2 20-13 15M4 21l12-12"/>',
  droplet: '<path d="M12 2S5 10 5 15a7 7 0 0 0 14 0C19 10 12 2 12 2Z"/><path d="M8 15c0 2 1 3 3 3"/>',
  thermometer: '<path d="M9 14V5a3 3 0 0 1 6 0v9a5 5 0 1 1-6 0Zm3-7v11"/>',
  bolt: '<path d="m13 2-8 12h6l-1 8 9-13h-6z"/>',
  flask: '<path d="M8 3h8M10 3v7L4 20a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1l-6-10V3M7 16h10"/>'
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.grid}</svg>`;
document.querySelectorAll('[data-icon]').forEach(el => el.innerHTML = icon(el.dataset.icon));
const metrics = [
  { key: 'moisture', label: '体积含水率', english: 'WATER CONTENT', unit: '%', decimals: 1, icon: 'droplet', hint: 'FDR · 体积百分比' },
  { key: 'temperature', label: '土壤温度', english: 'TEMPERATURE', unit: '°C', decimals: 1, icon: 'thermometer', hint: 'NTC · 土壤温度' },
  { key: 'ec', label: '电导率', english: 'CONDUCTIVITY', unit: 'µS/cm', decimals: 0, icon: 'bolt', hint: 'EC · 电导率' },
  { key: 'ph', label: '酸碱度', english: 'ACIDITY', unit: 'pH', decimals: 1, icon: 'flask', hint: '首次稳定 > 5 分钟' }
];
const nutrients = [{ key: 'nitrogen', label: '氮含量', symbol: 'N', unit: 'mg/kg' }, { key: 'phosphorus', label: '磷含量', symbol: 'P', unit: 'mg/kg' }, { key: 'potassium', label: '钾含量', symbol: 'K', unit: 'mg/kg' }, { key: 'salinity', label: '盐分', symbol: 'S', unit: 'ppm' }];
let state, info, samples = [], logs = [], chartKey = 'moisture', chartRange = 1, historyPage = 0, historyRange = 0;
let identity = '', configSignature = '', plan = null, planSettings = null, toastTimer, serviceOnline = false, chartPoints = [];
let sensorResult, sensorWriteResult, gatewayResult, discoveryResult, discoveryMessage, activeToast, pendingDialog;
let sensorMessage, gatewayMessage, planMessage;
const time = (stamp, withDate = false) => !stamp ? '—' : new Intl.DateTimeFormat(getLanguage() === 'en' ? 'en-SG' : 'zh-CN', { timeZone: 'Asia/Singapore', ...(withDate ? { month: '2-digit', day: '2-digit' } : {}), hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(stamp));
const number = (value, decimals = 0) => value === null || value === undefined ? '—' : Number(value).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
function renderToast() { if (activeToast) $('toast').textContent = t(activeToast.message, { ...activeToast.parameters, ...(activeToast.parameters.error ? { error: t(activeToast.parameters.error) } : {}) }); }
function toast(message, error = false, parameters = {}) { clearTimeout(toastTimer); activeToast = { message, parameters }; renderToast(); $('toast').classList.toggle('error', error); $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; activeToast = null; }, error ? 10000 : 4500); }
async function api(path, data) {
  const response = await fetch(`/api/${path}`, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Loam-Request': '1' }, body: JSON.stringify(data) });
  const result = await response.json(); if (!response.ok) throw new Error(result.message || '请求未完成'); return result;
}
async function run(button, fn) {
  if (button.disabled) return; const original = button.innerHTML; button.disabled = true; button.setAttribute('aria-busy', 'true');
  try { await fn(); } catch (error) { toast(error.message, true); }
  finally { button.innerHTML = original; applyTranslations(button); button.disabled = false; button.removeAttribute('aria-busy'); }
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); }
  catch { const area = document.createElement('textarea'); area.value = text; document.body.append(area); area.select(); const success = document.execCommand('copy'); area.remove(); if (!success) throw new Error('浏览器不支持复制，请手动选择文本。'); }
  toast('已复制到剪贴板');
}
function renderDialog() {
  if (!pendingDialog) return;
  const parameters = { ...pendingDialog.parameters, ...(pendingDialog.parameters.source ? { source: t(pendingDialog.parameters.source) } : {}) };
  $('confirm-title').textContent = t(pendingDialog.title, parameters); $('confirm-message').textContent = t(pendingDialog.message);
  $('confirm-detail').textContent = pendingDialog.detail; $('confirm-detail').hidden = !pendingDialog.detail;
}
function confirmChange(title, message, detail = '', parameters = {}) {
  return new Promise(resolve => {
    const dialog = $('confirm-dialog'); pendingDialog = { title, message, detail, parameters }; renderDialog();
    dialog.returnValue = 'cancel'; dialog.addEventListener('close', () => { pendingDialog = null; resolve(dialog.returnValue === 'confirm'); }, { once: true }); dialog.showModal();
  });
}
function navigate() {
  const page = ['overview','history','settings','diagnostics','guide'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
  document.querySelectorAll('.page').forEach(el => el.hidden = el.id !== `page-${page}`);
  document.querySelectorAll('nav a').forEach(el => el.classList.toggle('active', el.dataset.page === page));
  $('breadcrumb').textContent = t({ overview: '观测总览', history: '数据档案', settings: '设备配置', diagnostics: '通信诊断', guide: '接入指南' }[page]);
  if (page === 'history') renderHistory(); if (page === 'diagnostics') renderLogs(); if (page === 'overview') renderChart();
}
window.addEventListener('hashchange', navigate); navigate();
function buildMetrics() {
  $('metrics').innerHTML = metrics.map(m => `<button class="metric-card ${m.key === chartKey ? 'selected' : ''}" data-metric="${m.key}" aria-label="${esc(t('查看{metric}趋势', { metric: t(m.label) }))}"><div class="metric-top"><span class="metric-icon">${icon(m.icon)}</span><div>${t(m.label)}<div class="metric-caption">${m.english}</div></div></div><div class="metric-number"><span id="value-${m.key}">—</span><small>${m.unit}</small></div><div class="metric-bottom"><span id="hint-${m.key}">${t(m.hint)}</span><svg viewBox="0 0 70 20" aria-hidden="true" id="spark-${m.key}"></svg></div></button>`).join('');
  $('chart-tabs').innerHTML = metrics.map(m => `<button data-metric="${m.key}" class="${m.key === chartKey ? 'active' : ''}">${t(m.label)}</button>`).join('');
  $('nutrients').innerHTML = nutrients.map(n => `<div class="nutrient-row"><div class="nutrient-label"><span class="nutrient-symbol">${n.symbol}</span>${t(n.label)}</div><div class="nutrient-val"><span id="value-${n.key}">—</span><small>${n.unit}</small></div></div>`).join('');
}
buildMetrics();
function markService(online) {
  serviceOnline = online; $('service-pill').classList.toggle('off', !online);
  $('service-pill').innerHTML = `<i></i>${t(online ? '局域网服务在线' : '服务连接中断')}`;
}
function applyState(next) {
  const previousIdentity = identity; state = next;
  identity = JSON.stringify([state.config.mode,state.config.host,state.config.port,state.config.address,state.config.metrics]);
  if (previousIdentity && previousIdentity !== identity) { samples = []; historyPage = 0; sensorResult = sensorWriteResult = gatewayResult = null; sensorMessage = '连接已更改，请重新读取设备配置'; gatewayMessage = '连接已更改，请重新读取网关'; renderAuxiliary(); reloadHistory().catch(e => toast(e.message, true)); }
  const signature = JSON.stringify(state.config);
  if (signature !== configSignature) { if (!$('connection-form').dataset.dirty) fillConnection(); configSignature = signature; }
  renderState();
}
function renderState() {
  if (!state) return;
  const c = state.config, v = state.latest?.values || {}, demo = c.mode === 'demo';
  $('demo-banner').hidden = !demo; $('mode-badge').textContent = t(demo ? '模拟观测' : '真实设备'); $('mode-badge').classList.toggle('hardware', !demo);
  $('side-device').textContent = c.label; $('side-state').textContent = t(state.status === 'error' ? (c.polling ? '连接异常 · 自动重连' : '连接异常 · 采集已暂停') : state.status === 'reading' ? '采样中' : !c.polling ? '自动采集已暂停' : demo ? '模拟设备 · 自动采集' : state.status === 'online' ? '真实设备 · 已收到读数' : '等待设备响应');
  document.querySelector('.device-led').classList.toggle('off', state.status === 'error');
  $('hero-status').textContent = demo ? 'SIMULATED OBSERVATION' : 'LIVE SOIL OBSERVATION';
  $('hero-moisture').textContent = number(v.moisture, 1); $('hero-device').textContent = c.label; $('hero-time').textContent = state.latest ? `${time(state.latest.timestamp)} · SGT` : t('等待首次采样');
  $('session-source').textContent = demo ? t('模拟设备') : `${c.host}:${c.port}`;
  $('session-interval').textContent = c.polling ? t('每 {seconds} 秒', { seconds: c.pollIntervalMs / 1000 }) : t('手动采集');
  $('session-last').textContent = time(state.latest?.timestamp); $('session-count').innerHTML = `${state.successCount} <small>${t('次')}</small>`;
  $('session-note').textContent = t(!c.polling ? '自动采集暂停，可手动采样' : state.status === 'error' ? '通信异常，等待重连' : demo ? '模拟数据 · 不代表真实土壤' : '连接由电脑统一管理');
  $('error-banner').hidden = !state.lastError;
  if (state.lastError) $('error-banner').textContent = `${t(state.lastError.message)} (${time(state.lastError.timestamp)})`;
  for (const m of [...metrics,...nutrients]) $(`value-${m.key}`).textContent = number(v[m.key], m.decimals || 0);
  for (const m of metrics) {
    const enabled = c.metrics.includes(m.key), warnings = state.latest?.warnings || [];
    $(`hint-${m.key}`).textContent = t(!enabled ? '此测量项未启用' : warnings.some(w => w.includes(m.label) || (m.key === 'moisture' && w.includes('含水'))) ? '超出量程 · 请检查' : m.hint);
    document.querySelector(`.metric-card[data-metric="${m.key}"]`).classList.toggle('warning', warnings.some(w => w.includes(m.label)));
    const values = samples.slice(-20).map(s => s.values[m.key]).filter(x => x !== null && x !== undefined);
    if (values.length > 1) {
      const min = Math.min(...values), max = Math.max(...values), span = Math.max(max - min, .1);
      $(`spark-${m.key}`).innerHTML = `<path d="${values.map((val,i) => `${i ? 'L' : 'M'}${i / (values.length - 1) * 70},${18 - (val - min) / span * 15}`).join(' ')}"/>`;
    } else $(`spark-${m.key}`).innerHTML = '';
  }
  $('gateway-web').href = `http://${c.host}`;
  $('diagnostic-stats').innerHTML = [{ v: state.successCount, l: '成功采样' }, { v: state.errorCount, l: '采样异常' }, { v: c.address, l: 'Modbus 设备地址' }].map(x => `<div class="diagnostic-stat"><strong>${x.v}</strong><span>${t(x.l)}</span></div>`).join('');
  freshness(); renderChart();
}
function freshness() {
  if (!state?.latest) { $('freshness').textContent = t('等待首次采样'); return; }
  const age = Math.max(0, Math.round((Date.now() - Date.parse(state.latest.timestamp)) / 1000));
  const stale = age * 1000 > Math.max(state.config.pollIntervalMs * 3, 15000);
  $('freshness').textContent = t(age < 60 ? '{count} 秒前更新' : '{count} 分钟前更新', { count: age < 60 ? age : Math.floor(age / 60) }) + (stale ? t(' · 数据已过期') : '');
  $('freshness').style.color = stale ? '#a87555' : '';
}
function fillConnection() {
  const f = $('connection-form');
  for (const [key,value] of Object.entries(state.config)) {
    if (key === 'metrics') continue;
    const el = f.elements.namedItem(key); if (!el) continue;
    if (key === 'mode') { f.querySelectorAll('[name=mode]').forEach(radio => radio.checked = radio.value === value); }
    else if (key === 'polling') el.checked = value; else el.value = value;
  }
  document.querySelectorAll('[name=metric]').forEach(el => el.checked = state.config.metrics.includes(el.value));
}
async function reloadHistory() {
  const requestedIdentity = identity, result = await api('history');
  if (requestedIdentity !== identity) return;
  const combined = new Map(result.samples.map(s => [s.id,s])); samples.forEach(s => combined.set(s.id,s));
  samples = [...combined.values()].sort((a,b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)).slice(-10000);
  renderState(); renderHistory();
}
function addSample(sample) {
  if (sample.source !== state?.config.mode || sample.address !== state.config.address || (sample.source === 'hardware' && sample.host !== state.config.host)) return;
  if (!samples.some(s => s.id === sample.id)) { samples.push(sample); if (samples.length > 10000) samples.shift(); }
  if (state) state.latest = sample;
  renderState(); if (location.hash === '#history') renderHistory();
}
function renderChart() {
  const metric = metrics.find(m => m.key === chartKey), svg = $('trend-chart');
  document.querySelectorAll('[data-metric]').forEach(el => el.classList.toggle(el.classList.contains('metric-card') ? 'selected' : 'active', el.dataset.metric === chartKey));
  $('chart-value').textContent = number(state?.latest?.values[chartKey], metric.decimals); $('chart-unit').textContent = metric.unit;
  $('chart-source').textContent = t(state?.config.mode === 'hardware' ? '真实设备' : '模拟数据');
  const rows = samples.filter(s => Date.parse(s.timestamp) >= Date.now() - chartRange * 3600000 && s.values[chartKey] != null);
  $('chart-sample-count').textContent = t('{count} 个采样点 · {metric}', { count: rows.length, metric: t(metric.label) });
  const width = 800, left = 48, right = 780, top = 16, bottom = 174;
  const defs = '<defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#b1c38c" stop-opacity=".28"/><stop offset="100%" stop-color="#b1c38c" stop-opacity=".02"/></linearGradient></defs>';
  if (!rows.length) { chartPoints = []; svg.innerHTML = `${defs}<path d="M48 174H780" stroke="#e8eedf"/><text x="410" y="96" fill="#93a480" text-anchor="middle" font-size="12">${t(state?.config.metrics.includes(chartKey) ? '首次采样后，趋势从这里开始。' : '此测量项未启用，请在连接配置中选择。')}</text>`; return; }
  let min = Math.min(...rows.map(s => s.values[chartKey])), max = Math.max(...rows.map(s => s.values[chartKey]));
  const padding = Math.max((max - min) * .22, metric.decimals ? 1 : 20); min -= padding; max += padding;
  if (chartKey !== 'temperature') min = Math.max(0,min);
  const startTime = Math.max(Date.now() - chartRange * 3600000, Math.min(Date.parse(rows[0].timestamp), Date.parse(rows.at(-1).timestamp) - 60000));
  const endTime = Math.max(startTime + 60000, Date.parse(rows.at(-1).timestamp));
  chartPoints = rows.map(row => ({ row, x: left + (Date.parse(row.timestamp) - startTime) / (endTime - startTime) * (right - left), y: bottom - (row.values[chartKey] - min) / (max - min) * (bottom - top) }));
  const lines = Array.from({ length: 4 }, (_,i) => { const y = top + i / 3 * (bottom - top), value = max - i / 3 * (max - min); return `<path d="M${left} ${y}H${right}" stroke="#e8edde" stroke-dasharray="3 5"/><text x="35" y="${y+4}" text-anchor="end" fill="#9dac8d" font-size="10">${number(value,metric.decimals)}</text>`; }).join('');
  const labels = Array.from({ length: 5 }, (_,i) => `<text x="${left + i / 4 * (right-left)}" y="203" fill="#9dac8d" text-anchor="middle" font-size="9">${time(startTime+i/4*(endTime-startTime)).slice(0,5)}</text>`).join('');
  const line = chartPoints.map((p,i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' '), last = chartPoints.at(-1);
  svg.innerHTML = `${defs}${lines}${labels}${rows.length > 1 ? `<path d="${line} L${last.x} ${bottom} L${chartPoints[0].x} ${bottom} Z" fill="url(#chart-fill)"/><path d="${line}" fill="none" stroke="#809a5b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` : ''}<circle cx="${last.x}" cy="${last.y}" r="5" fill="#91a76c" stroke="#fff" stroke-width="2"/>${rows.length === 1 ? `<text x="410" y="105" text-anchor="middle" font-size="11" fill="#9aab88">${t('已收到第一个读数，继续采样以形成趋势。')}</text>` : ''}`;
  svg.setAttribute('aria-label', t('{metric}趋势，{count}个采样点，最新{value}{unit}', { metric: t(metric.label), count: rows.length, value: number(last.row.values[chartKey],metric.decimals), unit: metric.unit }));
}
$('chart-wrap').addEventListener('pointermove', event => {
  if (!chartPoints.length) return;
  const rect = $('trend-chart').getBoundingClientRect(), x = (event.clientX - rect.left) / rect.width * 800;
  const point = chartPoints.reduce((best,p) => Math.abs(p.x-x) < Math.abs(best.x-x) ? p : best), metric = metrics.find(m => m.key === chartKey);
  const tooltip = $('chart-tooltip'); tooltip.textContent = `${time(point.row.timestamp)} · ${number(point.row.values[chartKey],metric.decimals)} ${metric.unit}`;
  tooltip.hidden = false; tooltip.style.left = `${Math.max(0,Math.min(rect.width-165,event.clientX-rect.left-75))}px`; tooltip.style.top = '15px';
});
$('chart-wrap').addEventListener('pointerleave', () => $('chart-tooltip').hidden = true);
function filteredHistory() { return historyRange ? samples.filter(s => Date.parse(s.timestamp) >= Date.now() - historyRange * 3600000) : samples; }
function renderHistory() {
  const rows = filteredHistory().slice().reverse(), maxPage = Math.max(0,Math.ceil(rows.length/20)-1); historyPage = Math.min(historyPage,maxPage);
  $('history-count').textContent = t('{count} 条{source}观测', { count: rows.length.toLocaleString(), source: t(state?.config.mode === 'hardware' ? '真实' : '模拟') });
  $('history-body').innerHTML = rows.slice(historyPage*20,(historyPage+1)*20).map(row => `<tr><td>${time(row.timestamp,true)}</td><td><span class="source-chip ${row.source}">${t(row.source === 'demo' ? '模拟' : '设备')}</span></td>${['temperature','moisture','ec','ph','nitrogen','phosphorus','potassium','salinity'].map(key => `<td>${number(row.values[key], ['temperature','moisture','ph'].includes(key) ? 1 : 0)}</td>`).join('')}</tr>`).join('') || `<tr><td class="empty-state" colspan="10">${t('暂无观测记录。开启采集后，数据将自动保存在这台电脑。')}</td></tr>`;
  $('history-pagination').textContent = t('第 {page} / {total} 页 · 每页 20 条', { page: historyPage+1, total: maxPage+1 });
  $('history-prev').disabled = historyPage === 0; $('history-next').disabled = historyPage === maxPage;
  $('export-csv').href = `/api/export.csv${historyRange ? `?since=${encodeURIComponent(new Date(Date.now()-historyRange*3600000).toISOString())}` : ''}`;
}
function renderLogs() {
  $('packet-log').innerHTML = logs.slice().reverse().map(l => `<div class="packet-entry ${esc(l.kind)}"><time>${time(l.timestamp)}</time><span class="packet-kind">${esc(l.kind.toUpperCase())}</span><span>${l.source === 'demo' ? t('[模拟] ') : ''}${esc(t(l.message))}</span></div>`).join('') || `<div class="empty-state">${t('首次采样后显示通信日志')}</div>`;
}
async function refreshLogs() { logs = (await api('logs')).logs; renderLogs(); }
function renderAuxiliary() {
  if (sensorResult) {
    const result = sensorResult, colon = getLanguage() === 'en' ? ': ' : '：';
    $('sensor-settings-values').innerHTML = `<b>${t('{source}配置返回', { source: t(result.source === 'demo' ? '模拟设备' : '真实设备') })}</b><br>${t('地址')}${colon}${result.address}<br>${t('波特率寄存器原始值')}${colon}${result.baudRegister} / 0x${result.baudRegister.toString(16).toUpperCase().padStart(4,'0')}<br>${t('校验')}${colon}${result.parity} · ${t('数据位')}${colon}${result.dataBits} · ${t('停止位')}${colon}${result.stopBits}<br><span class="muted">${esc(result.raw)}</span>`;
  } else if (sensorWriteResult) {
    $('sensor-settings-values').textContent = t('设备已应答（{ack}），请点击「读取配置」验证。', { ack: sensorWriteResult.acknowledgement }) + (sensorWriteResult.pollingPaused ? t('串口参数变更：采集已暂停，请先同步网关。') : '');
  } else if (sensorMessage) $('sensor-settings-values').textContent = t(sensorMessage);
  if (gatewayResult) $('gateway-values').textContent = Object.entries(gatewayResult.values).map(([k,v]) => `${k}: ${t(v)}`).join('\n');
  else if (gatewayMessage) $('gateway-values').textContent = t(gatewayMessage);
  if (plan) $('gateway-plan').textContent = plan.commands.map(item => item.sensitive ? `${item.command.split('=')[0]}=•••• (${t('已隐藏')})` : item.command).join('\n') + `\n\n${t('# 重启后生效；请重新确认 IP 和串口参数')}`;
  else if (planMessage) $('gateway-plan').textContent = t(planMessage);
  if (discoveryResult) $('discovery-results').innerHTML = discoveryResult.devices.length ? discoveryResult.devices.map(d => `<div class="discovery-result"><div>${esc(d.ip)}<small>${esc(d.model)} · ${esc(d.mac)}</small></div><button class="button" data-use-ip="${esc(d.ip)}">${t('使用此设备')}</button></div>`).join('') : t('没有收到兼容搜索响应。检查网卡、同一局域网及隔离设置，或手动输入 IP。');
  else if (discoveryMessage) $('discovery-results').textContent = t(discoveryMessage);
  $('sensor-param-hint').textContent = t(hints[$('sensor-write-form').elements.parameter.value]);
}
function renderNetworkInfo() {
  if (!info) return;
  const checked = new Map([...document.querySelectorAll('[name=metric]')].map(el => [el.value,el.checked]));
  $('enabled-metrics').innerHTML = info.metrics.map(m => `<label class="check-label"><input type="checkbox" name="metric" value="${m.key}">${esc(t(m.label))}</label>`).join('');
  document.querySelectorAll('[name=metric]').forEach(el => el.checked = checked.has(el.value) ? checked.get(el.value) : state.config.metrics.includes(el.value));
  $('lan-addresses').innerHTML = info.addresses.map(a => `<div class="lan-address"><div><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.url)}</a><span>${esc(a.name)}</span></div><button type="button" data-copy="${esc(a.url)}">${t('复制 ↗')}</button></div>`).join('') || `<p class="muted">${t('暂未发现局域网地址，请连接 Wi-Fi 后刷新。')}</p>`;
}
document.addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.dataset.language) { setLanguage(button.dataset.language); return; }
  if (button.dataset.metric) { chartKey = button.dataset.metric; renderChart(); }
  if (button.dataset.range) { chartRange = Number(button.dataset.range); document.querySelectorAll('[data-range]').forEach(b => b.classList.toggle('active', b === button)); renderChart(); }
  if (button.dataset.settingsTab) { document.querySelectorAll('[data-settings-tab]').forEach(b => b.classList.toggle('active', b === button)); document.querySelectorAll('.settings-content').forEach(el => el.hidden = el.id !== `settings-${button.dataset.settingsTab}`); }
  if (button.dataset.copy) await run(button, () => copy(button.dataset.copy));
  if (button.dataset.useIp) { const form = $('connection-form'); form.elements.host.value = button.dataset.useIp; form.querySelector('[name=mode][value=hardware]').checked = true; form.dataset.dirty = '1'; toast('已填入设备 IP，请保存连接配置'); }
  if (!button.dataset.action) return;
  await run(button, async () => {
    switch (button.dataset.action) {
      case 'read': await api('read', {}); toast('已完成一次采样'); break;
      case 'refresh-logs': await refreshLogs(); break;
      case 'discover': {
        discoveryResult = null; discoveryMessage = '正在搜索，约 1–2 秒…'; renderAuxiliary();
        try { discoveryResult = await api('gateway/discover', { localAddress: $('discovery-interface').value || undefined }); discoveryMessage = null; renderAuxiliary();
        } catch (error) { discoveryMessage = error.message; renderAuxiliary(); throw error; } break;
      }
      case 'read-sensor': {
        sensorResult = await api('sensor/config', {}); sensorWriteResult = null; renderAuxiliary(); break;
      }
      case 'read-gateway': {
        gatewayResult = await api('gateway/read', { key: $('gateway-key').value }); renderAuxiliary(); toast(gatewayResult.compatibility); break;
      }
      case 'restart-gateway': {
        if (!await confirmChange('重启 Wi-Fi 网关？', '网络连接会中断。采集将暂停；设备重启后需重新确认 IP、连接并恢复采集。', 'AT+Z')) return;
        const result = await api('gateway/restart', { key: $('gateway-key').value, confirm: true }); toast(result.message); break;
      }
    }
  });
});
$('connection-form').addEventListener('input', () => $('connection-form').dataset.dirty = '1');
$('connection-form').addEventListener('submit', event => {
  event.preventDefault(); const form = event.currentTarget, data = new FormData(form), button = form.querySelector('[type=submit]');
  run(button, async () => {
    const config = Object.fromEntries(['label','host','mode'].map(k => [k,data.get(k)]));
    for (const k of ['port','address','timeoutMs','pollIntervalMs']) config[k] = Number(data.get(k));
    config.polling = data.has('polling'); config.metrics = data.getAll('metric');
    const result = await api('config', config); delete form.dataset.dirty; applyState(result); fillConnection(); toast(config.mode === 'hardware' ? '连接配置已保存，等待设备响应' : '已保存模拟观测配置');
  });
});
const hints = { address: '设备地址：1–247。应答后自动更新服务连接地址。', baudRegister: '填写厂家确认的原始寄存器值（十进制或 0x 十六进制）。手册 19200 示例为 0x1920，其他档位编码有歧义。写入后同步设置网关并恢复采集。', parity: '1 = 奇校验，2 = 偶校验；0 = 无校验由出厂参数推定，需实机确认。写入后同步网关。', dataBits: '此组合仅支持 8 数据位。', stopBits: '1 或 2。写入后同步网关停止位。' };
$('sensor-write-form').elements.parameter.addEventListener('change', event => $('sensor-param-hint').textContent = t(hints[event.target.value]));
function parseInteger(value) { if (!/^(?:\d+|0x[\da-f]+)$/i.test(value.trim())) throw new Error('请输入整数或 0x 开头的十六进制值'); return Number(value); }
$('sensor-write-form').addEventListener('submit', event => {
  event.preventDefault(); const form = event.currentTarget;
  run(form.querySelector('[type=submit]'), async () => {
    const parameter = form.elements.parameter.value, value = parseInteger(form.elements.value.value);
    if (!await confirmChange('修改{source}传感器配置？', hints[parameter], `${parameter} → ${value} / 0x${value.toString(16).toUpperCase()}`, { source: state.config.mode === 'demo' ? '模拟' : '真实' })) return;
    sensorWriteResult = await api('sensor/write', { parameter, value, confirm: true }); sensorResult = null; renderAuxiliary();
    toast('写入已应答，请读取配置验证');
  });
});
function readGatewayForm() {
  const data = new FormData($('gateway-form')), result = {}, val = key => data.get(key), num = key => Number(val(key));
  if (data.has('useUart')) result.uart = { baud: num('baud'), parity: val('parity'), stopBits: num('stopBits') };
  if (data.has('useWifi')) result.wifi = { ssid: val('ssid'), password: val('password'), mode: val('wifiMode') };
  if (data.has('useIp')) result.ip = { mode: val('ipMode'), address: val('ipAddress'), mask: val('mask'), gateway: val('ipGateway') };
  if (data.has('useTcp')) result.tcp = { port: num('tcpPort'), address: val('tcpAddress') };
  if (data.has('usePacket')) result.packet = { intervalMs: num('packetInterval'), bytes: num('packetBytes') };
  if (data.has('useAp')) result.ap = { ssid: val('apSsid'), password: val('apPassword') };
  return result;
}
$('gateway-form').addEventListener('input', () => { plan = null; planSettings = null; planMessage = '参数已更改，请重新生成配置预览'; $('copy-plan').disabled = true; $('apply-plan').disabled = true; renderAuxiliary(); });
$('gateway-form').addEventListener('submit', event => {
  event.preventDefault(); run(event.currentTarget.querySelector('[type=submit]'), async () => {
    const settings = readGatewayForm(); plan = await api('gateway/plan', settings); planSettings = settings;
    renderAuxiliary();
    $('copy-plan').disabled = false; $('apply-plan').disabled = false;
  });
});
$('copy-plan').addEventListener('click', event => run(event.currentTarget, () => copy(plan.commands.map(c => c.command).join('\r\n') + '\r\n')));
$('apply-plan').addEventListener('click', event => run(event.currentTarget, async () => {
  if (!plan) return;
  const hidden = plan.commands.map(item => item.sensitive ? `${item.command.split('=')[0]}=[${t('密码已隐藏')}]` : item.command).join('\n');
  if (!await confirmChange('将配置写入真实网关？', '使用 HF UDP 兼容通道。采集将暂停；逐条写入无法保证整体回滚。此次只保存配置，请确认参数后再单独重启网关。', hidden)) return;
  const result = await api('gateway/apply', { settings: planSettings, key: $('gateway-key').value, confirm: true, restart: false }); toast(result.message);
}));
$('register-form').addEventListener('submit', event => {
  event.preventDefault(); const form = event.currentTarget;
  run(form.querySelector('[type=submit]'), async () => { const result = await api('registers/read', { start: parseInteger(form.elements.start.value), count: Number(form.elements.count.value) }); $('register-result').textContent = result.values.map((v,i) => `0x${(result.start+i).toString(16).toUpperCase().padStart(4,'0')} : ${v} / 0x${v.toString(16).toUpperCase().padStart(4,'0')}`).join('\n') + `\n\nRX: ${result.raw}`; });
});
$('history-range').addEventListener('change', event => { historyRange = Number(event.target.value); historyPage = 0; renderHistory(); });
$('history-prev').addEventListener('click', () => { historyPage--; renderHistory(); }); $('history-next').addEventListener('click', () => { historyPage++; renderHistory(); });
function startEvents() {
  const stream = new EventSource('/api/events'); stream.onopen = () => markService(true); stream.onerror = () => markService(false);
  stream.addEventListener('state', event => applyState(JSON.parse(event.data)));
  stream.addEventListener('sample', event => addSample(JSON.parse(event.data)));
  stream.addEventListener('log', event => { logs.push(JSON.parse(event.data)); if (logs.length > 300) logs.shift(); if (location.hash === '#diagnostics') renderLogs(); });
}
async function initialize() {
  try {
    const results = await Promise.all([api('state'),api('info')]); state = results[0]; info = results[1];
    renderNetworkInfo();
    $('discovery-interface').innerHTML += info.addresses.map(a => `<option value="${esc(a.address)}">${esc(a.name)} · ${esc(a.address)}</option>`).join('');
    applyState(state); fillConnection(); startEvents(); await Promise.all([reloadHistory(),refreshLogs()]); markService(true);
  } catch (error) { markService(false); toast('无法加载服务：{error}。请保持服务运行并刷新页面。',true,{ error: error.message }); }
}
window.addEventListener('loam:languagechange', () => {
  buildMetrics(); renderNetworkInfo(); renderState(); renderHistory(); renderLogs(); renderAuxiliary(); renderDialog(); renderToast();
  markService(serviceOnline); navigate(); $('chart-tooltip').hidden = true;
  $('clock').textContent = time(Date.now()).slice(0,5) + ' SGT';
});
setInterval(() => { $('clock').textContent = time(Date.now()).slice(0,5) + ' SGT'; freshness(); },1000);
setLanguage(getLanguage());
initialize();
