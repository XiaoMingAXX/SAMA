const $ = (id) => document.getElementById(id);
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
let language = localStorage.getItem("sama.language") || "zh";
const t = (zh, en) => (language === "en" ? en : zh);
const model = {
  user: null,
  csrf: "",
  state: null,
  plants: [],
  plantOptions: [],
  includeArchived: false,
  optionsLoadedAt: 0,
  total: 0,
  offset: 0,
  q: "",
  detail: null,
  samples: [],
  recordings: [],
  jobs: [],
  users: [],
  gateways: [],
  tab: "overview",
  metric: "moisture",
  stream: null,
  route: "plants",
  plantId: null,
  refreshTimer: null,
  historyResult: null,
};
const metricNames = {
  temperature: ["土壤温度", "Soil temperature"],
  moisture: ["含水率", "Water content"],
  ec: ["电导率", "Conductivity"],
  salinity: ["盐分", "Salinity"],
  nitrogen: ["氮 N", "Nitrogen"],
  phosphorus: ["磷 P", "Phosphorus"],
  potassium: ["钾 K", "Potassium"],
  ph: ["pH", "pH"],
};
const metricName = (k) => t(...(metricNames[k] ?? [k, k]));
const statusName = (k) =>
  ({
    running: t("记录中", "Recording"),
    scheduled: t("待开始", "Scheduled"),
    stopped: t("已停止", "Stopped"),
    completed: t("已完成", "Completed"),
    failed: t("失败", "Failed"),
    queued: t("排队中", "Queued"),
    ready: t("已完成", "Ready"),
    cancelled: t("已取消", "Cancelled"),
  })[k] ?? k;
const eventName = (k) =>
  ({
    status: t("生长状态", "Growth status"),
    watering: t("浇水", "Watering"),
    fertilizing: t("施肥", "Fertilizing"),
    repotting: t("换盆", "Repotting"),
    moving: t("移动位置", "Relocation"),
    note: t("观察笔记", "Observation"),
  })[k] ?? k;
const number = (v, d = 1) =>
  v === undefined || v === null
    ? "—"
    : Number(v).toLocaleString("en-US", { maximumFractionDigits: d });
