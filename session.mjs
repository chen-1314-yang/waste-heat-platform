/* session.mjs —— 多轮会话状态（**进程内存**，不落盘、不引数据库）。
 *
 * 为什么用内存就够：这是答辩现场的单机演示件，一次演示只有一个人、一两个会话。
 * 引一个数据库只会增加现场起不来服务的风险（原版零第三方依赖，这里继续保持）。
 * 代价写在 README「已知限制」里：重启即清空、单进程不共享。
 *
 * 🔴 这里**只存**，不做任何数值加工。
 *    存下来的东西有两类，用途严格分开（这是多轮下"数字只用本轮引擎输出"的关键）：
 *      ① turn.userText / turn.engineNumbers —— 进入**前文上下文**，只能作为"待引用的数字"提供给 LLM，
 *         并且只有当 LLM **逐字引用**了其中一个数字时，才允许它进入本轮的 scene；
 *      ② turn.engineRaw / turn.ledger —— 本轮引擎返回体原样，用于界面上"展开明细"，
 *         **永不进入**下一轮的数字回查语料（下一轮的回查语料只由下一轮自己的引擎输出构成）。
 */

const MAX_TURNS = 12;          // 每个会话保留最近 12 轮（够演示；防止内存无限长）
const MAX_SESSIONS = 200;      // 最多 200 个会话，超出按最久未用淘汰
const MAX_USER_CHARS = 2000;   // 单条用户消息上限（与 server 的 body 限制一致）

const sessions = new Map();    // id → { id, createdAt, updatedAt, turns: [] }

function nowIso() { return new Date().toISOString(); }

export function newSessionId() {
  /* 不用 crypto.randomUUID：Node 18 有，但这里保持最小依赖面，用时间戳+随机后缀即可。
     它只做内存键，没有安全语义。 */
  return "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function createSession(id) {
  const sid = String(id || "").trim() || newSessionId();
  const s = { id: sid, createdAt: nowIso(), updatedAt: nowIso(), turns: [] };
  sessions.set(sid, s);
  evictIfNeeded();
  return s;
}

export function getSession(id) {
  const s = sessions.get(String(id || ""));
  return s || null;
}

export function getOrCreate(id) {
  return getSession(id) || createSession(id);
}

export function resetSession(id) {
  const s = getSession(id);
  if (!s) return null;
  s.turns = [];
  s.updatedAt = nowIso();
  return s;
}

export function dropSession(id) { return sessions.delete(String(id || "")); }

export function sessionList() {
  return [...sessions.values()]
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .map((s) => ({ id: s.id, turns: s.turns.length, createdAt: s.createdAt, updatedAt: s.updatedAt }));
}

/**
 * 记一轮。**只接收已算完的东西**，本函数不做任何判断。
 *
 * @param {string} id
 * @param {object} t
 *   t.userText       本轮用户原话
 *   t.scene          本轮引擎 validateScene 之后的实际 scene（引擎补过默认值）
 *   t.engine         本轮 engine 摘要（**报告用**，不进前文语料的数字白名单）
 *   t.ledger         本轮数字来源表（报告用）
 *   t.certificate    本轮证书摘要
 *   t.answer         本轮正式回答（**报告用**）
 *   t.engineNumbers  本轮**引擎算出来的**数字字符串集合（报告用，永不作为下一轮的合法数字来源）
 *   t.inputNumbers   本轮**已经落成 scene 入参**的数字（含派生值），下一轮允许被引用的白名单
 *   t.inputLog       resolveScene 的逐字段日志（含 source/detail，下一轮引用时要能追到同一句话）
 *   t.degraded       本轮是否离线降级
 *   t.chat           true ⇒ 本轮是**闲聊**（M1）。闲聊轮 scene/inputLog 都是空的，
 *                    因此它对下一轮的唯一影响是"上一轮用户原话"，**不会**给下一轮任何可引用的数字
 *                    —— 这正是我们想要的：闲聊这条路不产生数字，也就不可能污染数字闸门。
 *   t.guidance       true ⇒ 本轮是**缺参数引导轮**（G1，2026-10-12 加）。与闲聊轮**同款隔离**：
 *                    scene=null、engineNumbers=[]、inputNumbers=[]，所以它对下一轮的贡献
 *                    只有"上一轮用户原话"那一段。下一轮用户答的那个数之所以能被引用，
 *                    靠的是 `prevScopeText()` 把上一轮原话算进可引用范围 ——
 *                    **不是**靠给引导轮塞一个 scene。续问兜底的 `carry()` 读的是 `prev.scene`，
 *                    引导轮没有 scene ⇒ **不可能**从引导轮"继承"出任何数值（这是关键的安全性质）。
 *   t.outOfScope     true ⇒ 本轮是**分半回答轮**（G6，2026-10-12 加）。隔离性质与引导轮**逐条相同**
 *                    （scene=null、engineNumbers=[]、inputNumbers=[]、inputLog=[]，
 *                    所以它对下一轮的唯一贡献也是"上一轮用户原话"）。
 *                    它额外被读一处：`runTurn` 用 `prev.outOfScope` 保证**只分半一次** ——
 *                    用户把参数补齐后的那一轮必须**照常算**，不能再分半一次。
 *                    它**不是**数字通道：不产生任何可引用数值，也不放宽任何闸门。
 */
export function appendTurn(id, t) {
  const s = getOrCreate(id);
  s.turns.push({
    at: nowIso(),
    index: s.turns.length + 1,
    kind: t.chat ? "chat" : (t.guidance ? "guidance" : (t.outOfScope ? "out_of_scope_partial" : "engine")),
    userText: String(t.userText || "").slice(0, MAX_USER_CHARS),
    scene: t.scene || null,
    engine: t.engine || null,
    certificate: t.certificate || null,
    answer: t.answer || null,
    ledger: t.ledger || [],
    engineNumbers: t.engineNumbers || [],
    inputNumbers: t.inputNumbers || [],
    inputLog: t.inputLog || [],
    outOfScope: !!t.outOfScope,
    degraded: !!t.degraded,
  });
  while (s.turns.length > MAX_TURNS) s.turns.shift();
  s.updatedAt = nowIso();
  return s.turns[s.turns.length - 1];
}

export function lastTurn(id) {
  const s = getSession(id);
  return s && s.turns.length ? s.turns[s.turns.length - 1] : null;
}

function evictIfNeeded() {
  if (sessions.size <= MAX_SESSIONS) return;
  const arr = [...sessions.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1));
  for (const s of arr.slice(0, sessions.size - MAX_SESSIONS)) sessions.delete(s.id);
}

export function stats() {
  return { sessions: sessions.size, turns: [...sessions.values()].reduce((a, s) => a + s.turns.length, 0), maxTurnsPerSession: MAX_TURNS };
}
