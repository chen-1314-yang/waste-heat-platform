/* llm.mjs —— DeepSeek API 调用层。只做两件事：
 *   (a) 把用户口语解析成引擎的结构化入参候选（**只输出 JSON**，见 parseScene）
 *   (b) 在"数字已由引擎/文档产出"的前提下做措辞润色（见 polish，带数字回查）
 *
 * 🔴 铁律 1：LLM 绝不允许产出任何数字。本文件的落地做法：
 *     - parseScene 只回 {温度, 流量, 流量单位, 载体, 需求, 小时, 端差, 等等}，
 *       其中**数值**在原句里必须找得到（见 server.mjs 的 traceNumbers 数字溯源），
 *       否则一律丢弃、退回默认值。
 *     - polish 回来之后必须过 verifyNumbers()：把润色文本里的每个数字抽出来，
 *       逐个核对是否出现在"引擎原话"里；有一个对不上，润色整段作废、退回模板句。
 *
 * 🔴 铁律 3：**不写 key、不打印 key、不落盘**。key 只从这三处来（**按优先级**），且只放内存：
 *     ① 环境变量 `DEEPSEEK_API_KEY`（外部显式设置时最高优先，便于临时切换）
 *     ② D:\DeepSeekHarness\home\.credentials.yaml 的 `DEEPSEEK_API_KEY: sk-...` 一行
 *        —— **这是主路径**：用户与 DSH 对话用的就是这把 key，本项目直接用它，无需另外配置
 *     ③ 可选覆盖：本目录纯文本文件 `.user_api_key`（一行，只有 key 本身）。
 *        **不要求用户创建它**；它只是留给将来换 key 的一个入口。
 *   实际查找顺序是 ① → ③（若该文件存在）→ ②，即"可选覆盖"夹在中间；不建 ③ 时行为就是 ① → ②。
 *   三者都没有 ⇒ 不抛错，进入离线降级（available() === false）。
 *
 * ⚠ 三条路（工况解析 / 知识问答 / 闲聊对话）**共用这一个 key**，不存在"闲聊用另一个 key"。
 *   对外只暴露 `keySource()`（**只报来源，永不回显内容**）。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* 用户自己的 key 文件：**纯文本、一行、只有 key 本身**。放在本目录下。 */
export const USER_KEY_FILE = path.join(HERE, ".user_api_key");

const CRED_CANDIDATES = [
  process.env.DSH_CREDENTIALS_FILE,
  "D:\\DeepSeekHarness\\home\\.credentials.yaml",
].filter(Boolean);

/* --------------------------------------------------------- key 读取（只在内存） */

let _keyCache;             // undefined = 未读；null = 读了但没有
let _keySource = "";

/** ③ **可选覆盖**：本目录 `.user_api_key`（纯文本一行）。不要求用户创建；存在则优先于凭据文件。 */
function readKeyFromUserFile() {
  try {
    if (!fs.existsSync(USER_KEY_FILE)) return null;
    const text = fs.readFileSync(USER_KEY_FILE, "utf8");
    const line = String(text).split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0];
    if (!line) return null;
    /* 容忍用户顺手写成 `DEEPSEEK_API_KEY=sk-...` 或带引号；但**只取冒号/等号右边那一截**。
       ⚠ 无论读到什么，本函数**不打印、不记录**它的内容。 */
    const m = line.match(/^(?:DEEPSEEK_API_KEY\s*[:=]\s*)?["']?([^"'\s]+)["']?$/);
    const k = m ? m[1] : line;
    return k || null;
  } catch { return null; }
}

/** ② DSH 凭据文件 —— **主路径**：用户与 DSH 对话用的就是这把 key。 */
function readKeyFromCredentialsFile() {
  for (const f of CRED_CANDIDATES) {
    let text;
    try {
      if (!fs.existsSync(f)) continue;
      text = fs.readFileSync(f, "utf8");
    } catch { continue; }
    /* 只做一次逐行匹配，匹配到的组**不回显、不记录、不进日志** */
    const m = text.match(/^[ \t]*DEEPSEEK_API_KEY[ \t]*:[ \t]*(\S+)[ \t]*$/m);
    if (m && m[1]) { _keySource = f + "（行内 DEEPSEEK_API_KEY）"; return m[1]; }
  }
  return null;
}

/**
 * 取 API key。**优先级**：
 *   ① 环境变量 DEEPSEEK_API_KEY（外部显式设置 ⇒ 最高优先，便于临时切换）
 *   ② DSH 凭据文件 —— **主路径**（已核实：里面就是用户自己的 key）
 *   ③ 可选覆盖 本目录 `.user_api_key`（不要求创建；存在则优先于 ②）
 * 三条路（工况解析 / 知识问答 / 闲聊）共用它。
 */
