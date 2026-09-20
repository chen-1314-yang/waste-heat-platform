
const eng = window.WHENG;
const D = window.HFDATA;
const IO = window.WHIO;
eng.setTables(D);

const DEMAND_MAP = IO.DEMAND_MAP;
const MEDIUM_MAP = IO.MEDIUM_MAP;
const REV_DEMAND = IO.REV_DEMAND;
const ICONS = {
  orc: "⚡", steam_pp: "⚡", teg: "⚡", direct: "♨", whb_steam: "♨",
  abs_self: "♨", abs_ext: "♨", comp: "♨", tc_storage: "▦", pcm_storage: "▦",
  abs_cool: "❄", comp_cool: "❄"
};

const $ = (id) => document.getElementById(id);
const num = (x, d = 0) => (x === null || x === undefined || isNaN(x)) ? "—" :
  Number(x).toLocaleString("zh-CN", { maximumFractionDigits: d });

let state = {
  t: 120, f: 50, medium: "热水/冷凝水", dT: 10, hours: 8000,
  demand: "发电", cont: "连续", drv: "余热自驱动", lam: 0.5
};

function readInputs() {
  state.t = +$("in-t").value; state.f = +$("in-f").value;
  state.medium = $("medium").value; state.dT = +$("in-dt").value;
  state.hours = +$("in-h").value; state.demand = $("demand").value;
  state.lam = +$("in-lam").value;
  $("v-t").textContent = state.t + " ℃"; $("v-f").textContent = state.f + " kg/s";
  $("v-dt").textContent = state.dT + " ℃"; $("v-h").textContent = state.hours + " h";
  $("v-lam").textContent = state.lam.toFixed(2);
}

function buildScene(t, f, medium, dT, hours, demand, cont, drv) {
  return {
    "需求": DEMAND_MAP[demand],
    "热源温度_degC": t, "载体": MEDIUM_MAP[medium], "流量_kg_s": f,
    "换热端差_degC": dT, "年运行小时": hours, "连续性": cont, "驱动来源": drv
  };
}

function currentScene() {
  return buildScene(state.t, state.f, state.medium, state.dT, state.hours,
    state.demand, state.cont, state.drv);
}

/* ---------------- 渲染 ---------------- */
function renderStage(validScene, res) {
  const st = eng.stage1(validScene);
  const rows = eng.PATH_KEYS.map((p) =>
    `<tr><td>${eng.DISPLAY[p]}</td><td class="${st.keep[p] ? "ok" : "no"}">${st.keep[p] ? "✓ 通过" : "✗ 排除"}</td><td>${st.reasons[p] || ""}</td></tr>`).join("");
  $("t-stage").innerHTML = "<tr><th>路径</th><th>结果</th><th>原因</th></tr>" + rows;
  if (res && !res.out_of_scope) {
    $("calc-note").textContent = `当前工况：${validScene["热源温度_degC"]}℃ · ${validScene["流量_kg_s"]} kg/s · ${REV_DEMAND[validScene["需求"]]} · 驱动=${validScene["驱动来源"]} · λ=${state.lam.toFixed(2)}；进入第二级候选：${res.labels.join("、") || "无"}`;
  }
}

function renderTopsis(res) {
  if (res.out_of_scope || !res.order) {
    $("t-topsis").innerHTML = "";
    $("ch-lam").innerHTML = "";
    $("lam-snap").textContent = "—";
    return;
  }
  const head = "<tr><th>排名</th><th>路径</th>" + eng.INDICATORS.map((h) => `<th>${h}</th>`).join("") +
    "<th>TOPSIS 贴近度</th></tr>";
  const body = res.order.map((o, i) =>
    `<tr class="${i === 0 ? "best" : ""}"><td>${i + 1}</td><td>${eng.DISPLAY[o.path]}</td>` +
    o.row.map((v, j) => {
      if (j === 3) return `<td>${v > 0 ? num(v, 1) : "—"}</td>`;
      if (j === 1 || j === 2) return `<td>${num(v, 2)}</td>`;
      if (j === 5) return `<td>${num(v, 1)}</td>`;
      return `<td>${num(v, 2)}</td>`;
    }).join("") + `<td>${o.closeness.toFixed(4)}</td></tr>`).join("");
  $("t-topsis").innerHTML = head + body;
  drawLam(res);
}

function drawLam(res) {
  const top5 = res.order.slice(0, 5);
  const names = top5.map((o) => eng.DISPLAY[o.path]);
  const X5 = top5.map((o) => o.row);
  const lines = [];
  for (let l = 0; l <= 1.0001; l += 0.05) {
    const w = eng.combinedWeights(l, X5, D.meta);
    lines.push({ l, c: eng.topsis(X5, w) });
  }
  const W = 780, H = 270, padL = 50, padB = 34, padT = 18, padR = 160;
  const X = (l) => padL + l * (W - padL - padR);
  const Y = (v) => H - padB - v * (H - padB - padT);
  const cols = ["#0E9F8A", "#3D6FB4", "#E8A33D", "#8A6BB8", "#E05252"];
  let s = `<line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="#C9D6E2"/>` +
    `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}" stroke="#C9D6E2"/>`;
  for (let k = 0; k < names.length; k++) {
    const pts = lines.map((row) => `${X(row.l).toFixed(1)},${Y(row.c[k]).toFixed(1)}`).join(" ");
    s += `<polyline points="${pts}" fill="none" stroke="${cols[k % 5]}" stroke-width="2.5"/>`;
    s += `<text x="${W - padR + 8}" y="${(Y(lines[lines.length - 1].c[k]) + 4).toFixed(1)}" font-size="12" fill="${cols[k % 5]}">${names[k]}</text>`;
  }
  for (let l = 0; l <= 1; l += 0.25) s += `<text x="${X(l)}" y="${H - 10}" text-anchor="middle" font-size="11" fill="#8AA0B4">λ=${l.toFixed(2)}</text>`;
  s += `<text x="${padL + 6}" y="${padT + 12}" font-size="11" fill="#8AA0B4">TOPSIS 贴近度</text>`;
  $("ch-lam").innerHTML = s;
  const snap = res.order.slice(0, 3).map((o) => `${eng.DISPLAY[o.path]}(${o.closeness.toFixed(3)})`).join(" ＞ ");
  $("lam-snap").textContent = `排序快照（λ=${state.lam.toFixed(2)}）：${snap}；拖动 λ 观察前几名排序变化。`;
}

