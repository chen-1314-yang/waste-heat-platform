/* app.js —— 对话式前端。只做三件事：发消息、把 SSE 步骤**逐条**画出来、把后端给的结构化字段摊开。
 *
 * 🔴 本文件**不做任何数值计算**。所有显示出来的数字都直接来自后端 JSON 里
 *    引擎对象的字段（ledger / engineRaw / certificate）。唯一的"加工"是 .toFixed()/字符串拼接
 *    这类**纯排版**，且只作用于后端已经给出的数值（不产生新数、不改小数位）。
 *
 * 🔴 步骤是**逐条出现**的：SSE 每来一条就画一条，绝不"等全部算完再一次性渲染"。
 *    （回答到达后会把它们**收起来**成一行"计算过程（N 步）"——这是 N3 的整洁要求，
 *      收起不等于不显示：点一下就看得到全部步骤，且仍然是一条条来的。）
 *
 * 🔴 N4：下一步 chips **只渲染后端白名单给出的那些**。前端**不许**自己生成、拼接、
 *     "顺手加一个" —— 那样就把"建议必须系统真能做"这条纪律绕过去了。
 */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (v) => (typeof v === "number" && isFinite(v)) ? String(v) : String(v == null ? "—" : v);
const md = (s) => (window.WHMD ? window.WHMD.render(s) : esc(s));
const nowClock = () => { const d = new Date(); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };

let META = null, HEALTH = null, SESSION = null, busy = false, ctrl = null;

/* 会话 id 存在 sessionStorage，刷新页面不丢上下文 */
function loadSessionId() { try { return sessionStorage.getItem("agent_wh_cloud_sid") || ""; } catch { return ""; } }
function saveSessionId(id) { try { sessionStorage.setItem("agent_wh_cloud_sid", id || ""); } catch { /* 隐私模式下忽略 */ } }

/* ============================================================ 启动 */

async function boot() {
  try { META = await (await fetch("/api/meta")).json(); } catch (e) { console.error(e); }
  try { HEALTH = await (await fetch("/api/health")).json(); } catch (e) { console.error(e); }
  renderHealth();
  renderKB();
  fillForm();
  SESSION = loadSessionId() || null;
  if (SESSION) {
    try { if (!(await fetch('/api/session/status', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:SESSION})})).ok) SESSION=null; }
    catch { SESSION=null; }
  }
  if (!SESSION) await newSession(false);
  renderWelcome();
  if (window.parent !== window) window.parent.postMessage({type:'waste-heat-agent-ready',ai:!!(HEALTH && HEALTH.llm && HEALTH.llm.available)}, '*');
}

/* 2026-10-12 加：**健康自愈**
   原实现只在 boot() 里查一次 `/api/health`，之后**永不复查** ⇒
   若页面是在"后端还没起来"的时候打开的，那一刻检查失败，页面就**从此一直停在
   "AI 入口不可用"的状态**（用户实测："粘贴不出来、一直不行"——其实输入框/发送一直是灰的）。
   ⇒ 现在每 5 秒复查一次；恢复后自动解禁，不需要用户自己强刷。
   ⚠ 只更新 UI 状态，**不重置会话、不动聊天记录**。 */