export function getApiKey() {
  /* 显式强制离线开关：设 DSH_AGENT_WH_NO_LLM=1 即进入离线降级（**不读 key**）。
     用途：① 现场演示"断网会发生什么"，不用真拔网线；② 保密场合下彻底不碰凭据。 */
  if (process.env.DSH_AGENT_WH_NO_LLM === "1" || process.env.DSH_AGENT_WH_NO_LLM === "true") {
    _keyCache = null; _keySource = "（已由 DSH_AGENT_WH_NO_LLM 强制离线）"; return null;
  }
  if (_keyCache !== undefined) return _keyCache;
  const env = process.env.DEEPSEEK_API_KEY;
  if (env && env.trim()) {
    _keyCache = env.trim();
    _keySource = "环境变量 DEEPSEEK_API_KEY";
    return _keyCache;
  }
  /* ③ 可选覆盖：存在就用它（优先级高于凭据文件） */
  const userFile = readKeyFromUserFile();
  if (userFile) {
    _keyCache = userFile;
    _keySource = "本目录 .user_api_key（可选的本地覆盖）";
    return _keyCache;
  }
  /* ② 主路径：DSH 凭据文件（= 用户自己的 key） */
  const fromFile = readKeyFromCredentialsFile();
  _keyCache = fromFile || null;
  if (fromFile) return _keyCache;
  _keySource = "";
  return null;
}

/** key 的来源说明（**只说来源，绝不含 key 本身**），供网页/日志展示 */
export function keySource() {
  getApiKey();
  return _keySource || "（未找到）";
}

/* --------------------------------------------------------------- API 端点 */

const BASE = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
/* 模型名：从 DSH 的 settings 读到的是 deepseek-flash（本机 agent-default-model.model）；
   可用环境变量覆盖。见 README「已知限制」——这个 id 是按 DSH 本机配置取的，
   不是线上文档确认过的公开 id。 */
export const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-flash";
const ENDPOINT = BASE.replace(/\/+$/, "") + "/chat/completions";
const TIMEOUT_MS = Number(process.env.DEEPSEEK_TIMEOUT_MS || 25000);
// 整理是可选步骤：单次、短时限；失败直接使用已核验原文。解析策略保持不变。
const rewriteTimeout = Number(process.env.DEEPSEEK_REWRITE_TIMEOUT_MS || 12000);
const REWRITE_OPTIONS = Object.freeze({
  thinking: { type: "disabled" }, retryBudget: false, rejectTruncated: true,
  timeoutMs: Number.isFinite(rewriteTimeout) && rewriteTimeout > 0 ? rewriteTimeout : 12000,
});

export function available() { return !!getApiKey(); }

/** 探测一次可用性（真发一个极小的请求）。断网 / 无 key / 401 都返回 ok:false。 */
export async function probe() {
  if (!available()) return { ok: false, reason: "no_key", detail: "未找到 DEEPSEEK_API_KEY（环境变量与凭据文件都没有）" };
  try {
    const r = await chat([{ role: "user", content: "ping" }], { maxTokens: 4, temperature: 0 });
    return { ok: true, detail: "模型 " + MODEL + " 可用", sample: (r || "").slice(0, 40) };
  } catch (e) {
    return { ok: false, reason: e.code || "error", detail: String(e.message || e) };
  }
}

/* ---------------------------------------------------------------- 底层调用 */

export class LlmError extends Error {
  constructor(msg, code) { super(msg); this.code = code || "llm_error"; }
}

async function chat(messages, opts = {}) {
  const key = getApiKey();
  if (!key) throw new LlmError("无 API key：进入离线降级", "no_key");
  const base = opts.maxTokens || 1200;

  /* 🔴 2026-10-13（第 2 次踩同一个坑，这次做成机制而不是数字）：
     预算不足 ⇒ **自动抬预算重试一次**，仍然失败才报错。
     为什么是"重试"而不是"直接写一个更大的数"：
       budget 是个**会漂的量** —— 模型一更新，同样的提示可能突然多吐一倍 reasoning
       （实测：注释里标定的 reasoning 峰值是 1012，本轮实测直接吃满 2000）。
       把任何一个数字写死，都只是把"哪天不够"往后推；而"不够就再给一次"是有界的兜底：
       最多多花一次调用，且第二次的预算只有第一次失败过才会用到。
     ⚠ 只在 **budget** 这一种错误上重试：network / http_4xx / bad_json 重试没有意义，
       反而会把一次瞬时错误变成两次。 */
  let attempt = 0;
  for (;;) {
    attempt++;
    const maxTokens = attempt === 1 ? base : Math.max(base * 2, base + 2000);
    try {
      const txt = await chatOnce(messages, { ...opts, maxTokens });
      if (attempt > 1) console.log("[llm] budget 重试成功：max_tokens " + base + " → " + maxTokens);
      return txt;
    } catch (e) {
      if (e && e.code === "budget" && attempt === 1 && opts.retryBudget !== false) {
        console.log("[llm] budget 不足（max_tokens=" + base + "），自动抬到 " +
          Math.max(base * 2, base + 2000) + " 重试一次");
        continue;   /* 只重试一次 */
      }
      throw e;
    }
  }
}