function statCard(htmlId, key, val, unit) {
  $(htmlId + "-k").textContent = key;
  $(htmlId + "-v").textContent = val;
  $(htmlId + "-u").textContent = unit;
}

function renderTop(res) {
  const box = $("boundary-box"), scope = $("scope-box");
  box.innerHTML = ""; scope.innerHTML = "";
  if (res.out_of_scope || !res.top) {
    $("r-name").textContent = "—"; $("r-sub").textContent = "—";
    $("r-fit").textContent = "—"; $("r-icon").textContent = "?";
    ["s1", "s2"].forEach((k) => statCard(k, "—", "—", ""));
    $("s-co2").textContent = "—"; $("s-money").textContent = "—";
    if (res.message) scope.innerHTML = `<div class="warn">⚠ ${res.message}</div>`;
    return;
  }
  const top = res.top;
  const t = state.t, f = state.f, med = state.medium, hours = state.hours, dT = state.dT;
  const medCore = MEDIUM_MAP[med];
  let sub = "", icon = ICONS[top] || "•";
  let s1k = "可回收热功率", s1v = "—", s1u = "kW", s2k = "年发电量", s2v = "—", s2u = "MWh/年", co2 = 0, money = 0;
  if (top === "orc") {
    const d = eng.orcDetail(t, f, medCore, hours, dT);
    s1v = num(d.q, 0); s2v = num(d.mwh, 0); co2 = d.co2; money = d.money;
    sub = `ORC 净功率 P50 ${num(d.p50, 1)} kW/MW热（P10 ${num(d.p10, 1)}~P90 ${num(d.p90, 1)}，${num(d.n, 0)} 工况）· 实际回收 ${num(d.q, 0)} kW`;
  } else if (top === "steam_pp") {
    const d = eng.steamDetail(t, f, medCore, hours, dT);
    s1v = num(d.q, 0); s2v = num(d.mwh, 0); co2 = d.co2; money = d.money;
    sub = `蒸汽朗肯净功率 ${num(d.p50, 1)} kW/MW热 · 实际回收 ${num(d.q, 0)} kW`;
  } else if (top === "teg") {
    const q = eng.recoveredHeatKw(currentScene());
    s1v = num(q, 0); co2 = 0; money = 0; s2v = "—";
    sub = "TEG 温差发电兜底候选：未做发电细账（转换效率低，仅低品位备选）";
  } else if (top === "comp") {
    const d = eng.heatDetail(f, medCore, t, hours, dT, eng.HP_COP);
    s1v = num(d.q, 0); s2v = num(d.heatGj / 3.6, 0); s2u = "MWh 热/年"; co2 = d.co2; money = d.money;
    sub = `热泵提温 COP ${eng.HP_COP} · 替代天然气并扣除自身耗电（一次能源效率 ≈106%）`;
  } else if (top === "abs_cool") {
    const cop = eng.absCoolCop(t) || eng.COP_C_ABS;
    const q = eng.recoveredHeatKw(currentScene());
    const qCold = cop * q;
    const avoidedMwh = qCold / eng.COP_E_COOL * hours / 1000;
    co2 = avoidedMwh * eng.GRID_EF; money = avoidedMwh * 1000 * eng.ELEC_PRICE / 10000;
    s1v = num(q, 0); s2k = "服务冷量"; s2v = num(qCold, 0); s2u = "kW 冷";
    sub = `吸收式制冷 COP_c=${cop}（${t >= 85 ? "≥85℃ 0.7" : "80~84℃ 0.6"}）· 替代电压缩电耗 COP_e=${eng.COP_E_COOL}`;
    icon = "❄";
  } else if (top === "comp_cool") {
    s1v = "—"; s2v = "—"; s2u = ""; co2 = 0; money = 0;
    sub = "电压缩制冷为电制冷现状基准（减排记 0，与现状同口径）——本页不把它当作废热回收成果";
  } else {
    const isSteamNeed = state.demand === "工艺蒸汽";
    const d = eng.heatDetail(f, medCore, t, hours, dT, null);
    s1v = num(d.q, 0); s2v = num(d.heatGj / 3.6, 0); s2u = "MWh 热/年"; co2 = d.co2; money = d.money;
    if (top === "abs_self") {
      const cop = isSteamNeed ? 0.45 : 1.7;
      sub = `吸收式热泵 COP_h=${cop}（${isSteamNeed ? "二类制蒸汽 0.45" : "一类增热 1.7"}）· 替代天然气口径`;
    } else if (top === "abs_ext") {
      sub = "外购蒸汽驱动吸收式（哈石化余热暖民同型，COP_h≈1.7）· 已扣驱动蒸汽燃料";
    } else if (top === "direct") sub = "直接换热 · 替代天然气锅炉口径（0.0561 tCO₂/GJ ÷ 90%）";
    else if (top === "whb_steam") sub = "余热锅炉直接产汽 · 替代天然气锅炉口径";
    else sub = "储热路径 · 时空解耦（热量按替代天然气口径）";
  }
  $("r-name").textContent = eng.DISPLAY[top];
  $("r-sub").textContent = sub;
  $("r-fit").textContent = res.order[0].closeness.toFixed(3);
  $("r-icon").textContent = icon;
  statCard("s1", s1k, s1v, s1u); statCard("s2", s2k, s2v, s2u);
  $("s-co2").textContent = num(co2, 1);
  $("s-money").textContent = num(money, 1);
  eng.boundaryNotices(res).forEach((n) => {
    box.innerHTML += `<div class="warn boundary">${n}</div>`;
  });
  (res.warnings || []).forEach((w) => { scope.innerHTML += `<div class="warn">⚠ ${w}</div>`; });
}