async function newSession(clearChat = true) {
  try {
    const r = await fetch("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '暂时无法创建会话');
    if (d && d.sessionId) { SESSION = d.sessionId; saveSessionId(SESSION); }
  } catch (e) { SESSION = null; console.error(e); }
  if (clearChat) { $("#chat").innerHTML = ""; renderWelcome(); }
}

/* ============================================================ 状态条 */

function renderHealth() {
  const e = $("#pill-engine"), l = $("#pill-llm"), k = $("#pill-kb");
  /* R1 减法：顶栏只留**一个**状态点（#pill-status）。
     三个具体状态（引擎/AI/知识库）仍逐个更新，但它们住在 `#pill-detail` 里、默认 hidden ——
     只在**出错**时随降级条一起显形。全绿时不再每轮念三遍"正常"。
     ⚠ 三个节点**不许删**：它们是 judge 需要当场核对「AI 是否真的活着」的实况值。 */
  const s = $("#pill-status"), sd = $("#pill-detail");
  const setStatus = (cls, text) => { if (s) { s.className = "pill" + (cls ? " " + cls : ""); s.textContent = text; } };
  if (!HEALTH) {
    e.className = "pill off"; e.textContent = "引擎：后端未响应";
    l.className = "pill off"; l.textContent = "AI：未知";
    k.className = "pill"; k.textContent = "知识库：—";
    setStatus("off", "服务未响应");
    if (sd) sd.hidden = false;
    $("#degrade").classList.add("show");
    $("#degrade-title").textContent = "后端服务未响应";
    $("#degrade-detail").textContent = "服务可能正在启动，请稍后点「重新检测」。";
    setComposerEnabled(false, "后端未响应");
    return;
  }
  const engineOk = HEALTH.engine && HEALTH.engine.ok;
  e.className = "pill " + (engineOk ? "on" : "off");
  e.textContent = engineOk ? "引擎：已加载（真实 runDecision）" : "引擎：加载失败";
  const llmOn = !!(HEALTH.llm && HEALTH.llm.available);
  l.className = "pill " + (llmOn ? "on" : "warn");
  l.textContent = llmOn ? "AI：可用（" + HEALTH.llm.model + "）" : "AI：离线降级";
  k.className = "pill on";
  k.textContent = "知识库：" + (HEALTH.knowledge ? HEALTH.knowledge.chunks : "—") + " 段";

  /* 🔴 铁律 4：调不到 DeepSeek 就明确提示，绝不假装 AI 还活着 */
  const dg = $("#degrade");
  if (!llmOn) {
    setStatus("warn", "AI 离线降级");
    if (sd) sd.hidden = false;                 /* 出错时把三个实况值亮出来，供当场核对 */
    dg.classList.add("show");
    $("#degrade-title").textContent = "AI 入口暂不可用";
    $("#degrade-detail").innerHTML =
      "自然语言入口需要调用 DeepSeek，现在调不到；<b>计算这件事没坏</b>：点右边「直接填参数（不经过 AI）」照样能出引擎结论。" +
      "也可以切回主站的「计算」页使用网页工具。";
    $("#offline-link").style.display = HEALTH.offlineDemo ? "" : "none";
    setComposerEnabled(false, "AI 入口当前不可用（无网络）—— 用下面的「直接填参数」或离线单文件页");
  } else {
    setStatus("on", "AI 入口可用");
    if (sd) sd.hidden = true;
    dg.classList.remove("show");
    setComposerEnabled(true);
  }
  /* ⚠ M3：右侧栏（「本轮发生了什么」+「运行状态」#foot-info）已按用户意见整体删除，
     这里**不再有任何往右栏写的代码**（留一个 null 判断等于把死节点又请回来）。
     右栏原先展示的引擎项目根 / 端口 / 模型 / key 来源，仍可从顶栏状态与 GET /api/health 看到。 */
}

function setComposerEnabled(on, hint) {
  // 2026-10-12 改：**输入框始终可用**。
  // 原实现是 `$("#input").disabled = !on` —— 后端/AI 不可用时**整个禁用输入框**，
  // 结果用户**连一句话都粘不进去**（实测反馈："为啥对话框不能粘贴复制"）。
  // 现在改成：能打字、能粘贴、能准备内容；**只禁发送**，并在提示里说明原因。
  $("#input").disabled = false;
  $("#input").readOnly = false;
  $("#btn-send").disabled = !on;
  $("#composer-hint").textContent = on
    ? "Enter 发送 · Shift+Enter 换行 · 闲聊直接聊，工况句会去调引擎，问口径会去查知识库并给出处"
    : ((hint || "AI 入口当前不可用") + "　（仍可在此输入/粘贴，恢复后即可发送；也可用下方「直接填参数」）");
}

function renderKB() {
  const box = $("#kb-list");
  if (!HEALTH || !HEALTH.knowledge) { box.dataset.count = ""; box.textContent = "—"; return; }
  const srcs = HEALTH.knowledge.sources || [];
  const ok = srcs.filter((s) => s.ok);
  /* ⚠ 值没变就不重画：这行现在会被健康自愈定时器每 5 秒看一次，
     无脑重画会把用户展开的 <details> 每次合上（renderHealth/renderKB 都在 setInterval 里）。 */
  const stamp = HEALTH.knowledge.chunks + "/" + srcs.length + "/" + ok.length;
  if (box.dataset.count === stamp && box.childElementCount) return;
  box.dataset.count = stamp;
  /* R1 减法：常驻只留**一行**。原来每个来源都摊出「X 段 / 其中 Y 段标「不得引用」已屏蔽 /
     仓库相对路径」，三行合计 125px，和左边的示例问句抢注意力 ——
     而"有几个来源、一共多少段"才是用户选这条路时要判断的事。
     "几段被屏蔽"与那条纪律说明**没有删**，它们被折进 details（要较真时照样查得到）。 */
  const forbidden = ok.reduce((a, s) => a + (s.forbidden || 0), 0);
  const bad = srcs.filter((s) => !s.ok);
  box.innerHTML =
    '<div><b>' + ok.length + "</b> 个来源 · <b>" + HEALTH.knowledge.chunks + "</b> 段" +
    (bad.length ? "　<span class='no'>" + bad.length + " 个未能加载</span>" : "") + "</div>" +
    '<details class="det kb-det"><summary>知识库明细与引用纪律</summary><div class="det-body">' +
    ok.map((s) => "<div>" + (s.authority === 1 ? "★" : "·") + " <b>" + esc(s.title) + "</b>　" + esc(s.chunks) + " 段" +
      (s.forbidden ? "，其中 <b class='no'>" + s.forbidden + " 段标「不得引用」已屏蔽</b>" : "") +
      '<div class="cite">' + esc(s.rel) + "</div></div>").join("") +
    bad.map((s) => "<div>✗ " + esc(s.title) + " —— " + esc(s.reason) + "</div>").join("") +
    '<div class="note small">标「不得引用」的段落<b>已从检索中整体剔除</b>；问到它时页面只说"存在但依纪律不得引用"，不吐内容。' +
    "知识手册也受同一条约束。" + (forbidden ? "（当前共 " + forbidden + " 段被屏蔽）" : "") + "</div>" +
    "</div></details>";
}

function fillForm() {
  if (!META) return;
  const d = $("#f-demand"), m = $("#f-medium"), c = $("#f-cond");
  d.innerHTML = Object.keys(META.demandMap).map((k) => '<option value="' + esc(k) + '">' + esc(k) + "</option>").join("");
  m.innerHTML = Object.keys(META.mediumMap).map((k) => '<option value="' + esc(k) + '">' + esc(k) + "</option>").join("");
  d.value = "发电"; m.value = "烟气";
  c.innerHTML = '<option value="">— 手动自定义 —</option>' + META.conds.map((r, i) => '<option value="' + i + '">' + esc(r[0]) + "（" + fmt(r[3]) + "℃ / " + fmt(r[4]) + " kg/s / " + esc(r[9]) + "）</option>").join("");
}

/* ============================================================ 消息骨架 */

function renderWelcome() {
  const box = $("#chat");
  if (box.dataset.welcomed === "1") return;
  box.dataset.welcomed = "1";
  /* ── R2 只做减法（2026-10-13 第二轮）──────────────────────────────────────
     🔴 删掉了一处**真重复**：原来 `hint` 的在线分支里已经有一行
        「**试一句**：我这儿有个 320℃ 的窑炉烟气…」，下面 insertAdjacentHTML 又拼了一次
        `hint + "\n\n**试一句**：…（同一句）"` ⇒ 渲染出来是同一句话**连着说两遍**。
        （md.js 的段落分支把相邻两行用 <br> 接起来，所以两遍都在同一段里，肉眼清晰可见。）
     删掉的第二块：在线分支那张 3 条 bullet 的"怎么用"说明书。
        删掉它用户会失去什么？**答不上来** —— 这三条讲的事在打开页面时**已经全在屏上**：
        「怎么问」= 左栏卡①六个示例问句 + 卡①底部追问提示；「项目口径」= 左栏卡②四个口径问句；
        「能不能随便聊」= 输入框 placeholder + 底部提示行；「去知识库查并给出处」= 底部提示行。
        而那三条里唯一不在别处的信息是"闲聊不调引擎"——它现在由 `.gate` 那行承担。
     保留下来的「试一句」现在只剩**一处**，指向左栏卡①里同一个例句。 */
  const hint = (HEALTH && HEALTH.llm && HEALTH.llm.available)
    ? "**随便说点什么都可以** —— 说一句「你好」，或者直接给一句工况。"
    : "AI 入口当前不可用，但计算没有坏：点左下「打开『直接填参数』面板」，那条路完全不经过 AI。";
  box.insertAdjacentHTML("beforeend",
    '<div class="msg ai"><div class="avatar">WH</div><div class="body"><div class="bubble">' +
    '<div class="md">' + md(hint + "\n\n**试一句**：我这儿有个 320℃ 的窑炉烟气，流量 1.2 万标方每小时，想发电") + "</div>" +
    "</div></div></div>");
}

function addUserMsg(text) {
  $("#chat").insertAdjacentHTML("beforeend",
    '<div class="msg me"><div class="body"><div class="bubble">' + esc(text) + "</div>" +
    '<div class="meta">' + nowClock() + "</div></div></div>");
  scrollBottom();
}

/** 建一个助手气泡：里面有「计算过程」区 + 「正式回答」区 + 「下一步」区 + 「明细」区 */
function addAiMsg() {
  const el = document.createElement("div");
  el.className = "msg ai";
  el.innerHTML =
    '<div class="avatar">WH</div>' +
    '<div class="body">' +
    '  <div class="steps" data-role="steps"></div>' +
    '  <button class="steps-toggle" data-role="steps-toggle" hidden></button>' +
    '  <div class="result-status" data-role="result-status" role="status" hidden></div>' +
    '  <div class="bubble" data-role="bubble" hidden><div class="md" data-role="md"></div></div>' +
    '  <details class="result-source" data-role="result-source" hidden><summary>查看本轮原文与适用边界</summary><div class="md" data-role="result-original"></div></details>' +
    '  <div class="gate" data-role="gate" hidden></div>' +
    '  <div class="next" data-role="next" hidden></div>' +
    '  <div class="details" data-role="details" hidden></div>' +
    '  <div class="meta" data-role="meta"></div>' +
    "</div>";
  $("#chat").appendChild(el);
  scrollBottom();
  return el;
}

/* 「计算过程」的收起/展开：回答一到就收起（N3 的整洁要求），点一行就全看回来。
   ⚠ 收起是**视觉折叠**，不是删节点 —— 步骤仍是一条条 appendChild 进去的（自检断言这一点）。 */
function bindStepsToggle(host) {
  const btn = host.querySelector('[data-role="steps-toggle"]');
  const steps = host.querySelector('[data-role="steps"]');
  if (!btn || !steps) return;
  const n = steps.querySelectorAll(".step").length;
  const set = (collapsed) => {
    steps.className = "steps" + (collapsed ? " folded" : "");
    btn.hidden = false;
    btn.textContent = (collapsed ? "▸ " : "▾ ") + "计算过程（" + n + " 步）";
    host.dataset.stepsCollapsed = collapsed ? "1" : "0";
  };
  btn.onclick = () => set(host.dataset.stepsCollapsed !== "1");
  btn.hidden = false;
  btn.textContent = "▾ 计算过程（" + n + " 步）";
  host.dataset.stepsCollapsed = "0";
}

function collapseSteps(host) {
  const steps = host.querySelector('[data-role="steps"]');
  const btn = host.querySelector('[data-role="steps-toggle"]');
  if (!steps || !btn) return;
  bindStepsToggle(host);          /* 先刷新步数 */
  const set = (collapsed) => {
    steps.className = "steps" + (collapsed ? " folded" : "");
    btn.textContent = (collapsed ? "▸ " : "▾ ") + "计算过程（" + steps.querySelectorAll(".step").length + " 步）";
    host.dataset.stepsCollapsed = collapsed ? "1" : "0";
  };
  btn.onclick = () => set(host.dataset.stepsCollapsed !== "1");
  set(true);
}

function scrollBottom() {
  const c = $("#chat");
  requestAnimationFrame(() => { c.scrollTop = c.scrollHeight; });
}

/* ============================================================ 计算过程：逐条追加 */

const STEP_ICON = { run: "spinner", ok: "dot-ok", warn: "dot-warn", bad: "dot-bad" };

function pushStep(host, text, state) {
  const box = host.querySelector('[data-role="steps"]');
  const st = state || "ok";
  const el = document.createElement("div");
  el.className = "step " + st;
  el.innerHTML = '<span class="ic ' + (STEP_ICON[st] || "dot-ok") + '"></span><span class="tx">' + md(text) + "</span>";
  box.appendChild(el);
  scrollBottom();
  return el;
}

/** 把上一次的 "run" 步骤收尾（避免一直转圈） */
function closeRunSteps(host, state) {
  host.querySelectorAll('.step.run').forEach((s) => { s.className = "step " + (state || "ok"); s.querySelector(".ic").className = "ic " + (STEP_ICON[state || "ok"]); });
}

/* ---------------- 场景卡：把结构化结果亮出来 ---------------- */

const PLAN_FIELDS = [
  ["热源温度_degC", "热源温度", "℃"], ["载体", "载体", ""], ["流量_kg_s", "流量", "kg/s"],
  ["需求", "需求", ""], ["年运行小时", "年运行小时", "h"], ["换热端差_degC", "换热端差", "K"],
  ["连续性", "连续性", ""], ["驱动来源", "驱动来源", ""], ["需求温度_degC", "需求温度", "℃"], ["规模_kW", "规模", "kW"],
];

function planCard(host, scene) {
  const rows = PLAN_FIELDS.filter(([k]) => scene[k] !== undefined).map(([k, label, unit]) => {
    const v = scene[k];
    return "<div><span class='pk'>" + label + "</span><span class='pv'>" + esc(fmt(v)) + (unit && v != null ? " " + unit : "") + "</span></div>";
  }).join("");
  host.insertAdjacentHTML("beforeend", '<div class="plan" data-role="plan"><div class="pt">已解析出的场景（引擎 <code>validateScene</code> 之后的实际读入值）</div><div class="pgrid">' + rows + "</div></div>");
  scrollBottom();
}

/** 解析明细表（每个字段的取值 + 来源 + 依据）——来源列就是"它凭什么用这个数" */
function parseRows(log) {
  return (log || []).map((r) => {
    const cls = /换算|上文派生/.test(r.source || "") ? "flip" : (/丢弃|默认/.test(r.source || "") ? "muted" : "ok");
    return "<tr><td><code>" + esc(r.field) + "</code></td><td class='num'>" + esc(fmt(r.value)) + "</td>" +
      "<td class='" + cls + "'>" + esc(r.source) + "</td><td class='small'>" + esc(r.detail || "") + "</td></tr>";
  }).join("");
}

/* ============================================================ 明细折叠区 */

function collapse(title, innerHtml, open) {
  return '<details class="det"' + (open ? " open" : "") + "><summary>" + title + "</summary><div class='det-body'>" + innerHtml + "</div></details>";
}

/* ---------------- 出处（N2 的落点） ----------------
 * 正文里**不许**出现文件名/路径/行号；它们全部住在这个折叠块里。
 * 数据来自后端 answer.citations（kind: input / engine / knowledge），
 * 前端只做排版与转义，**不新增任何内容**。
 *
 * R1 减法：立场条与页脚被砍掉的**口径细节**（决策内核名、台账原样引用、跨轮不复用、
 * 数值冻结线）搬到这里当脚注 —— 它们是"口径与出处"这件事的一部分，
 * 该在需要较真时才出现，而不是每一轮都在顶栏和页脚占位。文案一字未新写，只是换了落点。 */
const CITE_FOOTNOTE =
  "口径：所有对外数字原样引用自决策内核（runDecision）、边界与口径文件与对外数字台账，不做任何加工；" +
  "本轮的每个数字都由本轮重新调引擎算出来，上一轮的数字不会被当成本轮的依据。" +
  "数值口径以《对外数字台账》（数值冻结线 2026-10-16）与《边界与口径》为准。本页面由 Agent 原型生成，仅用于竞赛答辩演示。";

function renderCites(host, cites) {
  if (!cites || !cites.length) return;
  const box = host.querySelector('[data-role="details"]');
  const oldCites = box.querySelector('[data-role="citations"]');
  if (oldCites) oldCites.remove();
  const KN = { input: "本轮入参来源", engine: "引擎输出字段", knowledge: "知识库原文" };
  const groups = { input: [], engine: [], knowledge: [] };
  for (const c of cites) (groups[c.kind] || groups.engine).push(c);
  let inner = "<p class='small muted' style='margin-top:0'>正文里刻意不写文件名与行号（那是内部标识）；" +
    "每个数、每条结论的**原始出处**都在这里，可逐条复核。</p>";
  for (const k of ["input", "engine", "knowledge"]) {
    const g = groups[k];
    if (!g.length) continue;
    inner += "<h4>" + KN[k] + "（" + g.length + " 条）</h4><div class='cites'>" +
      g.map((c) => "<div class='cr'><span class='cw'>" + esc(c.what) + "</span>" +
        "<span class='cf'>" + esc(c.where) + "</span></div>" +
        (c.snip ? "<div class='snip'>" + esc(c.snip) + "…</div>" : "")).join("") + "</div>";
  }
  inner += "<div class='note small'>" + CITE_FOOTNOTE + "</div>";
  box.insertAdjacentHTML("afterbegin", '<div data-role="citations">' + collapse("出处（" + cites.length + " 条）：每个数来自哪里", inner) + '</div>');
  box.hidden = false;
}

/* ---------------- 下一步 chips（N4） ----------------
 * ⚠ 只渲染后端给的 chips。点一下 = **把那句话作为下一轮输入**（复用现有多轮机制）。
 *   chip 上显示的是"人话"（text），真正发出去的是后端给的 followup
 *   —— 因为路由认的是 followup 那个说法（例如 chip 写「看看它的碳减排」，
 *      发出去的是「这台机组的年降碳量按 LCA 口径怎么讲、有哪些边界要注意」）。 */
function renderNext(host, ev) {
  const box = host.querySelector('[data-role="next"]');
  const chips = ev.chips || [];
  if (!chips.length) { box.hidden = true; return; }
  const firstHint = chips.find((c) => c.hint);
  box.innerHTML = chips.map((c, i) =>
    '<button class="nx" data-i="' + i + '">' + esc(c.text) + "</button>").join("") +
    (firstHint ? '<span class="nh">提示：「' + esc(firstHint.text) + "」—— " + esc(firstHint.hint) + "</span>" : "");
  box.hidden = false;
  box.querySelectorAll(".nx").forEach((b) => {
    const c = chips[Number(b.dataset.i)];
    if (!c) return;
    b.onclick = () => {
      /* 点过的 chip 禁用，避免连点发起两轮（会话是单进程内存的，连点会串上下文） */
      box.querySelectorAll(".nx").forEach((x) => { x.disabled = true; });
      $("#input").value = c.followup || c.text;
      autoGrow();
      send();
    };
  });
  scrollBottom();
}

function renderDetails(host, ev) {
  const box = host.querySelector('[data-role="details"]');
  const cites = box.querySelector('[data-role="citations"]');
  let h = "";
  /* ⚠ R1：原来这里把「工况库那 19 行（其中 17 行可评）」写死在文案里。19 这个数其实就是
     /api/meta 的 conds 条数，抄一份到前端只会**过期**（引擎那边一改，页面就留一句错话）。
     本轮实测到引擎在 12:40 被外部改过：同一句 fixture 的首位贴近度从 0.9128 变成 0.9081 ——
     这正说明"抄进前端的数"靠不住。现在改成取 meta.conds.length。
     ⚠ "17 行可评"那个数**后端 meta 里没有**，而前端不许自己算（本文件不做任何计算），
       所以这里不再报它 —— 它是引擎自己的话，在「引擎结论全量」那张 stage1 表里逐行可查。 */
  const rows = (META && Array.isArray(META.conds)) ? META.conds.length : null;
  const libScope = rows ? ("工况库那 " + rows + " 行") : "本原型标定的工况库范围";

  /* 1. 解析明细 */
  if (ev.parse && (ev.parse.log || []).length) {
    /* R1 减法：summary 从「解析明细：每个字段的取值 / 来源 / 依据（这就是「它凭什么用这个数」）」
       压成「解析明细：每个字段的取值 / 来源 / 依据」。
       那句口语解释挪到折叠**里面**当第一行 —— 展开的人照样看得到，收起时少占半行。 */
    h += collapse("解析明细：每个字段的取值 / 来源 / 依据",
      "<p class='small muted' style='margin-top:0'>下面这张表就是「它凭什么用这个数」。</p>" +
      "<div class='tbl-scroll'><table><thead><tr><th>scene 字段</th><th>取值</th><th>来源</th><th>依据 / 换算过程</th></tr></thead><tbody>" +
      parseRows(ev.parse.log) + "</tbody></table></div>" +
      (ev.parse.raw ? "<h4>大模型原样吐出的 JSON（供核对；它不产生数字，只做翻译）</h4><pre class='tight'>" + esc(JSON.stringify(ev.parse.raw, null, 2)) + "</pre>" : ""));
  }

  /* 2. 数字来源表 */
  if ((ev.ledger || []).length) {
    h += collapse("数字来源表（" + ev.ledger.length + " 项）：每个数来自引擎的哪个字段",
      "<p class='small muted' style='margin-top:0'>表里没有的数，本轮回答里不会出现（除非它来自知识库文档并标注了出处）。</p>" +
      "<div class='tbl-scroll'><table><thead><tr><th>量</th><th>值</th><th>单位</th><th>出处</th></tr></thead><tbody>" +
      ev.ledger.map((r) => "<tr><td>" + esc(r.name) + "</td><td class='num'>" + esc(fmt(r.value)) + "</td><td>" + esc(r.unit) + "</td><td class='cite'>" + esc(r.source) + "</td></tr>").join("") +
      "</tbody></table></div>");
  }

  /* 3. 引擎结论全量（排序、stage1、边界提示） */
  const raw = ev.engineRaw;
  if (raw && raw.ok && !raw.out_of_scope && raw.engine) {
    const keys = raw.engine.keys, labels = raw.engine.labels;
    let inner = "<h4>TOPSIS 排序与六项指标原值（引擎 X 矩阵）</h4><div class='tbl-scroll'><table><thead><tr><th>排名</th><th>路径</th>" +
      (raw.engine.indicators || []).map((x) => "<th>" + esc(x) + "</th>").join("") + "<th>贴近度</th></tr></thead><tbody>" +
      raw.engine.order.map((o, i) => "<tr class='" + (i === 0 ? "best" : "") + "'><td>" + (i + 1) + "</td><td>" + esc(labels[keys.indexOf(o.path)] || o.path) + "</td>" +
        o.row.map((v) => "<td class='num'>" + fmt(v) + "</td>").join("") + "<td class='num'>" + fmt(o.closeness) + "</td></tr>").join("") +
      "</tbody></table></div>";
    if (raw.engine.stage1) {
      inner += "<h4>第一级筛选（引擎 stage1：谁被排除、为什么）</h4><div class='tbl-scroll'><table><thead><tr><th>路径</th><th>结果</th><th>原因（引擎原话）</th></tr></thead><tbody>" +
        raw.engine.stage1.map((s) => "<tr><td>" + esc(s.label) + "</td><td class='" + (s.keep ? "ok" : "no") + "'>" + (s.keep ? "✓ 进入候选" : "✗ 排除") + "</td><td class='small'>" + esc(s.reason || "") + "</td></tr>").join("") +
        "</tbody></table></div>";
    }
    for (const b of (ev.boundaryNotices || [])) inner += "<div class='note info'>" + esc(b) + "</div>";
    for (const w of (ev.warnings || [])) inner += "<div class='note'>" + esc(w) + "</div>";
    h += collapse("引擎结论全量：排序 / 六指标原值 / 第一级筛选 / 边界提示", inner);
  }

  /* 4. 决策证书逐条 */
  const c = ev.certificate;
  if (c) {
    let inner = "<div class='note'><b>引擎原话：</b>" + esc(c.statement) + "</div>" +
      "<p class='small muted'>扰动 <b>" + fmt(c.total) + "</b> 项，其中 <b class='" + (c.flips ? "flip" : "ok") + "'>" + fmt(c.flips) + "</b> 项会让推荐改变。候选 {" + (c.candidates || []).map(esc).join("、") + "}。</p>" +
      "<h4>逐条扰动的后果</h4><div class='tbl-scroll'><table><thead><tr><th>扰动</th><th>口径（引擎写的）</th><th>此时推荐</th><th>结论</th></tr></thead><tbody>" +
      (c.probes || []).map((p) => "<tr class='" + (p.flipped ? "best" : "") + "'><td>" + esc(p.name) + "</td><td class='small'>" + esc(p.detail) + "</td><td>" + esc(p.label) + "</td><td class='" + (p.flipped ? "flip" : "muted") + "'>" + (p.flipped ? "★ 翻转" : "稳定") + "</td></tr>").join("") +
      "</tbody></table></div>" +
      "<h4>推荐压着的假设与证据等级（" + (c.assumptions || []).length + " 条）</h4><div class='tbl-scroll'><table><thead><tr><th>假设</th><th>当前取值</th><th>证据</th><th>等级</th></tr></thead><tbody>" +
      (c.assumptions || []).map((a) => "<tr><td>" + esc(a.name) + "</td><td class='num'>" + esc(a.value == null ? "见各路径" : a.value) + "</td><td class='small'>" + esc(a.source) + "</td><td>" + esc(a.grade) + "</td></tr>").join("") +
      "</tbody></table></div>" +
      "<div class='note'><b>适用范围（别读过头）：</b>本结论只在<b>" + libScope + "</b>、且只在上表这 <b>" + fmt(c.total) + "</b> 项扰动之内成立。库外场景、以及界面上其它未被扰动的滑块，不在覆盖范围内。</div>";
    /* R1 减法：summary 从「哪个假设敏感 · 调多少会翻 · 翻成什么（29 项扰动，1 项翻转）」
       压成「扰动与翻转逐条」（29 项/1 项这两个数**正文里已经有了**，折叠标题再念一遍是冗余）。
       折叠里面那张表一字未动。 */
    h += collapse("决策证书：扰动与翻转逐条", inner);
  }

  /* 5. 知识库检索片段 */
  if ((ev.hits || []).length) {
    h += collapse("检索到的原文片段（" + ev.hits.length + " 条，带出处，可逐条复核）",
      ev.hits.map((x) => "<div class='hit'><div class='hd'>" + (x.authority === 1 ? "<span class='chip active' style='padding:0 7px'>权威</span>" : "<span class='chip' style='padding:0 7px'>参考</span>") +
        "<span class='small'>" + esc(x.source) + "</span><span class='spacer' style='margin-left:auto'></span><span class='xsmall soft'>BM25 " + x.score + "</span></div>" +
        "<div class='txt'>" + esc(x.text) + "</div><div class='cite'>出处：" + esc(x.cite) + "</div></div>").join(""));
  }
  if (ev.forbidden) {
    h += "<div class='note bad'><b>注意：</b>知识库里确实有与你的问题相关的条目，但它被标为<b>「不得引用」</b>，" +
      "按项目纪律本原型不会把内容显示出来。存在的位置是：" + ev.forbidden.items.map((x) => "<code>" + esc(x.cite) + "</code>").join("、") + "。</div>";
  }

  /* 6. 引擎返回体原文 + 导出 */
  if (raw) {
    const id = "dump-" + Math.random().toString(36).slice(2, 8);
    /* R1 减法：summary 从「引擎返回体原文（评委可当场核对：这就是引擎返回的对象，未经改写）」
       压成「引擎返回体原文」。那句括号里的说明本来就是给评委的，它**仍然在折叠里面**
       —— 展开后紧挨着就是导出按钮与 JSON 本体，不必占一行常驻标题。 */
    h += collapse("引擎返回体原文（未经改写，可当场核对）",
      "<button class='btn ghost small' id='" + id + "'>导出本轮 JSON</button>" +
      "<pre class='tight' style='margin-top:8px'>" + esc(JSON.stringify(raw, null, 1)) + "</pre>");
    setTimeout(() => {
      const b = document.getElementById(id);
      if (b) b.onclick = () => {
        const blob = new Blob([JSON.stringify(raw, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob); a.download = "agent_wh_engine_reply.json"; a.click();
        URL.revokeObjectURL(a.href);
      };
    }, 0);
  }

  if (!h) { box.hidden = true; return; }
  box.innerHTML = h;
  if (cites) box.prepend(cites);
  box.hidden = false;
  scrollBottom();
}

/* ============================================================ 数字闸门小结 */

function renderGate(host, ev) {
  const box = host.querySelector('[data-role="gate"]');
  const okAll = (!ev.missing || !ev.missing.length) && !ev.rejected;
  /* N3：这一块也**不许堆框** —— 默认只留一行灰字，锚点与语料范围收进折叠里。 */
  let h = '<span class="ic ' + (okAll ? "dot-ok" : "dot-warn") + '"></span><div>';
  h += "<b>数字回查：" + (ev.checked || 0) + " 个数字</b> —— " + (okAll ? "全部出现在本轮引擎原文里 ✓" : "有数字被拦下 ⚠");
  if (ev.missing && ev.missing.length) h += '<div>被拦下的数字：' + ev.missing.slice(0, 12).map((x) => "<code>" + esc(x) + "</code>").join(" ") + "（这些数在本轮语料里找不到，不符合纪律，因此不采用）</div>";
  const inner =
    '<div class="xsmall soft">语料范围：' + esc(ev.scope || "") + "</div>" +
    ((ev.anchors && ev.anchors.length)
      ? '<div class="anchors">' + ev.anchors.map((a) => "<span class='anchor'><i>" + esc(a.name) + "</i> <b>" + esc(a.value) + "</b> <em>" + esc(a.source) + "</em></span>").join("") + "</div>"
      : "");
  if (inner) h += '<details class="det" style="border-top:none"><summary>回查范围与关键事实锚点</summary><div class="det-body">' + inner + "</div></details>";
  h += "</div>";
  box.innerHTML = h;
  box.hidden = false;
  box.className = "gate " + (okAll ? "good" : "warnbox");
  scrollBottom();
}

/* ============================================================ 发一轮（读 SSE） */

async function send(text) {
  if (busy) return;
  if (!text && !$("#input").value.trim()) return;
  const q = (text || $("#input").value).trim();
  if (!q) return;
  busy = true;
  $("#input").value = "";
  autoGrow();
  addUserMsg(q);
  const host = addAiMsg();
  pushStep(host, "正在理解你的问题…", "run");
  ctrl = new AbortController();
  $("#btn-stop").style.display = "";
  $("#btn-send").disabled = true;

  let gotAnswer = false;
  try {
    const resp = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: q, sessionId: SESSION }),
      signal: ctrl.signal,
    });
    if (!resp.ok || !resp.body) { const e=await resp.json().catch(()=>({}));throw new Error(e.error || '助手暂不可用'); }

    const reader = resp.body.getReader();
    const dec = new TextDecoder("utf-8");
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      /* SSE 帧以空行分隔 */
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;      // 忽略注释帧（: hb / : open）
          let ev;
          try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
          handleEvent(host, ev);
          if (ev.type === "answer") gotAnswer = true;
        }
      }
    }
    if (!gotAnswer) pushStep(host, "本轮没有拿到正式回答（流提前结束）", "bad");
  } catch (e) {
    if (e.name === "AbortError") pushStep(host, "已停止本轮", "warn");
    else pushStep(host, "请求失败：" + e.message + "（后端是否还在运行？）", "bad");
  } finally {
    closeRunSteps(host, "ok");
    finishMeta(host);
    busy = false; ctrl = null;
    $("#btn-stop").style.display = "none";
    setComposerEnabled(!!(HEALTH && HEALTH.llm && HEALTH.llm.available));
    scrollBottom();
  }
}