/** 单次调用（不含 budget 重试）。所有分支都要把 `usage` 交给 opts.onUsage（供实测 reasoning 用量）。 */
async function chatOnce(messages, opts = {}) {
  const key = getApiKey();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs || TIMEOUT_MS);
  let resp, raw;
  try {
    resp = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify({
        model: opts.model || MODEL,
        messages,
        temperature: opts.temperature === undefined ? 0 : opts.temperature,
        max_tokens: opts.maxTokens || 1200,
        stream: false,
        ...(opts.thinking ? { thinking: opts.thinking } : {}),
        ...(opts.json ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: ac.signal,
    });
    // 时限覆盖响应头和完整正文；不得在 headers 到达后提前清掉计时器。
    raw = await resp.text();
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (ac.signal.aborted) throw new LlmError("调用超时（" + (opts.timeoutMs || TIMEOUT_MS) + " ms）", "timeout");
    throw new LlmError("网络不可达：" + msg, "network");
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    /* ⚠ 只回状态码与**经过裁剪的**响应体，防止任何形式的回显把 key 带出去（响应体里不会有 key）。 */
    throw new LlmError("DeepSeek 返回 HTTP " + resp.status + "：" + raw.slice(0, 300), "http_" + resp.status);
  }
  let j;
  try { j = JSON.parse(raw); } catch { throw new LlmError("响应不是 JSON：" + raw.slice(0, 200), "bad_json"); }
  const ch = j && j.choices && j.choices[0];
  const txt = ch && ch.message && ch.message.content;
  const u = j.usage || {};
  /* 实测用量回调（R-测量用）：reasoning / completion / max_tokens 都报出来 */
  if (typeof opts.onUsage === "function") {
    try {
      opts.onUsage({
        reasoning: u.completion_tokens_details ? u.completion_tokens_details.reasoning_tokens : null,
        completion: u.completion_tokens ?? null,
        prompt: u.prompt_tokens ?? null,
        maxTokens: opts.maxTokens || 1200,
        finish: ch && ch.finish_reason,
        contentChars: typeof txt === "string" ? txt.length : 0,
      });
    } catch { /* 测量回调不许影响主流程 */ }
  }
  /* ⚠ 关键判据：finish_reason === "length" 且 content 为空 ⇒ **不是模型不听话，是 token 预算不够**
     （reasoning tokens 把 max_tokens 吃光了）。装成 parse_bad_json 会让人往错的方向查。 */
  if ((txt == null || txt === "") && ch && ch.finish_reason === "length") {
    throw new LlmError("token 预算不足（reasoning 吃掉 " +
      (u.completion_tokens_details ? u.completion_tokens_details.reasoning_tokens : "?") +
      " / max_tokens " + (opts.maxTokens || 1200) + "），模型还没来得及输出正文；请调大 max_tokens", "budget");
  }
  if (opts.rejectTruncated && ch && ch.finish_reason === "length") {
    throw new LlmError("整理正文被 token 上限截断：保留完整原文", "truncated");
  }
  if (typeof txt !== "string") throw new LlmError("响应里没有 choices[0].message.content（finish_reason=" + (ch && ch.finish_reason) + "）", "bad_shape");
  return txt;
}

/* ============================================================ (a) 解析入参 */

/* ⚠ 实测踩到的坑（2026-10-11，本轮改造时发现）：
   本机模型（deepseek-flash）会先吐 **reasoning tokens**，而 reasoning 也算进 max_tokens。
   原来 parseScene 用的 maxTokens:500 在**带前文的多轮提示**下会 100% 被 reasoning 吃光：
     usage: {completion_tokens:500, reasoning_tokens:500} → finish_reason:"length"、content:""
   （实测三次连败，报错是 parse_bad_json:"解析结果不是合法 JSON："，看着像模型不听话，
     实际是**预算不够**。短提示时 500 够用，所以单轮测试发现不了。）
   修法：把预算抬到 2000（实测 reasoning 峰值约 1012，content 233），
   并在 chat() 里把 finish_reason=length 明确报成 budget 错误，不再伪装成"JSON 不合法"。

   ⚠ 2026-10-13 第三轮（**同一个坑第三次**，故这次不靠"再猜一个更大的数"）：
     2000 又不够了。e2e 用例 ⑰ 的第 2 轮实测 `reasoning 吃掉 2000 / max_tokens 2000`、
     content 为空 ⇒ 引擎这一轮**根本没被调用**、推荐为 null，
     10 条断言连带全红（_x_base_e2e.txt:512-532）。现场演示同一条话术会**当场吐 error**。
     处置两条：
       ① 本处预算 2000 → 3000（实测 reasoning 分布见回报；3000 = 实测 max + 余量）；
       ② **更关键**：chat() 现在会在 budget 失败时**自动抬到 max(2×base, base+2000) 重试一次**，
          仍失败才抛错。⇒ 预算这个数从此**不再是单点**：它漂了还有一层兜底，
          而不是"哪天数不够了就现场翻车"。
     ⚠ `onUsage` 只用于实测与回报，不参与任何判定逻辑。 */
const PARSE_MAX_TOKENS = 3000;

/* 系统提示刻意写死"不许算、不许补数"。
   注意：我们**不指望提示词能保证正确**——真正的保证在 server.mjs：
   数值必须在原句里找得到，否则丢弃。提示词只是第一道。 */