function calc() {
  readInputs();
  const scene = currentScene();
  const v = eng.validateScene(scene);
  const scope = $("scope-box");
  scope.innerHTML = "";
  if (!v.ok) {
    renderStage(scene, null);
    renderTop({ out_of_scope: true, message: v.error });
    renderTopsis({ out_of_scope: true });
    return;
  }
  const res = eng.runDecision(v.scene, state.lam, D.meta);
  renderStage(v.scene, res);
  renderTop(res);
  renderTopsis(res);
}

/* ---------------- 实时数据接入（io.js 驱动） ---------------- */
function mediumFromType(type) {
  const s = type || "";
  if (/烟气|排烟|废气/.test(s)) return "烟气";
  if (/渣|熔盐|工艺液/.test(s)) return "工艺液体";
  return "热水/冷凝水";
}

const DEMAND_OPT_HTML = ["发电", "工艺蒸汽", "供暖/热水", "储热调峰", "供冷（制冷）", "干燥/烘干"]
  .map((d) => `<option>${d}</option>`).join("");

const rtLive = {
  kind: "sim", source: null, fileSrc: null, frame: null,
  hist: [], lastTs: 0, base: 120, ageTimer: null
};

function ioDefaults() {
  return {
    t_base: state.t, f_base: state.f, medium: state.medium, demand: state.demand,
    continuity: state.cont, driver: state.drv, dT: state.dT, hours: state.hours
  };
}

function ioRenderCfg() {
  const kind = $("io-kind").value;
  rtLive.kind = kind;
  const box = $("io-cfg");
  const d = ioDefaults();
  let h = "";
  if (kind === "sim") {
    h = `<div class="field"><label>热源基准温度 <b id="v-sim-t">${d.t_base} ℃</b></label>
      <input type="range" id="sim-t" min="25" max="900" step="5" value="${d.t_base}"></div>
      <div class="field"><label>波动幅度 <b id="v-sim-amp">20 ℃</b></label>
      <input type="range" id="sim-amp" min="0" max="120" step="5" value="20"></div>
      <div class="field"><label>波动波形</label>
      <select id="sim-wave"><option>正弦</option><option>阶跃</option><option>随机</option></select></div>
      <div class="field"><label>流量基准 <b id="v-sim-f">${d.f_base} kg/s</b></label>
      <input type="range" id="sim-f" min="0.5" max="200" step="0.5" value="${d.f_base}"></div>
      <div class="field"><label>用能需求</label><select id="sim-demand">${DEMAND_OPT_HTML}</select></div>`;
  } else if (kind === "file") {
    h = `<div class="field"><label>选择历史文件</label><input type="file" id="io-file" accept=".csv,.json"></div>
      <div class="field"><label>回放默认需求</label><select id="file-demand">${DEMAND_OPT_HTML}</select></div>
      <div class="field"><label>回放默认介质</label>
      <select id="file-medium"><option>热水/冷凝水</option><option>烟气</option><option>工艺液体</option></select></div>
      <div class="note">CSV 模板：ts,t_src_degC,m_dot_kg_s[,medium,demand,continuity,driver,dT_degC,hours]；缺失列用默认值补全；按真实时间戳回放。</div>`;
  } else if (kind === "http") {
    const host = location.hostname || "127.0.0.1";
    h = `<div class="field"><label>HTTP 地址</label>
      <input id="http-url" placeholder="http://127.0.0.1:8791/api/telemetry" value="http://${host}:8791/api/telemetry"></div>
      <div class="field"><label>轮询间隔 <b id="v-http-iv">2000 ms</b></label>
      <input type="range" id="http-iv" min="200" max="10000" step="100" value="2000"></div>`;
  } else {
    const host = location.hostname || "127.0.0.1";
    h = `<div class="field"><label>WebSocket 地址</label>
      <input id="ws-url" placeholder="ws://127.0.0.1:8787/ws" value="ws://${host}:8787/ws"></div>`;
  }
  box.innerHTML = h;
  ["sim-t", "sim-amp", "sim-f", "http-iv"].forEach((id) => {
    const el = $(id);
    if (el) {
      const lbl = { "sim-t": "v-sim-t", "sim-amp": "v-sim-amp", "sim-f": "v-sim-f", "http-iv": "v-http-iv" }[id];
      el.addEventListener("input", () => { $(lbl).textContent = el.value + (id === "http-iv" ? " ms" : (id === "sim-amp" ? " ℃" : (id === "sim-t" ? " ℃" : " kg/s"))); });
    }
  });
}