/* ---------------- 事件分发：SSE 每来一条就画一条 ---------------- */

function handleEvent(host, ev) {
  const steps = host.querySelector('[data-role="steps"]');
  switch (ev.type) {
    case "session":
      SESSION = ev.sessionId; saveSessionId(SESSION);
      break;
    case "step": {
      /* 新步骤到来时，把上一条还在转圈的收尾 */
      closeRunSteps(host, ev.state === "bad" ? "warn" : "ok");
      pushStep(host, ev.text, ev.state);
      break;
    }
    case "plan_row":
      break;   /* 明细里统一渲染，步骤区不刷屏 */
    case "plan":
      planCard(host, ev.scene || {});
      break;
    case "result": {
      if (!ev.verify || !ev.verify.ok) break;
      const b = host.querySelector('[data-role="bubble"]');
      b.hidden = false;
      host.querySelector('[data-role="md"]').innerHTML = md(ev.markdown || "");
      host.querySelector('[data-role="result-original"]').innerHTML = md(ev.markdown || "");
      const status = host.querySelector('[data-role="result-status"]');
      status.hidden = false;
      status.textContent = ev.source === "engine"
        ? "引擎结果已就绪 · 正在补充解释"
        : "已找到依据 · 正在整理答复";
      host.dataset.hasResult = "1";
      renderCites(host, ev.citations || []);
      collapseSteps(host);
      break;
    }
    case "answer": {
      host.dataset.hasFinalAnswer = "1";
      closeRunSteps(host, "ok");
      const b = host.querySelector('[data-role="bubble"]');
      b.hidden = false;
      host.querySelector('[data-role="md"]').innerHTML = md(ev.markdown || "");
      if (host.dataset.hasResult === "1") {
        host.querySelector('[data-role="result-status"]').textContent = "回答已完成";
        // 原始结论保留在独立折叠中；整理前后均可核对完整边界。
        host.querySelector('[data-role="result-source"]').hidden = ev.mode !== "llm";
      }
      /* 六种来源要分得清（M1 新增了"闲聊"，N1 新增了"手册直引"，G1 新增了"缺参数引导"，
         G6 新增了"分半回答"）：
           llm           = 工况结论经大模型改写（已过数字回查）
           handbook      = **项目概况快速通道**：手册定稿段落原样引用（没经过任何模型生成）
           guidance      = **缺参数引导轮**：先验提问，**本轮没调引擎**（没有 plan/ledger/证书）
           out_of_scope_partial = **分半回答**（G6）：一半能算、一半超出边界并点名，**本轮没调引擎**
           chat          = 闲聊：DeepSeek 的一次普通对话补全（**没走引擎，也就没有数字回查这回事**）
           chat-fallback = 闲聊没通过安全闸门 / 没连上模型
           template      = 引擎模板句 / 检索原文（未使用措辞改写） */
      /* R1 减法：mode="llm" 的徽标「措辞经大模型整理 · 已过数字回查」被删掉了 ——
         紧接着的 .gate 一行本来就写着「数字回查：N 个数字 —— 全部出现在本轮引擎原文里 ✓」，
         同一件事在相邻两行说两遍。其余五种 mode **一个都没动**（它们各自说的是不同的事，
         不删：handbook=手册直引、guidance=没调引擎、out_of_scope_partial=分半、
         chat=普通对话、chat-fallback=未采用）。落在兜底分支上的是"引擎模板句"，保持原样。 */
      if (ev.mode === "llm") {
        /* 不再追加徽标：由下面的 .gate 一行承担 */
      } else if (ev.mode === "handbook") {
        b.insertAdjacentHTML("beforeend", '<div class="badge ok">项目概况 · 原样引自项目知识手册（未经模型生成）</div>');
      } else if (ev.mode === "out_of_scope_partial") {
        /* 🔴 G6：这一条同样要**在界面上看得见**，而且必须把两件事说清：
             ① 这一轮**没有调用决策引擎**（所以不会有任何引擎数字，"不能算的那半"也没有数）；
             ② 点名的那些量**不在能力边界内**，系统不会给它们任何数值（连"约"都不给）。
           与引导轮一样，挂的是一条常驻可见的提示条，不是一个折叠里的说明。 */
        b.insertAdjacentHTML("beforeend",
          '<div class="badge">分半回答 · 一半能算、一半超出能力边界（本轮**没有**调用决策引擎）</div>' +
          '<div class="guide-prior">⚠ <b>上面点名的那些量不在系统的能力边界内</b>：' +
          '烟囱抽力 / 热压 / 酸露点 / 噪声 / 占地 / 水耗 / 检修 / 施工这一类，引擎里没有对应模块，' +
          '<b>所以不会给出它们的任何数值（连"约"都不给）</b>。能算的那半照常算 —— 把缺的参数补上即可。</div>');
      } else if (ev.mode === "guidance") {
        /* 🔴 G4：两件事必须**在界面上看得见**（不许藏在折叠里）：
             ① 这一轮**没有调引擎**（先验只用来提问）；
             ② 上面那些区间/参照值是**先验猜测、待你确认**。
           所以这里挂的不是一个"来源徽标"，而是一条常驻可见的提示条。 */
        b.insertAdjacentHTML("beforeend",
          '<div class="badge">缺参数引导 · 本轮**没有**调用决策引擎（先验只用来提问）</div>' +
          '<div class="guide-prior">⚠ <b>上面那些区间 / 参照值都是先验猜测，不是结论</b>：' +
          '它们只用来帮你把参数说出口，<b>在你确认（或改成你自己的数）之前，一个数都不会拿去算</b>。' +
          '每条先验的出处写在下面「出处」里（可逐条复核）。</div>');
      } else if (ev.mode === "chat") {
        b.insertAdjacentHTML("beforeend", '<div class="badge ok">普通对话 · 由 DeepSeek 直接回复（未调用决策引擎）</div>');
      } else if (ev.mode === "chat-fallback") {
        b.insertAdjacentHTML("beforeend", '<div class="badge">未采用模型回复 · 已退回一句澄清</div>');
      } else {
        b.insertAdjacentHTML("beforeend", '<div class="badge">引擎模板句 / 检索原文 · 未使用措辞改写</div>');
      }
      /* 🔴 N2：出处**只**在这两个地方出现 —— 回答下面的「出处」折叠块，与明细区。
         正文（.md 里）不许有文件名/路径/行号，这一条由后端 bodyIdentifiers() 守着，
         前端这里只负责把出处渲染到折叠区。 */
      renderCites(host, ev.citations);
      /* N3：回答到了就把「计算过程」收成一行（点开可看全部步骤） */
      collapseSteps(host);
      scrollBottom();
      break;
    }
    case "next":
      renderNext(host, ev);
      break;
    case "verify":
      renderGate(host, ev);
      break;
    case "detail":
      renderDetails(host, ev);
      break;
    case "offer": {
      const id = "off-" + Math.random().toString(36).slice(2, 8);
      host.querySelector('[data-role="steps"]').insertAdjacentHTML("beforeend",
        '<div class="offerbar"><b>' + esc(ev.title || "AI 入口当前不可用（无网络）") + "</b>" +
        '<a class="btn ghost small" href="' + esc(ev.href || "/offline-demo") + '" target="_blank" rel="noopener">打开离线单文件演示页 →</a>' +
        '<button class="btn ghost small" id="' + id + '">直接填参数（不经过 AI）</button></div>');
      const b = document.getElementById(id);
      if (b) b.onclick = () => openForm();
      scrollBottom();
      break;
    }
    case "error":
      pushStep(host, ev.message, "bad");
      break;
    case "turn_saved":
      host.dataset.turns = ev.turns;
      break;
    case "done":
      host.dataset.ms = ev.ms;
      break;
    default:
      break;
  }
}