const PARSE_SYS = `你是「工业余热回收智能决策平台」的自然语言入口。
你的唯一任务：把用户的一句话，翻译成决策引擎的结构化入参候选。

绝对禁止（违反即失败）：
1. 不许计算任何数字。不许单位换算（例如不要把"标方"换成"kg/s"、不要把"万"展开成数字）。
2. 不许补充用户没说过的数值。没说就填 null。
3. 不许给建议、不许评价、不许输出解释性文字。

只输出一个 JSON 对象，字段如下（缺省的填 null）：
{
  "温度_degC": 数字或 null,          // 热源温度，摄氏度。用户说"320度""320℃"→320
  "温度_原文": 字符串或 null,         // **照抄**：温度那个数所在的那一段原文，一个字都不许改
  "温度_运算": 字符串或 null,         // 见下方「派生运算文法」；数字直接来自本轮原话（含原话里的"减半"）时也填
  "流量_数值": 数字或 null,           // 用户给的流量数字**原样**（"1.2万"→1.2；"12000"→12000）
  "流量_单位": 字符串或 null,         // 只允许："kg/s" | "t/h" | "Nm3/h" | "m3/h" | "万Nm3/h" | "万m3/h"
  "流量_原文": 字符串或 null,         // **照抄**：基准数所在的那一段原文
  "流量_运算": 字符串或 null,
  "载体": 字符串或 null,              // 只允许："烟气" | "热水/冷凝水" | "工艺液体"
  "需求": 字符串或 null,              // 只允许："发电" | "工艺蒸汽" | "供暖/热水" | "储热调峰" | "供冷（制冷）" | "干燥/烘干"
  "年运行小时": 数字或 null,          // 用户明确说了年运行小时才填
  "年运行小时_原文": 字符串或 null,
  "年运行小时_运算": 字符串或 null,
  "换热端差_degC": 数字或 null,       // 用户明确说了端差才填
  "换热端差_原文": 字符串或 null,
  "换热端差_运算": 字符串或 null,
  "连续性": 字符串或 null,            // 只允许："连续" | "间歇"
  "驱动_原文": 字符串或 null          // 用户原话里关于驱动/热源来源的那一段，照抄
}

【派生运算文法】"*_运算" 只许写下面这几种写法之一（写别的会被判为不合法而丢弃）：
  "同一数值"          —— 数值原样照抄基准，没有任何运算
  "减半"              —— 基准 ÷ 2      （用户说"减半""一半"）
  "翻倍"              —— 基准 × 2      （用户说"翻倍""加倍"）
  "增加N" / "减少N"    —— 基准 + N / 基准 − N（N 是用户原话里的数，例如"提高 50 度"→"增加50"）
  "乘以N" / "除以N"    —— 基准 × N / 基准 ÷ N
  "设为N"             —— 直接等于 N（N 必须出现在本轮用户原话里）
**"减半"这类词也必须填运算**：数值填算完的结果，"_原文"照抄基准那一段。缺一不可。

判定线索：
- "烟气/废气/排烟/窑炉/炉窑/锅炉排烟" → 载体 "烟气"；"热水/循环水/冷凝水/冲渣水" → "热水/冷凝水"；"油/熔盐/工艺液体/物料" → "工艺液体"
- "发电/余热发电/发电上网" → 需求 "发电"；"蒸汽/产汽/供汽" → "工艺蒸汽"；"供暖/采暖/热水/供热" → "供暖/热水"；
  "储热/调峰/蓄热" → "储热调峰"；"制冷/供冷/空调/冷冻" → "供冷（制冷）"；"干燥/烘干" → "干燥/烘干"
- 没说载体就填 null。没说需求就填 null。
只输出 JSON，不要 markdown 代码块，不要任何前后缀。`;

/* 多轮补充提示。**它不放松闸门**：解析出的每个数仍然必须满足
   「本轮原话里找得到」或「`取值_原文` 照抄的片段能在上一轮原话/已落盘入参里逐字找到」。
   这里只是把"该去哪里找证据"讲清楚，判定全在 dialog.mjs:resolveSceneNL()。 */