function ioStateText(st) {
  const map = { idle: "未连接", connecting: "连接中…", live: "已连接", error: "错误", stale: "数据过期" };
  return map[st.state] || st.state;
}
function ioStateColor(st) {
  return { idle: "#64748B", connecting: "#3D6FB4", live: "#0E9F8A", error: "#E05252", stale: "#B57A1E" }[st.state] || "#64748B";
}

function ioAgeTick() {
  const st = rtLive.source ? rtLive.source.status() : { state: "idle" };
  $("io-state").textContent = ioStateText(st);
  $("io-state").style.color = ioStateColor(st);
  $("io-detail").textContent = st.detail || (rtLive.kind === "file" ? "文件回放中" : "");
  const warnBox = $("io-warn");
  warnBox.innerHTML = "";
  if (st.state === "error" || st.state === "stale") {
    warnBox.innerHTML = `<div class="warn">⚠ ${st.detail || "数据连接异常"}：当前结果仅参考，请检查数据源/地址。</div>`;
  }
  if (rtLive.frame) {
    const age = Math.round((Date.now() - rtLive.lastTs) / 1000);
    $("io-age-note").innerHTML = `距上帧 <b>${age}</b> 秒 · 质量 <b>${rtLive.frame.quality}</b>` +
      (rtLive.frame.error ? ` · ${rtLive.frame.error}` : "");
    if (age > 5) warnBox.innerHTML += `<div class="warn">⚠ 数据 ${age} 秒未更新，当前结果仅参考。</div>`;
    if (rtLive.frame.quality === "over_range") {
      warnBox.innerHTML += `<div class="warn">⚠ 当前帧温度越界（${rtLive.frame.t_src_degC}℃），引擎将按能力圈外处理。</div>`;
    }
  }
}

function onIoFrame(f) {
  rtLive.frame = f;
  rtLive.lastTs = Date.now();
  rtLive.hist = rtLive.hist.slice(-59).concat([f.t_src_degC]);
  if (rtLive.base === 120 && rtLive.hist.length === 1) rtLive.base = f.t_src_degC;
  drawRtChart();
  renderRtFrame(f);
  ioAgeTick();
}

function ioConnect() {
  ioDisconnect();
  const kind = rtLive.kind;
  const d = ioDefaults();
  const warnBox = $("io-warn");
  warnBox.innerHTML = "";
  let src = null;
  if (kind === "sim") {
    src = new IO.SimSource({
      t_base: +$("sim-t").value, t_amp: +$("sim-amp").value,
      t_wave: $("sim-wave").value, f_base: +$("sim-f").value, f_amp: 0,
      t_period_s: 60, medium: d.medium, demand: $("sim-demand").value,
      continuity: d.continuity, driver: d.driver, dT_degC: d.dT, hours: d.hours
    });
    rtLive.fileSrc = null;
    $("io-pause").style.display = "none"; $("io-step").style.display = "none";
  } else if (kind === "file") {
    const input = $("io-file");
    if (!input.files || !input.files.length) {
      warnBox.innerHTML = `<div class="warn">⚠ 请先选择 CSV/JSON 历史文件。</div>`;
      return;
    }
    src = new IO.FilePlaybackSource({
      defaults: { demand: $("file-demand").value, medium: $("file-medium").value,
        continuity: "连续", driver: "余热自驱动", dT_degC: d.dT, hours: d.hours }
    });
    src.connect(null, onIoFrame);
    src.loadFile(input.files[0]).then((n) => {
      rtLive.fileSrc = src;
      $("io-pause").style.display = "inline-block";
      $("io-step").style.display = "inline-block";
      src.play();
    }).catch((e) => {
      warnBox.innerHTML = `<div class="warn">⚠ 文件解析失败：${e.message}</div>`;
      ioDisconnect();
    });
    rtLive.source = src;
    ioAgeTick();
    return;
  } else if (kind === "http") {
    src = new IO.HttpPollSource({
      url: $("http-url").value.trim(), interval_ms: +$("http-iv").value,
      defaults: { demand: d.demand, medium: d.medium, continuity: d.continuity,
        driver: d.driver, dT_degC: d.dT, hours: d.hours }
    });
    $("io-pause").style.display = "none"; $("io-step").style.display = "none";
  } else {
    src = new IO.WsSource({ url: $("ws-url").value.trim() });
    $("io-pause").style.display = "none"; $("io-step").style.display = "none";
  }
  rtLive.source = src;
  rtLive.fileSrc = null;
  rtLive.lastTs = Date.now();
  src.connect(null, onIoFrame);
  ioAgeTick();
}

function ioDisconnect() {
  if (rtLive.source) { try { rtLive.source.disconnect(); } catch (e) {} }
  rtLive.source = null; rtLive.fileSrc = null;
  $("io-state").textContent = "未连接";
  $("io-state").style.color = "#64748B";
  $("io-pause").style.display = "none"; $("io-step").style.display = "none";
}