const time = (v, full = true) =>
  v
    ? new Intl.DateTimeFormat(language === "en" ? "en-SG" : "zh-CN", {
        timeZone: "Asia/Singapore",
        ...(full ? { year: "numeric", month: "2-digit", day: "2-digit" } : {}),
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(new Date(v))
    : "—";
const localDate = (v = new Date()) =>
  new Date(new Date(v).getTime() + 8 * 3600000).toISOString().slice(0, 16);
const utc = (v) => (v ? new Date(v + "+08:00").toISOString() : undefined);
function toast(message, error = false) {
  const box = $("toast");
  box.textContent = message;
  box.classList.toggle("error", error);
  box.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (box.hidden = true), error ? 8000 : 4000);
}
const errors = {
  "Please sign in": ["请先登录", "Please sign in"],
  "Invalid username or password": [
    "用户名或密码不正确",
    "Invalid username or password",
  ],
  "Resource not found": [
    "未找到该资源，或你没有访问权限",
    "Resource not found",
  ],
  "Bind this sensor to a plant first": [
    "请先将传感器绑定到植物",
    "Bind this sensor to a plant first",
  ],
  "Overlapping recording for this sensor": [
    "该传感器已有重叠的采集任务",
    "Overlapping recording for this sensor",
  ],
  "Username already exists": ["用户名已存在", "Username already exists"],
  "Gateway offline": ["网关离线，请检查网络", "Gateway offline"],
  "Password must be 10–128 characters": [
    "密码需要 10–128 个字符",
    "Password must be 10–128 characters",
  ],
  "Recording interval must be at least the polling interval": [
    "存档间隔不能小于设备轮询间隔",
    "Recording interval must be at least the polling interval",
  ],
};
function errorText(e) {
  return errors[e.message] ? t(...errors[e.message]) : e.message;
}
async function api(
  route,
  body,
  method = body === undefined ? "GET" : "POST",
  headers = {},
) {
  const response = await fetch("/api/v1/" + route, {
    method,
    headers: {
      ...(body === undefined
        ? {}
        : {
            "Content-Type":
              body instanceof File
                ? body.type || "application/octet-stream"
                : "application/json",
            "X-Sama-Request": "1",
            "X-CSRF-Token": model.csrf,
          }),
      ...headers,
    },
    body:
      body === undefined
        ? undefined
        : body instanceof File
          ? body
          : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && model.user) {
      model.user = null;
      model.stream?.close();
      renderAuth();
    }
    throw new Error(data.message || response.statusText);
  }
  return data;
}
async function action(fn) {
  try {
    await fn();
  } catch (e) {
    toast(errorText(e), true);
  }
}
const brand = () =>
  '<a href="#plants" class="brand">sama<span>.</span><small>SOIL ANALYSIS & MONITORING ARRAY</small></a>';
const languageButtons = () =>
  `<div class="language"><button data-language="zh" class="${language === "zh" ? "active" : ""}">中文</button><button data-language="en" class="${language === "en" ? "active" : ""}">EN</button></div>`;
function hookLanguages() {
  document.querySelectorAll("[data-language]").forEach(
    (b) =>
      (b.onclick = () => {
        language = b.dataset.language;
        localStorage.setItem("sama.language", language);
        document.documentElement.lang = language === "en" ? "en-SG" : "zh-CN";
        if (model.user) render();
        else renderAuth();
      }),
  );
}
function field(name, label, value = "", type = "text", attrs = "") {
  return `<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${attrs}></label>`;
}
function area(name, label, value = "", attrs = "") {
  return `<label class="wide">${label}<textarea name="${name}" ${attrs}>${esc(value)}</textarea></label>`;
}
function select(name, label, options, value = "", attrs = "") {
  return `<label>${label}<select name="${name}" ${attrs}>${options.map(([id, label]) => `<option value="${esc(id)}" ${String(id) === String(value) ? "selected" : ""}>${esc(label)}</option>`).join("")}</select></label>`;
}
function empty(title, copy, button = "") {
  return `<div class="empty"><h3>${title}</h3><p>${copy}</p>${button}</div>`;
}
function modal(title, body) {
  $("dialog-content").innerHTML =
    `<div class="dialog-head"><h2>${title}</h2><button id="dialog-close" aria-label="${t("关闭", "Close")}">×</button></div>${body}`;
  $("dialog-close").onclick = () => $("dialog").close();
  if (!$("dialog").open) $("dialog").showModal();
}
function formModal(title, body, handler, submit = t("保存", "Save")) {
  modal(
    title,
    `<form id="modal-form">${body}<p class="dialog-error" id="dialog-error" role="alert"></p><div class="dialog-actions"><button type="button" id="dialog-cancel">${t("取消", "Cancel")}</button><button class="primary" type="submit">${submit}</button></div></form>`,
  );
  $("dialog-cancel").onclick = () => $("dialog").close();
  $("modal-form").onsubmit = async (event) => {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    $("dialog-error").textContent = "";
    try {
      await handler(new FormData(event.target));
      $("dialog").close();
      await load();
    } catch (e) {
      $("dialog-error").textContent = errorText(e);
    } finally {
      button.disabled = false;
    }
  };
}
function renderAuth(mode = "login") {
  model.stream?.close();
  clearTimeout(model.refreshTimer);
  $("app").innerHTML =
    `<div class="auth-shell"><section class="auth-story">${brand()}<div><div class="eyebrow">SOIL IN CONTEXT</div><h1>${t("让每一盆植物，<br>拥有自己的生长故事。", "Every plant has<br>a story to grow.")}</h1><p>${t("把土壤读数、养护记录和每一次变化，留在同一份植物档案里。", "Bring soil readings, care records and every small change into one plant history.")}</p></div><div class="story-footer">OBSERVE · RECORD · UNDERSTAND</div></section><section class="auth-form-wrap"><div class="auth-form">${languageButtons()}<h2>${mode === "login" ? t("欢迎回到观测站", "Welcome to your observatory") : t("建立你的植物档案", "Start your plant journal")}</h2><p class="help">${t("每个账号拥有独立的植物、照片和采集记录。", "Your plants, photos and observations stay in your own workspace.")}</p><div class="tabs"><button id="login-tab" class="${mode === "login" ? "active" : ""}">${t("登录", "Sign in")}</button><button id="register-tab" class="${mode === "register" ? "active" : ""}">${t("注册", "Register")}</button></div><form id="auth-form">${field("username", t("用户名", "Username"), "", "text", 'required autocomplete="username" minlength="3" maxlength="40" pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]{2,39}"')}${mode === "register" ? field("name", t("显示名称", "Display name"), "", "text", 'maxlength="80"') : ""}${field("password", t("密码", "Password"), "", "password", `required autocomplete="${mode === "login" ? "current-password" : "new-password"}" minlength="${mode === "register" ? 10 : 1}" maxlength="128"`)}<div class="auth-error" id="auth-error" role="alert"></div><button class="primary" type="submit">${mode === "login" ? t("进入观测站", "Enter workspace") : t("创建账号", "Create account")}</button></form><p class="help">${mode === "register" ? t("用户名使用 3–40 位字母、数字、点、下划线或短横线。密码至少 10 位；设备由管理员分配。", "Use 3–40 letters, digits, dots, underscores or dashes. Passwords need at least 10 characters. Devices are assigned by an administrator.") : t("忘记密码时，请联系管理员重置。首次管理员通过本地管理命令创建。", "Ask your administrator to reset a forgotten password. The first administrator is created with the local management command.")}</p></div></section></div>`;
  hookLanguages();
  $("login-tab").onclick = () => renderAuth("login");
  $("register-tab").onclick = () => renderAuth("register");
  $("auth-form").onsubmit = async (event) => {
    event.preventDefault();
    event.submitter.disabled = true;
    try {
      const body = Object.fromEntries(new FormData(event.target));
      if (mode === "register") await api("auth/register", body);
      const result = await api("auth/login", {
        username: body.username,
        password: body.password,
      });
      model.user = result.user;
      model.csrf = result.csrf;
      await load();
      connectEvents();
    } catch (e) {
      $("auth-error").textContent = errorText(e);
      event.submitter.disabled = false;
    }
  };
}
function shell(content) {
  const nav = [
    ["plants", "◌", t("植物档案", "Plants")],
    ["recordings", "≋", t("采集任务", "Recordings")],
    ["history", "↗", t("数据回看", "History")],
    ["sensors", "⊙", t("传感器", "Sensors")],
    ["jobs", "↓", t("导出与分析数据", "Exports & context")],
    ...(model.user.role === "admin"
      ? [["admin", "⌘", t("全局管理", "Administration")]]
      : []),
    ["account", "⋯", t("账号设置", "Account")],
  ];
  return `<aside class="sidebar">${brand()}<nav class="nav" aria-label="${t("主导航", "Navigation")}">${nav.map(([id, icon, label]) => `<button data-nav="${id}" class="${model.route === id || (model.route === "plant" && id === "plants") ? "active" : ""}"><span class="nav-icon">${icon}</span>${label}</button>`).join("")}</nav><div class="userbox"><strong>${esc(model.user.name)}</strong><small>${model.user.role === "admin" ? t("管理员 · 全局视图", "Administrator · global view") : t("个人植物空间", "Personal workspace")}</small><button id="logout-side">${t("退出登录", "Sign out")}</button></div></aside><main class="main"><header class="topbar"><div class="location">SAMA / ${t("植物观测数据仓库", "Plant observatory")}</div><div class="top-actions">${languageButtons()}<span id="stream-pill" class="pill">${t("实时连接", "Live connection")}</span><button id="account-shortcut" class="link">${esc(model.user.name)}</button></div></header><div class="page">${content}<footer class="footer"><span>SAMA · ${t("记录事实，理解生长", "Observe carefully. Understand growth.")}</span><span>${model.state?.objectStore === "local" ? t("本地预览 · 文件存储", "Local preview · file storage") : t("私有 OSS 存储", "Private OSS storage")} · SGT (UTC+8) · v0.2</span></footer></div></main>`;
}
function pageHead(title, copy, buttons = "") {
  return `<div class="page-head"><div><div class="eyebrow">SAMA OBSERVATORY</div><h1>${title}</h1><p>${copy}</p></div><div class="row wrap">${buttons}</div></div>`;
}
const plantSvg =
  '<svg viewBox="0 0 100 120" fill="none" aria-hidden="true"><path d="M50 82V31M50 61C18 63 13 39 14 31c22 0 36 8 36 30ZM50 47C78 49 87 28 86 18c-23 0-36 8-36 29Z" stroke="currentColor" stroke-width="2"/><path d="M30 83h40l-7 27H37L30 83Z" fill="currentColor" opacity=".25" stroke="currentColor" stroke-width="2"/><path d="M25 83h50" stroke="currentColor" stroke-width="3"/></svg>';
function plantCards() {
  return model.plants.length
    ? `<div class="plant-grid">${model.plants
        .map((p) => {
          const sensors = model.state.sensors.filter(
            (s) => s.plant_id === p.id,
          );
          return `<button class="plant-card" data-plant="${p.id}"><div class="plant-cover">${p.cover_asset_id ? `<img loading="lazy" src="/api/v1/assets/${p.cover_asset_id}/content?thumb=1" alt="${esc(p.name)}">` : plantSvg}<span class="pill">${sensors.length ? t("已连接传感器", "Sensor assigned") : t("植物档案", "Plant journal")}</span></div><div class="plant-copy"><h3>${esc(p.name)}</h3><p>${esc(p.profile.species || t("物种待补充", "Species not recorded"))} · ${esc(p.profile.location || t("位置待补充", "Location not recorded"))}</p><div class="meta"><span>${esc(p.code || p.id.slice(0, 8))}</span><span>${sensors.length} ${t("支传感器", "sensors")}</span></div></div></button>`;
        })
        .join("")}</div>`
    : empty(
        t("从第一盆植物开始", "Start with your first plant"),
        t(
          "建立档案，绑定传感器，再选择需要保存的观测。",
          "Create a profile, assign a sensor, then choose what to record.",
        ),
        `<button class="primary" id="empty-new-plant">${t("添加植物", "Add plant")}</button>`,
      );
}
function plantsPage() {
  const stats = model.state.stats;
  return (
    pageHead(
      t("每一盆，都值得被看见。", "Every plant, worth observing."),
      t(
        "管理植物档案，连接土壤数据与生长变化。",
        "Connect plant profiles with soil data and changes over time.",
      ),
      `<button class="primary" id="new-plant">+ ${t("添加植物", "Add plant")}</button>`,
    ) +
    `<section class="hero"><div><div class="eyebrow">OBSERVE WITH CONTEXT</div><h2>${t("让数据有归属，让每次变化有迹可循。", "Give every reading a plant.<br>Give every change a history.")}</h2><p>${t("传感器可以轮流使用。植物的读数、照片与养护故事，会一直留在自己的档案里。", "A sensor can move between plants. Each plant keeps its readings, photos and care history.")}</p></div><div class="hero-mark">◌</div></section><div class="stats"><div class="stat"><small>${t("植物档案", "Plant profiles")}</small><strong>${number(stats.plants, 0)}</strong></div><div class="stat"><small>${t("当前可用传感器", "Assigned sensors")}</small><strong>${model.state.sensors.length}</strong></div><div class="stat"><small>${t("完整历史已归档点数", "Archived readings")}</small><strong>${number(stats.archivedSamples, 0)}</strong></div></div><div class="panel-title"><h2>${t("我的植物", "Plant collection")}</h2><form id="search-form" class="row"><input class="search" name="q" placeholder="${t("搜索名称或盆号", "Search name or plant code")}" value="${esc(model.q)}" aria-label="${t("搜索植物", "Search plants")}"><button>${t("搜索", "Search")}</button></form></div>${plantCards()}<div class="row between section"><small>${model.offset + 1}–${Math.min(model.offset + model.plants.length, model.total)} / ${model.total}</small><div class="row"><button id="plants-prev" ${model.offset === 0 ? "disabled" : ""}>${t("上一页", "Previous")}</button><button id="plants-next" ${model.offset + 60 >= model.total ? "disabled" : ""}>${t("下一页", "Next")}</button></div></div>`
  );
}
function liveReadings(sensors) {
  return sensors
    .map(
      (s) =>
        `<div class="panel-title"><div><h3>${esc(s.name)}</h3><small>${s.simulated ? t("模拟读数 · 用于本地验证", "Simulated readings · local testing") : t("真实传感器", "Hardware sensor")} · <span data-live-state="${s.id}">${s.connected ? t("在线", "Online") : t("离线", "Offline")}</span></small></div><div class="row"><button data-read="${s.id}">${t("立即读取", "Read now")}</button><button data-manual="${s.id}" class="primary">${t("保存一条", "Save one")}</button></div></div><div class="readings">${[
          "moisture",
          "temperature",
          "ec",
          "ph",
        ]
          .filter((k) => s.metrics.includes(k))
          .map((k) => {
            const m = model.state.metrics.find((m) => m.key === k);
            return `<div class="reading"><span>${metricName(k)}</span><strong><b data-live-value="${s.id}|${k}">${number(s.latest?.values?.[k])}</b><small>${esc(m.unit)}</small></strong><div class="when" data-live-time="${s.id}">${time(s.latest?.timestamp, false)}</div></div>`;
          })
          .join("")}</div>`,
    )
    .join("");
}
function chart(rows, key = model.metric) {
  const values = rows.filter(
    (r) => r.values?.[key] !== null && r.values?.[key] !== undefined,
  );
  if (!values.length)
    return empty(
      t("还没有该指标的保存记录", "No saved readings for this metric"),
      t(
        "开始采集后，这里会显示趋势。较早的历史可以在数据回看中读取。",
        "Start a recording to see a trend. Archived data is available in History.",
      ),
    );
  const m = model.state.metrics.find((m) => m.key === key),
    v = values.map((r) => r.values[key]),
    low = Math.min(...v),
    high = Math.max(...v),
    pad = Math.max((high - low) * 0.15, 0.2),
    min = low - pad,
    max = high + pad,
    start = Date.parse(values[0].timestamp),
    end = Math.max(start + 1000, Date.parse(values.at(-1).timestamp));
  let last = null;
  const points = values
    .map((r) => {
      const stamp = Date.parse(r.timestamp),
        x = 58 + ((stamp - start) / (end - start)) * 700,
        y = 190 - ((r.values[key] - min) / (max - min)) * 160,
        command = last === null || stamp - last > 300000 ? "M" : "L";
      last = stamp;
      return `${command}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return `<svg class="chart" viewBox="0 0 800 235" role="img" aria-label="${esc(metricName(key) + " " + m.unit)}">${[
    0, 1, 2, 3,
  ]
    .map((i) => {
      const y = 30 + (i / 3) * 160;
      return `<path class="grid" d="M58 ${y}H758"/><text x="48" y="${y + 4}" text-anchor="end">${number(max - ((max - min) * i) / 3)}</text>`;
    })
    .join(
      "",
    )}<text x="58" y="15">${esc(m.unit)}</text><path class="line" d="${points}"/><text x="58" y="214">${esc(time(values[0].timestamp, false))}</text><text x="758" y="214" text-anchor="end">${esc(time(values.at(-1).timestamp, false))}</text><text x="400" y="232" text-anchor="middle">${t("采样时间 · SGT", "Sampling time · SGT")}</text></svg><small>${t("来源：已保存原始读数；未对缺失数据补点。", "Source: saved measurements; missing periods are not interpolated.")} ${values.length} ${t("点", "points")}</small>`;
}
function sampleTable(rows, photo = true) {
  return rows.length
    ? `<div class="table-wrap"><table><thead><tr><th>${t("采样时间 · SGT", "Sample time · SGT")}</th><th>${metricName("moisture")} %</th><th>${metricName("temperature")} °C</th><th>EC µS/cm</th><th>pH</th><th>${t("来源与质量", "Source & quality")}</th>${photo ? `<th>${t("操作", "Action")}</th>` : ""}</tr></thead><tbody>${[
        ...rows,
      ]
        .reverse()
        .map(
          (r) =>
            `<tr><td>${esc(time(r.timestamp))}<small>${esc(r.sensorId?.slice(0, 8) || r.legacyDeviceId || "—")}</small></td><td>${number(r.values?.moisture)}</td><td>${number(r.values?.temperature)}</td><td>${number(r.values?.ec, 0)}</td><td>${number(r.values?.ph)}</td><td>${r.source === "demo" ? t("模拟", "Simulated") : esc(r.source)}<small>${r.warnings?.length ? esc(r.warnings.join("; ")) : t("校准状态未知", "Calibration unknown")}</small></td>${photo ? `<td><button data-photo-sample="${r.id}">${t("补照片", "Add photo")}</button><button data-sample-detail="${r.id}">${t("详情", "Details")}</button></td>` : ""}</tr>`,
        )
        .join("")}</tbody></table></div>`
    : empty(
        t("暂无保存记录", "No saved observations"),
        t(
          "实时读数只有在开启任务或手动保存时才进入长期档案。",
          "Live readings enter the history when a recording is active or you save one.",
        ),
      );
}
function recordingTable(rows) {
  return rows.length
    ? `<div class="table-wrap"><table><thead><tr><th>${t("任务 / 植物", "Recording / plant")}</th><th>${t("状态", "Status")}</th><th>${t("开始 / 结束 · SGT", "Start / end · SGT")}</th><th>${t("保存策略", "Storage policy")}</th><th>${t("保存点数", "Saved readings")}</th><th>${t("操作", "Action")}</th></tr></thead><tbody>${rows.map((r) => `<tr><td><strong>${esc(r.name)}</strong><small>${esc(r.plant_name)} · ${esc(r.sensor_name)}</small></td><td><span class="pill ${r.status === "failed" ? "warn" : ""}">${statusName(r.status)}</span></td><td>${time(r.start_at)}<small>${time(r.stopped_at ?? r.end_at)}</small></td><td>${r.interval_ms / 1000}s<small>${r.full_resolution ? t("同时保留全部读数", "All readings retained") : t("按设定间隔", "Selected interval")}</small></td><td>${r.count}<small>${r.selected_count} ${t("存档点", "selected")}</small></td><td>${["running", "scheduled"].includes(r.status) ? `<button data-stop="${r.id}">${t("停止", "Stop")}</button>` : `<button data-record-history="${r.id}" data-plant-id="${r.plant_id}">${t("回看", "Review")}</button>`}</td></tr>`).join("")}</tbody></table></div>`
    : empty(
        t("还没有采集任务", "No recording sessions yet"),
        t(
          "为一盆植物选择传感器，设置间隔和时间，就可以开始。",
          "Choose a plant and sensor, then set the interval and time.",
        ),
      );
}
function plantPage() {
  const { plant: p, observations, assets } = model.detail,
    sensors = model.state.sensors.filter((s) => s.plant_id === p.id);
  const tabs = [
    ["overview", t("观测总览", "Overview")],
    ["recordings", t("采集记录", "Recordings")],
    ["photos", t("状态与照片", "Notes & photos")],
    ["profile", t("生长档案", "Plant profile")],
  ];
  let body = "";
  if (model.tab === "overview")
    body = `${sensors.length ? liveReadings(sensors) : `<div class="note">${t("当前没有绑定传感器，可在「传感器」页面选择这盆植物。", "No sensor is currently assigned. Choose this plant on the Sensors page.")}</div>`}<div class="panel section"><div class="panel-title"><h2>${t("最近保存的变化", "Recent saved observations")}</h2>${select(
      "metric",
      t("指标", "Metric"),
      model.state.metrics.map((m) => [m.key, metricName(m.key)]),
      model.metric,
      'id="chart-metric"',
    )}</div><div id="chart-area">${chart(model.samples)}</div></div><div class="panel section"><div class="panel-title"><h2>${t("最近采样", "Recent measurements")}</h2><button id="plant-history">${t("完整历史回看", "Explore full history")}</button></div><div id="sample-area">${sampleTable(model.samples.slice(-30))}</div></div>`;
  if (model.tab === "recordings")
    body = `<div class="panel">${recordingTable(model.recordings.filter((r) => r.plant_id === p.id))}</div>`;
  if (model.tab === "photos")
    body = `<div class="grid2"><section class="panel"><div class="panel-title"><h2>${t("生长与养护时间线", "Growth & care timeline")}</h2><button id="add-observation">+ ${t("记一笔", "Add event")}</button></div>${observations.length ? observations.map((o) => `<article class="timeline-item"><div class="row between"><strong>${eventName(o.kind)}</strong><small>${time(o.happened_at)}</small></div>${o.payload.amount !== null ? `<p>${number(o.payload.amount)} ${esc(o.payload.unit)}</p>` : ""}<p>${esc(o.payload.notes)}</p></article>`).join("") : empty(t("第一条养护记录", "Your first care note"), t("记录浇水、施肥或发现的变化，为以后的分析留下背景。", "Record watering, fertilizer or a change you notice to add context."))}</section><section class="panel"><div class="panel-title"><h2>${t("照片档案", "Photo journal")}</h2><button id="add-photo">+ ${t("上传", "Upload")}</button></div>${assets.length ? `<div class="photos">${assets.map((a) => `<div class="photo"><a href="/api/v1/assets/${a.id}/content" target="_blank" rel="noopener"><img loading="lazy" src="/api/v1/assets/${a.id}/content?thumb=1" alt="${esc(a.caption || p.name)}"></a><p>${esc(a.caption || a.category)}</p><small>${a.captured_at ? time(a.captured_at) : t("未填拍摄时间", "Capture time unknown")}</small>${a.sample_id ? `<small>${t("关联采样", "Sample")} ${esc(a.sample_id.slice(0, 8))}</small>` : ""}</div>`).join("")}</div>` : empty(t("留下它现在的样子", "Keep a picture of today"), t("支持档案照、日常状态照和采样照片。", "Upload profile, everyday or sample photos."))}</section></div>`;
  if (model.tab === "profile") {
    const labels = {
      species: t("物种", "Species"),
      cultivar: t("品种", "Cultivar"),
      substrate: t("基质", "Substrate"),
      pot: t("盆具", "Pot"),
      location: t("位置", "Location"),
      plantedAt: t("栽植日期", "Planted on"),
      growthStage: t("生长阶段", "Growth stage"),
      notes: t("备注", "Notes"),
    };
    body = `<div class="grid2"><section class="panel"><div class="panel-title"><h2>${t("植物档案", "Plant profile")}</h2><button id="edit-plant">${t("编辑", "Edit")}</button></div><dl class="profile-list"><dt>${t("盆号", "Plant code")}</dt><dd>${esc(p.code || "—")}</dd>${Object.entries(
      labels,
    )
      .map(
        ([k, label]) => `<dt>${label}</dt><dd>${esc(p.profile[k] || "—")}</dd>`,
      )
      .join(
        "",
      )}<dt>${t("档案版本", "Revision")}</dt><dd>${p.revision}</dd></dl><button id="archive-plant" class="danger">${p.archived ? t("恢复植物", "Restore plant") : t("归档植物", "Archive plant")}</button></section><section class="panel"><h2>${t("传感器使用历史", "Sensor assignment history")}</h2>${model.detail.assignments.map((a) => `<article class="timeline-item"><strong>${esc(a.sensor_name)}</strong><p>${time(a.started_at)} → ${a.ended_at ? time(a.ended_at) : t("当前绑定", "Current assignment")}</p></article>`).join("") || `<p class="help">${t("尚未绑定过传感器。", "No sensor has been assigned yet.")}</p>`}</section></div>`;
  }
  return (
    pageHead(
      esc(p.name),
      `${esc(p.code || p.id.slice(0, 8))} · ${esc(p.profile.species || t("植物观测档案", "Plant observation profile"))}`,
      `<button id="plant-export">${t("导出档案", "Export journal")}</button><button class="primary" id="new-recording">+ ${t("开始采集", "Start recording")}</button>`,
    ) +
    `<div class="tabs">${tabs.map(([id, label]) => `<button data-tab="${id}" class="${model.tab === id ? "active" : ""}">${label}</button>`).join("")}</div>${body}`
  );
}
function sensorsPage() {
  return (
    pageHead(
      t("传感器与当前测量对象", "Sensors & current plants"),
      t(
        "设备使用权由管理员分配；换盆会结束旧绑定及采集段。",
        "Administrators assign device access. Moving a probe closes the old assignment and recording.",
      ),
    ) +
    `<section class="panel">${model.state.sensors.length ? model.state.sensors.map((s) => `<div class="sensor-card"><div><h3>${esc(s.name)} ${s.simulated ? `<span class="pill warn">${t("模拟", "Simulated")}</span>` : ""}</h3><small>${esc(s.gateway_name)} · RS485 ${s.address} · ${s.interval_ms / 1000}s ${t("轮询", "poll")}</small><p class="help">${t("正在测量", "Measuring")}: ${esc(s.plant_name || t("未绑定植物", "No plant assigned"))}${model.user.role === "admin" ? ` · ${esc(s.owner_name || t("未分配账号", "No assigned account"))}` : ""}</p></div><div class="row wrap"><button data-bind="${s.id}" ${!s.owner_id ? "disabled" : ""}>${t("设置测量植物", "Choose plant")}</button><button data-configure="${s.id}">${t("设置", "Settings")}</button><button data-read="${s.id}">${t("读取", "Read")}</button>${s.plant_id ? `<button data-manual="${s.id}" class="primary">${t("保存一条", "Save one")}</button>` : ""}</div></div>`).join("") : empty(t("尚未分配传感器", "No sensors assigned"), t("账号注册完成后，请管理员为你分配设备使用权。", "Ask your administrator to assign a device after registration."))}</section><div class="note">${t("一个传感器同一时刻只测一盆植物。设备转给其他账号后，你之前的植物、照片与历史仍属于你。", "A sensor measures one plant at a time. When a device moves to another account, your previous plants, photos and history remain yours.")}</div>`
  );
}
function recordingsPage() {
  return (
    pageHead(
      t("每一次采集，都有清楚的起点。", "Every observation has a beginning."),
      t(
        "独立设置每段记录的植物、间隔、起止时间和原始读数留存。",
        "Set each session’s plant, interval, time window and full-resolution retention.",
      ),
      `<button class="primary" id="new-recording">+ ${t("新建采集段", "New recording")}</button>`,
    ) +
    `<div class="panel">${recordingTable(model.recordings)}</div><div class="note">${t("网页关闭后，任务仍由服务器执行。设备离线或读数失败的时段会留空，不用旧值补齐。", "Sessions run on the server after the browser closes. Offline or failed periods are left missing, never filled with stale values.")}</div>`
  );
}
function historyPage() {
  return (
    pageHead(
      t("回到某一天，看见变化。", "Return to a day. See what changed."),
      t(
        "按植物与时间查询完整历史，包含已归档到对象存储的数据。",
        "Query by plant and time, including archived observations.",
      ),
    ) +
    `<section class="panel"><form id="history-form"><div class="fields">${select("plantId", t("植物", "Plant"), [["", t("所有有权限的植物", "All authorized plants")], ...model.plantOptions.map((p) => [p.id, p.name])], model.plantId || "")}${select(
      "selectedOnly",
      t("数据范围", "Readings"),
      [
        ["true", t("按设定间隔保存的点", "Selected interval")],
        ["false", t("全部留存的原始读数", "All retained readings")],
      ],
      "true",
    )}${field("since", t("开始时间 · SGT", "From · SGT"), localDate(Date.now() - 7 * 86400000), "datetime-local", "required")}${field("until", t("结束时间 · SGT", "Until · SGT"), localDate(), "datetime-local", "required")}</div><div class="row wrap"><button class="primary" type="submit">${t("查询完整历史", "Query full history")}</button><button id="history-export" type="button">${t("按此条件导出", "Export this range")}</button><small>${t("后台读取，每页 300 条。", "Read in the background, 300 readings per page.")}</small></div></form></section><section id="history-result" class="panel section">${model.historyResult ? historyResultHtml(model.historyResult) : `<p class="help">${t("选择时间范围后查询。高频记录请适当缩短范围，每次查询上限 50 万条。", "Choose a range to begin. Shorten high-frequency ranges; each scan is limited to 500,000 readings.")}</p>`}</section>`
  );
}
function historyResultHtml(result) {
  return `<div class="panel-title"><h2>${t("查询结果", "Query results")}</h2><small>${result.count} ${t("条匹配记录", "matching readings")}</small></div>${chart(result.preview)}${sampleTable(result.preview)}${result.nextBefore ? `<button id="history-older">${t("查看更早一页", "Older readings")}</button>` : ""}`;
}
function jobsPage() {
  return (
    pageHead(
      t("把记录带走，把背景交给分析。", "Take your records. Keep the context."),
      t(
        "下载数据与植物档案，或生成面向未来大模型的只读数据快照。",
        "Download observations or generate a read-only context snapshot for future analysis.",
      ),
      `<button id="new-export" class="primary">${t("新建导出", "New export")}</button>`,
    ) +
    `<section class="panel"><div class="panel-title"><h2>${t("后台任务", "Background jobs")}</h2><button id="refresh-jobs">${t("刷新", "Refresh")}</button></div>${model.jobs.length ? model.jobs.map((j) => `<article class="job"><div><h3>${{ export: t("数据导出", "Data export"), context: t("植物分析上下文", "Plant context"), history: t("历史查询", "History query") }[j.kind]} <span class="pill ${j.status === "failed" ? "warn" : ""}">${statusName(j.status)}</span></h3><small>${time(j.created_at)} · ${esc(j.filter.format || j.kind)}${j.result?.count !== undefined ? " · " + j.result.count + " " + t("条", "readings") : ""}</small>${j.error ? `<p class="help error-text">${esc(j.error)}</p>` : ""}${j.expires_at ? `<p class="help">${t("到期时间", "Expires")} ${time(j.expires_at)}</p>` : ""}</div><div class="row wrap">${j.status === "ready" && j.result?.key ? `<a href="/api/v1/jobs/${j.id}/download" class="primary"><button>${t("下载", "Download")}</button></a>` : ""}${j.result?.snapshotId ? `<button data-context="${j.result.snapshotId}">${t("查看上下文", "View context")}</button>` : ""}${j.result?.preview ? `<button data-history-job="${j.id}">${t("查看结果", "View results")}</button>` : ""}${["queued", "running"].includes(j.status) ? `<button data-cancel="${j.id}">${t("取消", "Cancel")}</button>` : ""}</div></article>`).join("") : empty(t("还没有后台任务", "No background jobs yet"), t("从植物详情导出，或生成分析数据快照。", "Export from a plant detail page or generate a context snapshot."))}</section><div class="note">${t("上下文包含植物档案版本、指标单位、质量限制、养护事件及照片引用。当前不会调用外部模型，也不会自动执行养护操作。", "Context includes profile versions, metric units, data limitations, care events and photo references. No external model is called and no care action is automated.")}</div>`
  );
}
function adminPage() {
  const users = model.users;
  return (
    pageHead(
      t("全局管理", "Administration"),
      t(
        "管理账号、重置密码，并分配同一时刻的设备使用权。",
        "Manage accounts, reset passwords and allocate exclusive device access.",
      ),
    ) +
    `<section class="panel"><div class="panel-title"><h2>${t("账号", "Accounts")}</h2><button id="admin-new-user">+ ${t("创建账号", "Create account")}</button></div><div class="table-wrap"><table><thead><tr><th>${t("账号", "Account")}</th><th>${t("角色 / 状态", "Role / status")}</th><th>${t("操作", "Actions")}</th></tr></thead><tbody>${users.map((u) => `<tr><td>${esc(u.name)}<small>${esc(u.username)}</small></td><td>${u.role === "admin" ? t("管理员", "Administrator") : t("用户", "User")} · ${u.active ? t("启用", "Active") : t("已禁用", "Disabled")}</td><td><button data-reset-password="${u.id}">${t("重置密码", "Reset password")}</button><button data-user-toggle="${u.id}">${u.active ? t("禁用", "Disable") : t("启用", "Enable")}</button></td></tr>`).join("")}</tbody></table></div></section><section class="panel section"><div class="panel-title"><h2>${t("传感器使用权", "Sensor access")}</h2><div class="row"><button id="admin-new-gateway">+ ${t("网关", "Gateway")}</button><button id="admin-new-sensor">+ ${t("传感器", "Sensor")}</button></div></div><div class="table-wrap"><table><thead><tr><th>${t("传感器", "Sensor")}</th><th>${t("当前账号", "Current account")}</th><th>${t("当前植物", "Current plant")}</th><th>${t("操作", "Action")}</th></tr></thead><tbody>${model.state.sensors.map((s) => `<tr><td>${esc(s.name)}<small>${esc(s.gateway_name)} / RS485 ${s.address}${s.simulated ? " / " + t("模拟", "Simulated") : ""}</small></td><td>${esc(s.owner_name || "—")}</td><td>${esc(s.plant_name || "—")}</td><td><button data-transfer="${s.id}">${t("分配 / 转交", "Assign / transfer")}</button></td></tr>`).join("")}</tbody></table></div></section><section class="panel section"><div class="panel-title"><h2>${t("网关身份", "Gateway identity")}</h2><button id="admin-audit">${t("查看操作审计", "View audit")}</button></div>${model.gateways.map((g) => `<div class="sensor-card"><div><h3>${esc(g.name)}</h3><small class="mono">${esc(g.id)}${g.simulated ? " · " + t("模拟", "Simulated") : ""}</small></div><button data-rotate-gateway="${g.id}">${t("重置接入凭据", "Rotate credential")}</button></div>`).join("")}<p class="help">${t("接入凭据仅在创建或重置后显示。真实设备需配置新注册包；本地预览没有修改服务器上的网关。", "Credentials are shown only after creation or rotation. Real devices need the new registration packet. Local preview does not reconfigure online gateways.")}</p></section>`
  );
}
function accountPage() {
  return (
    pageHead(
      t("账号设置", "Account settings"),
      t(
        "管理你的显示名称和登录密码。",
        "Manage your display name and password.",
      ),
    ) +
    `<section class="panel"><dl class="profile-list"><dt>${t("用户名", "Username")}</dt><dd>${esc(model.user.username)}</dd><dt>${t("显示名称", "Display name")}</dt><dd>${esc(model.user.name)}</dd><dt>${t("权限", "Role")}</dt><dd>${model.user.role === "admin" ? t("管理员，可管理全局", "Administrator, global management") : t("独立个人空间", "Private workspace")}</dd></dl><div class="row"><button id="change-password">${t("修改密码", "Change password")}</button><button id="logout">${t("退出登录", "Sign out")}</button></div></section>`
  );
}

function render() {
  document.documentElement.lang = language === "en" ? "en-SG" : "zh-CN";
  const pages = {
    plants: plantsPage,
    plant: plantPage,
    sensors: sensorsPage,
    recordings: recordingsPage,
    history: historyPage,
    jobs: jobsPage,
    admin: adminPage,
    account: accountPage,
  };
  $("app").innerHTML = shell((pages[model.route] || plantsPage)());
  hookLanguages();
  bind();
}
let generation = 0;
async function load() {
  if (!model.user) return;
  const previousRoute =
    model.route + "/" + (model.route === "plant" ? model.plantId : "");
  const g = ++generation,
    parts = location.hash.slice(1).split("/");
  model.route = parts[0] || "plants";
  model.plantId = parts[0] === "plant" ? parts[1] : model.plantId;
  const state = await api("state");
  if (g !== generation) return;
  model.state = state;
  model.user = state.user;
  const owner = model.includeArchived ? "&archived=1" : "";
  const plants = await api(
    "plants?limit=60&offset=" +
      model.offset +
      "&q=" +
      encodeURIComponent(model.q) +
      owner,
  );
  if (g !== generation) return;
  model.plants = plants.plants;
  model.total = plants.total;
  if (
    ["history", "jobs", "plant"].includes(model.route) &&
    (Date.now() - model.optionsLoadedAt > 30000 ||
      model.optionsUser !== model.user.id)
  ) {
    const all = [];
    for (let offset = 0; offset < 5000; offset += 100) {
      const page = await api("plants?limit=100&archived=1&offset=" + offset);
      all.push(...page.plants);
      if (all.length >= page.total) break;
    }
    if (g !== generation) return;
    model.plantOptions = all;
    model.optionsLoadedAt = Date.now();
    model.optionsUser = model.user.id;
  }
  if (model.route === "plant") {
    const [detail, samples, recordings] = await Promise.all([
      api("plants/" + model.plantId),
      api("measurements?plantId=" + model.plantId + "&latest=true&limit=300"),
      api("recordings?plantId=" + model.plantId),
    ]);
    if (g !== generation) return;
    model.detail = detail;
    model.samples = samples.samples;
    model.recordings = recordings.recordings;
  }
  if (model.route === "recordings")
    model.recordings = (await api("recordings")).recordings;
  if (model.route === "jobs") model.jobs = (await api("jobs")).jobs;
  if (model.route === "admin") {
    if (model.user.role !== "admin") {
      location.hash = "plants";
      return;
    }
    const [u, g] = await Promise.all([
      api("admin/users"),
      api("admin/gateways"),
    ]);
    model.users = u.users;
    model.gateways = g.gateways;
  }
  if (g !== generation) return;
  render();
  if (
    previousRoute !==
    model.route + "/" + (model.route === "plant" ? model.plantId : "")
  )
    window.scrollTo(0, 0);
  scheduleRefresh();
}
function scheduleRefresh() {
  clearTimeout(model.refreshTimer);
  if (model.route === "jobs")
    model.refreshTimer = setTimeout(() => action(load), 4000);
}
function navigate(route) {
  if (location.hash === "#" + route) action(load);
  else location.hash = route;
}
function connectEvents() {
  model.stream?.close();
  const stream = (model.stream = new EventSource("/api/v1/events"));
  stream.onopen = () => {
    if ($("stream-pill")) {
      $("stream-pill").textContent = t("实时连接", "Live connection");
      $("stream-pill").classList.remove("warn");
    }
  };
  stream.onerror = () => {
    if ($("stream-pill")) {
      $("stream-pill").textContent = t("连接中断", "Disconnected");
      $("stream-pill").classList.add("warn");
    }
  };
  stream.addEventListener("live", (event) => {
    const sample = JSON.parse(event.data),
      sensor = model.state?.sensors.find((s) => s.id === sample.sensorId);
    if (sensor) {
      sensor.latest = sample;
      sensor.connected = true;
    }
    document.querySelectorAll("[data-live-value]").forEach((el) => {
      const [id, key] = el.dataset.liveValue.split("|");
      if (id === sample.sensorId) el.textContent = number(sample.values[key]);
    });
    document
      .querySelectorAll(`[data-live-time="${sample.sensorId}"]`)
      .forEach((el) => (el.textContent = time(sample.timestamp, false)));
  });
  stream.addEventListener("saved", (event) => {
    const sample = JSON.parse(event.data);
    if (model.route === "plant" && sample.plantId === model.plantId) {
      model.samples.push(sample);
      model.samples = model.samples.slice(-300);
      if ($("chart-area")) $("chart-area").innerHTML = chart(model.samples);
      if ($("sample-area")) {
        $("sample-area").innerHTML = sampleTable(model.samples.slice(-30));
        bindSamples();
      }
    }
  });
  stream.addEventListener("sensor-status", (event) => {
    const status = JSON.parse(event.data),
      s = model.state?.sensors.find((s) => s.id === status.sensorId);
    if (s) s.connected = status.connected;
    document
      .querySelectorAll(`[data-live-state="${status.sensorId}"]`)
      .forEach(
        (el) =>
          (el.textContent = status.connected
            ? t("在线", "Online")
            : t("离线", "Offline")),
      );
  });
  stream.addEventListener("refresh", () => action(load));
}
async function logout() {
  await api("auth/logout", {});
  model.stream?.close();
  model.user = null;
  model.csrf = "";
  model.detail = null;
  model.plants = [];
  model.historyResult = null;
  renderAuth();
}
function plantForm(plant = null) {
  const p = plant?.profile ?? {};
  formModal(
    plant
      ? t("编辑植物档案", "Edit plant profile")
      : t("添加植物", "Add plant"),
    `<div class="fields">${field("name", t("植物名称", "Plant name"), plant?.name ?? "", "text", 'required maxlength="100"')}${field("code", t("盆号 / 标签", "Plant code / label"), plant?.code ?? "", "text", 'maxlength="60"')}${field("species", t("物种", "Species"), p.species)}${field("cultivar", t("品种", "Cultivar"), p.cultivar)}${field("location", t("位置", "Location"), p.location)}${field("substrate", t("基质", "Substrate"), p.substrate)}${field("pot", t("盆具", "Pot"), p.pot)}${field("plantedAt", t("栽植日期", "Planting date"), p.plantedAt, "date")}${field("growthStage", t("生长阶段", "Growth stage"), p.growthStage)}${area("notes", t("生长档案与备注", "Growth profile & notes"), p.notes, 'maxlength="4000"')}</div>`,
    async (data) => {
      const input = Object.fromEntries(data),
        profile = {};
      for (const k of [
        "species",
        "cultivar",
        "location",
        "substrate",
        "pot",
        "plantedAt",
        "growthStage",
        "notes",
      ])
        profile[k] = input[k];
      const result = await api(
        plant ? "plants/" + plant.id : "plants",
        { name: input.name, code: input.code, profile },
        plant ? "PATCH" : "POST",
      );
      if (!plant) location.hash = "plant/" + result.id;
      model.optionsLoadedAt = 0;
    },
  );
}
async function bindPlant(id) {
  const sensor = model.state.sensors.find((s) => s.id === id),
    plants = await api("plants?limit=100&ownerId=" + sensor.owner_id);
  formModal(
    t("设置传感器当前测量的植物", "Choose the plant this probe measures"),
    `<p class="help">${esc(sensor.name)} · ${t("更换植物会结束旧采集段，过去记录不会改归属。", "Changing plants ends the old session and preserves its history.")}</p>${field("q", t("搜索植物名称 / 盆号", "Search plant name / code"), "", "search", 'id="bind-search"')}${select("plantId", t("植物", "Plant"), [["", t("取消绑定", "Unbind")], ...plants.plants.map((p) => [p.id, p.name])], sensor.plant_id, 'id="bind-plant-select"')}`,
    async (data) => {
      await api("sensors/" + id + "/bind", {
        plantId: data.get("plantId") || null,
      });
    },
  );
  let timer;
  $("bind-search").oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () =>
        action(async () => {
          const list = await api(
            "plants?limit=100&ownerId=" +
              sensor.owner_id +
              "&q=" +
              encodeURIComponent($("bind-search").value),
          );
          $("bind-plant-select").innerHTML = [
            ["", t("取消绑定", "Unbind")],
            ...list.plants.map((p) => [p.id, p.name]),
          ]
            .map(
              ([id, name]) =>
                `<option value="${esc(id)}">${esc(name)}</option>`,
            )
            .join("");
        }),
      250,
    );
  };
}
function recordingForm() {
  const sensors = model.state.sensors.filter(
    (s) =>
      s.plant_id &&
      (!model.plantId ||
        model.route !== "plant" ||
        s.plant_id === model.plantId),
  );
  if (!sensors.length) {
    toast(
      t(
        "请先在传感器页面绑定植物。",
        "Bind a plant on the Sensors page first.",
      ),
      true,
    );
    return;
  }
  formModal(
    t("新建一段采集", "Create a recording session"),
    `<div class="fields">${field("name", t("任务名称", "Session name"), t("植物观测", "Plant observation"), "text", 'required maxlength="100"')}${select(
      "sensorId",
      t("传感器 → 植物", "Sensor → plant"),
      sensors.map((s) => [s.id, s.name + " → " + s.plant_name]),
    )}${field("intervalSeconds", t("每隔多少秒保存一条", "Save every (seconds)"), 60, "number", 'required min="1" max="86400"')}${field("stabilizeSeconds", t("稳定等待（秒）", "Settling time (seconds)"), 0, "number", 'required min="0" max="3600"')}${field("startAt", t("开始时间 · SGT（留空立即开始）", "Start · SGT (blank = now)"), "", "datetime-local")}${field("endAt", t("结束时间 · SGT（留空手动停止）", "End · SGT (blank = manual stop)"), "", "datetime-local")}${area("notes", t("采样说明", "Notes"), "", 'maxlength="2000"')}</div><label class="check"><input name="fullResolution" type="checkbox">${t("同时保留全部实际成功读数及原始帧", "Also retain every successful reading and raw frame")}</label><p class="help">${t("存档间隔不能小于传感器轮询间隔。保存全部读数会增加存储量；实际采集速度由硬件响应决定。", "The save interval cannot be shorter than sensor polling. Full resolution uses more storage; actual frequency depends on hardware.")}</p>`,
    async (data) => {
      await api(
        "recordings",
        {
          sensorId: data.get("sensorId"),
          name: data.get("name"),
          intervalMs: Number(data.get("intervalSeconds")) * 1000,
          stabilizeSeconds: Number(data.get("stabilizeSeconds")),
          fullResolution: data.has("fullResolution"),
          startAt: utc(data.get("startAt")),
          endAt: utc(data.get("endAt")),
          notes: data.get("notes"),
        },
        "POST",
        { "Idempotency-Key": crypto.randomUUID() },
      );
      toast(t("采集任务已建立", "Recording created"));
    },
  );
}
function observationForm() {
  formModal(
    t("记录生长与养护", "Record growth or care"),
    `<div class="fields">${select(
      "kind",
      t("记录类型", "Type"),
      ["status", "watering", "fertilizing", "repotting", "moving", "note"].map(
        (k) => [k, eventName(k)],
      ),
    )}${field("happenedAt", t("发生时间 · SGT", "Event time · SGT"), localDate(), "datetime-local", "required")}${field("amount", t("数量（可选）", "Amount (optional)"), "", "number", 'min="0" step="any"')}${field("unit", t("单位（例如 mL、g）", "Unit (e.g. mL, g)"))}${area("notes", t("状态、变化与说明", "What changed / notes"), "", 'required maxlength="4000"')}</div>`,
    async (data) => {
      await api("plants/" + model.plantId + "/observations", {
        ...Object.fromEntries(data),
        happenedAt: utc(data.get("happenedAt")),
      });
    },
  );
}
function photoForm(sample = null) {
  const plantId = sample?.plantId || model.plantId;
  if (!plantId) {
    toast(t("请先选择植物。", "Choose a plant first."), true);
    return;
  }
  formModal(
    t("上传植物照片", "Upload a plant photo"),
    `${sample ? `<div class="note">${t("关联采样", "Linked sample")}: ${time(sample.timestamp)} · ${esc(sample.id.slice(0, 8))}</div>` : ""}${select(
      "category",
      t("照片类型", "Photo category"),
      sample
        ? [["sample", t("本次采样照片", "Sample photo")]]
        : [
            ["status", t("日常状态", "Everyday status")],
            ["profile", t("档案 / 封面", "Profile / cover")],
          ],
    )}${field("capturedAt", t("实际拍摄时间 · SGT（可留空）", "Captured at · SGT (optional)"), "", "datetime-local")}${field("caption", t("照片说明", "Caption"), "", "text", 'maxlength="1000"')}${field("image", t("选择照片", "Choose photo"), "", "file", 'required accept="image/jpeg,image/png,image/webp"')}<p class="help">${t("JPEG / PNG / WebP，最多 10 MiB、2400 万像素。展示图会压缩并移除 EXIF；本版保留展示图，不保存原图。拍摄时间请自行确认。", "JPEG / PNG / WebP, up to 10 MiB and 24 MP. Display images are resized and EXIF is removed; original files are not retained in this version. Confirm the capture time yourself.")}</p>`,
    async (data) => {
      const file = data.get("image");
      if (file.size > 10 * 1024 * 1024)
        throw new Error(t("照片超过 10 MiB。", "Photo exceeds 10 MiB."));
      const asset = await api("assets", {
        plantId,
        category: data.get("category"),
        caption: data.get("caption"),
        capturedAt: utc(data.get("capturedAt")),
        sampleId: sample?.id,
        sampleReference: sample
          ? {
              plantId: sample.plantId,
              recordingId: sample.recordingId,
              timestamp: sample.timestamp,
            }
          : undefined,
      });
      await api("assets/" + asset.id + "/content", file, "PUT");
      toast(t("照片已保存", "Photo saved"));
    },
  );
}
function exportForm(prefill = {}) {
  formModal(
    t("导出数据或植物档案", "Export observations or a plant archive"),
    `<div class="fields">${select("plantId", t("植物", "Plant"), [["", t("全部有权限的数据", "All authorized data")], ...model.plantOptions.map((p) => [p.id, p.name])], prefill.plantId || model.plantId || "")}${select(
      "format",
      t("格式", "Format"),
      [
        ["csv", t("CSV · Excel 数据", "CSV · Excel")],
        ["ndjson", "NDJSON · JSON records"],
        ["zip", t("ZIP · 植物完整档案", "ZIP · plant archive")],
      ],
    )}${field("since", t("开始时间 · SGT", "From · SGT"), prefill.since ? localDate(prefill.since) : localDate(Date.now() - 7 * 86400000), "datetime-local", "required")}${field("until", t("结束时间 · SGT", "Until · SGT"), prefill.until ? localDate(prefill.until) : localDate(), "datetime-local", "required")}</div><label class="check"><input name="selectedOnly" type="checkbox" checked>${t("仅按设定间隔保存的点", "Selected-interval readings only")}</label><label class="check"><input name="includePhotos" type="checkbox">${t("ZIP 包含照片（单次最多 100 张）", "Include photos in ZIP (up to 100)")}</label><p class="help">${t("大文件在后台生成，完成后到「导出与分析数据」下载。下载有效期为 7 天。", "Files are generated in the background. Download them from Exports & context within 7 days.")}</p>`,
    async (data) => {
      const input = {
        plantId: data.get("plantId") || undefined,
        format: data.get("format"),
        since: utc(data.get("since")),
        until: utc(data.get("until")),
        selectedOnly: data.has("selectedOnly"),
        includePhotos: data.has("includePhotos"),
      };
      if (input.format === "zip" && !input.plantId)
        throw new Error(
          t("ZIP 档案需要选择一盆植物。", "Choose a plant for a ZIP archive."),
        );
      await api("exports", input);
      toast(t("导出已进入后台队列", "Export queued"));
      navigate("jobs");
    },
    t("创建导出", "Create export"),
  );
}
function downloadJson(filename, value) {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
      type: "application/json",
    }),
    url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function contextModal(id) {
  const value = await api("context-snapshots/" + id);
  modal(
    t("植物分析数据快照", "Plant analysis context"),
    `<div class="note">${t("固定版本的只读数据，可供后续模型集成使用。当前未调用大模型。", "A versioned, read-only snapshot for future model integration. No model has been called.")}</div><pre>${esc(JSON.stringify(value, null, 2))}</pre><button id="download-context" class="primary">${t("下载 JSON", "Download JSON")}</button>`,
  );
  $("download-context").onclick = () =>
    downloadJson("sama-context-" + id + ".json", value);
}
async function historyQuery(filter) {
  const job = await api("history-queries", filter);
  $("history-result").innerHTML =
    `<p class="help">${t("正在后台读取归档与近期数据…", "Reading archived and recent data…")}</p>`;
  for (let attempt = 0; attempt < 120; attempt++) {
    await new Promise((r) => setTimeout(r, 1000));
    const current = await api("jobs/" + job.id);
    if (current.status === "failed") throw new Error(current.error);
    if (current.status === "ready") {
      model.historyResult = current.result;
      model.historyFilter = { ...filter, maxSeq: current.result.maxSeq };
      model.samples = current.result.preview;
      if ($("history-result")) {
        $("history-result").innerHTML = historyResultHtml(current.result);
        bindSamples();
        if ($("history-older"))
          $("history-older").onclick = () =>
            action(() =>
              historyQuery({
                ...model.historyFilter,
                beforeSeq: current.result.nextBefore,
              }),
            );
      }
      return;
    }
    if (model.route !== "history") return;
  }
  throw new Error(
    t(
      "任务仍在运行，请到后台任务查看。",
      "The query is still running. Check Background jobs.",
    ),
  );
}
function bindSamples() {
  const rows =
    model.route === "history"
      ? (model.historyResult?.preview ?? [])
      : model.samples;
  document
    .querySelectorAll("[data-photo-sample]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          photoForm(rows.find((s) => s.id === b.dataset.photoSample))),
    );
  document.querySelectorAll("[data-sample-detail]").forEach(
    (b) =>
      (b.onclick = () => {
        const sample = rows.find((s) => s.id === b.dataset.sampleDetail);
        modal(
          t("完整采样记录", "Complete observation"),
          `<pre>${esc(JSON.stringify(sample, null, 2))}</pre>`,
        );
      }),
  );
}
function bind() {
  if ($("search-form")) {
    const label = document.createElement("label");
    label.className = "check";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = model.includeArchived;
    checkbox.onchange = () => {
      model.includeArchived = checkbox.checked;
      model.offset = 0;
      action(load);
    };
    label.append(
      checkbox,
      document.createTextNode(t("包含归档", "Include archived")),
    );
    $("search-form").append(label);
  }
  if (model.route === "account") {
    const button = document.createElement("button");
    button.textContent = t("修改显示名称", "Edit display name");
    button.onclick = () =>
      formModal(
        t("显示名称", "Display name"),
        field(
          "name",
          t("名称", "Name"),
          model.user.name,
          "text",
          'required maxlength="80"',
        ),
        async (data) => {
          await api("auth/profile", { name: data.get("name") }, "PATCH");
        },
      );
    document.querySelector(".page .panel .row").prepend(button);
  }
  document
    .querySelectorAll("[data-nav]")
    .forEach((b) => (b.onclick = () => navigate(b.dataset.nav)));
  document.querySelectorAll("[data-plant]").forEach(
    (b) =>
      (b.onclick = () => {
        model.tab = "overview";
        navigate("plant/" + b.dataset.plant);
      }),
  );
  document.querySelectorAll("[data-tab]").forEach(
    (b) =>
      (b.onclick = () => {
        model.tab = b.dataset.tab;
        render();
      }),
  );
  for (const id of ["logout", "logout-side"])
    if ($(id)) $(id).onclick = () => action(logout);
  if ($("account-shortcut"))
    $("account-shortcut").onclick = () => navigate("account");
  for (const id of ["new-plant", "empty-new-plant"])
    if ($(id)) $(id).onclick = () => plantForm();
  if ($("edit-plant"))
    $("edit-plant").onclick = () => plantForm(model.detail.plant);
  if ($("new-recording")) $("new-recording").onclick = recordingForm;
  if ($("add-observation")) $("add-observation").onclick = observationForm;
  if ($("add-photo")) $("add-photo").onclick = () => photoForm();
  if ($("plant-export"))
    $("plant-export").onclick = () => exportForm({ plantId: model.plantId });
  if ($("new-export")) $("new-export").onclick = () => exportForm();
  if ($("plant-history"))
    $("plant-history").onclick = () => navigate("history");
  if ($("chart-metric"))
    $("chart-metric").onchange = (event) => {
      model.metric = event.target.value;
      $("chart-area").innerHTML = chart(model.samples);
    };
  if ($("search-form"))
    $("search-form").onsubmit = (event) => {
      event.preventDefault();
      model.q = new FormData(event.target).get("q");
      model.offset = 0;
      action(load);
    };
  if ($("plants-prev"))
    $("plants-prev").onclick = () => {
      model.offset = Math.max(0, model.offset - 60);
      action(load);
    };
  if ($("plants-next"))
    $("plants-next").onclick = () => {
      model.offset += 60;
      action(load);
    };
  document.querySelectorAll("[data-read]").forEach(
    (b) =>
      (b.onclick = () =>
        action(async () => {
          b.disabled = true;
          try {
            await api("sensors/" + b.dataset.read + "/read", {});
            toast(t("已获得新读数", "New reading received"));
          } finally {
            b.disabled = false;
          }
        })),
  );
  document.querySelectorAll("[data-manual]").forEach(
    (b) =>
      (b.onclick = () =>
        action(async () => {
          b.disabled = true;
          try {
            const result = await api(
              "sensors/" + b.dataset.manual + "/manual",
              {},
              "POST",
              { "Idempotency-Key": crypto.randomUUID() },
            );
            toast(
              t(
                "已保存新采样，可继续补照片",
                "Observation saved; you can add a photo",
              ),
            );
            await load();
            photoForm(result.sample);
          } finally {
            b.disabled = false;
          }
        })),
  );
  document
    .querySelectorAll("[data-bind]")
    .forEach(
      (b) => (b.onclick = () => action(() => bindPlant(b.dataset.bind))),
    );
  document.querySelectorAll("[data-configure]").forEach(
    (b) =>
      (b.onclick = () => {
        const s = model.state.sensors.find((s) => s.id === b.dataset.configure);
        formModal(
          t("传感器设置", "Sensor settings"),
          field("name", t("名称", "Name"), s.name, "text", "required") +
            field(
              "intervalSeconds",
              t("实时轮询间隔（秒）", "Live polling interval (seconds)"),
              s.interval_ms / 1000,
              "number",
              'required min="1" max="3600"',
            ),
          async (data) => {
            await api(
              "sensors/" + s.id,
              {
                name: data.get("name"),
                intervalMs: Number(data.get("intervalSeconds")) * 1000,
              },
              "PATCH",
            );
          },
        );
      }),
  );
  document.querySelectorAll("[data-stop]").forEach(
    (b) =>
      (b.onclick = () =>
        action(async () => {
          await api("recordings/" + b.dataset.stop + "/stop", {});
          await load();
        })),
  );
  document.querySelectorAll("[data-record-history]").forEach(
    (b) =>
      (b.onclick = () => {
        model.plantId = b.dataset.plantId;
        navigate("history");
      }),
  );
  if ($("archive-plant"))
    $("archive-plant").onclick = () =>
      formModal(
        t("归档状态", "Archive status"),
        `<p>${t("归档会结束正在进行的绑定和采集，历史记录仍会保留。", "Archiving ends active assignments and recordings while retaining the history.")}</p>`,
        async () => {
          await api(
            "plants/" + model.plantId,
            { archived: !model.detail.plant.archived },
            "PATCH",
          );
        },
      );
  if ($("change-password"))
    $("change-password").onclick = () =>
      formModal(
        t("修改密码", "Change password"),
        field(
          "oldPassword",
          t("当前密码", "Current password"),
          "",
          "password",
          'required autocomplete="current-password"',
        ) +
          field(
            "password",
            t("新密码", "New password"),
            "",
            "password",
            'required minlength="10" maxlength="128" autocomplete="new-password"',
          ),
        async (data) => {
          await api("auth/password", Object.fromEntries(data));
          model.user = null;
          model.stream?.close();
          renderAuth();
          toast(t("密码已修改，请重新登录", "Password changed; sign in again"));
        },
      );
  if ($("history-form")) {
    $("history-form").onsubmit = (event) => {
      event.preventDefault();
      const data = new FormData(event.target),
        filter = {
          plantId: data.get("plantId") || undefined,
          since: utc(data.get("since")),
          until: utc(data.get("until")),
          selectedOnly: data.get("selectedOnly") === "true",
        };
      action(() => historyQuery(filter));
    };
    $("history-export").onclick = () => {
      const d = new FormData($("history-form"));
      exportForm({
        plantId: d.get("plantId"),
        since: utc(d.get("since")),
        until: utc(d.get("until")),
      });
    };
  }
  if ($("history-older"))
    $("history-older").onclick = () =>
      action(() =>
        historyQuery({
          ...model.historyFilter,
          beforeSeq: model.historyResult.nextBefore,
        }),
      );
  if ($("refresh-jobs")) $("refresh-jobs").onclick = () => action(load);
  document.querySelectorAll("[data-cancel]").forEach(
    (b) =>
      (b.onclick = () =>
        action(async () => {
          await api("jobs/" + b.dataset.cancel + "/cancel", {});
          await load();
        })),
  );
  document
    .querySelectorAll("[data-context]")
    .forEach(
      (b) => (b.onclick = () => action(() => contextModal(b.dataset.context))),
    );
  document.querySelectorAll("[data-history-job]").forEach(
    (b) =>
      (b.onclick = () => {
        const job = model.jobs.find((j) => j.id === b.dataset.historyJob);
        model.historyResult = job.result;
        model.historyFilter = job.filter;
        model.samples = job.result.preview;
        navigate("history");
      }),
  );
  if (model.route === "admin") bindAdmin();
  bindSamples();
  if (model.route === "plant" && model.tab === "profile") {
    const b = document.createElement("button");
    b.textContent = t("生成分析数据快照", "Generate analysis context");
    b.onclick = () =>
      action(async () => {
        await api("plants/" + model.plantId + "/context-snapshots", {});
        toast(t("分析上下文已进入后台队列", "Context snapshot queued"));
        navigate("jobs");
      });
    document.querySelector(".page .panel").appendChild(b);
  }
}
function bindAdmin() {
  if ($("admin-new-user"))
    $("admin-new-user").onclick = () =>
      formModal(
        t("创建账号", "Create account"),
        field(
          "username",
          t("用户名", "Username"),
          "",
          "text",
          'required minlength="3" maxlength="40"',
        ) +
          field("name", t("显示名称", "Display name")) +
          field(
            "password",
            t("初始密码", "Initial password"),
            "",
            "password",
            'required minlength="10" maxlength="128"',
          ) +
          select("role", t("角色", "Role"), [
            ["user", t("普通用户", "User")],
            ["admin", t("管理员", "Administrator")],
          ]),
        async (data) => {
          await api("admin/users", Object.fromEntries(data));
        },
      );
  document.querySelectorAll("[data-reset-password]").forEach(
    (b) =>
      (b.onclick = () =>
        formModal(
          t("重置用户密码", "Reset account password"),
          `<p class="help">${t("将撤销该用户现有登录会话。", "This revokes existing login sessions.")}</p>` +
            field(
              "password",
              t("新密码", "New password"),
              "",
              "password",
              'required minlength="10" maxlength="128"',
            ),
          async (data) => {
            await api(
              "admin/users/" + b.dataset.resetPassword,
              { password: data.get("password") },
              "PATCH",
            );
          },
        )),
  );
  document.querySelectorAll("[data-user-toggle]").forEach(
    (b) =>
      (b.onclick = () =>
        action(async () => {
          const u = model.users.find((u) => u.id === b.dataset.userToggle);
          await api("admin/users/" + u.id, { active: !u.active }, "PATCH");
          await load();
        })),
  );
  document.querySelectorAll("[data-transfer]").forEach(
    (b) =>
      (b.onclick = () => {
        const s = model.state.sensors.find((s) => s.id === b.dataset.transfer);
        formModal(
          t("分配设备使用权", "Allocate device access"),
          `<p class="help">${esc(s.name)} · ${t("转交将结束原账号的绑定及采集，历史仍归原账号所有。", "Transfer ends the old assignment and recording. Previous history stays with the old account.")}</p>` +
            select(
              "ownerId",
              t("允许使用的账号", "Account with access"),
              [
                ["", t("收回，暂不分配", "Revoke access")],
                ...model.users
                  .filter((u) => u.active)
                  .map((u) => [u.id, u.name + " / " + u.username]),
              ],
              s.owner_id,
            ),
          async (data) => {
            await api("sensors/" + s.id + "/transfer", {
              ownerId: data.get("ownerId") || null,
            });
          },
        );
      }),
  );
  if ($("admin-new-gateway"))
    $("admin-new-gateway").onclick = () => {
      formModal(
        t("添加网关", "Add gateway"),
        field("name", t("网关名称", "Gateway name"), "", "text", "required") +
          `<label class="check"><input type="checkbox" name="simulated">${t("本地模拟网关（没有真实设备连接）", "Local simulated gateway (no hardware connection)")}</label>`,
        async (data) => {
          const g = await api("admin/gateways", {
            name: data.get("name"),
            simulated: data.has("simulated"),
          });
          setTimeout(() => registrationModal(g.registration), 0);
        },
      );
    };
  if ($("admin-new-sensor"))
    $("admin-new-sensor").onclick = () =>
      formModal(
        t("添加传感器", "Add sensor"),
        select(
          "gatewayId",
          t("网关", "Gateway"),
          model.gateways.map((g) => [g.id, g.name]),
          "",
          "required",
        ) +
          field(
            "name",
            t("传感器名称", "Sensor name"),
            "",
            "text",
            "required",
          ) +
          field(
            "address",
            t("Modbus 从机地址", "Modbus address"),
            2,
            "number",
            'required min="1" max="247"',
          ) +
          field("model", t("传感器型号", "Sensor model")) +
          field(
            "serialNumber",
            t("物理序列号（可选）", "Physical serial number (optional)"),
          ) +
          select("ownerId", t("分配账号", "Assign account"), [
            ["", t("暂不分配", "Unassigned")],
            ...model.users
              .filter((u) => u.active)
              .map((u) => [u.id, u.username]),
          ]) +
          `<label>${t("支持的指标", "Supported metrics")}</label><div class="fields">${model.state.metrics.map((m) => `<label class="check"><input type="checkbox" name="metrics" value="${m.key}" checked>${metricName(m.key)}</label>`).join("")}</div>`,
        async (data) => {
          await api("admin/sensors", {
            gatewayId: data.get("gatewayId"),
            name: data.get("name"),
            address: Number(data.get("address")),
            ownerId: data.get("ownerId") || undefined,
            metrics: data.getAll("metrics"),
            profile: {
              model: data.get("model"),
              serialNumber: data.get("serialNumber"),
            },
          });
        },
      );
  document.querySelectorAll("[data-rotate-gateway]").forEach(
    (b) =>
      (b.onclick = () =>
        formModal(
          t("重置接入凭据", "Rotate gateway credential"),
          `<p>${t("旧凭据立即失效。需要手动更新真实网关的注册包后才能重连。", "The old credential becomes invalid. Update the hardware registration packet manually before reconnecting.")}</p>`,
          async () => {
            const result = await api(
              "admin/gateways/" + b.dataset.rotateGateway + "/rotate-key",
              {},
            );
            setTimeout(() => registrationModal(result.registration), 0);
          },
        )),
  );
  if ($("admin-audit"))
    $("admin-audit").onclick = () =>
      action(async () => {
        const result = await api("admin/audit");
        modal(
          t("操作审计", "Audit trail"),
          `<pre>${esc(JSON.stringify(result.audit, null, 2))}</pre>`,
        );
      });
}
function registrationModal(registration) {
  modal(
    t("网关注册包（请妥善保存）", "Gateway registration packet"),
    `<p class="help">${t("仅本次显示，不包含 Wi-Fi 设置。当前尚未向真实硬件发送任何命令。", "Shown once. This does not include Wi-Fi settings. No command has been sent to hardware.")}</p><pre>${esc(registration)}</pre><p class="help">${t("当前仍是明文 TCP；正式接入前要验证固件支持的注册包长度与传输保护。", "The current transport is plain TCP. Verify firmware packet length and transport protection before production use.")}</p>`,
  );
}
window.addEventListener("hashchange", () => {
  if (model.user) action(load);
});
try {
  const session = await api("auth/me");
  model.user = session.user;
  model.csrf = session.csrf;
  await load();
  connectEvents();
} catch {
  renderAuth();
}