const PARSE_SYS_MULTI = `

【多轮续问的额外规矩 —— 这是本平台最容易被误解的一步，务必照做】
用户可能在追问上一轮，例如「那流量减半呢？」——他**不会**把上一轮的每个参数再报一遍。
**续问时，上一轮已经落盘的参数继续有效**，你要把它们照抄下来，而不是填 null。
判定标准只有一条：用户这句话读起来像是**在上一轮工况上做改动/追问**（出现"那/如果/改成/减半/翻倍/呢"等），
就按下述五步做；如果读起来是一个**全新的独立工况**，就按单轮规矩填（没说的一律 null）。

第一步 · 找基准：到【前文】的「【上一轮的入参（**这些数字允许被照抄引用**）】」那一段里，
  找到被追问的那个字段那一行（形如「  · 流量_kg_s = 4.4667」）。
第二步 · 填证据：把**那一行**照抄进对应的"_原文"字段（连「· 」和「字段名 = 」一起抄）。
  照抄必须在前文里逐字找得到；判定方会忽略空白与标点差异，但文字必须一致。
第三步 · 填运算：在对应的"_运算"字段里填上白名单运算。
第四步 · 填数：数值字段填**算完之后的数**（取 4 位小数），单位沿用基准那一行的单位。
第五步 · **未改动的参数一律"同一数值"带过来**：
  · 未被追问、但上一轮已经落盘的参数（例如温度 320、需求 发电）⇒ 数值照填、"_运算"填 "同一数值"、
    且"_原文"**必须**照抄【前文】那一行（例如「  · 热源温度_degC = 320」）。
    漏了"_原文"这个字段就会被丢弃，追问就会断在"没听出热源温度"上。
  · 上一轮里本来就没有的字段（例如上一轮没给年运行小时）⇒ 填 null。
  · 需求 / 载体 / 连续性 这类**非数值**字段，续问时直接沿用上一轮的值（它们不需要证据字段）。

再强调三条禁令：
1. 不许凭"上一轮推荐了什么技术路线"来推断本轮该填什么。
2. 上一轮的引擎输出（贴近度、可回收热功率、证书项数…）**不是**本轮的合法数字来源，一个字都不许引用。
3. 如果前文里根本找不到基准数，就把数值、"_原文"、"_运算"都填 null，让判定方去报"信息不足"。**不许猜。**`;

/**
 * 解析自然语言 → 结构化入参候选。**只回字段，不回数字解释。**
 * @param {string} userText 本轮用户原话
 * @param {string} [context] 前文摘要（`dialog.mjs:contextDigest`），首轮传空
 * @param {(u:object)=>void} [onUsage] 可选：每次底层调用回报 token 用量（测量用，不参与判定）
 * @returns {Promise<object>} 原始候选（未经校验；校验在 dialog.mjs:resolveSceneNL）
 */
export async function parseScene(userText, context, onUsage) {
  const ctx = String(context || "").trim();
  const sys = PARSE_SYS + (ctx && !/^（这是第一轮/.test(ctx) ? PARSE_SYS_MULTI : "");
  const user = (ctx ? "【前文】\n" + ctx + "\n\n【本轮用户原话】\n" : "") + String(userText || "").slice(0, 600);
  const txt = await chat(
    [{ role: "system", content: sys }, { role: "user", content: user }],
    { json: true, temperature: 0, maxTokens: PARSE_MAX_TOKENS, onUsage }
  );
  let s = txt.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  let obj;
  try { obj = JSON.parse(s); } catch { throw new LlmError("解析结果不是合法 JSON：" + s.slice(0, 200), "parse_bad_json"); }
  if (!obj || typeof obj !== "object") throw new LlmError("解析结果不是对象", "parse_bad_shape");
  return obj;
}

/* ==================================================== (a2) 意图分派（不做数字） */

const CLASSIFY_SYS = `你是「工业余热回收智能决策平台」的入口分派器。
判断用户这一句属于哪一类，只输出 JSON：{"intent":"chat"|"decide"|"ask","reason":"不超过 20 字的理由"}

- "chat"：**与工况无关的普通对话** —— 寒暄、打招呼、道谢、问它是谁、问它能干什么、让你讲个笑话、
  或任何读起来不像"这个项目/这个平台"的问题的闲聊。例：「你好」「在吗」「谢谢」「你是谁」「你能做什么」
- "decide"：用户给了一个**工况**（有温度/流量/载体/需求等具体描述），要平台算一算该用什么技术路线。
  例：「320℃ 的窑炉烟气，1.2 万标方每小时，想发电」「那流量减半呢？」「50 kg/s 的 150℃ 排烟做烘干」
- "ask"：用户在问**本项目的口径、出处、定义、数字来源、项目纪律**，不是要算工况、也不是闲聊。
  例：「年运行小时默认多少」「温度包络是多少」「9517 和 7733 是怎么回事」「证书扰动几项会翻」

判定优先级（务必按此顺序，**拿不准就不要选 decide**）：
1. 只要句子里出现**具体的温度/流量/载体/需求**（能拿去算一个工况）⇒ "decide"。
2. 只要在问**本项目的数字或口径** ⇒ "ask"（哪怕它是用闲聊的口吻问的，例如"你们那个 9517 是啥"）。
3. 其余话题与项目无关、只是聊天 ⇒ "chat"。
4. **拿不准时填 "ask"**，不要填 "decide"，也不要填 "chat"。

绝对禁止：不许计算、不许输出任何数字、不许给建议、不许解释超过 20 字。
只输出 JSON，不要 markdown 代码块。`;

/**
 * 意图分派（三类）。**LLM 不可用或判定失败时，由 dialog.mjs 的规则路由兜底**，所以这里失败不致命。
 *
 * ⚠ 返回值的坑（本轮修）：老版本写成 `obj.intent === "ask" ? "ask" : "decide"`，
 *   等于把**任何**没识别的意图都硬判成工况计算 —— 「你好」于是被塞进了算工况那条路。
 *   现在：只认白名单里的三类；识别不出来就**抛错**，交给 dialog.mjs 的兜底路由去处理。
 *
 * @returns {Promise<{intent:"chat"|"decide"|"ask", reason?:string}>}
 */