function drawRtChart() {
  const W = 900, H = 240, padL = 52, padB = 30, padT = 14, padR = 18;
  const hist = rtLive.hist.length ? rtLive.hist : [rtLive.base || 120];
  const all = hist.concat([rtLive.base || 120]);
  const tmin = Math.min.apply(null, all) - 3, tmax = Math.max.apply(null, all) + 3;
  const X = (i) => padL + (i / 59) * (W - padL - padR);
  const Y = (v) => H - padB - ((v - tmin) / (tmax - tmin)) * (H - padB - padT);
  let s = `<line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="#C9D6E2"/>` +
    `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}" stroke="#C9D6E2"/>`;
  if (hist.length > 1) {
    const pts = hist.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
    s += `<polyline points="${pts}" fill="none" stroke="#0E9F8A" stroke-width="2.5"/>`;
    const last = hist[hist.length - 1];
    s += `<circle cx="${X(hist.length - 1).toFixed(1)}" cy="${Y(last).toFixed(1)}" r="5" fill="#E05252"/>`;
    s += `<text x="${X(hist.length - 1) + 8}" y="${Y(last) - 8}" font-size="13" font-weight="800" fill="#E05252">${Number(last).toFixed(1)}℃</text>`;
  }
  for (let k = 0; k <= 4; k++) {
    const v = tmin + (k / 4) * (tmax - tmin);
    s += `<text x="${padL - 8}" y="${Y(v) + 4}" text-anchor="end" font-size="10.5" fill="#8AA0B4">${Math.round(v)}</text>`;
  }
  s += `<text x="${padL + 10}" y="${padT + 12}" font-size="11" fill="#8AA0B4">热源温度（℃）· 最近 ${hist.length} 帧</text>`;
  $("rt-chart").innerHTML = s;
  const f = rtLive.frame;
  $("rt-legend").textContent = f
    ? `数据源：${$("io-kind").selectedOptions[0].textContent} · 当前 ${Number(f.t_src_degC).toFixed(1)}℃ / ${f.m_dot_kg_s} kg/s · ${f.demand} · ${f.medium}`
    : "—";
}

function renderRtFrame(f) {
  const scene = IO.frameToScene(f);
  const box = $("rt-boundary");
  box.innerHTML = "";
  const v = eng.validateScene(scene);
  $("rt-t").textContent = Number(f.t_src_degC).toFixed(1);
  $("rt-out").textContent = "—"; $("rt-co2").textContent = "—";
  $("rt-sub").textContent = ""; $("rt-rank").innerHTML = "";
  $("rt-warn").textContent = "—";
  if (f.quality === "invalid") {
    $("rt-name").textContent = "数据无效";
    $("rt-sub").textContent = f.error || "帧缺温度或流量/规模";
    $("rt-fit").textContent = "—"; $("rt-icon").textContent = "?";
    return;
  }
  if (!v.ok) {
    $("rt-name").textContent = "能力圈外";
    $("rt-sub").textContent = v.error;
    $("rt-fit").textContent = "—"; $("rt-icon").textContent = "?";
    box.innerHTML = `<div class="warn">⚠ ${v.error}</div>`;
    return;
  }
  const res = eng.runDecision(v.scene, state.lam, D.meta);
  const top = res.top;
  $("rt-icon").textContent = top ? (ICONS[top] || "•") : "?";
  $("rt-name").textContent = top ? eng.DISPLAY[top] : "无可行候选";
  $("rt-fit").textContent = res.order && res.order.length ? res.order[0].closeness.toFixed(3) : "—";
  const t = Number(f.t_src_degC), m = Number(f.m_dot_kg_s), hours = f.hours, dT = f.dT_degC;
  const medium = f.medium;
  if (top === "orc") {
    const dd = eng.orcDetail(t, m, MEDIUM_MAP[medium], hours, dT);
    $("rt-out").textContent = num(dd.mwh, 0); $("rt-out-u").textContent = "MWh/年";
    $("rt-co2").textContent = num(dd.co2, 1);
    $("rt-sub").textContent = `ORC P50 ${num(dd.p50, 1)} kW/MW热 · 回收 ${num(dd.q, 0)} kW`;
  } else if (top === "steam_pp") {
    const dd = eng.steamDetail(t, m, MEDIUM_MAP[medium], hours, dT);
    $("rt-out").textContent = num(dd.mwh, 0); $("rt-out-u").textContent = "MWh/年";
    $("rt-co2").textContent = num(dd.co2, 1);
    $("rt-sub").textContent = `蒸汽朗肯 P50 ${num(dd.p50, 1)} kW/MW热`;
  } else if (top === "abs_cool") {
    const cop = eng.absCoolCop(t) || eng.COP_C_ABS;
    const q = eng.recoveredHeatKw(v.scene);
    $("rt-out").textContent = num(cop * q, 0); $("rt-out-u").textContent = "kW 冷";
    $("rt-co2").textContent = num(cop * q / eng.COP_E_COOL * hours / 1000 * eng.GRID_EF, 1);
    $("rt-sub").textContent = `吸收式制冷 COP_c=${cop} · 替代电压缩电耗`;
  } else if (top === "comp_cool") {
    $("rt-out").textContent = "—"; $("rt-out-u").textContent = "";
    $("rt-co2").textContent = "0";
    $("rt-sub").textContent = "电压缩制冷为电制冷现状基准（减排记 0）";
  } else if (top === "teg") {
    const q = eng.recoveredHeatKw(v.scene);
    $("rt-out").textContent = num(q, 0); $("rt-out-u").textContent = "kW 回收热";
    $("rt-co2").textContent = "0";
    $("rt-sub").textContent = "TEG 温差发电兜底候选（未做发电细账）";
  } else {
    const dd = eng.heatDetail(m, MEDIUM_MAP[medium], t, hours, dT, top === "comp" ? eng.HP_COP : null);
    $("rt-out").textContent = num(dd.heatGj / 3.6, 0); $("rt-out-u").textContent = "MWh 热/年";
    $("rt-co2").textContent = num(dd.co2, 1);
    $("rt-sub").textContent = top === "comp" ? "热泵提温 COP 2.8（扣耗电）" : "替代天然气口径";
  }
  const notes = eng.boundaryNotices(res);
  $("rt-warn").textContent = notes.length ? "见下方提示" : (res.out_of_scope ? "越界" : "无");
  $("rt-warn").style.color = notes.length ? "#B57A1E" : "#0E9F8A";
  notes.forEach((n) => { box.innerHTML += `<div class="warn boundary">${n}</div>`; });
  (res.warnings || []).forEach((w) => { box.innerHTML += `<div class="warn">⚠ ${w}</div>`; });
  if (res.order) {
    const head = "<tr><th>#</th><th>路径</th><th>贴近度</th><th>能效%</th><th>CO₂减排 t/年</th></tr>";
    const body = res.order.slice(0, 5).map((o, i) =>
      `<tr class="${i === 0 ? "best" : ""}"><td>${i + 1}</td><td>${eng.DISPLAY[o.path]}</td>` +
      `<td>${o.closeness.toFixed(3)}</td><td>${num(o.row[0], 2)}</td><td>${o.row[3] > 0 ? num(o.row[3], 1) : "—"}</td></tr>`).join("");
    $("rt-rank").innerHTML = head + body;
  }
}