function finishMeta(host) {
  if (host.dataset.hasResult === "1" && host.dataset.hasFinalAnswer !== "1") {
    host.querySelector('[data-role="result-status"]').textContent = "结果已保留 · 补充解释未完成";
  }
  const el = host.querySelector('[data-role="meta"]');
  const ms = host.dataset.ms ? (Number(host.dataset.ms) / 1000).toFixed(2) + " s" : "";
  const turns = host.dataset.turns ? ("会话第 " + host.dataset.turns + " 轮") : "";
  el.textContent = [nowClock(), ms, turns].filter(Boolean).join(" · ");
}

/* ============================================================ 表单路径（不经过 AI） */

async function runForm() {
  const th = $("#f-th").value.trim();
  const useTh = th !== "" && isFinite(Number(th));
  const scene = {
    demand: $("#f-demand").value,
    medium: $("#f-medium").value,
    continuity: $("#f-cont").value,
    tempC: Number($("#f-t").value),
    flowValue: useTh ? Number(th) : Number($("#f-m").value),
    flowUnit: useTh ? "t/h" : "kg/s",
    dT: Number($("#f-dt").value),
    hours: Number($("#f-h").value),
  };
  closeForm();
  const label = "直接填参数：" + scene.tempC + "℃ / " + scene.flowValue + " " + scene.flowUnit + " / " + scene.medium + " / " + scene.demand;
  addUserMsg(label);
  const host = addAiMsg();
  busy = true; $("#btn-send").disabled = true;
  try {
    const resp = await fetch("/api/chat/stream", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "", scene, sessionId: SESSION, noPolish: true }),
    });
    if (!resp.ok || !resp.body) { const e=await resp.json().catch(()=>({}));throw new Error(e.error || '助手暂不可用'); }
    const reader = resp.body.getReader(); const dec = new TextDecoder("utf-8");
    let buf = "";
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
          handleEvent(host, ev);
        }
      }
    }
  } catch (e) { pushStep(host, "请求失败：" + e.message, "bad"); }
  finally { closeRunSteps(host, "ok"); finishMeta(host); busy = false; setComposerEnabled(!!(HEALTH && HEALTH.llm && HEALTH.llm.available)); }
}