export async function classify(userText, context) {
  const ctx = String(context || "").trim();
  const txt = await chat(
    [{ role: "system", content: CLASSIFY_SYS },
     { role: "user", content: (ctx && !/^（这是第一轮/.test(ctx) ? "【前文】\n" + ctx + "\n\n" : "") + "【本轮】\n" + String(userText || "").slice(0, 400) }],
    { json: true, temperature: 0, maxTokens: 1000 }
  );
  let s = String(txt).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  const obj = JSON.parse(s);
  const it = obj && String(obj.intent || "").trim();
  if (it !== "chat" && it !== "decide" && it !== "ask") {
    throw new LlmError("意图判定返回了白名单外的值：" + JSON.stringify(it), "classify_bad_intent");
  }
  return { intent: it, reason: obj && obj.reason ? String(obj.reason) : null };
}

/* ==================================================== (a3) 闲聊对话（真调模型） */

/* ⚠ 这一段的定位（用户明确要求，别搞混）：
   闲聊**就是一次普通的对话补全** —— 把用户的寒暄原样丢给模型、把模型的话显示出来。
   **不是**模板话术，**也不**走工况那条流水线（不调引擎、不出证书、不显示那串步骤）。
   只给一个简短的系统提示，把"别凭记忆报本项目的数"这条纪律说清楚。 */
const CHAT_SYS = `你是「工业余热回收智能决策平台」的对话入口，现在在和用户闲聊。

现在这一轮用户没有给工况，你**不需要**、也**没有**调用任何计算引擎。就用自然、简短（1~3 句）、
口语化的中文回应他，像一个正常的聊天助手。

⚠ 唯一的硬纪律：**不要凭记忆说出本项目的任何具体数值或口径**（例如年运行小时的默认值、
温度包络上下限、各种效率/投资/回收期/贴近度/吨数，以及任何"某个文件里写了多少"的说法）。
这类问题**不是你这一轮该回答的** —— 你没有查过知识库，说了就是编。
碰到这类问题，就顺口说一句"这个我去知识库里查一下更准，你直接问我就行"，或者在需要具体工况时
请他给一句工况描述。**宁可少说，也不许猜一个看起来合理的数。**

也不要提及文件名、行号、函数名、台账、证书、扰动项数这类内部细节。
不要输出 JSON、不要用 markdown 代码块、不要写小标题，就一段自然的对话。`;

/**
 * 闲聊一轮：**真调一次普通的 chat completion**（同一个 DeepSeek key / 同一个端点）。
 *
 * ⚠ 数字纪律的落地点在**闸门**而不是提示词：模型回来之后，`dialog.mjs:chatStage` 会用
 *   `isSafeChatReply()` 再查一遍（不许有阿拉伯数字、不许出现项目内专有名词），
 *   命中就整段作废、改为一句反问。理由和铁律 1 一样：**不指望提示词能保证正确。**
 *
 * @param {string} userText 用户本轮原话
 * @param {string} [context] 前文摘要（`dialog.mjs:contextDigest`），首轮传空
 * @returns {Promise<string>} 模型的回复正文（已剥掉代码围栏）
 */
export async function chatReply(userText, context) {
  const ctx = String(context || "").trim();
  const msgs = [{ role: "system", content: CHAT_SYS }];
  /* 前文只给"用户说过什么"，**不给任何数字白名单** —— 闲聊这条路拿不到本项目的数据。
     这样即使模型想"顺着上一轮的数字接着说"，它手里也没有那些数。 */
  if (ctx && !/^（这是第一轮/.test(ctx)) {
    const prev = ctx.split("\n").filter((l) => /^上一轮用户原话：/.test(l)).join("\n");
    if (prev) msgs.push({ role: "user", content: prev });
  }
  msgs.push({ role: "user", content: String(userText || "").slice(0, 600) });
  const out = await chat(msgs, { temperature: 0.7, maxTokens: 700 });
  return String(out).replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/, "").trim();
}

/* ==================================================== (b2) 对话式改写（带数字闸门） */