/* ---------------- 帕累托前沿 ---------------- */
function svgPareto(el, points, line, extra, xlab, ylab, cur) {
  const W = 900, H = 430, padL = 66, padB = 46, padT = 18, padR = 20;
  const ptsAll = points.concat(line || []).concat(extra || []).concat(cur ? [cur] : []);
  let xmax = Math.max.apply(null, ptsAll.map((p) => p[0])) * 1.08 || 1;
  let ymax = Math.max.apply(null, ptsAll.map((p) => p[1])) * 1.08 || 1;
  const X = (x) => padL + x / xmax * (W - padL - padR);
  const Y = (y) => H - padB - y / ymax * (H - padB - padT);
  const eff = (p) => Math.min(1, Math.max(0, (p[2] - 0.09) / 0.07));
  const col = (p) => eff(p) > 0.66 ? "#E8A33D" : eff(p) > 0.33 ? "#0E9F8A" : "#6FA8DC";
  let s = `<line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="#C9D6E2"/>` +
    `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}" stroke="#C9D6E2"/>`;
  s += `<text x="${padL + (W - padL - padR) / 2}" y="${H - 8}" text-anchor="middle" font-size="13" fill="#8AA0B4">${xlab}</text>`;
  s += `<text x="15" y="${padT + (H - padB - padT) / 2}" text-anchor="middle" font-size="13" fill="#8AA0B4" transform="rotate(-90 15 ${padT + (H - padB - padT) / 2})">${ylab}</text>`;
  for (let k = 0; k <= 4; k++) {
    const t = k / 4;
    s += `<text x="${X(t * xmax)}" y="${H - padB + 20}" text-anchor="middle" font-size="11" fill="#8AA0B4">${Math.round(t * xmax)}</text>` +
      `<text x="${padL - 8}" y="${Y(t * ymax) + 4}" text-anchor="end" font-size="11" fill="#8AA0B4">${Math.round(t * ymax)}</text>`;
  }
  if (line) s += `<polyline points="${line.map((p) => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(" ")}" fill="none" stroke="#0E9F8A" stroke-width="3.2"/>`;
  points.forEach((p) => { s += `<circle cx="${X(p[0]).toFixed(1)}" cy="${Y(p[1]).toFixed(1)}" r="3.4" fill="${col(p)}" opacity="0.8"/>`; });
  (extra || []).forEach((p) => { s += `<circle cx="${X(p[0]).toFixed(1)}" cy="${Y(p[1]).toFixed(1)}" r="4.8" fill="#3D6FB4" stroke="#fff" stroke-width="1.2"/>`; });
  if (cur) s += `<circle cx="${X(cur[0]).toFixed(1)}" cy="${Y(cur[1]).toFixed(1)}" r="7" fill="#E05252" stroke="#fff" stroke-width="2"/>`;
  el.innerHTML = s;
}

function currentPerMW() {
  readInputs();
  const med = MEDIUM_MAP[state.medium];
  const scene = buildScene(state.t, state.f, state.medium, state.dT, 8000, state.demand, state.cont, state.drv);
  let orc = null, steam = null;
  if (state.t >= 110 && state.t <= 350) {
    const o = eng.orcDetail(state.t, state.f, MEDIUM_MAP[state.medium], 8000, state.dT);
    if (o) orc = [o.money, o.p50];
  }
  if (state.t >= 280 && state.t <= 650) {
    const st = eng.steamDetail(state.t, state.f, MEDIUM_MAP[state.medium], 8000, state.dT);
    if (st) steam = [st.money, st.p50];
  }
  return { orc, steam };
}

function drawParetoTabs() {
  const cur = currentPerMW();
  svgPareto($("ch-orc"), D.pymoo, D.orcF, D.real14, "设备成本代理（万元）", "净功率（kW/MW 回收热）", cur.orc);
  const co2Pts = D.orcF.map((p) => [p[0], p[1] * 8000 * eng.GRID_EF / 1000]);
  const co2Real = D.real14.map((p) => [p[0], p[1] * 8000 * eng.GRID_EF / 1000]);
  svgPareto($("ch-co2"), co2Real, co2Pts, null, "设备成本代理（万元）", "年碳减排（tCO₂）",
    cur.orc ? [cur.orc[0], cur.orc[1] * 8000 * eng.GRID_EF / 1000] : null);
  svgPareto($("ch-steam"), D.steam, D.stF, null, "设备成本代理（万元）", "净功率（kW/MW 回收热）", cur.steam);
}