/* ============================================================ 交互绑定 */

function autoGrow() {
  const t = $("#input");
  t.style.height = "auto";
  t.style.height = Math.min(180, t.scrollHeight) + "px";
}
function openForm() { $("#formpanel").classList.add("show"); }
function closeForm() { $("#formpanel").classList.remove("show"); }

$("#btn-send").onclick = () => send();
$("#input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); send(); }
});
$("#input").addEventListener("input", autoGrow);
$("#btn-stop").onclick = () => { if (ctrl) ctrl.abort(); };
$("#btn-new").onclick = () => { newSession(true); };
$("#btn-recheck").onclick = boot;
$("#btn-form").onclick = openForm;
$("#btn-form-offline").onclick = openForm;
$("#btn-form-close").onclick = closeForm;
$("#btn-runform").onclick = runForm;

$$(".chip.ex").forEach((c) => c.onclick = () => { $("#input").value = c.textContent.trim(); autoGrow(); send(); });
$$(".chip.exq").forEach((c) => c.onclick = () => { $("#input").value = c.textContent.trim(); autoGrow(); send(); });

$("#f-cond").onchange = () => {
  const i = Number($("#f-cond").value);
  if (!META || !isFinite(i) || $("#f-cond").value === "") return;
  const r = META.conds[i];
  const medium = /烟气|排烟|废气/.test(r[2]) ? "烟气" : (/渣|熔盐|工艺液/.test(r[2]) ? "工艺液体" : "热水/冷凝水");
  $("#f-t").value = r[3]; $("#f-m").value = r[4]; $("#f-th").value = "";
  $("#f-medium").value = medium; $("#f-demand").value = r[9];
  $("#f-h").value = r[8] || 8000;
  $("#f-cont").value = (r[10] === "间歇") ? "间歇" : "连续";
};

boot();