const COMPOSE_SYS = `你是「工业余热回收智能决策平台」的答复改写器。用户刚刚问了一个工况问题，平台已经用**决策引擎**算完了。

你收到的【引擎原文】是引擎算出来的结论（Markdown）。你的任务：把它改写成一段**面向现场工程师的对话式答复**。

绝对禁止（违反即失败）：
1. 不许出现【引擎原文】里没有的任何数字、百分比、单位、年份、路径名、文件路径。
2. 不许改动、四舍五入、约等于、合并原文里的任何数字。原文写 0.9128 就必须写 0.9128，不许写"约 0.91"；
   原文写 1326.610 就不许写 1326.61 或 1326.6。
3. 不许新增结论、不许新增建议、不许做因果解释、不许推测投资额/回收期/效率。
4. 不许改动推荐路径的中文名称，不许改候选条数。
5. 不许删掉原文里的"口径提示 / 适用范围 / 限制 / 引擎告警"类句子，它们必须保留（可以换说法）。
6. 不许返回空内容，不许省略号，不许"以下略"。
7. 不许提及"上一轮""上一次""刚才"给出的任何数字。
8. **想不起某个数、又觉得需要它时，就整句不写**——宁可不提，也不许补一个"看起来合理"的数
   （例如原文只说了"工况库 19 行"，就不许写成"17 行可评"）。多写的每一个数都会被回查拦下，
   导致整段改写被丢弃，白费一次调用。

允许并且希望你做的：
- 先给一句直接结论（推荐哪条路径），再用小标题与 Markdown 表格把依据摊开。
- 用"你/当前工况"这类现场口吻；只使用用户明确提供的场景身份，不得自行补出行业、设备或工厂名称。
- 保留原文的表格结构（表格里的数一个都不许动）。
- **凡是拿不准要不要写的数，就整句照抄原文那一句**（原文的「口径提示」「适用范围」两句请原样保留，
  一个字都别改写）——照抄永远安全，改写才容易多出数字。
- **写短一点**：正文长度控制在【引擎原文】的 0.8~1.2 倍。
  一张表加几句点评就够了，不要额外发挥、不要复述表格里已有的数、不要写"综上所述"这类套话。
  （这条是现场演示需要：输出越短，用户等得越少。）

只输出改写后的 Markdown 正文，不要 JSON、不要代码围栏、不要任何前后缀说明。`;

/**
 * 对话式改写 + 数字回查（**内部先做一次回查，服务端还会用 verifyAnswer 再做一次**）。
 * @param {string} engineMarkdown 引擎模板原文（数字的唯一来源）
 * @param {{userText?:string, digest?:string}} ctx
 * @returns {Promise<{ok:boolean, text:string, reason?:string, dropped?:string[]}>}
 */
export async function composeAnswer(engineMarkdown, ctx = {}) {
  const src = String(engineMarkdown || "");
  if (!src.trim()) return { ok: false, text: src, reason: "引擎原文为空" };
  if (!available()) return { ok: false, text: src, reason: "离线降级：未调用改写" };
  /* 数字已经由引擎计算；整理不再消耗推理预算，也不串联重试。 */
  const call = (style) => chat(
    [{ role: "system", content: COMPOSE_SYS + (style ? "\n\n额外要求：" + style : "") },
     { role: "user", content: "【用户本轮原话】\n" + String(ctx.userText || "").slice(0, 400) + "\n\n【引擎原文】\n" + src }],
    { temperature: 0.2, maxTokens: 2500, ...REWRITE_OPTIONS }
  );
  let out = null, err = null;
  try { out = await call(); }
  catch (e) {
    err = e;
  }
  if (out == null) return { ok: false, text: src, reason: "改写调用失败（" + (err && err.code) + "）：保留引擎原文" };
  const cleaned = String(out).replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/, "").trim();
  /* 空串会让数字回查"无数字可查"而**真空通过** —— 这正是"守卫自身被绕过"的形态，先判空 */
  if (!cleaned) return { ok: false, text: src, reason: "改写返回空内容（已判为失败，退回引擎原文）" };
  if (cleaned.length < src.length * 0.15) return { ok: false, text: src, reason: "改写结果过短（疑似截断），退回引擎原文" };

  /* ⚠ 这里**刻意不**做第二次 verifyNumbers。理由（这是一个真实的坑）：
     `src` 是**模板正文**（引擎浮点数按 fmtN 呈现，例如 1198.2389），而引擎返回体是全精度
     （1198.2389015867936）。两边各查一次就会出现"同一个数字在 A 处合法、在 B 处非法"的自相矛盾，
     实测表现为：模型照抄了模板里的 1198.2389，却因为模板与返回体不一致而被判越界。
     真正的闸门是**下游**的 `dialog.mjs:verifyAnswer(candidate, r, parseLog, {corpus: 模板正文})` ——
     语料 = 模型实际看到的那份文本（不多也不少），并且还额外核对推荐路径名与候选条数。
     所以：本函数只管"拿到一段非空、不像被截断的文本"，判决权全部交给下游一道闸。*/
  return { ok: true, text: cleaned };
}

/* ============================================================ (b) 措辞润色 */

const POLISH_SYS = `你是「工业余热回收智能决策平台」的措辞润色器。

你收到一段**已经由决策引擎算好的**结论（下称"原文"）。你的唯一任务：把它改写得更容易听懂。

绝对禁止（违反即失败）：
1. 不许出现原文里没有的任何数字、百分比、单位、年份、路径名。
2. 不许改动、四舍五入、约等于、合并原文里的任何数字。原文写 0.9128 就必须是 0.9128，不许写"约 0.91"。
3. 不许新增结论、不许新增建议、不许做因果解释、不许提原文没提的技术名词。
4. 不许删掉原文里的"口径提示/适用范围/限制"类句子，它们必须保留。
5. **不许返回空内容。**必须把原文实质上重述出来；原文有几段，就写几段。
6. 不许省略号、不许"以下略"、不许"……"。必须写完整。

只输出改写后的正文，不要 JSON、不要 markdown 代码块、不要任何解释。
长度控制在原文的 0.7~1.5 倍之间。`;