/* ---------------- 动态 LCA ---------------- */
function drawLca() {
  const W = 900, H = 430, padL = 60, padB = 46, padT = 18, padR = 18;
  const maxCum = Math.max.apply(null, D.monthly.map((r) => r[2]));
  const maxM = Math.max.apply(null, D.monthly.map((r) => r[1]));
  const bw = (W - padL - padR) / 12;
  const X = (i) => padL + i * bw + bw * 0.22;
  const Y = (v) => H - padB - v / maxM * (H - padB - padT);
  let s = `<line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="#C9D6E2"/>` +
    `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}" stroke="#C9D6E2"/>`;
  D.monthly.forEach((r, i) => {
    const h = r[1] / maxM * (H - padB - padT);
    s += `<rect x="${X(i).toFixed(1)}" y="${(H - padB - h).toFixed(1)}" width="${(bw * 0.56).toFixed(1)}" height="${h.toFixed(1)}" rx="5" fill="#0E9F8A" opacity="0.92"/>`;
    s += `<text x="${(X(i) + bw * 0.28).toFixed(1)}" y="${H - padB + 20}" text-anchor="middle" font-size="11" fill="#8AA0B4">${i + 1}月</text>`;
    s += `<text x="${(X(i) + bw * 0.28).toFixed(1)}" y="${(H - padB - h - 6).toFixed(1)}" text-anchor="middle" font-size="10" fill="#5E7387">${r[1].toFixed(1)}</text>`;
  });
  const cumPts = D.monthly.map((r, i) => `${(X(i) + bw * 0.28).toFixed(1)},${(H - padB - r[2] / maxCum * 280).toFixed(1)}`).join(" ");
  s += `<polyline points="${cumPts}" fill="none" stroke="#E8A33D" stroke-width="3"/>`;
  s += `<text x="${padL + 8}" y="${padT + 14}" font-size="12" fill="#8AA0B4">月度降碳（tCO₂）· 金线 = 全年累计</text>`;
  s += `<text x="${W - padR}" y="${H - 8}" text-anchor="end" font-size="12" fill="#B57A1E">年累计 ${num(D.monthly[11][2], 1)} tCO₂</text>`;
  $("ch-lca").innerHTML = s;

  const W2 = 900, H2 = 360, padL2 = 64, padB2 = 42, padT2 = 18, padR2 = 18;
  const maxC = Math.max.apply(null, D.mcHist.counts);
  const bw2 = (W2 - padL2 - padR2) / D.mcHist.n;
  let t = "";
  D.mcHist.counts.forEach((c, i) => {
    const h = c / maxC * (H2 - padB2 - padT2);
    t += `<rect x="${(padL2 + i * bw2 + bw2 * 0.12).toFixed(1)}" y="${(H2 - padB2 - h).toFixed(1)}" width="${(bw2 * 0.76).toFixed(1)}" height="${h.toFixed(1)}" fill="#6FA8DC" opacity="0.88"/>`;
  });
  const px = (v) => padL2 + (v - D.mcHist.lo) / (D.mcHist.hi - D.mcHist.lo) * (W2 - padL2 - padR2);
  [[D.mcP5, "#E05252"], [D.mcP50, "#E8A33D"], [D.mcP95, "#E05252"]].forEach(([v, c]) => {
    t += `<line x1="${px(v).toFixed(1)}" y1="${padT2}" x2="${px(v).toFixed(1)}" y2="${H2 - padB2}" stroke="${c}" stroke-width="2" stroke-dasharray="5 4"/>`;
  });
  t += `<text x="${px(D.mcP5).toFixed(1)}" y="${padT2 + 12}" text-anchor="middle" font-size="11" fill="#E05252">P5 ${D.mcP5}</text>`;
  t += `<text x="${px(D.mcP50).toFixed(1)}" y="${padT2 + 28}" text-anchor="middle" font-size="11" fill="#B57A1E">P50 ${D.mcP50}</text>`;
  t += `<text x="${px(D.mcP95).toFixed(1)}" y="${padT2 + 12}" text-anchor="middle" font-size="11" fill="#E05252">P95 ${D.mcP95}</text>`;
  t += `<text x="${padL2 + (W2 - padL2 - padR2) / 2}" y="${H2 - 8}" text-anchor="middle" font-size="12" fill="#8AA0B4">年降碳（tCO₂/年）· ${num(D.mcN, 0)} 次抽样</text>`;
  $("ch-mc").innerHTML = t;
  $("mc-note").textContent = `年降碳基准 ${D.mcP50} tCO₂/年，P5~P95 ≈ ${D.mcP5}~${D.mcP95} tCO₂/年（与申报口径一致）。`;
}