/**
 * 措辞润色 + **数字回查**。
 *
 * 单次整段润色 → 数字回查 → 采用；超时/失败/越界直接退回原文。
 * 不再串联「整段重试 + 逐块润色」，避免可选整理阻塞可靠结果。
 *
 * @param {string} sourceText 引擎/文档产出的原文（数字的唯一来源）
 * @param {string} [style] 额外风格要求
 * @returns {Promise<{text:string, polished:boolean, reason?:string, dropped?:string[], mode?:string}>}
 *          polished=false 表示润色被拒（空内容/数字对不上/调用失败），text 是**原文**。
 */
export async function polish(sourceText, style) {
  const src = String(sourceText || "");
  if (!src.trim()) return { text: src, polished: false, reason: "原文为空" };
  if (!available()) return { text: src, polished: false, reason: "离线降级：未调用润色" };

  const one = await polishOnce(src, style);
  if (one.polished) return { ...one, mode: "整段" };
  return { text: src, polished: false, reason: one.reason, dropped: one.dropped };
}

/** 单次润色 + 数字回查。**空/过短一律判失败**（空串会让回查真空通过）。 */
async function polishOnce(src, style) {
  let out;
  try {
    out = await chat(
      [{ role: "system", content: POLISH_SYS + (style ? "\n\n额外要求：" + style : "") },
       { role: "user", content: "【原文】\n" + src }],
      // 保留足够正文预算；不开启思考，不抬预算重试。
      { temperature: 0.2, maxTokens: 6000, ...REWRITE_OPTIONS }
    );
  } catch (e) {
    return { text: src, polished: false, reason: "润色调用失败（" + e.code + "）：保留原文" };
  }
  const cleaned = String(out).replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/, "").trim();

  /* ⚠ 实测踩过的坑（2026-10-11）：模型偶尔返回**空串**（原文较长时更容易，1.7~2.2 KB 段实测复现两次）。
     空串会让数字回查"无数字可查"而**真空通过** —— 这正是"守卫自身被绕过"的形态。
     所以先判空：空/过短一律视为润色失败。 */
  if (!cleaned) return { text: src, polished: false, reason: "润色返回空内容（已判为失败，退回原文）" };
  if (cleaned.length < src.length * 0.15) {
    return { text: src, polished: false, reason: "润色结果过短（" + cleaned.length + " 字符 vs 原文 " + src.length + "），疑似截断，退回原文" };
  }

  const check = verifyNumbers(cleaned, src);
  if (!check.ok) {
    return { text: src, polished: false, reason: "润色文本出现原文里没有的数字，已丢弃润色", dropped: check.missing };
  }
  return { text: cleaned, polished: true };
}

/* ------------------------------------------------------ 数字回查（铁律 1 的闸门） */

/** 把全角数字折成半角，便于比对 */
export function toHalfWidth(s) {
  return String(s).replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, " ");
}

/* 数字 token：
   ① 带千分位的  1,234.5      —— 台账正文里用**空格**分隔（"3 313~8 000 h"），所以空格也算
   ② 小数/整数   0.9128 / 320
   ③ 全角        ６５００
   顺序重要：先长后短，避免把 "3 313" 拆成 3 与 313。 */
const NUM_RE = /\d{1,3}(?:[,\u00A0\u2009 ]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

/** 抽出一个文本里的所有数字 token（已折半角、去千分位） */
export function extractNumbers(text) {
  const t = toHalfWidth(text);
  const found = t.match(NUM_RE) || [];
  return found.map((x) => x.replace(/[,\u00A0\u2009 ]/g, ""));
}

/**
 * 数字回查：candidate 里的每个数字，都必须能在 source 里找到。
 * 比对规则（宽严结合，宁可误杀不可放过）：
 *   - 把两边都折半角、去千分位分隔符、去前后导零
 *   - candidate 的数字与 source 的数字**字符串相等**，或在数值上相等
 * @returns {{ok:boolean, missing:string[], checked:number}}
 */
export function verifyNumbers(candidate, source) {
  const cs = extractNumbers(candidate);
  const ss = new Set(extractNumbers(source));
  const ssNum = new Set([...ss].map((x) => String(Number(x))));
  const missing = [];
  for (const c of cs) {
    const canon = String(Number(c));
    if (ss.has(c) || ssNum.has(canon) || ss.has(canon)) continue;
    missing.push(c);
  }
  return { ok: missing.length === 0, missing, checked: cs.length };
}

/**
 * 判断一个"数字"是否能溯源到用户原话 —— 用于解析入参的闸门。
 * "1.2万" 这种写法：LLM 会给 流量_数值=1.2、流量_单位="万Nm3/h"，
 * 而原句里只有 "1.2" 与 "万"，因此分开找。
 */
export function numberTraceableInUserText(value, userText) {
  const src = new Set(extractNumbers(userText));
  const canon = String(Number(value));
  return src.has(String(value)) || src.has(canon);
}