/* ---------------- 工况库 ---------------- */
function drawConds(filter) {
  const q = (filter || "").toLowerCase();
  const rows = D.conds.filter((r) => !q || r[0].toLowerCase().includes(q) || r[1].toLowerCase().includes(q) || r[2].toLowerCase().includes(q));
  $("t-conds").innerHTML = "<tr><th>工况名称</th><th>行业</th><th>热源类型</th><th>温度℃</th><th>流量kg/s</th><th>需求</th><th>连续性</th><th>数据来源</th></tr>" +
    rows.map((r, ri) => {
      const i = D.conds.indexOf(r);
      return `<tr class="cond-row" data-i="${i}"><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td>${r[3]}</td><td>${r[4]}</td><td>${r[9]}</td><td>${r[10]}</td><td>${r[11]}</td></tr>`;
    }).join("");
  document.querySelectorAll("#t-conds .cond-row").forEach((el) => {
    el.addEventListener("click", () => loadCond(+el.dataset.i));
  });
}

function applyCondToUi(r) {
  $("in-t").value = r[3]; $("in-f").value = r[4]; $("demand").value = r[9];
  $("in-h").value = r[8] || 8000;
  const med = mediumFromType(r[2]);
  $("medium").value = med;
  document.querySelectorAll(".chips .chip[data-c]").forEach((c) => c.classList.toggle("active", c.dataset.c === r[10]));
  document.querySelectorAll(".chips .chip[data-drv]").forEach((c) => c.classList.toggle("active", c.dataset.drv === "余热自驱动"));
}

function loadCond(i) {
  const r = D.conds[i];
  applyCondToUi(r);
  state.cont = r[10]; state.drv = "余热自驱动";
  $("preset").value = r[0];
  calc();
  switchTab("calc");
}

function fillPreset() {
  const name = $("preset").value;
  if (!name) return;
  const i = D.conds.findIndex((c) => c[0] === name);
  if (i >= 0) loadCond(i);
}

/* ---------------- 切换 / 绑定 / 初始化 ---------------- */
function switchTab(name) {
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll("section.tab").forEach((s) => s.classList.toggle("active", s.id === "tab-" + name));
  if (name === "pareto") drawParetoTabs();
  if (name === "lca") drawLca();
  if (name === "conds") drawConds($("cond-search").value);
  if (name === "realtime" && rtLive.kind === "sim" && !rtLive.source) ioConnect();
}

/* ===== 新站适配层（自动生成，勿手改）=====
   老站的绑定与初始化原本在脚本顶层执行，那一套假设整个页面都是它自己的。
   在新站里它只是一个页签，所以：
     1) 导航绑定交给新站外壳（下面原 NAV_BINDING 那行已被移除）；
     2) 顶层初始化收进 initLegacyTools()，由新站首次打开工具页签时调用一次；
     3) LEGACY_ON_SHOW 复刻老站 switchTab 里的"切到某页要做的事"。
   ============================================ */
window.LEGACY_ON_SHOW = {
  calc: function () { calc(); },
  realtime: function () {
    if (rtLive.kind === "sim" && !rtLive.source) ioConnect();
  },
  pareto: function () { drawParetoTabs(); },
  lca: function () { drawLca(); },
  conds: function () { drawConds($("cond-search").value); },
  method: function () {}
};

window.initLegacyTools = function () {
  if (window.__legacyReady) { return; }
  var __host = document.getElementById("legacy-host");
  try {
document.querySelectorAll(".chips .chip[data-c]").forEach((c) => c.addEventListener("click", () => {
  document.querySelectorAll(".chips .chip[data-c]").forEach((x) => x.classList.remove("active"));
  c.classList.add("active"); state.cont = c.dataset.c; calc();
}));
document.querySelectorAll(".chips .chip[data-drv]").forEach((c) => c.addEventListener("click", () => {
  document.querySelectorAll(".chips .chip[data-drv]").forEach((x) => x.classList.remove("active"));
  c.classList.add("active"); state.drv = c.dataset.drv; calc();
}));
$("btn").addEventListener("click", calc);
$("preset").addEventListener("change", fillPreset);
$("cond-search").addEventListener("input", () => drawConds($("cond-search").value));
[$("in-t"), $("in-f"), $("in-dt"), $("in-h"), $("in-lam"), $("medium"), $("demand")].forEach((el) => {
  el.addEventListener("input", readInputs);
  el.addEventListener("change", calc);
});

$("io-kind").addEventListener("change", () => { ioDisconnect(); ioRenderCfg(); });
$("io-connect").addEventListener("click", ioConnect);
$("io-disconnect").addEventListener("click", ioDisconnect);
$("io-pause").addEventListener("click", () => {
  if (!rtLive.fileSrc) return;
  const st = rtLive.fileSrc.status().state;
  if (st === "playing") {
    rtLive.fileSrc.pause();
    $("io-pause").textContent = "▶ 继续";
  } else {
    rtLive.fileSrc.play();
    $("io-pause").textContent = "⏸ 暂停";
  }
  ioAgeTick();
});
$("io-step").addEventListener("click", () => {
  if (rtLive.fileSrc) { rtLive.fileSrc.step(); ioAgeTick(); }
});
rtLive.ageTimer = setInterval(ioAgeTick, 1000);

// 初始化
D.conds.forEach((c) => {
  const o = document.createElement("option"); o.value = c[0]; o.textContent = c[0];
  $("preset").appendChild(o);
});
calc();
drawLca();
drawConds("");
ioRenderCfg();

    window.__legacyReady = true;
    if (__host) { __host.setAttribute("data-legacy", "ready"); }
  } catch (err) {
    var msg = String((err && err.message) || err);
    window.__legacyError = msg;
    if (__host) { __host.setAttribute("data-legacy-error", msg); }
    if (window.console && window.console.error) {
      window.console.error("[legacy] 初始化失败：", err);
    }
  }
};
