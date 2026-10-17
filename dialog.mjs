/* dialog.mjs —— **对话式**主流水线：一次提问 → 逐步可见的计算过程 → 正式回答。
 *
 * 它是 server.mjs 的核心，被写成**异步生成器**，好处有两个（都很实在）：
 *   ① `/api/chat/stream` 直接把 yield 出来的事件写成 SSE —— **步骤是真的边算边推**，
 *      不是"全部算完再一次性渲染"；
 *   ② 自检脚本可以 import 它、直接消费同一个事件流 —— 自检测的是**线上跑的那段代码**，
 *      不是另写一份仿制品。
 *
 * 事件词表（前端按 type 分发；顺序即用户看到的顺序）──────────────────────────
 *   {type:"session", sessionId, turns}        会话已就绪 / 载入了前几轮
 *   {type:"step",    phase, text, state}      一条"计算过程"（状态：run|ok|warn|bad）
 *   {type:"plan",    rows[]}                  已解析出的场景：结构化结果亮出来
 *   {type:"answer",  markdown, mode}          正式回答（Markdown）
 *                                             mode: "template" 引擎模板句
 *                                                   "llm"      大模型改写（已过数字回查）
 *                                                   "chat"     闲聊：DeepSeek 的一次普通对话补全 ← M1
 *                                                   "chat-fallback" 闲聊未通过安全闸门/未连上
 *   {type:"verify",  checked, missing[], anchors[], scope}  本轮数字回查小结
 *   {type:"detail",  ledger[], certificate, engineRaw, scene, parse}  可展开的明细
 *                                             （闲聊轮另有 detail.chat = {byModel, mode, reason, gate}）
 *   {type:"offer",   offline, href}           离线降级时的出口
 *   {type:"error",   message}
 *   {type:"done",    ms}
 *
 * ── 三条意图各自走哪条路（M1，2026-10-11 加）────────────────────────────────
 *   chat   → chatStage()   只发 session / 一条"正在回复…" / answer / turn_saved / done。
 *                          **绝不出现** "正在解析场景""正在调用决策引擎""决策证书""数字来源表"。
 *   decide → parseScene → resolveSceneNL → callEngine → verifyAnswer（原有链路，一字未动）
 *   ask    → askStage()    BM25 检索，答案必带出处
 *
 * ── 🔴 多轮下的数字闸门（本轮改造最容易出事的地方，专门写在这一段）──────────────
 *   旧版只有一个"数字必须在用户原话里找得到"的闸门。多轮一来就有一个新漏洞：
 *   第 2 轮说「流量减半」，"减半"的基准数来自**上一轮**，如果放开"历史轮次的数字也算已溯源",
 *   那么 LLM 就可以拿上一轮的任何数字来凑本轮结果，闸门形同虚设。
 *   这里的分工是**两道互不相通的闸**：
 *
 *   闸 A（入参闸，allowPrev=true）：判断"LLM 填进 scene 的数能不能用"。
 *     合法来源只有三种，且必须逐字对得上：
 *       ① 用户本轮原话里找得到；
 *       ② LLM 在 `取值_原文` 里**照抄**的片段，能在【上一轮用户原话 + 上一轮已落盘入参的派生值】
 *          里逐字找到 —— 这时标为「由上文派生」，界面上显式提示它对上文的依赖；
 *       ③ 引擎默认值（6500 / 10 / 连续 / 余热自驱动），由 ENGINE_DEFAULTS 提供，不算 LLM 产物。
 *     对不上 → 丢弃该字段并在界面上写明"被丢弃"。**绝不把历史数字悄悄算作已溯源。**
 *
 *   闸 B（回答闸，allowPrev=false）：判断"回答里的数能不能用"。
 *     语料 **只有本轮 callEngine 的返回体**（由 buildCorpus 现取），
 *     历史上任何一轮的引擎数字都**不在**语料里 —— 所以上一轮答案里的 1326.610
 *     如果被搬到本轮回答里，会被直接判为"不可溯源"并退回模板句。
 *     这条约束由 e2e_chat_test.mjs 用**反向突变**（故意把上一轮的数字塞进候选回答）实测证明。
 */

import * as Session from "./session.mjs";
import * as LLM from "./llm.mjs";
import { verifyNumbers, extractNumbers, numberTraceableInUserText, toHalfWidth } from "./llm.mjs";
/* ⚠ 这条静态 import **不构成循环依赖**：rag.mjs 只 import node:fs / node:path / engine_bridge.mjs，
   它**不** import dialog.mjs。同理 engine_bridge.mjs 也不回头 import dialog.mjs。
   （之所以要静态引入而不是在函数里 `await import`：routeIntent() 是同步函数。） */
import { isProjectOverviewQuestion } from "./rag.mjs";
/* 同理：prior.mjs 只 import engine_bridge.mjs（读工况库那 19 行），不回头 import dialog.mjs。
   它只提供"提问用的先验"，**不产生任何进引擎的数字** —— 见文件头那条红线。 */
import * as Prior from "./prior.mjs";

/* ====================================================================== 常量 */

export const VALID = {
  demand: ["发电", "工艺蒸汽", "供暖/热水", "储热调峰", "供冷（制冷）", "干燥/烘干"],
  medium: ["烟气", "热水/冷凝水", "工艺液体"],
  continuity: ["连续", "间歇"],
};

/* 引擎自己的默认值（可被引用而不算"编数字"）：
   DEFAULT_RUN_HOURS=6500  decision_core.js:338
   换热端差缺省 10         decision_core.js:555
   连续性缺省「连续」       decision_core.js:550
   驱动来源缺省「余热自驱动」decision_core.js:551 */
export const ENGINE_DEFAULTS = { hours: 6500, dT: 10, continuity: "连续", driver: "余热自驱动" };

/* 体积流量 → 质量流量的换算系数。
   ⚠ **这两个数是本演示件自己引入的，不在项目台账里**（已实测：项目内 grep 不到"标方/kg/Nm³"）。
      因此界面上必须显式标注"未确认的工程取值"，且密度可被用户覆盖。
      t/h → kg/s 是纯单位换算（÷3.6），无数值假设。
   ⚠ 文案里**不许写文件名/函数名** —— 它会原样出现在回答正文里（N2）。 */
export const CONV = {
  density_kg_per_Nm3: 1.34,
  density_source: "标况烟气密度的工程取值（⚠ 未在项目台账与边界文件中找到出处，也未核；仅作演示换算，可手动覆盖）",
};

/* ── 意图路由用的关键词：**只在 LLM 不可用或判定失败时兜底**，一律不参与计算 ──────────

   ⚠ 本轮修的坑（用户第一条意见）：老版本的兜底规则最后一段是
       `ASK_MARKERS.test(text) ? "ask" : "decide"`
     —— 于是**任何**没识别出来的话（包括「你好」）都掉进"工况计算"那条路。
     现在改成三分类，并且**兜底一律偏保守**：拿不准 ⇒ "ask"（知识问答会给"没检索到"的实话），
     绝不硬猜成"工况"，也绝不硬猜成"闲聊"把真问题挡掉。 */

/* ① 纯寒暄：**整句**就是一句问候/道谢时才算（不做子串匹配，避免把
      「你好，我这有个 320℃ 的窑炉烟气…」这种正话误判成闲聊）。 */
const CHAT_PATTERNS = [
  /^(你好|您好|哈喽|哈啰|嗨|hi|hello|hey|在吗|在么|在不在|早上好|中午好|下午好|晚上好|早安|晚安)[呀啊哦嗯~！!。.，,、\s]*$/i,
  /^(谢谢|多谢|感谢|辛苦了|好的|好哒|收到|明白|明白了|ok|okay|嗯嗯|哈哈|嘿嘿|呵呵|嘻嘻|再见|拜拜|回见)[呀啊哦嗯~！!。.，,\s]*$/i,
];

/* ② 闲聊式问句：**短**、带问号、且**不含**任何"问知识/问工况"的实词 ⇒ 仍是闲聊。
      这一条保证「你是谁」「你能干啥」走闲聊，而不是被当成口语化知识问答。 */
const CHAT_QUESTION = /^(你|您|咱|咱俩|我们)?[^。！!；;]{0,14}(是谁|叫啥|叫什么|叫什么名字|能干什么|能做什么|能干啥|会什么|能帮|干吗|干嘛|做什么|怎么了|好吗|好不好|怎么样)[^。]{0,6}[？?]?$/;

/* ⑤ 项目专有内容标记：命中 ⇒ 必须走知识问答（RAG），**绝不当闲聊答**。
      这是用户定的纪律：闲聊里问到项目事实 ⇒ 转 ③，不许直接答。 */
const CORPUS_MARKERS = /(年运行小时|运行小时|温度包络|包络|台账|证书|扰动|翻转|贴近度|可回收热|口径|出处|依据|来源|边界|阈值|默认值|工况库|余热|烟气|窑炉|蒸汽|发电|供冷|制冷|供暖|烘干|干燥|储热|调峰|换热|端差|热源|载体|流量|焓|效率|投资|回收期|吨|标方|小时|项目|平台|知识库|引擎|决策|数据集|仿真|模型|9517|7733)/;

/* ⑥ 工况痕迹：出现**温度读数或计量单位**才算 —— 光有"炉/窑/蒸汽"这类词不足以判定为可算的工况。
      ⚠ "度" 必须**紧跟在数字后面**（"350度"）。否则"温**度**包络""制**度**""程**度**"全会误命中，
        把"温度包络是多少"这种纯知识问题抢去算工况（实测踩到，故此处的 (?<=\d) 是必须的）。 */
const DECIDE_MARKERS = /((?<=\d)\s*度|℃|kg\/s|kg／s|t\/h|吨\/小时|标方|立方|Nm3|m3\/h)/;

/* 续问标记：出现这些词时，本轮极可能引用上一轮的工况 */
const CONTINUATION_MARKERS = /(那|那么|如果|要是|假如|改成|换成|减半|翻倍|一半|同样|这个|该工况|上面|刚才|再|呢[？?]?$|的话)/;

/* ==================================================== F1：meta（「关于你自己」）判定
 *
 * 用户报的现象（真实发生）：
 *   问「**介绍你的工作过程**」⇒ 它答的是**知识手册 §9「评委必问三题」（Q1/Q2/Q3）**，完全跑偏。
 *
 * 病根（read 出来的，不是猜的）：
 *   routeIntent() 的六条规则没有一条认得出"这是在问你自己怎么工作"：
 *     · 不是纯寒暄（isPureSmallTalk 否）；
 *     · 不是项目概况（isProjectOverviewQuestion 否）；
 *     · 没有温度/单位（DECIDE_MARKERS 否）；
 *     · 不是"你是谁/你能干啥"那种**短的**闲聊式问句（CHAT_QUESTION 要求整句 14 字内且以
 *       「是谁/能做什么/怎么样」这类词收尾，"介绍你的工作过程"两个条件都不满足）；
 *     · CORPUS_MARKERS 也命中不了（"过程"不在词表里）。
 *   ⇒ 掉进第 ⑥ 条兜底「其余一律知识问答」⇒ BM25 检索到手册 §9 那几节（它字面就长成
 *     "**Q1：请用一句话介绍你们的项目。**"，与"介绍"这个词高度相关）⇒ 答非所问。
 *   LLM 分类器同样只会回 chat/decide/ask 三种之一，**没有 meta 这一类**。
 *
 * 所以这一类的判据必须是**确定性规则**，而且要在"问模型"之前短路：
 *   · 两个条件同时成立才算 meta：**在说你**（META_YOU）+ **在问工作方式/可信度**（META_TOPIC）；
 *   · 句子里只要有阿拉伯数字就**不算** —— 例如「320℃ 的窑炉，你怎么保证不编数」是工况问题，
 *     不能被抢走（这条排除是为了保守，宁可漏判成 ask，也不抢工况句）。
 */
const META_YOU = /(你|您|你们|咱|咱俩|贵方|助手|agent|AI)/i;
const META_TOPIC = /(工作过程|工作流程|工作方式|工作原理|工作步骤|运行机制|怎么工作|如何工作|怎样工作|怎么做到|如何做到|怎么保证|如何保证|怎样保证|不编数|不编造|不瞎编|不乱编|不虚构|不胡编|数据.{0,6}(真实|可靠|可信)|数字.{0,6}(真实|可靠|可信)|计算器|有什么不同|有什么区别|有何不同|有什么不一样|有什么差别)/;

/**
 * 是不是「关于你自己」的问题（F1）。
 * @param {string} text 用户原话
 * @returns {boolean}
 */
export function isMetaQuestion(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (!META_YOU.test(t)) return false;
  if (!META_TOPIC.test(t)) return false;
  /* 带阿拉伯数字 ⇒ 是具体工况/口径问题，不许被 meta 抢走 */
  if (/[0-9]/.test(t)) return false;
  return true;
}

/* ==================================================== G1：缺参数引导（2026-10-12 加）
 *
 * 用户报的现象（真实发生）：
 *   「我这儿有 80℃ 的热水，想供冷」（**没说流量**）⇒ 老版直接回
 *   「没听出热源流量。请写清数值与单位」⇒ **用户走了，引擎一次都没被调用。**
 *
 * 病根：表单要求"你已经知道参数"；而现场的人往往是"知道自己有麻烦，但说不清参数"。
 *
 * 改法（本段就是它）：缺关键参数时**不再直接拒答**，改成
 *   ① 先给出听懂了的部分（哪一类热源）；
 *   ② 只问最关键的 1~2 个缺口（优先级见 MISSING_PRIORITY）；
 *   ③ 每个缺口给候选区间/参照值 **+ 依据 + "这是先验猜测、待你确认"的显式标注**。
 *
 * 🔴 红线（写在这里，因为这段代码最容易越界）：
 *   · **先验只用来提问、绝不用来出数**：本段产出的数字一个都不进 scene。
 *     用户答了之后，那个数走的是 `resolveSceneNL` 的闸 A（本轮原话里逐字找得到）——
 *     与改动前**同一条通道**，闸门一个字都没放宽。
 *   · **先验必须有出处**：全部来自 `prior.mjs`（工况库第 N 行 / 台账 / 案例回测登记）。
 *     查不到出处 ⇒ `Prior.blindAsk()`，只问"大概是多少"，不给区间（宁可不给，不许编）。
 */

/* 「这一句像不像在描述一处**自己的**余热工况，只是还没给出参数」。
   ⚠ 它只判"该不该走引导"，不判任何数字。
   ⚠ 两个都必须成立，否则不认：
       · SCENARIO_MARKER：有余热/工况的实词（窑、烟气、热水、炉、蒸汽…）；
       · VAGUE_MARKER：有"说话人在讲自己现场"的口吻（我这/我们/这台/一直没用/想供冷/挺烫/帮忙看看…）。
     实测这条的必要性：老版把用户那句送进了 **知识问答**（routeIntent 兜底 ⇒ "ask"），
     于是用户拿到的是一段讲边界口径的长文 —— 完全答非所问。 */
const SCENARIO_MARKER = /(窑|炉|锅炉|烟气|废气|排烟|尾气|热水|循环水|冷凝水|冷却水|冲渣水|回水|蒸汽|余热|废热|热源|熔渣|高炉渣|熔盐|物料|塔底|裂解|烧结|环冷|篦冷|冷却机|烘干|烟道|换热|热量|热气|水温|温度)/;
const VAGUE_MARKER = /(我|咱|我们|这儿|这里|这台|这个|这边|现场|一直|平时|目前|现在|挺|有点|比较|大概|差不多|左右|想|要|打算|准备|能不能|可以|怎么办|怎么用|用什么|干点|做点|没用|不用|浪费|排掉|放掉|白排|回收|利用)/;
/** 句子里**已经带了可算的读数/单位** ⇒ 不是"说不清"，不走引导（走原来那条解析路）。 */
const HAS_READING = /((?<=\d)\s*℃|(?<=\d)\s*(?:度|摄氏)|\d\s*(?:kg\/s|kg／s|t\/h|吨|标方|立方|Nm3|m3|万))/;

/**
 * 「这一句是一次**说不清参数的工况自述**吗」。
 * 只用规则、可复算；与数字闸门无关（它只决定"走引导还是走解析"）。
 * @param {string} text 用户本轮原话
 * @returns {boolean}
 */
export function isVagueScenario(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (HAS_READING.test(t)) return false;               // 已经给了读数 ⇒ 不是"说不清"
  if (!SCENARIO_MARKER.test(t)) return false;          // 没有余热实词 ⇒ 不是工况自述
  if (!VAGUE_MARKER.test(t)) return false;             // 没有"讲自己现场"的口吻 ⇒ 不认
  return true;
}

/* ================================================ G6：超出能力边界 ⇒ 分半回答（2026-10-12 加）
 *
 * 用户实测的原话（就是本节必须接住的那一句）：
 *   「我的余热锅炉现在把烟气温度降到了 120℃。但是我发现，因为烟气温度降得太低，导致烟囱的
 *     拔风力（抽力）严重不足，排烟不畅。现在我如果为了排烟顺畅把温度提到 180℃，我的余热回收
 *     效率就会下降。请你给我一个权衡（Trade-off）方案，如何在保证排烟顺畅的前提下，最大化回收热量？」
 *
 * 老版把它当成"一个 120℃ 的钢铁余热工况"，**只问气量** —— 也就是**默认整句都在能力范围内**。
 * 病根不是流程错，而是**缺一类回答**：这句话有一半引擎答不了，而系统不告诉用户。
 *
 * ── 真实的能力边界（逐条核对过，**不扩大也不缩小**）──────────────────────────
 *   【引擎有的】12 条技术路径的筛选与排序、两级决策、决策证书；
 *               输入 = 需求 / 热源温度 / 载体 / 流量 / 规模 / 换热端差 / 年运行小时 /
 *               连续性 / 驱动来源 / 需求温度；包络 25~650℃。
 *   【引擎没有的】见 `OUT_OF_SCOPE_ITEMS` —— 每一项都写了"为什么不在引擎里"，
 *               加一条必须能说出理由（这是本节的准入条件，不是词表越长越好）。
 *
 * ── 🔴 三条硬纪律（写在这里，因为这段最容易越界）─────────────────────────────
 *   ① **不许编**：绝不能假装算了热压或酸露点，**连"约""大概"都不许给**。
 *      实现上的保证：本段**一个数都不产出**（不调引擎、没有 ledger、没有 verify 语料），
 *      正文里的数字只可能是**用户原话里已经有的字面量**（照抄），别的数一律不出现。
 *   ② **不许因为超范围就整句拒答**：能答的那半（回收路径与回收量）照常答、照常问缺的参数。
 *   ③ **数字闸门一条都不许放宽**：这条路根本不经闸（它不产生数字），
 *      用户确认后的值走的是**既有**那条通道（`resolveSceneNL` 的闸 A，逐字可溯）。
 */
const OUT_OF_SCOPE_ITEMS = [
  /* 问的是**"该不该做这件事"**，而不是**"能不能这么反应"** —— 不是词表没覆盖，是引擎没这个模块 */
  { id: "draft", words: ["烟囱", "抽力", "拔风", "自拔力", "热压", "烟道阻力", "引风机", "风机压头", "排烟不畅"],
    name: "烟囱抽力 / 自拔力（热压）", kind: "物理量",
    why: "我的引擎不做烟道阻力与热压计算，也没有引风机模型" },
  { id: "dewpoint", words: ["酸露点", "露点腐蚀", "低温腐蚀"],
    name: "酸露点 / 低温腐蚀", kind: "约束",
    why: "我的引擎里没有酸露点约束，也不做低温腐蚀判定" },
  /* ⚠ 这一条**不靠词表命中**：用户原话里往往只写了"排烟不畅"，没写"酸露点"。
       但只要他问的是"**温度能降到多低**"，这个量就**必然**是那个问题的另一半 ——
       见 `LOWER_INTENT` / `LOWER_QUESTION` 与 `outOfScopeHits()` 末尾的按需注入。
       ⚠ 注入的是**条目本身**（名称 + 为什么算不了），**不是一个数字** —— 纪律 ① 不受影响。 */
  { id: "lowlimit", words: [], inject: true,
    name: "低温限制（多低算太低：抽力 + 酸露点）", kind: "约束",
    why: "我的引擎不判「多低算太低」：它既不算烟道抽力，也不判酸露点，所以给不出这个下限" },
  { id: "engineering", words: ["噪声", "噪音", "占地", "水耗", "检修", "施工", "工期"],
    name: "噪声 / 占地 / 水耗 / 检修周期 / 施工", kind: "工程与运维",
    why: "我的引擎不评工程与运维条件，这些量它一个都不读" },
  { id: "finance", words: ["内部收益率", "irr", "净现值", "npv", "投资回报", "财务模型", "现金流"],
    name: "财务类指标（内部收益率 / 净现值 / 现金流…）", kind: "经济性",
    why: "我的引擎只出「投资回收期」这一个经济性指标，其余财务口径它不算" },
];

/* 判据用的是**领域词**，不是句子长。两句的边界逐条写在下面（都是实测的形态）： */
const SCOPE_TEMP = "(?:\\d+(?:\\.\\d+)?)\\s*(?:℃|°C|度)";
/* ① 「排烟温度」是**用户侧的工艺量**，不是我们的输入变量 —— 我们吃的是"热源温度"。
      所以它不算"引擎没有的物理量"（那是缩小边界），但它会把话题带进烟道，是**强提示**。 */
const OUT_OF_SCOPE_HINT = /排烟温度|烟气出口温度|出口烟温|露点/;
/* ② 只提一句领域名词（「我这台窑的烟气，烟囱是现成的，流量 1.2 万标方，想发电」）
      ⇒ **不是**权衡题。这一条是防误判的第二半，与下面的约束语义**必须同时成立**。 */
const OUT_OF_SCOPE_MARKER = new RegExp(OUT_OF_SCOPE_ITEMS.map((x) => x.words.join("|")).join("|"), "i");
/* ③ **约束/权衡语义** —— 缺了它就不算"权衡题"，这正是反向变异 ③ 的挡板。
      两条形态，任一命中即可；两者都不允许被"随口提一个名词"命中：
        · TRADEOFF_INTENT：句子里**明说了**一个交换条件（保证 / 确保 / 前提 / 为了 / 权衡…）
          —— 这类词是**议题词**而不是**领域词**：反向变异 ③ 的「…想发电，烟囱是现成的」
            一个都不含（"想发电"三个字刻意不在表里，否则普通工况句会被误判），
            所以它挡得住"只因出现『烟囱』二字就整句降级"。
        · TRADEOFF_CLAUSE：句子里写出了**代价**（…就会下降 / 会降低 / 牺牲 / 打折）
          或"在…前提下"的让步结构。窗口按中文字数给足（实测「保证排烟顺畅的前提」
          中间夹了 6 个字，窗口给 0~12 就漏了）。 */
const TRADEOFF_INTENT = /(权衡|trade-?off|保证|确保|前提是|前提为|前提|条件下|为了)/i;
const TRADEOFF_CLAUSE = new RegExp(
  "(?:在[^，。；！？,;!?]{0,14}(?:前提|条件下)" +
  "|(?:就|会|则|要|将)[^，。；！？,;!?]{0,8}(?:下降|降低|变差|打折|牺牲|损失)" +
  "|(?:下降|降低|变差|打折|牺牲))", "i");
const TRADEOFF_CONSTRAINT = TRADEOFF_INTENT;

/**
 * 这一句里**点了名**的超范围项（去重；空数组 = 没有）。
 *
 * ⚠ 末尾那次"按需注入"是有意为之，理由写在这里：
 *   用户问「温度能降到多低还不影响排烟」时，那个问题的另一半**必然**是"低温限制"
 *   （抽力 + 酸露点），但他自己往往只写了现象（"排烟不畅"）、不会写"酸露点"。
 *   如果只照字面点名，用户会以为我们漏看了他真正的约束 —— 所以**把这一半也点名**。
 *   🔴 注入的是**条目**（名称 + 为什么算不了），**不是数字**：纪律 ① 一个字都没松。
 *
 * @param {string} text 用户本轮原话
 * @returns {Array<{id,words,name,kind,why,hits:string[]}>}
 */
export function outOfScopeHits(text) {
  const t = String(text || "");
  const out = [];
  for (const it of OUT_OF_SCOPE_ITEMS) {
    const hits = it.words.filter((w) => t.toLowerCase().includes(w.toLowerCase()));
    if (hits.length) out.push({ id: it.id, words: it.words, name: it.name, kind: it.kind, why: it.why, hits });
  }
  /* 问的是"温度能降到多低"⇒ 把低温限制这一项也点名（见上面那段 ⚠） */
  if (asksHowLow(t) && !out.some((x) => x.id === "lowlimit")) {
    const it = OUT_OF_SCOPE_ITEMS.find((x) => x.id === "lowlimit");
    if (it) out.push({ id: it.id, words: [], name: it.name, kind: it.kind, why: it.why, hits: ["（由「降温」这个问法带入）"] });
  }
  return out;
}

/**
 * 「这一句问的是**温度能降到多低**吗」——
 * 命中它 ⇒ 把 `lowlimit`（低温限制）这条超范围项也点名（理由见 `outOfScopeHits`）。
 *
 * ⚠ 两条形态分别对应两种真实问法，都要求**降温/下限**语义，不能光有"温度"两个字：
 *   ① 正在拿温度朝下走：「把温度降到 …」「温度降到了 …」「再低一点」
 *   ② 在问那个下限：「能降到多少」「最低多少度」
 *   ⇒ 反向变异那两句（「想发电，烟囱是现成的」「320℃ 窑炉烟气…想发电」）一条都不命中。
 */
const LOWER_INTENT = /(?:再|继续|往下|往低|降低|降|下调|压低|减到|减至)[^，。；！？,;!?]{0,8}?(?:温度|烟温|排烟温度)|温度[^，。；！？,;!?]{0,3}(?:降到|降至|降低|下降|下调|压低|再低)/;
const LOWER_QUESTION = /(?:能|可以|最低|至少|下限)[^，。；！？,;!?]{0,8}?(?:多少|多低|几度)/;export function asksHowLow(text) {
  const t = String(text || "");
  return LOWER_INTENT.test(t) || LOWER_QUESTION.test(t);
}

/**
 * 「这一句里有**超出引擎能力边界**的关注点吗」（G6 的**新类别**判据）。
 *
 * 🔴 判据靠**领域词**，三条同时成立才算（这就是"防误判"的全部做法）：
 *   ① 命中 `OUT_OF_SCOPE_HINT`（排烟温度/出口烟温/露点）**或** `OUT_OF_SCOPE_MARKER`
 *      （超范围词表里任一个词）—— 这一条说明**话题里真有引擎管不着的东西**；
 *   ② 命中 `TRADEOFF_CONSTRAINT`（在…前提下 / 保证… / 前提是… / …就会下降 / 权衡）——
 *      这一条说明用户在**权衡**，而不是顺口提了一个名词；
 *   ③ 句子里有温度读数（℃/度）或计量单位，**或者**是"说不清参数的现场自述"
 *      （`isVagueScenario`）—— 这一条说明它**与一处真实工况有关**。
 *
 * ⚠ 为什么必须 ②：反向变异 ③ 的实测句「我这儿有个 320℃ 的窑炉烟气，流量 1.2 万标方每小时，
 *   想发电，烟囱是现成的」只满足 ① 和 ③ —— 绝不能因为出现"烟囱"二字就把整句降级。
 * ⚠ 为什么③要收窄：纯知识问题（「酸露点的定义是什么」）不满足 ③ ⇒ 照旧走知识问答。
 * ⚠ 本判据**不参与任何数字判定**：它只决定"回答里要不要加后两段"，不放宽也不收紧任何闸门。
 *
 * @param {string} text 用户本轮原话
 * @returns {boolean}
 */
export function isOutOfScopePartial(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (!(OUT_OF_SCOPE_HINT.test(t) || OUT_OF_SCOPE_MARKER.test(t))) return false;   /* ① */
  if (!(TRADEOFF_INTENT.test(t) || TRADEOFF_CLAUSE.test(t))) return false;         /* ② */
  if (!(DECIDE_MARKERS.test(t) || isVagueScenario(t))) return false;               /* ③ */
  return true;
}

/**
 * 分半回答里要"照常问"的缺口（`missingKeyParams` 的同一套字段名与顺序）。
 *
 * ⚠ 为什么不直接把用户原话丢进 `resolveSceneNL` 去问：那个函数的判据是"**你给没给我这个入参**"，
 *   不是"**你的话里有没有这个数**"。用户说的是「烟气温度降到了 120℃」——那是**烟囱侧的排烟温度**
 *   （一个我们明确说"不是引擎输入变量"的量），引擎该照旧问它"**热源**温度是多少"。
 *   所以这里的口径与引擎一致：**只有温度与流量两个必填项**，二者都还没落成入参 ⇒ 都要问。
 * ⚠ 它只产出**字段名**，不产出任何值 —— 与 `renderGuidance` 同款：先验/文义推断都不进这一段。
 * @param {string} text 用户本轮原话
 * @returns {string[]} MISSING_PRIORITY 顺序的子集
 */
export function missingForPartial(text) {
  void text;   /* 判据与用户原话无关（见上面那段"为什么"）—— 参数留着是为了调用点读起来清楚 */
  return ["温度", "流量"];   /* 两个必填项：分半回答里都还没落成入参 */
}

/* 缺口优先级（**一次只问前 1~2 个**）。理由逐条写在下面，不是拍脑袋： */
export const MISSING_PRIORITY = ["温度", "流量", "载体", "需求"];
export const MISSING_REASONS = {
  温度: "引擎的**必填**入参里，温度是第一位的：它直接决定哪些路径还在候选里（150℃ 的排烟与 450℃ 的池窑烟气根本不是同一批技术路线）。没有它，引擎连「算不了」都说不清；而且现场的人对温度往往最有感觉（「挺烫的」），最容易答。",
  流量: "第二个**必填**入参：温度定「能不能用某种路线」，流量定「规模够不够、经不经济」。两者缺一个引擎都拒绝 —— **它不会替你假设一个流量**。",
  载体: "引擎有默认值（按「烟气」假设），但换错载体结论会变（同温度下「热水·冷凝水」与「烟气」的可回收热算法不同）。所以它排在两个必填项之后：先把算得出来的补齐，再纠正假设。",
  需求: "引擎会默认按「发电」假设，而用途（发电/产汽/供暖/供冷/干燥/储热）是路线分岔口。同样排在必填项之后。",
};

/**
 * 本轮**缺哪几个**关键参数（顺序 = MISSING_PRIORITY）。
 *
 * ⚠ 「缺」的判据与 `resolveSceneNL` 的报错**同源**（就是它 push 的那两条 missing 文案），
 *   所以不会出现"闸说缺流量、引导却说齐了"这种两套说法。
 * @param {{frame:object|null, errors:string[]}} rs resolveSceneNL 的返回值
 * @returns {string[]}
 */
export function missingKeyParams(rs) {
  const errs = (rs && rs.errors) || [];
  const missing = [];
  for (const e of errs) {
    if (/没听出热源温度|温度.*缺失/.test(e)) missing.push("温度");
    if (/没听出热源流量|流量.*缺失/.test(e)) missing.push("流量");
  }
  return MISSING_PRIORITY.filter((p) => missing.includes(p));
}

/**
 * 引导轮的 chips（G5）。
 *
 * 🔴 与 N4 同一条纪律：**只在用户明确点选时才生效**，且点下去发出去的那句话里
 *    **必须逐字带上 chip 上那个数** —— 因为"点选"在法律上就是用户自己说出了这个值；
 *    发出去的句子会被闸 A 按"本轮原话"核对（走的是既有的 `numberTraceableInUserText`）。
 * 🔴 先验区间里的**其它值**（例如区间的上沿 400）一个都不许出现在 followup 里 ——
 *    否则"点一次"等于把整个区间都授权了。自检第 ⑱ 节对此有专门断言。
 *
 * @param {object} shape   Prior.guessShape 的结果（可为 null）
 * @param {string[]} missing 本轮缺的参数（MISSING_PRIORITY 顺序）
 * @returns {Array<{id,text,followup,hint}>}
 */
export function guidanceChips(shape, missing, opts = {}) {
  const out = [];
  /* ⚠ 硬条件：**用户本轮没说温度**时才推预设。
     实测踩到（第 ⑬ 节）：「200℃ 的热水应该用于什么」——用户已经明确说了 200℃，
     而形态判定把他读成"数据中心冷却水回水"（预设 70℃），于是 chip 变成了
     「按工况库预设先算一遍（70℃…）」——**听起来像在拿 70℃ 覆盖他说的 200℃**，非常糟。
     所以：只要本轮原话里有温度读数，这条 chip 就不给（不能拿一个先验去顶用户已经说过的数）。 */
  const hasReading = HAS_READING.test(String(opts.text || ""));
  if (shape && shape.main && !hasReading) {
    /* 发出去的话里逐字带参数：温度用**工况库那一行的值**（不取区间上沿），流量同理。
       两者都逐字出现在句子里 ⇒ 它们能通过闸 A 的"本轮原话"判定，来源标「用户点选」。 */
    const followup = "按工况库预设先算一遍：" + shape.main.name + " " + shape.main.t + "℃ " +
      shape.main.flow + " kg/s " + (/热水|水|渣/.test(shape.main.medium) ? "热水/冷凝水" : "烟气") + " 发电";
    out.push({
      id: "use-preset",
      text: "按工况库预设先算一遍（" + shape.main.t + "℃ / " + shape.main.flow + " kg/s / 发电）",
      followup,
      hint: "点了才算**你给的**值：" + shape.main.t + "℃ 与 " + shape.main.flow + " kg/s 写在发出去的那句话里，" +
        "对得上来源（" + shape.main.cite + "）才准用。你没点之前，这两个数一个都不会进引擎 —— " +
        "先验区间的另一头（比如 300~400 里的 400）也**不会**被顺带带上。",
    });
  }
  /* 第二个出口：这个温区有什么边界 —— **静态知识**，不依赖本轮有没有算出结论，
     所以引导轮给它是成立的（"缺参数的时候用户更需要知道边界在哪"）。
     ⚠ 它的 followup 不是路由文案而是真话，路由靠关键词 "边界" 接住。 */
  out.push({
    id: "boundary",
    text: "这个温区有什么边界要注意",
    followup: "温度包络与边界有哪些",
    hint: null,
  });
  return out;
}

/**
 * 引导轮的正文（Markdown）。**这就是用户看到的那段话**，逐条可核对：
 *   · 听懂了什么（哪一类热源，以及"这是按最接近的一类读的"）；
 *   · 缺什么、每个缺口的候选区间/参照值 + 依据；
 *   · **每一行都标明"这是先验猜测、待你确认，确认后才按你说的算"**（不许藏在折叠里）。
 * 🔴 这里出现的数字**只是问题的一部分**（先验），不进任何入参。
 * @param {object} g { priors, missing, intro, note, defaults }
 * @returns {{markdown:string, cites:Array}}
 */
export function renderGuidance(g) {
  const priors = g.priors || [];
  const L = [];
  L.push("### 我先确认 " + priors.length + " 件事，就不用你翻参数表了");
  if (g.intro) L.push("", g.intro);
  L.push("");
  priors.forEach((p, i) => {
    /* ⚠ `asks` 自己带 `**…**`，外面**不再**套一层 —— 套了会渲染出嵌套星号
       （实测：`**1. **大概多少度？** …**` 原样漏出星号）。 */
    L.push((i + 1) + ". " + p.asks);
    /* 🔴 F3：这里**不再**在正文里印「　依据：…」。
       那些出处本来就已经在 `cites` 里（见本函数末尾，`what: p.param + " 的先验依据"`），
       正文里再印一遍等于把内部行号摊在正文上 —— 用户报的就是这个形态。
       数字一个没动（这些先验值只在正文，不进引擎）。 */
    L.push("");
  });
  if (g.defaults && g.defaults.length) {
    L.push("另外，" + g.defaults.join("、") + " 你要是没说，我按平台默认值算（会在" +
      "「已解析出的场景」里逐条标出每个数是怎么来的，不混进你说的数里）。");
    L.push("");
  }
  if (g.note) { L.push(g.note); L.push(""); }
  L.push("⚠ **上面这些区间/参照值都是我的先验猜测，不是结论**：它们只用来帮你把参数说出口，" +
    "**在你确认（或改成你自己的数）之前，我一个数都不会拿去算**。" +
    "你说了数之后，引擎才动，而且那时候用的**全是你说出来的数**。");
  const cites = [];
  for (const p of priors) for (const c of (p.cites || [])) cites.push({ what: p.param + " 的先验依据", where: c, kind: "prior" });
  return { markdown: L.join("\n"), cites };
}

/* 「点选工况库预设」那条 followup 的固定前缀（`guidanceChips` 生成、`detectPresetPick` 认它）。
   ⚠ 只认这一条前缀：用户**手打**相同内容也走同一条路（那本来就是他明确给了这些数），
     而"系统自己悄悄塞进去"是不可能的 —— 这个函数只读**用户本轮原话**。 */
const PICK_PREFIX = /^\s*按工况库预设先算一遍[：:]/;

/** 识别"用户本轮原话 = 点选工况库预设"的那句话（见 runTurn 里的三道保险）。 */
export function detectPresetPick(text) {
  const t = String(text || "");
  if (!PICK_PREFIX.test(t)) return null;
  const shape = Prior.guessShape(t);
  if (!shape || !shape.main) return null;
  const m = shape.main;
  /* 🔴 三道保险之一：两个数都必须在**本轮原话**里逐字找得到 */
  if (!numberTraceableInUserText(m.t, t)) return null;
  if (!numberTraceableInUserText(m.flow, t)) return null;
  const medium = /热水/.test(m.medium) ? "热水/冷凝水" : (/渣|熔盐|工艺液|油|物料/.test(m.medium) ? "工艺液体" : "烟气");
  return {
    shape,
    raw: {
      tempC: m.t, tempQuote: null, tempOp: null,
      flowValue: m.flow, flowUnit: "kg/s", flowQuote: null, flowOp: null,
      medium, demand: m.demand || "发电",
      hours: num(m.hours), hoursQuote: null, hoursOp: null,
      dT: null, dTQuote: null, dTOp: null,
      continuity: VALID.continuity.includes(m.continuity) ? m.continuity : null,
      pickedFrom: { line: m.line, name: m.name, cite: m.cite },
    },
  };
}

/**
 * **引导段**：缺参数时，先问、不拒答。
 *
 * 事件序列（都是既有事件类型，前端不用改结构；G4 只需保证"先验标注"不被折叠）：
 *   step（听懂了什么 + 为什么只问这几个）
 *   answer（引导正文，mode="guidance"）
 *   next（chips：点选即等于用户给了值 —— 见 guidanceChips）
 *   detail（解析明细，让用户看到"哪些字段已经拿到、哪些还缺"）
 *   turn_saved（**本轮也记进会话** —— 下一轮要靠"上一轮原话"接住用户答的那个数，
 *               见 `prevScopeText()`：它把 `prev.userText` 算进可引用范围，
 *               所以"350 左右吧"下一轮说"10 万标方"时，350 仍可被逐字照抄引用）
 *
 * 🔴 本轮**不调引擎**：没有 plan / ledger / certificate / engineRaw 事件，
 *    也没有 verify（没有引擎语料可查）。这正是"先验不出数"的可见证据。
 */
async function* guidanceStage({ text, sess, rs, missing, llmOn, t0, step }) {
  const S = (phase, txt, state) => ({ type: "step", phase, text: txt, state: state || "ok", at: Date.now() - t0 });

  /* 优先级：一次只问最关键的 1~2 个（理由在 MISSING_REASONS，界面上也逐条说出来） */
  const ask = missing.slice(0, 2);
  const prevTurn = Session.lastTurn(sess.id);
  /* ⚠ 形态判定要看**最近几轮的原话**：本轮说"350 左右吧"时自己不含任何热源词，
     但上一轮那句"我们这台窑，烟气挺烫的"已经认出来了。只看本轮 ⇒ 先验会退化成"只问、不给"
     （实测踩到：第 2 轮问气量时参照值整段消失）。`guessShapeMulti` 找不到还是返回 null，
     调用方就走 `blindAsk`（只问、不给），**绝不用一个"差不多的"行硬凑**。 */
  const recent = (Session.getSession(sess.id)?.turns || []).slice(-3).map((t) => ({ userText: t.userText }));
  const shape = Prior.guessShapeMulti(text, recent);
  /* ⚠ 形态若来自上一轮，先验也要拿**那一轮的原话**去查（否则本轮"350 左右吧"查不到任何热源类，
     表现为"参照值整段消失"）。 */
  const priors = Prior.priorForParams(text, ask, shape && shape.fromEarlierTurn ? shape.fromText : null);
  /* 查不到出处 ⇒ 退化成"只问、不给"（`blindAsk` 的 asks 里既没区间也没典型值）。
     ⚠ 判据按**内容**而不是按"有没有 shape"：shape 来自上一轮时，本轮的 priorForParams 仍是空的。 */
  const shown = priors.map((p, i) => {
    const lackVal = (p.param === "温度" || p.param === "流量") && p.range == null && p.typical == null;
    if (!lackVal) return p;
    return { ...Prior.blindAsk(p.param), cites: shape ? (priors[i] && priors[i].cites) || [] : [] };
  });
  /* “先验查不到出处”这一事实要在界面上说出来，不能默默少给一段 */
  const blinded = shown.filter((p) => p.blind).map((p) => p.param);

  /* ⚠ "已经拿到"只列**数值入参**（用户给的、或由上文派生的）——不把平台/引擎默认值算成"听懂了"，
     否则用户会以为那些默认值也经过了确认（实测第一版就是这么写的，读了像在自夸）。
     ⚠ 本轮 `rs.log` 里往往只有"缺口前面的那些字段"（温度缺 ⇒ 它后面的字段还没 push），
       所以还要把**上一轮已经落盘的那些**（`prev.inputLog`）算进"已经拿到" ——
       这正是"多轮补齐"在界面上看得见的形态。 */
  const heard = [];
  const pushHeard = (field, value, source) => {
    if (value == null || typeof value !== "number") return;
    if (/默认/.test(String(source || ""))) return;
    if (heard.some((x) => x.indexOf(field + " = ") === 0)) return;
    heard.push(field + " = " + value);
  };
  for (const l of ((prevTurn && prevTurn.inputLog) || [])) pushHeard(l.field, l.value, l.source);
  if (rs && rs.log) for (const l of rs.log) pushHeard(l.field, l.value, l.source);
  /* 还缺但本轮不细问的参数（载体/需求）如实点名，并说清"没说就按平台默认算" */
  const restMissing = missing.slice(2);
  const intro = "**我听懂的部分**：" +
    (shape ? "像是一处**" + shape.main.industry + "**的余热（工况库里最接近的是「" + shape.main.name + "」" +
      (shape.fromEarlierTurn ? "，这是从你**上一轮**那句话读出来的" : "") + "）" : "像是一处余热工况") +
    "。" + (heard.length ? "已经拿到并已按你的原话逐字核对：" + heard.join("、") + "。" : "不过数值参数还没给全。") +
    "缺的这些缺了就算不了（引擎不会替你假设），所以先问清楚再算。" +
    (blinded.length ? "⚠ **" + blinded.join("、") + " 这一条我查不到可引用的出处，所以不给区间、也不给典型值** —— 宁可不给，不许编。" : "");

  yield S("guide", "缺 " + missing.length + " 个关键参数（" + missing.join("、") + "）。" +
    "**不问完不算** —— 但也不是把你挡回去：我给出同类工况的量级作参照，你确认或改一个数即可。", "warn");
  for (let i = 0; i < shown.length; i++) {
    const p = shown[i];
    yield S("guide", "要问的第 " + (i + 1) + " 个缺口：**" + p.param + "**。" + (MISSING_REASONS[p.param] || ""), "run");
    yield S("guide", "先验（**只是问题的一部分，不是结论**）：" + String(p.asks || "").replace(/\*\*/g, ""), "ok");
  }
  yield S("guide", "⚠ 上面这些区间/参照值**不会**进引擎：它们只用来帮你把参数说出口。" +
    "你说了数之后，来源是**你说的**（或你点选的那一下），走的是原来那条入参闸。", "warn");

  const g = renderGuidance({
    priors: shown, missing: ask, intro,
    defaults: restMissing.length ? restMissing : null,
    note: null,
  });
  const answerEv = answerEvent(g.markdown, "guidance", g.cites);
  const answer = answerEv.markdown;
  /* ⚠ 自检口径与 N2 一致：正文里不许出现文件名/路径/行号。
     先验的出处（含 docs 路径与行号）**只**出现在 citations 折叠区，
     正文里说的是"工况库第 4 行"这种人话。这里断言一次，免得文案改动时悄悄漏出去。 */
  if (!isBodyClean(answer)) {
    yield S("guide", "内部提示：引导正文里检出了内部标识（" + bodyIdentifiers(answer).map((x) => x.match).join("、") +
      "）—— 已改为只给结论、出处放折叠区", "warn");
  }
  yield answerEv;
  yield { type: "next", chips: guidanceChips(shape, ask, { text }) };
  yield {
    type: "detail",
    parse: { raw: (rs && rs.rawJson) || null, log: (rs && rs.log) || [] },
    ledger: [], certificate: null, engineRaw: null,
    guidance: {
      missing: ask, allMissing: missing,
      priors: shown.map((p) => ({ param: p.param, range: p.range, typical: p.typical, cites: p.cites, blind: !!p.blind })),
      reason: MISSING_REASONS,
      engineCalled: false,
    },
  };
  /* 🔴 本轮**照样记进会话**（没有 scene、没有引擎数字）。
     下一轮接的是"上一轮用户原话"（`prevScopeText()` 的第一段），
     所以用户答的那个数在下一轮仍能被逐字照抄引用 —— 走的还是既有那条通道。
     本轮 scene=null ⇒ 续问兜底的 `carry()` 没有基准可用，**不可能**从引导轮"继承"出任何值。 */
  Session.appendTurn(sess.id, {
    userText: text, scene: null, engine: null, certificate: null, answer,
    ledger: [], engineNumbers: [], inputNumbers: [], inputLog: (rs && rs.log) || [],
    degraded: !llmOn, guidance: true,
  });
  yield { type: "turn_saved", sessionId: sess.id, turns: Session.getSession(sess.id).turns.length };
}

/* ================================================== G6：分半回答的正文与 chips
 *
 * 回答形态**必须同时有三段**（缺一不算通过）：
 *   ① 能算的那半 —— 说清"回收路径与回收量我能算"，并**照常问缺的参数**（气量等）；
 *   ② 不能算的那半 —— **点名**是哪些、并**说清为什么**；
 *   ③ 我能帮什么 —— 例如"两个温度下各自的方案与回收量都算给你"，并给**可点的下一步**。
 *
 * 🔴 ②里**一个数都不许有**（连"约"都不行）。实现上这条是**构造性**的：
 *    `renderOutOfScopePartial()` 里没有任何插值，正文中的数字只来自
 *    `userTempsOf()`（**用户原话里的温度字面量照抄**）与 `missingKeyParams()`（字段名）。
 *    它不调引擎、没有 ledger、没有 verify 语料 ⇒ 想编也没有数可编。
 */

/** 用户原话里的**温度字面量**（原样，最多 2 个，去重）。
 *  ⚠ 与 `tempLiteralOf` 同源同纪律：**只用于"下一步建议"的措辞**，绝不进任何引擎入参。 */
export function userTempsOf(text) {
  const t = toHalfWidth(String(text || ""));
  const m = t.match(/(\d+(?:\.\d+)?)\s*(?:℃|°C|度)/g) || [];
  const out = [];
  for (const s of m) {
    const v = (s.match(/\d+(?:\.\d+)?/) || [])[0];
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= 2) break;
  }
  return out;
}

/**
 * 「能算的那半」要问的缺口的措辞。
 * ⚠ 与 `renderGuidance` 同一条红线：这里只**提问**，不给任何参照值 ——
 *   全篇没有一个"先验区间"，所以不存在"先验混进引擎"的可能。
 */
function outOfScopeAsks(missing, temps) {
  const asks = [];
  const has = (p) => (missing || []).includes(p);
  if (has("温度")) asks.push("热源温度是多少度");
  if (has("流量")) asks.push("热源流量是多少（kg/s 或 t/h；标方每小时也可以，请连温度一起说明）");
  if (has("载体")) asks.push("载体是什么（烟气 / 热水·冷凝水 / 工艺液体）");
  if (has("需求")) asks.push("这股热你想用来做什么（发电 / 工艺蒸汽 / 供暖·热水 / 储热调峰 / 供冷 / 干燥）");
  if (!asks.length) asks.push("载体与用途（没说我就按「烟气 + 发电」这两个平台默认值算，并在解析明细里逐条标出来）");
  return asks;
}

/**
 * 分半回答的正文（Markdown）。
 *
 * @param {object} a { text, missing, hits }
 *   a.text    用户本轮原话（**只用来照抄温度字面量**）
 *   a.missing `missingKeyParams()` 的结果
 *   a.hits    `outOfScopeHits()` 的结果（点名用）
 * @returns {{markdown:string, cites:Array}}
 */
export function renderOutOfScopePartial(a) {
  const hits = a.hits || [];
  const missing = a.missing || [];
  const temps = userTempsOf(a.text);
  const L = [];

  L.push("这句话里，有一半我能算，另一半我算不了。我按两半分着答，不混在一起。");

  /* ① 能算的那半 */
  L.push("");
  L.push("一、能算的那半：余热的回收路径与回收量");
  L.push("");
  L.push("你给我一处热源（热源温度、载体、流量，以及想拿来做什么），我就能给出回收路径的排序、" +
    "可回收热功率，以及哪些路径进不了候选、为什么。这一段是引擎真算的，不是我口头讲口径。");
  L.push("");
  L.push("要把这半算出来，我还缺：");
  for (const q of outOfScopeAsks(missing, temps)) L.push("- " + q);

  /* ② 不能算的那半（点名 + 说清为什么 + 一个数都没有） */
  L.push("");
  L.push("二、不能算的那半：这些量不在我的引擎里");
  L.push("");
  if (hits.length) {
    for (const h of hits) {
      L.push("- " + h.name + "（" + h.kind + "）—— **算不了**：" + h.why + "。");
    }
  } else {
    L.push("- 你这句里点到的那类关注点（烟道阻力 / 热压 / 酸露点一类）—— **算不了**：我的引擎里没有对应模块。");
  }
  L.push("");
  L.push("所以，凡是需要先知道这些量才能定的问题，我都不会给结论，也不会给数字 —— " +
    "**这半边的任何数值我一个都不给，因为我没有算过它**。");
  L.push("");
  L.push("我能算的边界，说清楚：引擎按 12 条技术路径做筛选与排序，输入是需求、热源温度、载体、" +
    "流量、规模、换热端差、年运行小时、连续性、驱动来源、需求温度，温度包络 25 到 650 度。");

  /* ③ 我能帮什么（可点的下一步在 chips 里，见 outOfScopeChips） */
  L.push("");
  L.push("三、我能帮上的那一步");
  L.push("");
  if (temps.length >= 2) {
    L.push("把 " + temps[0] + " 度与 " + temps[1] + " 度**两个温度下各自的回收方案与回收量**都算给你 —— " +
      "工艺侧怎么权衡（该不该为了提高排烟能力而牺牲回收量）由你在现场定，" +
      "但**两条路上的回收代价**我可以摆出来给你比。");
  } else if (temps.length === 1) {
    L.push("把 " + temps[0] + " 度这个温度下的回收方案与回收量算给你；" +
      "另一个温度你也可以直接说，我按同一个工况再算一遍给你比 —— " +
      "工艺侧怎么权衡由你在现场定，但两条路上的回收代价我可以摆出来。");
  } else {
    L.push("把候选温度下各自的回收方案与回收量分别算给你，供你在工艺侧做完权衡后比较 —— " +
      "工艺侧怎么权衡由你在现场定，但两条路上的回收代价我可以摆出来。");
  }
  L.push("");
  L.push("补一句实话：上面第二条点名的那些量，即使你告诉了我，我也只能把它当作**你给的工艺前提**记下来" +
    "（例如「我按这个温度算」），我不会去核算它本身。");
  L.push("");
  L.push("下面是可直接点的下一步。");

  return { markdown: L.join("\n"), cites: [] };
}

/**
 * 分半回答之后的 chips。
 * ⚠ 与 N4 同一条纪律：**只给系统真能做的**，点下去发出去的那句话必须能被白名单判据接住。
 *   这里给三条，全部 `need:"none"`（本轮什么都没算，不许推依赖结论的动作）：
 *     · scope-ab —— 带参数：把用户原话里的温度字面量**照抄**进 label 与 followup
 *       （不许替用户编温度；一个温度都没说就整条不给）。它**登记在 `NEXT_ACTIONS` 里**，
 *       所以和别的动作一样要过 `nextActionVerdict()` —— 自检对 label 与 followup 都断言。
 *     · goto-decide / boundary —— 直接从 `nextActionsFor()` 取，**同一张表**，不另写一份。
 */
export function outOfScopeChips(text) {
  const out = [];
  const temps = userTempsOf(text);
  const base = nextActionsFor({ intent: "decide", text, tempLit: temps[0] || tempLiteralOf(text), need: "none" });
  /* ① 「两个温度各算一遍」—— 前提是用户**真的说了两个温度**，没说就整条不给（宁少勿假） */
  if (temps.length >= 2) {
    const args = { intent: "decide", text, tempC: null, tempLit: temps[0] };
    const a = NEXT_ACTIONS.find((x) => x.id === "scope-ab");
    const label = a && (typeof a.label === "function" ? a.label(args) : a.label);
    const followup = a && (typeof a.mk === "function" ? a.mk(args) : a.followup);
    if (label && followup) out.push({ id: a.id, text: label, followup, hint: a.honest || null });
  }
  /* ② 复用同一张表里的两条（它们本来就有 `need:"none"`，是"不依赖本轮结论"的动作） */
  for (const id of ["goto-decide", "boundary"]) {
    const c = base.find((x) => x.id === id);
    if (c) out.push({ id: c.id, text: c.text, followup: c.followup, hint: c.hint || null });
  }
  return out.slice(0, 4);
}

/**
 * **分半回答段**（G6）。
 *
 * 事件序列（与前两段同款：都是既有事件类型，前端不用改结构）：
 *   step（为什么判成"有半边算不了"）
 *   answer（三段正文，mode="out_of_scope_partial"）
 *   next（chips，全部在白名单里）
 *   detail（说清"本轮没有调用引擎" + 点名了哪些超范围项）
 *   turn_saved（本轮也记进会话 —— 下一轮用户答的那个数靠"上一轮原话"续得上）
 *
 * 🔴 本轮**不调引擎**：没有 plan / ledger / certificate / engineRaw 事件，也没有 verify
 *    （没有引擎语料可查）。这正是"②里一个数都编不出来"的可见证据。
 */
async function* outOfScopePartialStage({ text, missing, hits, llmOn, sess, t0 }) {
  const S = (phase, txt, state) => ({ type: "step", phase, text: txt, state: state || "ok", at: Date.now() - t0 });
  const names = hits.map((h) => h.name);

  yield S("scope", "这句话里有**我的引擎没有的物理量/关注点**（点名：" + names.join("；") + "）。" +
    "按纪律**分半回答**：能算的那半照常问参数、照常算；不能算的那半**点名 + 说清为什么**，" +
    "并明确说出我给不了它任何数。", "warn");
  yield S("scope", "引擎不覆盖的那些量，我不给任何结论、也不给任何数值（连「约」都不给）—— " +
    "本轮**不会调用决策引擎**，所以也不会有任何引擎数字。", "warn");
  yield S("scope", "能算的那半照常：缺的参数我照样问，你答了之后走的是**原来那条**入参闸（逐字可溯），" +
    "闸门一个字都没放宽。", "ok");

  const g = renderOutOfScopePartial({ text, missing, hits });
  const answerEv = answerEvent(g.markdown, "out_of_scope_partial", g.cites);
  const answer = answerEv.markdown;
  /* ⚠ 与引导轮同款断言：正文里不许出现文件名/路径/行号。这里其实只可能来自文案改动，
     所以断言一次把话说明白 —— 免得以后有人往这段里塞"见 xxx.md"。 */
  if (!isBodyClean(answer)) {
    yield S("scope", "内部提示：分半回答正文里检出了内部标识（" +
      bodyIdentifiers(answer).map((x) => x.match).join("、") + "）—— 已改为只给结论、出处放折叠区", "warn");
  }
  yield answerEv;
  yield { type: "next", chips: outOfScopeChips(text) };
  yield {
    type: "detail",
    parse: { raw: null, log: [] },
    ledger: [], certificate: null, engineRaw: null,
    outOfScopePartial: {
      engineCalled: false,
      outOfScope: hits.map((h) => ({ id: h.id, name: h.name, kind: h.kind, why: h.why, hits: h.hits })),
      missing: missing || [],
      answerParts: 3,
      numbersProduced: 0,
    },
  };
  /* 🔴 本轮**照样记进会话**（没有 scene、没有引擎数字，与引导轮同款隔离）。
     下一轮接的是"上一轮用户原话"（`prevScopeText()` 的第一段），
     所以用户答的那个数在下一轮仍能被逐字照抄引用 —— 走的还是既有那条通道。
     ⚠ `outOfScope: true` 只用来做**一件事**：让紧随其后的那一轮（用户把参数补齐了）
       照常走工况路。见 runTurn 里那条"只分半一次"的纪律。 */
  Session.appendTurn(sess.id, {
    userText: text, scene: null, engine: null, certificate: null, answer,
    ledger: [], engineNumbers: [], inputNumbers: [], inputLog: [],
    degraded: !llmOn, outOfScope: true,
  });
  yield { type: "turn_saved", sessionId: sess.id, turns: Session.getSession(sess.id).turns.length };
}

/**
 * 兜底一律偏保守的那条规则的**补充**：「这一句的意图，规则已经足够确定，不必再问模型」。
 *
 * ⚠ 这个判据**不参与任何数字判定**，也**不放宽任何闸门**：
 *   它只决定"要不要发一次 classify 请求"。判错了最坏是"少问模型一次"，
 *   而且接下去走的仍是 routeIntent() 给出的那条路（与兜底完全同一条）。
 *   所以白名单刻意收得极窄，只认两种最没有歧义的形态：
 *     ① 纯寒暄（「你好」）—— 整句就是一句问候/道谢；
 *     ② 项目概况（「介绍一下这个项目」）—— 命中具名形态，且不含任何**具体口径词**
 *        （isProjectOverviewQuestion 自带排他表）。
 *   **有上文时一律不短路** —— 续问（「那…呢」）的语义规则判不准，必须交给模型。
 *   其余一切（所有工况句、所有口径问题）照旧调模型。
 *
 * @param {string} text 用户本轮原话
 * @param {object|null} prev 上一轮
 * @returns {boolean}
 */
export function isRuleCertainIntent(text, prev) {
  const t = String(text || "").trim();
  if (!t || prev) return false;
  if (isPureSmallTalk(t)) return true;
  if (isProjectOverviewQuestion(t)) return true;
  return false;
}

/* ============================================================== 小工具 */

const finite = (v) => typeof v === "number" && isFinite(v);
const num = (v) => { const n = Number(v); return (v === null || v === undefined || v === "" || !isFinite(n)) ? null : n; };
const fmt = (v) => (typeof v === "number" && isFinite(v)) ? String(v) : (v == null ? "—" : String(v));

/** 抽取一串数字 token（已折半角、去千分位） */
export function numbersOf(text) { return extractNumbers(text); }

/* ==================================================== N2：正文卫生（2026-10-12 加）
 *
 * 用户意见原文：「回答的很乱，就是全部报上来的都是那种文件名称、文件位置之类的，很凌乱」。
 *
 * 所以定了一条**可判定的**规矩，分成两半，各管一件事：
 *   · **正文**（气泡里用户直接看到的那部分）**不许出现**文件名 / 路径 / 行号 / 内部标识
 *     （`content/xxx.json`、`src/engine/decision_core.js:338`、`items[58]`、`runDecision()`…）；
 *   · **出处照旧保留**，但降级到回答下面的「出处」折叠区（`sources` 事件字段），
 *     以及明细区（`detail.parse.log` / `detail.ledger`）。证据一个都没丢，只是不再塞在正文里。
 *
 * ⚠ 判据必须**可执行**，不能靠"读一眼觉得干净"。下面两个函数就是判据本体：
 *   bodyIdentifiers(text) → 命中的内部标识清单（空 = 干净）
 *   assertBodyClean(...)  → 自检/服务端共用的同一把尺
 *
 * 判据的漏检面（如实写在这里，别假装它万能）：
 *   · 它只认"形态"（扩展名/盘符/斜杠/行号/固定内部串），认不出"没有扩展名的内部代号"；
 *   · 行内代码 `` ` `` 里的内容**也照样要干净** —— 因为用户看到的正文里它就是"文件名"。
 */

/* ① 扩展名形态：.js / .md / .json / .html / .py / .css …（后接非字母即算边界）
 *    ⚠ 这是**必需的**兜底：Windows 绝对路径里的目录名可能带空格（"时代杯项目材料"），
 *      光靠"盘符+路径"那条正则治不了它（实测漏过一次）。 */
const BAD_EXT = /\.[a-z]{2,4}(?![a-z0-9])/i;
/* ② 路径形态（三种，分开写，避免误杀自然语言里的斜杠）：
 *      ②a Windows 盘符（`C:\`、`D:/`）；
 *      ②b 项目里真实存在的目录前缀（`docs/`、`content/`…）后面跟着东西 —— 这是**确定性**的白名单，
 *          比"任何两个标识串中间夹斜杠"精准得多；
 *      ②c 带扩展名的文件名（斜杠前有目录）。
 *    ⚠ 刻意**不**写成"任意 `x/y`"：正文里 "投资万元/MW装机"、"P5/P50"、"9/9" 都不是路径
 *      （2026-10-12 实测，前者被旧规则误杀过）。 */
const BAD_PATH_WIN = /[A-Za-z]:[\\/]/;
const PROJECT_DIRS = "docs|content|src|tools|tests|public|dist|legacy|engine|views";
/* ⚠ 这里踩过一个安静的坑，写下来免得再犯：目录前缀正则只能定义**一处**。
 *   我原先在两处各写了一遍，其中一处把 JS 字符串写成了 `"\\\\/"` —— 那得到的是
 *   `\\/`（正则里的"反斜杠后跟斜杠"），于是 `content/boundaries.json` 一个都匹配不到，
 *   而**另一处写对了**，表现为"检测说它不干净、降级又说它已经删掉了"这种自相矛盾。
 *   现在两处都用这一个常量。（右斜杠在项目里就是 `/`；Windows 的 `\` 由 BAD_PATH_WIN 管。） */
const REL_DIR_RE = new RegExp("(?<![A-Za-z0-9_.])(?:" + PROJECT_DIRS + ")/");
const BAD_PATH_REL = new RegExp(REL_DIR_RE.source + "[A-Za-z0-9_.\\-\\u4e00-\\u9fff]+|" +
  "(?<![A-Za-z0-9_.])[A-Za-z0-9_\\-\\u4e00-\\u9fff]+/[A-Za-z0-9_\\-\\u4e00-\\u9fff]+\\.[A-Za-z0-9_\\-\\u4e00-\\u9fff]+");
/* ③ 行号形态：标识符 + `:数字`（`…快照.md:839`、`decision_core.js:338`）。
 *    ⚠ 前面**不能是数字**，否则 "14:30" 这种时间会被误杀（用户正文里允许出现时间）。
 *    🔴 2026-10-12 收紧（F2 连带修出来的）：标识符那一段**必须含 ASCII 字母/数字/下划线**。
 *       否则「该工况可回收热功率：31500」这种"**中文标签：数字**"的正常正文会被误判成行号，
 *       而 stripInternalRefs 规则 ② 对行号是"删掉 `标识:`、把数字留下" ⇒ **会把标签整个删掉**。
 *       原来它没暴露，是因为模型写的标签带 `**…**`（`*` 不在标识符字符类里，挡住了匹配）；
 *       F2 把 `**` 剥掉之后这层遮挡没了，实测踩到（e2e ⑬b 复现：命中"行号"=「可回收热功率：31500」）。
 *       真引用在本项目里一定带 ASCII（`docs/…快照.md:839`、`decision_core.js:338`、`items[3]:12`），
 *       所以这条收紧**不会**放过真引用 —— 它只排除"纯中文标签 + 冒号 + 数字"这一种误报。
 *       两条前瞻：①标识符以非数字开头（保住 "14:30" 不被误杀）；②标识符里至少有一个 ASCII 字符。
 *    ⚠ 这里刻意做成**单一来源**：检测用 BAD_LINENO、替换用 LINENO_RE，两者由同一组片段拼出来。
 *       之前 stripInternalRefs 里另写了一份**未收紧的副本**（就是它把「可回收热功率：31500」
 *       的标签删成了 "31500"）—— 两份判据漂移是本项目反复踩的坑，所以这里只留一份。
 */
const LINENO_ID = "[A-Za-z_\\u4e00-\\u9fff][A-Za-z0-9_\\u4e00-\\u9fff]*";
const LINENO_LOOKAHEADS =
  "(?=" + LINENO_ID + "[:：])" +
  "(?=[A-Za-z0-9_\\u4e00-\\u9fff]*[A-Za-z0-9_][A-Za-z0-9_\\u4e00-\\u9fff]*[:：])";
const BAD_LINENO = new RegExp(LINENO_LOOKAHEADS + LINENO_ID + "[:：]\\d{1,5}(?![0-9])");
/** 替换用：$1 = 标识符，$2 = 行号数字（数字要留下，它是闸 B 的语料） */
const LINENO_RE = new RegExp(LINENO_LOOKAHEADS + "(" + LINENO_ID + ")[:：](\\d{1,5})(?![0-9])", "g");
/* ④ 内部标识串：引擎函数/字段名、json 条目下标、手册正文名。
 *    ⚠ 刻意**不**把"任意行内代码"整段算成内部标识 —— 行内代码在本项目里主要用来
 *      框住**数字**（`` `1326.6099` ``），那些数字是正文的合法内容，不该被判违规。
 *    ⚠ 「数据来源台账」刻意**不**入此表：它在本项目里是**对外数字的正式名字**，
 *      正文里说"登记在《数据来源台账》§四"是正常说法，不是内部路径。 */
const BAD_INTERNAL = /(decision_core|decisionCertificate|runDecision|recoveredHeatKw|validateScene|frameToScene|normalizeFrame|WHENG|HFDATA|boundaries\.json|items\[\d+\]|对外数字台账|引用台账|知识手册_正文|知识手册|\.js\b|\.md\b|\.json\b|\.html\b)/i;

/** 正文里**不许出现**的内部标识清单（返回空数组 = 干净）。给自检与服务端共用。 */
export function bodyIdentifiers(text) {
  const s = String(text == null ? "" : text);
  const hits = [];
  const push = (why, m) => { if (m && m.length) hits.push({ why, match: String(m[0]) }); };
  push("扩展名", s.match(new RegExp(BAD_EXT.source, "i")));
  push("路径(盘符)", s.match(new RegExp(BAD_PATH_WIN.source, "g")));
  push("路径(相对)", s.match(new RegExp(BAD_PATH_REL.source, "gi")));
  push("行号", s.match(new RegExp(BAD_LINENO.source, "g")));
  push("内部标识", s.match(new RegExp(BAD_INTERNAL.source, "gi")));
  /* 去重（同一个串可能被多条规则命中） */
  const seen = new Set();
  return hits.filter((h) => { const k = h.why + "|" + h.match; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** 正文是否干净（`bodyIdentifiers` 为空） */
export function isBodyClean(text) { return bodyIdentifiers(text).length === 0; }

/**
 * 把内部标识从**给人看的那一句**里降级掉（正文卫生的"改写"那一半）。
 * 处理顺序很重要（踩过）：
 *   ① 行内代码：装**数字**的留下（只去掉反引号），装**标识**的整段删掉；
 *   ② 行号：`标识:数字` 只删 `标识:部分`、**把数字留下**（数字是闸 B 的语料，动了自相矛盾）；
 *   ③ 盘符路径 → 整段删；项目目录前缀（`docs/`…）→ 只删前缀，保留后面那截；
 *   ④ 残留的 `xxx.ext` 文件名 → 删掉；
 *   ⑤ 裸内部名（validateScene / decision_core…）→ 换成人话「引擎」。
 * ⚠ 硬约束：**不许凭空产生数字**；被删掉的路径里夹带的数字（`…v4_20261011_快照.md:839`）
 *   会随路径一起消失 —— 这是对的，因为那一整串本来就只是出处。
 */
export function stripInternalRefs(s) {
  let t = String(s == null ? "" : s);
  /* ① 行内代码：装数字的留下（只脱掉反引号），装标识/路径的整段删掉 */
  t = t.replace(/`([^`]*)`/g, (m, inner) =>
    (/[0-9]/.test(inner) && !BAD_INTERNAL.test(inner) && !BAD_EXT.test(inner) && !BAD_PATH_REL.test(inner)) ? inner : "");
  /* ② 已知的长文件名先整串删（顺序重要：它带着 `_v4_20261011_` 这种数字段，
        先删掉才不会在下一步被"行号抽取"切出半截来） */
  t = t.replace(/知识手册_正文_v4_\d+_快照/g, "");
  /* ③ 路径：盘符整段删；项目目录前缀只删前缀 */
  t = t.replace(/[A-Za-z]:[\\/][^\s，。；、）)】」]*/g, "");
  t = t.replace(new RegExp(REL_DIR_RE.source, "g"), "");
  /* ④ 残留文件名（`…快照.md` / `方案 v2.docx`）。
        `(?:\.ext)+` 让整条扩展名链一次匹配掉；`(?![A-Za-z0-9_.])` 避免从 `foo.md5` 里切出 `.md`。 */
  t = t.replace(/[A-Za-z0-9_\-\u4e00-\u9fff]+(?:\.(?:js|md|json|html|py|css|txt|yaml|yml|docx|pptx|xlsx))+(?![A-Za-z0-9_.])/gi, "");
  /* ④b 已经掉了主名的裸扩展名残片（`docs/知识手册…快照.md:26` 被切成 `.md:26` 那种形态）。
        要求"点的前面不是别的东西"，所以 `第0.2节` 里的 `.2` 不会被误吃。 */
  t = t.replace(/(?<![A-Za-z0-9_])\.(?:js|md|json|html|py|css|txt|yaml|yml|docx|pptx|xlsx)(?![A-Za-z0-9_])/gi, "");
  /* ⑤ 行号：`标识:数字` → 只删标识与冒号，**数字留下**（数字是闸 B 的语料）
        ⚠ 判据与 BAD_LINENO **同源**（LINENO_RE 由同一组片段拼出）—— 别再单独写一份。 */
  t = t.replace(LINENO_RE, "$2");
  /* ⑥ 裸内部名 → 人话 */
  t = t.replace(/decisionCertificate|runDecision|recoveredHeatKw|decision_core|validateScene|frameToScene|normalizeFrame/gi, "引擎");
  t = t.replace(/WHENG|HFDATA/g, "引擎");
  t = t.replace(/items\[\d+\]/gi, "");
  /* ⑥b 2026-10-13 补：**检测器与净化器不对称** ——
     `BAD_INTERNAL`（上面第 921-923 行）把这三个名字判成违规，但本函数原先**一个都不删**，
     于是 ask 路正文里带着《对外数字台账》《引用台账》《知识手册》就漏出去了
     （换新版手册后触发：新版把这些名字写进了散文。实测 5 个样本里 3 个复现）。
     ⚠ 注意 `数据来源台账` **刻意不在此列** —— 它是本项目对外数字的**正式名字**（见 BAD_INTERNAL 上方注释），
       正文里说"登记在《数据来源台账》§四"是正常说法。
     ⚠ 替换而非删除：这些名字在句子里常作主语/宾语，直接删会留下病句。 */
  t = t.replace(/对外数字台账|引用台账/g, "口径依据");
  t = t.replace(/知识手册_正文_v4_[^\s，。；、）)】」]*/g, "项目文档");
  t = t.replace(/知识手册/g, "项目文档");
  t = t.replace(/【待补台账】/g, "");
  /* 收尾：清掉因删除产生的空括号 / 孤立箭头 / 多余空格（不碰任何数字） */
  t = t.replace(/[（(]\s*[）)]/g, "").replace(/[（(]\s*[；;]\s*/g, "（").replace(/[；;]\s*[）)]/g, "）");
  t = t.replace(/→\s*(?=[，。；、）)】」]|$)/g, "");
  t = t.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+([，。；、）)])/g, "$1");
  return t.trim();
}

/** 断言正文干净；不干净就返回**具体**的命中项（供自检打印，别只说"失败了"） */
export function assertBodyClean(text, label) {
  const ids = bodyIdentifiers(text);
  return { ok: ids.length === 0, label: label || "", hits: ids };
}

/* ============================================== F2：回答正文的"渲染安全"（2026-10-12 加）
 *
 * 用户实测截图报的现象（原话）：
 *   「**Markdown 完全没渲染**：正文里裸露着字面的 `<br>` 标签、`**` 星号、`>` 引用符。
 *     截图里随处可见 `<br>A: 我们做一套…`、`<br>配了可运行的工具…`。⇒ 这是最丢脸的一条
 *     （页面上直接显示 HTML 标签）。」
 *
 * 排查结论（三种可能逐条查过，见回报第二节）：
 *   ① **md.js 没被调用？—— 不是。** app.js:513 对 answer 事件走的就是 `md(ev.markdown)`；
 *      实测把本轮真实回答喂给 md.js，`**` 确实变成了 `<strong>`。这条路没断。
 *   ② **md.js 认不出？—— 对 `<br>` 而言是的。** md.js 的策略是"先转义再拼 HTML"，
 *      `<br>` 被转义成 `&lt;br&gt;` ⇒ 浏览器**原样显示四个字符 `<br>`**。
 *      （这条是设计使然：不转义就等于允许模型注入 HTML，那是更严重的问题。）
 *   ③ **谁把 `<br>` 当换行符用？—— 模型。** 实测 grep（2026-10-12）：
 *      知识手册 / 对外数字台账 / boundaries.json / dialog.mjs 模板里，`<br` 出现 **0 次**
 *      （全目录唯一出现 `<br>` 的地方是 md.js 自己**输出**段落换行那一行）。
 *      而"措辞润色 / 改写"这一跳的提示词**没有禁止 HTML**，模型在重述多行原文时
 *      会用 `<br>` 当换行（这正是截图里 `<br>A: …`、`<br>配了可运行的工具…` 的形态：
 *      那两句原文在手册 §9 里是**两行**，模型把它们压进了一行）。
 *      ⇒ 结论：**② + ③ 同时成立**，根因是"模型产出未经净化就出门"。
 *
 * 修法（**改源头 + 边界净化 + 渲染器兜底**，三层，缺一层都能被绕过）：
 *   · 源头：llm.mjs 的三段提示词显式禁止 Markdown 标记与 HTML 标签（见 POLISH_SYS / COMPOSE_SYS / CHAT_SYS）；
 *   · 边界：`renderSafeAnswer()` 是**所有 answer 事件的唯一出口**（自检会数一遍调用点）——
 *     `<br>` → 真换行；其余标签剥掉；`**` / `##` / 行首 `>` / `|` 这些"没渲染就会露在页面上"
 *     的标记一律降级成纯文字；
 *   · 渲染器：md.js 补一条"`<br>` 当换行"的兜底（万一还有别处漏进来，也不至于显示成标签）。
 *
 * ⚠ 它**只在标记层面做替换，不碰任何数字**，所以闸 B 的结论对它照样成立；
 *   调用点在 verify / stripInternalRefs **之后**，是"最后一道排版"。
 */
export const ANSWER_FORBIDDEN = [
  { what: "HTML 标签", re: /<\/?[a-zA-Z][^>]*>/ },
  { what: "未渲染的加粗标记", re: /\*/ },
  { what: "未渲染的标题标记", re: /^[ \t]{0,3}#{1,6}[ \t]/m },
  { what: "未渲染的引用符", re: /^[ \t]{0,3}>[ \t]?/m },
  /* ⚠ 这里**刻意不列**「表格行（^|）」：md.js 会渲染规范表格，表格不在用户的禁项里
     （禁项只有 <br / </ / ** / ## / 裸 >）。列进来会与 renderSafeAnswer「放行规范表格」自相矛盾。 */
];

/**
 * 正文里"没渲染就会露在页面上"的标记清单（返回空数组 = 干净）。
 * 做法与 `bodyIdentifiers()` 同款：**先给判据，再让自检和服务端共用同一把尺**。
 * @param {string} text 最终回答的 markdown 字段
 * @returns {Array<{what:string, match:string}>}
 */
export function unrenderedMarkers(text) {
  const s = String(text == null ? "" : text);
  const hits = [];
  for (const f of ANSWER_FORBIDDEN) {
    const m = s.match(new RegExp(f.re.source, f.re.flags.includes("m") ? "gm" : "g"));
    if (m && m.length) hits.push({ what: f.what, match: String(m[0]).slice(0, 40) });
  }
  return hits;
}

/**
 * **回答正文的渲染安全化**（所有 answer 事件的唯一出口，见 renderSafeAnswer 的调用点）。
 *
 * 顺序（每一步都对应上面排查到的一种形态）：
 *   ① `<br>` / `</p>` 这类换行标签 → **真换行**（模型拿它当换行符用，那就给它换行）；
 *   ② 其余 HTML 标签 → 整段剥掉（内容留下）；
 *   ③ 已经是"双重转义"形态的 `&lt;br&gt;` → 也换成换行（它是同一种意图的残留）；
 *   ④ Markdown 标记 → 纯文字：标题去掉 `#`、加粗去掉 `**`、行首引用符去掉 `>`；
 *      表格分隔行整行丢掉，单元格的 `|` 换成全角 `｜`（避免页面上露出裸竖线）。
 * ⚠ 不做"约等于"、不改数字、不动单位。
 */
export function renderSafeAnswer(text) {
  let t = String(text == null ? "" : text);
  /* ① / ③ 换行类标签（含被转义过一次的形态）→ 真换行 */
  t = t.replace(/&lt;\s*br\s*\/?\s*&gt;/gi, "\n");
  t = t.replace(/<\s*br\s*\/?\s*>/gi, "\n");
  t = t.replace(/<\s*\/?\s*(p|div|li|tr|h[1-6]|blockquote)\s*>/gi, "\n");
  /* ② 其余标签整段剥掉 */
  t = t.replace(/<\/?[a-zA-Z][^>]*>/g, "");
  /* ④ Markdown 标记降级 */
  t = t.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "");          /* 标题：# 去掉，标题文字留下 */
  t = t.replace(/\*\*([^*\n]+)\*\*/g, "$1");                /* 加粗 */
  t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1$2");  /* 斜体 */
  t = t.replace(/\*/g, "");                                 /* 残留的单个星号（未配对的加粗标记） */
  t = t.replace(/^[ \t]{0,3}>[ \t]?/gm, "");                /* 引用符 */
  /* 表格：**规范表格原样留着** —— md.js 本来就会把它渲染成真表格，
     而用户的禁项只有 `<br` / `</` / `**` / `##` / 裸 `>`，**不含竖线**。
     ⚠ 2026-10-12 修正：原来这里是"分隔行整行丢掉 + 所有 | 换全角"，
       结果把手册「必须记住的三个数字」那张表打成了 `｜ … ｜ … ｜` 的竖线汤
       （overviewStage 是**原样引用**手册的，这一改就破坏了它自己的契约）。
       现在只把**不成表的散竖线**降级，规范表格整块放行。 */
  const isSepLine = (line) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && /-/.test(line);
  {
    const lines = t.split("\n");
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      /* 规范表格 = 本行含 | 且下一行是分隔行 ⇒ 表头 + 分隔行 + 连续数据行整块保留 */
      if (lines[i].includes("|") && i + 1 < lines.length && isSepLine(lines[i + 1])) {
        out.push(lines[i], lines[i + 1]);
        i += 2;
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) { out.push(lines[i]); i++; }
        i--;
        continue;
      }
      /* 孤立的分隔行（没有表头）没有意义 ⇒ 丢掉；其余散竖线降级成全角，别露裸竖线 */
      out.push(isSepLine(lines[i]) ? "" : lines[i].replace(/\|/g, " ｜ "));
    }
    t = out.join("\n");
  }
  /* 收尾：清尾巴空格与多余空行（不碰数字、不碰标点后的内容） */
  t = t.replace(/[ \t]+$/gm, "").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return t;
}

/* ============================================== F2：answer 事件的**唯一出口**（2026-10-12 补）
 *
 * ⚠ 上一轮只把 renderSafeAnswer 接到了 2 个出口（引导轮 :396 / 越界模板 :1693），
 *   而**主决策路径 :1767**、闲聊 :1859/:1897、知识问答 :1942、概况 :2017 全都绕过去了 ——
 *   用户截图里的 `<br>A: …` 正是从主决策路径出来的（模型改写那一跳）。
 *   注释写"唯一出口"而代码有 8 个出口，是最坏的一种谎：自检会照着注释去信。
 *
 * 所以这里不给"记得调用"的机会：**所有 answer 事件一律走 answerEvent()**，
 * 它内部固定做两件事（顺序不能反）：
 *   ① stripInternalRefs —— 内部标识（文件名/行号/items[n]）降级成人话；
 *   ② renderSafeAnswer  —— 渲染安全化（`<br>`→真换行、其余标签剥掉、`**`/`##`/行首`>` 降级）。
 * ⚠ 两步都**不碰数字**，所以闸 B（verifyAnswer）的结论对净化后的正文照样成立。
 */
export function answerEvent(markdown, mode, citations, opts) {
  const keep = (opts && opts.keepNames) || null;
  if (!keep || !keep.length) {
    return { type: "answer", markdown: renderSafeAnswer(stripInternalRefs(markdown)), mode: mode, citations: citations || [] };
  }
  /* ⚠ 极窄的例外口子（目前只有 meta 段用）：把指定串先换成占位符、过完两道净化再还原。
     为什么需要：F1 的第三步内容**就是**「调 WHENG.runDecision() 真算一遍」——
     而 BAD_INTERNAL 会把 `WHENG` 与 `runDecision` 都降级成「引擎」，
     结果是「调 引擎.引擎 真算一遍」这种**坏句子**（实测出现过）。
     ⚠ 这里是**白名单**不是绕过：除了 keepNames 命中的那几个串，其余照旧全过净化。 */
  const ph = [];
  let t = String(markdown == null ? "" : markdown);
  for (const re of keep) {
    t = t.replace(re, (m) => { ph.push(m); return "\u0000K" + (ph.length - 1) + "\u0000"; });
  }
  t = renderSafeAnswer(stripInternalRefs(t));
  t = t.replace(/\u0000K(\d+)\u0000/g, (_, i) => ph[Number(i)]);
  return { type: "answer", markdown: t, mode: mode, citations: citations || [] };
}

/** 所有 answer 出口的清单（自检用：数一遍，少一个就报出来） */
export const ANSWER_EXIT_SITES = [
  "guidance",   /* 引导轮：缺参数先问 */
  "out_of_scope_partial", /* G6：有半边超出能力边界 ⇒ 分半回答（点名 + 不给数） */
  "out_of_scope", /* 引擎明确拒绝 */
  "decide",     /* 主决策路径（模板 / 模型改写） */
  "chat",       /* 闲聊（模型 / 兜底） */
  "chat_fallback",
  "ask_nohit",  /* 知识问答：一条都没检索到 */
  "ask",        /* 知识问答：检索到片段 */
  "handbook",   /* 项目概况快速通道 */
];

/** 文本里是否有「续问」痕迹（用于给 LLM 的提示，不参与闸门判定） */
export function looksLikeContinuation(text) { return CONTINUATION_MARKERS.test(String(text || "")); }

/** 用户原话里那个温度字面量（**原样**，不做任何换算）—— 只为"换个温度再算"这类 chip 取参数。
 *  ⚠ 它只用于**生成建议**，绝不进任何引擎入参与数字闸门。
 *  取"紧挨着 ℃/度 的那个数"；取不到就返回 null ⇒ 那条 chip 干脆不给（不许替用户编数）。 */
export function tempLiteralOf(text) {
  const t = toHalfWidth(String(text || ""));
  const m = t.match(/(\d+(?:\.\d+)?)\s*(?:℃|°C|度)/);
  return m ? m[1] : null;
}

/* ============================================================== 意图三分类（M1） */

/* 三类各自的走向（**这是本文件里最该被看懂的一段**）：
 *   chat   → chatStage()   ：**真调一次普通的 DeepSeek 对话补全**，不碰引擎、不出证书、不显示那串步骤
 *   decide → parseScene → resolveSceneNL → callEngine → verifyAnswer → 模板/改写（**原有链路一字未动**）
 *   ask    → askStage()    ：本地 BM25 检索，答案**必带出处**
 *
 * ⚠ 兜底为什么长这样：LLM 不可用或判定失败时，只能靠关键词。
 *   关键词的唯一职责是**不要把话送错路**，所以顺序是「先认明显的闲聊 → 再认明显的工况 → 其余一律知识问答」。
 *   「其余一律 ask」是刻意的保守选择：知识问答答不出来会**如实说"没检索到"**，
 *   而硬猜成工况会给用户一串莫名其妙的引擎输出，硬猜成闲聊会把真问题挡掉 —— 两种都更糟。
 */

/**
 * 规则兜底：判定「是否**仅仅**是一句寒暄/道谢」。
 * 只要句子里还带了别的内容（问号追问、项目词、工况值），就**不算**纯寒暄。
 */
export function isPureSmallTalk(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (!CHAT_PATTERNS.some((re) => re.test(t))) return false;
  /* 寒暄句里出现项目词 ⇒ 它不是单纯闲聊（例如「谢谢，那年运行小时呢」） */
  if (CORPUS_MARKERS.test(t)) return false;
  return true;
}

/**
 * 规则兜底路由。**只在 LLM 判定不可用时使用。**
 *
 * ⚠ 判定顺序是踩出来的，别随手调（自检里 4 条真实输入被误判过）：
 *   ① 真实工况句里天然带"小时/标方"这类词（「1.2 万**标方**每**小时**」），
 *      所以"工况量"必须先于"项目词表"，否则整句被抢去知识问答；
 *   ② 「你是谁/你能干啥」这类**短的闲聊式问句**又要先于项目词表 ——
 *      否则"平台/能做什么"里的"平台"会把自我介绍也抢去知识问答；
 *   ③ 「那如果流量减半呢？」这种**承接上一轮的追问**，句中一个数都没有
 *      （"流量减半"里"流量"是项目词、"减半"是运算），必须在项目词表**之前**接走，
 *      否则追问会掉进知识问答、断在"没检索到"上。
 *
 * @returns {"chat"|"decide"|"ask"}
 */
export function routeIntent(text, prev) {
  const t = String(text || "").trim();
  if (!t) return "ask";
  /* ① 纯寒暄 ⇒ 闲聊（**必须最先**：否则「你好」会被下面任何一条抢走） */
  if (isPureSmallTalk(t)) return "chat";
  /* ①b **项目概况**（「介绍一下这个项目」这类）⇒ 知识问答（随后走快速通道，N1）。
     ⚠ 必须先于 ④ 的闲聊式问句：「这个项目是做什么的」同时命中 CHAT_QUESTION 的
       「做什么的」形态，不先接走就会被判成闲聊 —— 而闲聊那条路**不许**谈项目事实。
       ⚠ 也必须先于 ⑤ 的项目词表：它的目的是"别掉进检索+润色那条慢路"。
     这里用 require 式的同步判定：rag.mjs 顶部只 import node 内置与 engine_bridge，
     不 import dialog.mjs，所以这条边**不构成循环依赖**。 */
  if (isProjectOverviewQuestion(t)) return "ask";
  /* ② 工况痕迹 = 温度读数或计量单位。**先于**项目词表，避免真实工况句被"小时/标方"抢走 */
  if (DECIDE_MARKERS.test(t)) return "decide";
  /* ②b **G1（2026-10-12 加）：说不清参数的工况自述** ⇒ 也走 decide（随后由引导段接管）。
     ⚠ 为什么必须放在 ⑤ 之前：这类句子里天然带"窑/烟气/余热"这些项目词，
       老版会被 ⑤ 判定成"知识问答"，用户拿到的是一段讲口径的长文（实测就是这么翻车的：
       「我们这台窑，烟气挺烫的，一直没怎么用」被送去 BM25 检索了）。
       ⚠ 它只改"去哪条路"，**不改任何闸门**：走 decide 之后依旧是
         parseScene → resolveSceneNL（闸 A）→ callEngine → verifyAnswer（闸 B），
         只是"缺参数"时由引导段先问一句，而不是甩一个红色报错。 */
  if (isVagueScenario(t)) return "decide";
  /* ③ 承接上一轮工况的追问（有上文 + 有续问痕迹）⇒ 继续算 */
  if (prev && looksLikeContinuation(t)) return "decide";
  /* ④ 短的闲聊式问句（你是谁 / 你能干啥）⇒ 闲聊 */
  if (CHAT_QUESTION.test(t)) return "chat";
  /* ⑤ 问本项目的数字/口径/知识 ⇒ 知识问答 */
  if (CORPUS_MARKERS.test(t)) return "ask";
  /* ⑥ 其余一律知识问答：答不出来会如实说"没检索到"，绝不会硬猜成工况给一串莫名其妙的引擎输出 */
  return "ask";
}

/* ---- 闲聊回答的安全闸门 ----
   为什么要它：闲聊是**最松的一条路**（模型自由发挥），如果不查，它就成了
   "绕过数字闸门"的口子 —— 模型可以凭记忆报一串本项目的数，而那条路没有任何引擎语料可核。
   所以这里做两道与铁律 1 同源的检查：
     ① **不许出现阿拉伯数字**（本项目所有对外数字都是阿拉伯数字形态）；
     ② **不许出现项目内专有名词**（台账/证书/包络/决策引擎/文件行号…）。
   命中即整段作废，改为一句反问「是不是想查项目口径」。 */

/** 闲聊回答里**明令禁止**的项目内专有名词（命中 ⇒ 作废） */
const CHAT_FORBIDDEN = /(决策引擎|决策证书|证书|扰动|翻转|台账|数字来源|引擎返回|运行小时|温度包络|包络|贴近度|可回收热|工况库|换热端差|boundaries|decision_core|hfdoc|\bmd\b|\.js\b|\.json\b|\.md\b|行号|第\s*\d+\s*行)/i;

/** 把要送去判定的文本归一化：去掉代码围栏、URI、纯符号串（避免 https:// 里的数字误杀） */
function stripForChatGate(s) {
  return String(s || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\b\d{1,2}:\d{2}\b/g, " ");
}

/**
 * 闲聊回答是否**可用**。
 * @returns {{ok:boolean, why?:string, digits?:string[], words?:string[]}}
 */
export function isSafeChatReply(reply) {
  const r = String(reply || "").trim();
  if (!r) return { ok: false, why: "空内容" };
  if (r.replace(/\s/g, "").length < 2) return { ok: false, why: "内容过短" };
  if (r.length > 600) return { ok: false, why: "内容过长（" + r.length + " 字符，疑似跑题）" };
  const s = stripForChatGate(r);
  const digits = numbersOf(s);
  if (digits.length) return { ok: false, why: "出现数字 " + digits.slice(0, 4).join("/"), digits };
  const cn = s.match(CN_NUM_IN_CHAT);
  if (cn) return { ok: false, why: "出现中文数字 " + cn[0], digits: [cn[0]] };
  const words = s.match(new RegExp(CHAT_FORBIDDEN.source, "gi")) || [];
  if (words.length) return { ok: false, why: "出现项目内专有名词 " + [...new Set(words)].slice(0, 3).join("/"), words };
  return { ok: true };
}

/** 闲聊闸门拦下之后的反问句（**不含任何数字**，也不用模板冒充模型回复） */
export function chatClarifyText() {
  return "我这边没能确认要给你算的是哪个工况。你可以两种问法任选一种：\n\n" +
    "- 给一句工况描述（例如：某温度的某载体、多少流量、想做什么）；\n" +
    "- 或者问本项目的口径与出处，我会去知识库里查，并把出处一并给你。";
}

/* 中文数字词检测 —— 只用来**发现**闲聊回答里在"报数"的痕迹，不做任何换算。
   ⚠ 刻意**不**匹配「两个 / 三种 / 一会儿 / 一样」这类正常口语：
      要求"两个及以上数词连写 + 后接单位/量词"，也就是真的在报一个数（"六百五十小时""三万多吨"）。 */
const CN_NUM_IN_CHAT = /[二三四五六七八九][零一二三四五六七八九十百千万亿]+(?=个|项|条|种|倍|点|时|天|年|月|日|度|吨|台|套|次|人)/;

/* ---- 文本归一化：比对"照抄"时忽略空白、全角空格与常见标点差异 ----
   ⚠ 为什么需要它：LLM 把「流量 1.2 万标方每小时」抄成「流量1.2万标方每小时」是**排版差异**，
     不是内容造假；拿它当"对不上"会把真话判成假话。归一化只丢排版，不丢任何字符信息。 */
const nz = (x) => toHalfWidth(String(x == null ? "" : x))
  .replace(/[\s\u00A0\u2009\u3000]/g, "")
  .replace(/[（）()【】\[\]「」『』,，、；;：:]/g, "");
/** 半角化的连续数字 token（"1.2万"→"1.2"；"4.4667"→"4.4667"） */
const numTokens = (x) => (nz(x).match(/\d+(?:\.\d+)?/g) || []);

/* ============================================================== 闸 A：入参数字溯源 */

/**
 * 「派生运算」文法 —— 多轮追问下**唯一**允许产生新数字的通道。
 *
 * 为什么需要它：用户说「流量减半」，本轮原话里根本没有"2.2334"这个数，
 * 按最朴素的原句核对规则只能丢字段（现场就是"追问接不上"）。
 * 但直接放开"只要引用了上一轮某句话就信"又是**开天窗**：LLM 可以拿一句真话当挡箭牌塞任意数字。
 *
 * 所以这里把口子收成**可验证的算式**：
 *   新值 = 照抄片段里那个基准数 经过一个**白名单运算**得到的结果。
 * 判定方自己算一遍，对不上就丢。这样"新数字"的来路仍然只有两条：
 *   ① 本轮原话里逐字找得到；② 基准数（逐字可查）+ 白名单运算。
 * 两条都不接受"上一轮引擎算出的结论数字"。
 */
const OPS = [
  { re: /^(?:同一数值|不变|原值|照旧)$/, f: (b) => b, label: "沿用基准值" },
  { re: /^(?:减半|一半|除以\s*2|\/\s*2|×\s*0\.5|\*\s*0\.5)$/, f: (b) => b / 2, label: "减半（基准 ÷ 2）" },
  { re: /^(?:翻倍|加倍|乘以\s*2|×\s*2|\*\s*2)$/, f: (b) => b * 2, label: "翻倍（基准 × 2）" },
  { re: /^增加\s*(-?\d+(?:\.\d+)?)$/, f: (b, n) => b + n, label: "基准 + N", needN: true },
  { re: /^减少\s*(-?\d+(?:\.\d+)?)$/, f: (b, n) => b - n, label: "基准 − N", needN: true },
  { re: /^乘以\s*(-?\d+(?:\.\d+)?)$/, f: (b, n) => b * n, label: "基准 × N", needN: true },
  { re: /^除以\s*(-?\d+(?:\.\d+)?)$/, f: (b, n) => b / n, label: "基准 ÷ N", needN: true },
  /* 「设为 X」不需要基准：X 直接来自本轮用户原话，会被 numberTraceableInUserText 先接住 */
  { re: /^(?:设为|等于|就是)\s*(-?\d+(?:\.\d+)?)$/, f: () => null, label: "直接设为", literal: true },
];

/**
 * 在一个**已知基准数**上执行白名单运算。
 * @returns {{ok:boolean, value?:number, label?:string, why:string}}
 */
export function applyDerivationOn(base, op) {
  const s = toHalfWidth(String(op || "")).trim().replace(/\s+/g, "");
  if (!s) return { ok: false, why: "没有填运算" };
  const opDef = OPS.find((o) => o.re.test(s));
  if (!opDef) return { ok: false, why: "运算「" + op + "」不在白名单文法里（只允许：同一数值/减半/翻倍/增加N/减少N/乘以N/除以N/设为N）" };
  if (!isFinite(base)) return { ok: false, why: "基准不是有限数" };
  const m = s.match(/(-?\d+(?:\.\d+)?)/);
  const n = opDef.needN ? (m ? Number(m[1]) : null) : null;
  if (opDef.needN && n == null) return { ok: false, why: "运算里没找到 N" };
  const v = opDef.f(base, n);
  if (v == null || !isFinite(v)) return { ok: false, why: "运算结果不是有限数" };
  const sym = opDef.label.indexOf("−") >= 0 ? "−" : opDef.label.indexOf("÷") >= 0 ? "÷" : opDef.label.indexOf("×") >= 0 ? "×" : "+";
  return {
    ok: true, value: +v.toFixed(4), base,
    label: opDef.label + "（" + base + (n != null ? " " + sym + " " + n : "") + " ⇒ " + (+v.toFixed(4)) + "）",
  };
}

/**
 * 从照抄片段里取基准数再算一遍。**这是自检脚本与文档演示用的入口**；
 * `resolveSceneNL()` 内部走的是更严格的 `baseFromQuote()` + `applyDerivationOn()`
 * （基准必须是**上一轮真的落过盘的那个字段值**，不能是片段里随便一个数）。
 */
export function applyDerivation(op, quote) {
  const q = toHalfWidth(String(quote || "")).replace(/[\s\u00A0\u2009,]/g, "");
  const qnums = (q.match(/\d+(?:\.\d+)?/g) || []).map(Number).filter((x) => isFinite(x));
  if (!qnums.length) return { ok: false, why: "照抄片段里没有可当基准的数字" };
  return applyDerivationOn(qnums[0], op);
}

/**
 * 解析本轮入参（自然语言路径）。**这是多轮下的闸 A。**
 *
 * @param {object} raw        LLM 解析出的候选（含 `取值_原文` / `取值_运算` 证据字段）
 * @param {string} userText   本轮用户原话
 * @param {object|null} prev  上一轮（session.lastTurn 的结果），null 表示首轮
 * @returns {{scene, log, errors, warnings, usedPrev:boolean, prevQuotes:string[]}}
 */
export function resolveSceneNL(raw, userText, prev) {
  const log = [], errors = [], warnings = [];
  const push = (field, value, src, detail) => log.push({ field, value, source: src, detail });

  /* ---- 闸 A 的三条合法来源 ---- */
  const prevScope = prev ? prevScopeText(prev) : "";           // 上一轮可被引用的文本（原话 + 已落盘入参）
  const prevFields = new Map();                                // 上一轮每个数值字段 = 多少（派生运算的基准核对用）
  for (const l of ((prev && prev.inputLog) || [])) if (l.value != null && typeof l.value === "number") prevFields.set(String(l.field), l.value);
  if (prev && prev.scene) for (const [k, v] of Object.entries(prev.scene)) if (typeof v === "number") prevFields.set(String(k), v);

  const quoteOk = (q) => {
    if (q == null) return false;
    const s = String(q).trim();
    if (s.length < 6) return false;      // 太短的片段无法定位来源（例如只抄个"320"）
    /* 引用片段必须在**本轮原话**或**上一轮可引用文本**里找得到（忽略空白与标点差异） */
    return nz(userText).includes(nz(s)) || (!!prevScope && nz(prevScope).includes(nz(s)));
  };
  const quoteFromPrev = (q) => !!prevScope && String(q || "").trim().length >= 6 &&
    nz(prevScope).includes(nz(q)) && !nz(userText).includes(nz(q));

  /**
   * 派生运算的**基准核验**：照抄片段必须点出字段名，且该字段在上一轮确实是这个值。
   * 这样"基准"就不是 LLM 随便指的一段话，而是上一轮真的落过盘的那个数。
   * @returns {{ok:boolean, base?:number, why:string}}
   */
  const baseFromQuote = (q, preferField) => {
    const nq = nz(q);
    if (!quoteOk(q)) return { ok: false, why: "照抄片段在本轮原话与上文里都找不到（基准不可查）" };
    const nums = numTokens(q).map(Number).filter((x) => isFinite(x));
    if (!nums.length) return { ok: false, why: "照抄片段里没有数字" };
    const named = [...prevFields.keys()].filter((k) => nq.includes(nz(k)) && prevFields.get(k) != null);
    const fields = (preferField && named.includes(preferField)) ? [preferField] : named;
    for (const f of fields) {
      const v = prevFields.get(f);
      if (nums.some((n) => Math.abs(n - v) < 1e-9)) return { ok: true, base: v, field: f, why: "基准 = 上一轮 " + f + " = " + v };
    }
    if (named.length) return { ok: false, why: "照抄片段提到了「" + named.join("、") + "」，但片段里的数字与上一轮这些字段的值都对不上" };
    return { ok: false, why: "照抄片段没有点出是哪个参数（必须在片段里写出字段名，例如「流量_kg_s = 4.4667」）" };
  };

  let usedPrev = false;
  const prevQuotes = [];

  /**
   * 数值 v 能不能用。**三种合法来路，没有第四种。**
   *   ① 本轮原话里逐字找得到；
   *   ② v 恰好等于某段**逐字可查**的照抄片段里的数（原样引用）；
   *   ③ v = 上一轮某个已落盘字段的值 经过白名单运算（`*_运算`）的结果，且判定方复算一致。
   * 上一轮**引擎算出来的**数字（贴近度/可回收热功率/证书项数…）不在任何一种里 —— 它们压根不在 prevScope 里。
   */
  const traceable = (v, quote, op, field) => {
    if (!finite(v)) return { ok: false, fromPrev: false, why: "不是有效数字" };
    /* ① 本轮原话里逐字找得到 —— 最强来源，不需要引用片段 */
    if (numberTraceableInUserText(v, userText)) return { ok: true, fromPrev: false, why: "本轮原话" };
    /* ② 照抄片段里原样就有这个数 */
    if (quoteOk(quote)) {
      const canon = String(Number(v));
      if (numTokens(quote).some((x) => x === String(v) || x === canon || String(Number(x)) === canon)) {
        if (quoteFromPrev(quote)) {
          usedPrev = true; prevQuotes.push(String(quote).trim());
          return { ok: true, fromPrev: true, why: "照抄上文「" + String(quote).trim() + "」" };
        }
        return { ok: true, fromPrev: false, why: "照抄本轮原话「" + String(quote).trim() + "」" };
      }
    }
    /* ③ 派生运算：基准必须是**上一轮真的落过盘的那个字段值** + 白名单运算 + 复算一致 */
    if (op != null && String(op).trim()) {
      const b = baseFromQuote(quote, field);
      if (!b.ok) return { ok: false, fromPrev: false, why: "运算「" + op + "」被拒：" + b.why + "（基准不可查 ⇒ 不许算）" };
      const d = applyDerivationOn(b.base, op);
      if (!d.ok) return { ok: false, fromPrev: false, why: "派生运算不成立：" + d.why };
      if (Math.abs(d.value - v) > 1e-6) {
        return { ok: false, fromPrev: false, why: "派生运算对不上：按「" + d.label + "」应当是 " + d.value + "，但填的是 " + v };
      }
      usedPrev = true; prevQuotes.push(String(quote).trim());
      return { ok: true, fromPrev: true, why: "派生运算（已按上一轮 " + b.field + " = " + b.base + " 复算一致）「" + d.label + "」" };
    }
    /* ④ 以上都不成立 → 拒 */
    return { ok: false, fromPrev: false, why: "本轮原话里找不到、没有可查的照抄片段、也没有可复算的派生运算" };
  };

  /* ---- 需求 ---- */
  let demand = raw.demand;
  if (demand == null) { demand = "发电"; push("需求", "发电", "平台默认", "你没说要用它做什么，按最常见的「发电」假设（可在界面改成别的）"); }
  else if (!VALID.demand.includes(demand)) { errors.push("需求「" + demand + "」不在引擎支持集内：" + VALID.demand.join(" / ")); demand = null; }
  else push("需求", demand, "你的原话（LLM 翻译）", "已折算成决策内核能认的需求词");

  /* ---- 载体 ---- */
  let medium = raw.medium;
  if (medium == null) { medium = "烟气"; push("载体", "烟气", "平台默认", "你没说热源是什么载体，按最常见的烟气假设"); }
  else if (!VALID.medium.includes(medium)) { errors.push("载体「" + medium + "」不是引擎可取值：" + VALID.medium.join(" / ")); medium = null; }
  else push("载体", medium, "你的原话（LLM 翻译）", "已折算成决策内核能认的载体词（内核只有烟气 / 热水·冷凝水 / 工艺液体三种）");

  /* ---- 温度 ---- */
  let temp = raw.tempC;
  if (temp == null) errors.push("没听出热源温度。请给我一个数，例如「320 摄氏度的窑炉烟气」；沿用上一轮可以说「温度还是 320」。");
  else {
    const t = traceable(temp, raw.tempQuote, raw.tempOp, "热源温度");
    if (!t.ok) { errors.push("温度 " + temp + " 不可采用 —— " + t.why + "（按纪律丢弃）。"); temp = null; }
    else push("热源温度_degC", temp,
      t.fromPrev ? "由上文派生⚠（基准照抄上一轮）"
        : (raw.pickedFrom ? "用户点选（工况库预设第 " + raw.pickedFrom.line + " 行）" : "你的原话（已核对原句）"),
      t.why + "。引擎的温度包络是 25~650℃" + (t.fromPrev ? "；本次数值来自上文，不是本轮新给的" : ""));
  }

  /* ---- 体积流量 → 质量流量：把**用户原样的数**也记进日志 ----
     ⚠ 为什么：用户说「1.2 万标方每小时」，答复里很自然会写「你说的 1.2 万标方 → 4.4667 kg/s」。
     那个 "1.2" 是**用户自己给的数**，不是模型编的 —— 但它既不在引擎返回体里，也不在换算算式里，
     于是会被回答闸判为越界、整段改写作废（实测就是这么发生的，被拦下的是 "1.2"）。
     修法不是放松闸门，而是把这份"用户原样输入"补进解析日志 → 它自然进入本轮语料与模板的口径提示，
     答复就有据可依了。 */
  let flowRawNote = null;

  /* ---- 流量：单位换算走"白名单"，其余一律拒绝 ---- */
  let mDot = null, flowFromPrev = false;
  const fv = raw.flowValue, fu = raw.flowUnit;
  if (fv == null || fu == null) {
    errors.push("没听出热源流量。请写清数值与单位，例如「1.2 万标方每小时」或「50 kg/s」；沿用上一轮可以说「流量减半」。");
  } else {
    const t = traceable(fv, raw.flowQuote, raw.flowOp, "流量");
    if (!t.ok) {
      errors.push("流量 " + fv + " 不可采用 —— " + t.why + "（按纪律丢弃）。");
    } else {
      flowFromPrev = t.fromPrev;
      const U = String(fu).replace(/\s/g, "");
      const isWan = /万/.test(U);
      const n = fv * (isWan ? 10000 : 1);
      const prov = "。" + t.why;
      flowRawNote = "你给的原始流量： " + fv + " " + (fu || "");
      /* ⚠ G5：`raw.pickedFrom` 只可能来自 `detectPresetPick()`，而那个函数要求
         温度与流量**都**能在本轮原话里逐字找到。所以"用户点选"这个来源标签
         绝不是"点了就信"——它标注的是"这个数出现在用户点下去的那句话里"。 */
      const pickSrc = raw.pickedFrom ? "用户点选（工况库预设第 " + raw.pickedFrom.line + " 行）" : null;
      if (/^kg\/s$/i.test(U)) {
        mDot = n; push("流量_kg_s", mDot,
          t.fromPrev ? "由上文派生⚠（同单位，未再换算）" : (pickSrc || "你的原话（同单位，未换算）"),
          "引擎入参单位本来就是 kg/s" + prov);
      } else if (/^t\/h$/i.test(U)) {
        mDot = +(n / 3.6).toFixed(4);
        push("流量_kg_s", mDot, "单位换算（纯换算，无数值假设）", n + " t/h ÷ 3.6 = " + mDot + " kg/s" + prov);
      } else if (/^(万)?(Nm3\/h|m3\/h|标方|立方)/i.test(U)) {
        const rho = CONV.density_kg_per_Nm3;
        mDot = +(n / 3600 * rho).toFixed(4);
        push("流量_kg_s", mDot, "单位换算（含未确认假设）",
          n + " Nm³/h ÷ 3600 × " + rho + " kg/Nm³ = " + mDot + " kg/s。⚠ 密度 " + rho + " 是" + CONV.density_source + prov);
        warnings.push("流量是从体积流量换算来的，用了密度 " + rho + " kg/Nm³（" + CONV.density_source + "）。若你有实测质量流量，请直接给 kg/s。");
      } else {
        errors.push("流量单位「" + fu + "」不在白名单（kg/s、t/h、Nm3/h、万Nm3/h）内 —— 拒绝换算，不猜。");
      }
      if (t.fromPrev && mDot != null) usedPrev = true;
    }
  }

  /* ---- 年运行小时 ---- */
  let hours = raw.hours;
  if (hours == null) { hours = ENGINE_DEFAULTS.hours; push("年运行小时", hours, "引擎默认值", "引擎的默认年运行小时是 6500 h（6 个真实项目的等效满负荷小时中位≈6100，取 6500 是折中）"); }
  else {
    const t = traceable(hours, raw.hoursQuote, raw.hoursOp, "年运行小时");
    if (!t.ok) { warnings.push("年运行小时 " + hours + " 不可采用（" + t.why + "），已退回引擎默认 " + ENGINE_DEFAULTS.hours + " h。"); hours = ENGINE_DEFAULTS.hours; push("年运行小时", hours, "引擎默认值（LLM 的值被丢弃）", "同上"); }
    else push("年运行小时", hours, t.fromPrev ? "由上文派生⚠" : "你的原话", t.why + "。引擎会按需求折算：供暖·热水需求会被钳到 3200 h");
  }

  /* ---- 换热端差 ---- */
  let dT = raw.dT;
  if (dT == null) { dT = ENGINE_DEFAULTS.dT; push("换热端差_degC", dT, "引擎默认值", "引擎缺省换热端差 10 K"); }
  else {
    const t = traceable(dT, raw.dTQuote, raw.dTOp, "换热端差");
    if (!t.ok) { dT = ENGINE_DEFAULTS.dT; push("换热端差_degC", dT, "引擎默认值（LLM 的值被丢弃）", t.why); }
    else push("换热端差_degC", dT, t.fromPrev ? "由上文派生⚠" : "你的原话", t.why);
  }

  /* ---- 连续性 / 驱动 ---- */
  let continuity = raw.continuity;
  if (continuity == null || !VALID.continuity.includes(continuity)) { continuity = ENGINE_DEFAULTS.continuity; push("连续性", continuity, "引擎默认值", "引擎缺省「连续」"); }
  else push("连续性", continuity, "你的原话", "");
  const driver = ENGINE_DEFAULTS.driver;
  push("驱动来源", driver, "引擎默认值", "引擎缺省「余热自驱动」；本原型不做外购蒸汽/电驱动场景");

  if (usedPrev) {
    warnings.push("本轮有字段是**由上文派生**的（" + [...new Set(prevQuotes)].join("；") +
      "）。它来自上一轮的输入，不是本轮的新数字；引擎仍会重新算一遍，但请知道这条依赖。");
  }
  /* ---- 续问兜底：LLM 把"上一轮依然有效、但本轮没重述"的数值字段漏掉了 ----
     ⚠ 这是**为了现场演示不翻车**而加的一道确定性兜底，不是放松闸门：
       沿用必须同时满足三件事 ——
         ① 本轮读起来是**续问**（有「那/如果/减半/呢」这类标记）；
         ② 该字段在上一轮**真的落过盘**（prev.scene，即引擎 validateScene 之后的实读值）；
         ③ 该字段本轮**确实缺**（LLM 没给、或给了但没过闸）。
       沿用值直接来自上一轮的引擎实读值，界面上逐条标为「由上文续用⚠」，
       并在步骤区显式说出来 —— 不藏着。用户如果在本轮明确给了新值，走不到这里（①②③ 的 ③ 不成立）。 */
  const carried = [];
  if (prev && looksLikeContinuation(userText)) {
    const psc = prev.scene || {};
    const carry = (field, cur) => {
      if (cur != null) return cur;
      const pv = psc[field];
      if (pv == null || typeof pv !== "number" || !isFinite(pv)) return cur;
      carried.push(field + " = " + pv);
      usedPrev = true;
      push(field, pv, "由上文续用⚠（本轮未重述，按上一轮引擎实读值）",
        "续用取值来自上一轮 scene[" + field + "] = " + pv + "；引擎本轮仍会重新算一遍");
      return pv;
    };
    temp = carry("热源温度_degC", temp);
    const md0 = carry("流量_kg_s", mDot);
    if (md0 !== mDot) { mDot = md0; flowFromPrev = true; }
    hours = carry("年运行小时", hours);
    dT = carry("换热端差_degC", dT);
    if (demand == null && psc["需求"] != null) { demand = psc["需求"]; carried.push("需求 = " + psc["需求"]); }
    if (medium == null && psc["载体"] != null) { medium = psc["载体"]; carried.push("载体 = " + psc["载体"]); }
    if ((continuity == null || !VALID.continuity.includes(continuity)) && psc["连续性"] != null) continuity = psc["连续性"];
  }

  if (errors.length) return { frame: null, log, errors, warnings, usedPrev, prevQuotes, carried };
  if (temp == null || mDot == null) {
    return { frame: null, log, errors: ["信息不足：温度或流量仍然缺失。"], warnings, usedPrev, prevQuotes, carried };
  }

  push("规模_kW", null, "—", "走流量口径，不用规模口径");
  push("需求温度_degC", null, "引擎默认", "引擎缺省为空；仅供暖/干燥场景影响直接换热下限");
  /* 用户原样的流量写法（"1.2 万标方每小时"）也记一笔：答复里复述它时才有据可依。
     它**不是**引擎数字，所以在模板里只出现在「口径提示（不属于引擎）」那一段。 */
  if (flowRawNote) push("流量_原文", null, "你的原话（原样记录，不属于引擎）", flowRawNote);
  return { frame: { t_src_degC: temp, m_dot_kg_s: mDot, medium, demand, continuity, driver, dT_degC: dT, hours },
    log, errors, warnings, usedPrev, prevQuotes, carried };
}

/**
 * 闸 A（结构化表单路径）。表单里用户是在**具名输入框**里直接填的数，
 * 不存在"原话"可查 —— 若照搬原句核对，会把用户自己填的数当成 LLM 编的而全部丢弃
 * （原版实测就是这么错了一次）。这条路径压根不调 LLM，所以只要值来自具名字段就采纳。
 */
export function resolveSceneForm(raw) {
  const log = [], errors = [], warnings = [];
  const NG = { scene: null, frame: null, log, errors, warnings, usedPrev: false, prevQuotes: [], carried: [] };
  const push = (field, value, src, detail) => log.push({ field, value, source: src, detail });
  if (raw.tempC != null && !finite(raw.tempC)) { errors.push("热源温度不是有效数字（表单留空会变成 NaN）。"); raw = { ...raw, tempC: null }; }
  if (raw.flowValue != null && !finite(raw.flowValue)) { errors.push("流量不是有效数字（表单留空会变成 NaN）。"); raw = { ...raw, flowValue: null }; }
  if (raw.hours != null && !finite(raw.hours)) raw = { ...raw, hours: null };
  if (raw.dT != null && !finite(raw.dT)) raw = { ...raw, dT: null };

  let demand = raw.demand;
  if (demand == null) demand = "发电";
  if (!VALID.demand.includes(demand)) { errors.push("需求「" + demand + "」不在引擎支持集内。"); return NG; }
  push("需求", demand, "表单具名字段（不经过 LLM）", "已折算成决策内核的需求词");

  let medium = raw.medium;
  if (medium == null) medium = "烟气";
  if (!VALID.medium.includes(medium)) { errors.push("载体「" + medium + "」不是引擎可取值。"); return NG; }
  push("载体", medium, "表单具名字段（不经过 LLM）", "已折算成决策内核的载体词");

  if (raw.tempC == null) errors.push("请填热源温度（℃）。");
  else push("热源温度_degC", raw.tempC, "表单具名字段「热源温度 ℃」", "引擎包络 25~650℃");

  let mDot = null;
  if (raw.flowValue == null || raw.flowUnit == null) errors.push("请填流量（kg/s）。");
  else {
    const U = String(raw.flowUnit).replace(/\s/g, ""), n = raw.flowValue;
    if (/^kg\/s$/i.test(U)) { mDot = n; push("流量_kg_s", mDot, "表单具名字段「流量 kg/s」", "同单位未换算"); }
    else if (/^t\/h$/i.test(U)) { mDot = +(n / 3.6).toFixed(4); push("流量_kg_s", mDot, "表单具名字段（单位换算）", n + " t/h ÷ 3.6"); }
    else errors.push("表单流量单位只支持 kg/s 与 t/h（体积流量请用对话入口，那里会显式标注密度假设）。");
  }
  const hours = raw.hours == null ? ENGINE_DEFAULTS.hours : raw.hours;
  push("年运行小时", hours, raw.hours == null ? "引擎默认值" : "表单具名字段", "引擎默认年运行小时 6500 h");
  const dT = raw.dT == null ? ENGINE_DEFAULTS.dT : raw.dT;
  push("换热端差_degC", dT, raw.dT == null ? "引擎默认值" : "表单具名字段", "引擎缺省 10 K");
  let continuity = raw.continuity;
  if (continuity == null || !VALID.continuity.includes(continuity)) continuity = ENGINE_DEFAULTS.continuity;
  push("连续性", continuity, "表单具名字段", "引擎缺省「连续」");
  const driver = ENGINE_DEFAULTS.driver;
  push("驱动来源", driver, "引擎默认值", "引擎缺省「余热自驱动」");

  if (errors.length) return NG;
  return {
    frame: { t_src_degC: raw.tempC, m_dot_kg_s: mDot, medium, demand, continuity, driver, dT_degC: dT, hours },
    log, errors, warnings, usedPrev: false, prevQuotes: [], carried: [],
  };
}

/* ============================================================== 闸 B：回答数字回查 */

/**
 * 本轮数字语料的**唯一**来源：本轮 callEngine 的返回体（+ 本轮解析日志里已落盘的换算过程）。
 * **注意它不接受任何历史轮次参数** —— 这就是"上一轮的数字不许当本轮依据"的落地点。
 *
 * ⚠ 为什么要把 `parseLog` 也算进语料：解析日志里有**本轮的派生算式**
 *   （例如「12000 Nm³/h ÷ 3600 × 1.34 = 4.4667 kg/s」）。
 *   这些数字是**本轮**算出来的、并且已经落成了引擎入参；回答里若要复述这条口径提示，
 *   它们必须可溯源。它们**不属于**"历史轮次的数字"，放进来不违反上面那条纪律。
 *   反过来，历史轮次的引擎输出（recoveredKw / closeness / …）**永远不进语料**。
 */
export function buildCorpus(r, parseLog) {
  if (!r || !r.ok) return "";
  const parts = [];
  const add = (x) => { if (x != null && x !== "") parts.push(String(x)); };
  for (const l of (parseLog || [])) { add(l.field); add(l.value); add(l.source); add(l.detail); }
  add(r.message);
  add(r.lam);
  if (r.scene) for (const [k, v] of Object.entries(r.scene)) add(v);
  for (const w of (r.warnings || [])) add(w);
  for (const b of (r.boundaryNotices || [])) add(b);
  if (r.engine) {
    add(r.engine.top); add(r.engine.topLabel); add(r.engine.recoveredKw);
    for (const k of (r.engine.keys || [])) add(k);
    for (const l of (r.engine.labels || [])) add(l);
    for (const o of (r.engine.order || [])) { add(o.path); add(o.closeness); for (const v of (o.row || [])) add(v); }
    for (const s of (r.engine.stage1 || [])) { add(s.path); add(s.label); add(s.reason); }
  }
  const c = r.certificate;
  if (c && !c.error) {
    add(c.statement); add(c.total); add(c.flips);
    for (const x of (c.candidates || [])) add(x);
    for (const p of (c.probes || [])) { add(p.name); add(p.label); add(p.detail); }
    for (const a of (c.assumptions || [])) { add(a.name); add(a.value); add(a.source); add(a.grade); }
  }
  return parts.join("\n");
}

/** 本轮语料里出现的所有数字 token（去重） */
function corpusTokens(r, parseLog) { return [...new Set(numbersOf(buildCorpus(r, parseLog)))]; }

/**
 * 把候选回答与本轮语料 + 关键事实做交叉核对。
 *
 * 三关，任何一关不过就退回模板（**宁可用难看的模板句，也不用好看的假话**）：
 *   ① 数字：候选回答里的每个数字 token，必须在本轮语料里找得到（verifyNumbers 的规则）；
 *   ② 事实：推荐路径的中文名必须与引擎 topLabel 一致（比对去掉括号后的核心名）；
 *   ③ 事实：凡出现"N 条候选"的表述，N 必须等于本轮引擎候选条数。
 *      （第 ②③ 关是给多轮加的：数字闸门只看数字，看不住"把上一轮的名字搬过来"这种错。）
 *
 * ⚠ `opts.corpus` 的用法很重要：改写路径必须传**喂给模型的那份模板正文**当语料。
 *   理由：模板正文里引擎浮点数是按 4 位小数呈现的（1326.6099），而引擎返回体是全精度
 *   （1326.6099000000002）。若拿全精度返回体当语料，模型照抄模板里的 1326.6099 反而会被判越界 ——
 *   那是自相矛盾。原则是：**闸门用的语料 = 模型实际看到的那份文本**（不多也不少）。
 *   模板句路径（没有改写）传空即可，此时语料 = 本轮 callEngine 返回体 + 本轮解析派生式。
 *
 * @param {string} candidate LLM 产出的回答（Markdown 或纯文）
 * @param {object} r         本轮 callEngine 返回体
 * @param {Array}  [parseLog] 本轮解析日志（提供**本轮**派生换算里的数字）
 * @param {object} [opts]    { corpus?:string }
 */
export function verifyAnswer(candidate, r, parseLog, opts = {}) {
  const corpus = (typeof opts.corpus === "string")
    ? opts.corpus + "\n" + (parseLog || []).map((l) => [l.field, l.value, l.source, l.detail].join(" ")).join("\n")
    : buildCorpus(r, parseLog);
  const numCheck = verifyNumbers(candidate, corpus);
  const facts = [];
  const text = toHalfWidth(String(candidate || ""));

  if (r && r.engine && !r.out_of_scope) {
    const topLabel = r.engine.topLabel;
    const flat = toHalfWidth(String(candidate || ""));
    /* ② 推荐路径名必须与引擎一致。
       ⚠ 只比对**去掉括号与空白后的核心名**（"高温蒸汽发电（蒸汽朗肯）" → "高温蒸汽发电"）：
         人写答复时天然会把括号里的备注省掉，那是措辞不是结论；要求逐字全等会把真话误杀。 */
    const core = (s) => toHalfWidth(String(s || "")).replace(/[（(][^）)]*[）)]/g, "").replace(/[\s\u00A0]/g, "");
    if (topLabel && !flat.replace(/[\s\u00A0]/g, "").includes(core(topLabel))) {
      facts.push("回答里没有出现引擎推荐的路径名「" + topLabel + "」（核心名「" + core(topLabel) + "」）——疑似改写或搬错了轮次");
    }
    /* ③ 候选条数 */
    const n = (r.engine.keys || []).length;
    const re = /(\d+)\s*条(?:候选|路径)/g;
    for (const m of flat.matchAll(re)) {
      if (Number(m[1]) !== n) facts.push("回答写「" + m[1] + " 条候选」，本轮引擎实际是 " + n + " 条");
    }
  }
  return {
    ok: numCheck.ok && facts.length === 0,
    numbers: { ok: numCheck.ok, checked: numCheck.checked, missing: numCheck.missing },
    facts,
    corpus,
    corpusTokens: corpusTokens(r, parseLog),
    scope: "本轮 callEngine 返回体 + 本轮解析派生式（不含任何历史轮次的引擎数字）",
  };
}

/* ============================================================== 模板（数字的唯一来源） */

/* ⚠ 为什么模板里要做一个"位数截断"：
   引擎返回的浮点数是 IEEE754 全精度形态（实测 recoveredKw = 1326.6099000000002）。
   直接丢给大模型，它**必然**会写成 1326.61 —— 然后被数字回查判为"越界数字"、整段改写作废。
   所以模板（**只指给人看的模板正文**）统一按 4 位小数呈现：
     · 这是**纯显示格式**，不改数值本身，也不做"约等于"；
     · 引擎返回体的**原样**仍是全精度，在「引擎返回体原文」里可以逐位核对，导出 JSON 也是原样；
     · 数字来源表（ledger）里同样是引擎原值，不做截断。
   即：截断只发生在"给人读的那一句"上，不发生在任何"证据"上。 */
const ND = 4;
const fmtN = (v) => (typeof v === "number" && isFinite(v)) ? String(Number(v.toFixed(ND))) : String(v == null ? "—" : v);

/**
 * 本轮结论的**模板正文**（Markdown）。数字全部插值自引擎对象字段，一个字都不改。
 * 它是"数字的唯一来源"：润色/改写只能改措辞，不能改数（见 verifyAnswer）。
 *
 * 🔴 N2（2026-10-12）：正文里**不再写字段名/函数名/文件名**。
 *    以前这几行长这样：
 *      `- **该工况可回收热功率**：`1198.2389` kW（`WHENG.recoveredHeatKw`）`
 *    括号里那截对用户毫无用处（用户原话："全部报上来的都是那种文件名称、文件位置之类的，很凌乱"），
 *    已经被搬到回答下面的「出处」折叠区（事件字段 `sources`）。
 *    **数字一个都没动** —— 动的只是"这数是哪个字段算出来的"这种工程注释。
 */
export function renderTemplate(r, parseLog, opts = {}) {
  const L = [];
  const conv = (parseLog || []).filter((x) => /换算|上文派生|原样记录/.test(x.source || ""));
  if (conv.length) {
    /* ⚠ 每项之间用「；」分隔，并把 detail 收尾的句号去掉 —— 否则拼出来会是
       「…可手动覆盖）。本轮原话」这种半截括号 + 半截句子的难看形态（实测出现过）。
       ⚠ 再经一遍 stripInternalRefs：detail 里可能夹着路径（N2 的硬要求）。 */
    const parts = conv.map((c) => {
      const val = (c.value == null ? "" : " = " + fmt(c.value));
      const det = stripInternalRefs(String(c.detail || c.source || "").replace(/[。；;]\s*$/, ""));
      return c.field + val + "（" + det + "）";
    });
    L.push("> **口径提示（不属于引擎）**：" + parts.join("；"));
    L.push("");
  }
  if (r.out_of_scope) {
    L.push("## 引擎没有给出推荐");
    L.push("");
    L.push("**引擎原话**：" + r.message);
    L.push("");
    L.push("这是引擎自己的边界判定（不是 AI 的判断）。");
    return L.join("\n");
  }
  const labels = r.engine.labels, keys = r.engine.keys;
  L.push("## 推荐：" + r.engine.topLabel);
  L.push("");
  L.push("- **进入第二级的候选**：共 " + keys.length + " 条 —— " + labels.join("、"));
  if (r.engine.recoveredKw != null) L.push("- **该工况可回收热功率**：" + fmtN(Number(r.engine.recoveredKw)) + " kW");
  L.push("- **主观权重占比 λ**：" + fmtN(r.lam));
  L.push("");
  L.push("### TOPSIS 排序（贴近度 + 六项指标原值，全部来自引擎）");
  L.push("");
  L.push("| 排名 | 路径 | " + (r.engine.indicators || []).join(" | ") + " | 贴近度 |");
  L.push("|---|---|" + (r.engine.indicators || []).map(() => "---").join("|") + "|---|");
  r.engine.order.forEach((o, i) => {
    L.push("| " + (i + 1) + " | " + (labels[keys.indexOf(o.path)] || o.path) + " | " +
      (o.row || []).map((v) => fmtN(v)).join(" | ") + " | " + fmtN(o.closeness) + " |");
  });
  const c = r.certificate;
  if (c && !c.error) {
    L.push("");
    L.push("### 决策证书");
    L.push("");
    L.push("> " + c.statement);
    L.push("");
    L.push("- 扰动 **" + c.total + "** 项，其中 **" + c.flips + "** 项会让推荐改变");
    for (const p of (c.flippedProbes || [])) L.push("  - ★ " + p.name + " ⇒ 「" + p.label + "」（" + p.detail + "）");
    L.push("");
    L.push("**适用范围**：本结论只在工况库那 19 行（其中 17 行可评、2 行超包络未参与）、且只在上表这 " + c.total + " 项扰动之内成立；库外场景、以及界面上其它未被扰动的滑块，不在覆盖范围内。");
  }
  for (const w of (r.warnings || [])) { L.push(""); L.push("> **引擎告警**：" + w); }
  for (const b of (r.boundaryNotices || [])) { L.push(""); L.push("> **引擎边界提示**：" + b); }
  if (opts.contextNote) { L.push(""); L.push("> **本轮依赖**：" + opts.contextNote); }
  /* 兜底：模板里若还有漏网的内部标识（引擎告警/边界提示是引擎自己的文案，
     不受我们控制），统一在这里降级一次 —— 保证"正文卫生"是**构造性**成立的，
     而不是"现在这几句恰好干净"。 */
  return stripInternalRefs(L.join("\n"));
}

/* ============================================================== 前文上下文 */

/**
 * 上一轮**可被引用**的文本：用户原话 + 每个已落盘入参的 `字段 = 值` 行。
 *
 * ⚠ 这个函数的输出**同时**是两件事，必须保持一致，否则会出现"模型照抄了、闸门说查不到"：
 *     ① 闸 A 的 `prevScope`（判定"照抄片段是否逐字存在"的语料）
 *     ② `contextDigest()` 里给模型看的那一段（模型照着它抄）
 *   所以下面 `evidenceLines()` 是**唯一**的格式来源，两处都调它。
 *
 * ⚠ G3 补的一条（2026-10-12，实测踩到）：**平台默认值 / 引擎默认值不进这份清单**。
 *   原来这里不看 `source`，于是"上一轮按引擎默认填的 年运行小时 = 6500、换热端差 = 10"
 *   也会变成"允许被照抄引用"的行 —— 下一轮模型照抄一句「· 年运行小时 = 6500」，
 *   闸 A 就认了。那等于把**默认值**悄悄升格成"用户说过的数"。
 *   实测就是引导轮暴露的：引导轮自己选了「发电」平台默认 + 两个引擎默认值，
 *   下一轮它们就都成了可引用项（实况见 `_g1_live_streams.txt` 第 ② 轮）。
 *   这没有当场改变结论（这两个默认值本来也会被重新填一遍），但**口子必须堵上**：
 *   可引用的只能是"用户真的给过、或由它派生/换算出来的"数。
 *   ⇒ 判据：排除 `source` 里带「默认」的行。
 * @param {object} prev 上一轮
 * @returns {string[]}
 */
export function evidenceLines(prev) {
  if (!prev) return [];
  const out = [];
  for (const l of (prev.inputLog || [])) {
    if (l.value == null || typeof l.value !== "number") continue;
    if (/默认/.test(String(l.source || ""))) continue;      /* ← G3：默认值不是"用户说过的数" */
    out.push("  · " + l.field + " = " + l.value);
  }
  return out;
}

export function prevScopeText(prev) {
  if (!prev) return "";
  const parts = [String(prev.userText || "")];
  const lines = evidenceLines(prev);
  parts.push(...lines);
  /* 已落盘的入参数值本身也允许被引用（例如上一轮算出 4.4667 kg/s，本轮说"就用这个流量"）。
     ⚠ G3：只放**非默认**字段的值。原来这一行把 `scene` 里**所有**值都推进语料，
       连"引擎默认填的 6500 / 10"都算 —— 与上面 evidenceLines 的取舍不一致
       （一个排掉、一个放进来），那正是"模型照抄了、闸门说查不到"这类事故的温床。
       现在两处共用同一个判据：`source` 里带「默认」的字段，它的值**不进**这份文本。 */
  const nonDefaultFields = new Set(
    ((prev.inputLog || [])).filter((l) => !/默认/.test(String(l.source || ""))).map((l) => String(l.field))
  );
  if (prev.scene) {
    for (const [k, v] of Object.entries(prev.scene)) {
      if (v == null || !nonDefaultFields.has(String(k))) continue;
      parts.push(String(v));
    }
  }
  return parts.join("\n");
}

/**
 * 给 LLM 的**前文摘要**。刻意分成两段，各有用意：
 *
 *   ① 【可引用的数字】= 上一轮**已经落成引擎入参**的派生值，格式与 `evidenceLines()` 完全一致。
 *      这是"流量减半"这类追问唯一合法的基准——不给它，模型就只能瞎猜；
 *      给了也不会绕开闸门：抄不中、或运算复算对不上，字段照样丢。
 *   ② 【只作语境】= 上一轮推荐了什么。**明确告诉模型这不是本轮的合法数字来源。**
 *
 * ⚠ 这里给的是"上一轮的入参"，**不是**上一轮的引擎输出（closeness / recoveredKw 之类）。
 *   那些数一个都不进这里，也一个都不进闸 B 的语料 —— 两道闸各自成立。
 */
export function contextDigest(prev) {
  if (!prev) return "（这是第一轮，没有前文）";
  const sc = prev.scene || {};
  const lines = [];
  lines.push("上一轮用户原话：" + prev.userText);
  lines.push("上一轮引擎实读的场景：热源温度 " + fmt(sc["热源温度_degC"]) + " ℃ ｜ 载体 " + fmt(sc["载体"]) +
    " ｜ 流量 " + fmt(sc["流量_kg_s"]) + " kg/s ｜ 需求 " + fmt(sc["需求"]) +
    " ｜ 年运行小时 " + fmt(sc["年运行小时"]) + " h ｜ 换热端差 " + fmt(sc["换热端差_degC"]) + " K");
  const ev = evidenceLines(prev);
  if (ev.length) {
    lines.push("【上一轮的入参（**这些数字允许被照抄引用**；照抄时把下面某一行**原样**填进对应的「_原文」字段）】");
    lines.push(...ev);
  }
  lines.push("【上一轮引擎的推荐（**只作语境，不是本轮的合法数字来源**，不许引用其中的任何数字）】" +
    (prev.engine && prev.engine.topLabel ? prev.engine.topLabel : "（未给出推荐）"));
  lines.push("【续问时怎么办】把上面「上一轮的入参」里**依然有效**的行照抄进对应的「_原文」字段、「_运算」填「同一数值」；" +
    "被追问的那个参数填它对应的运算（如「减半」）。**漏抄了就会被丢弃，追问就会断在「没听出热源温度」上。**");
  return lines.join("\n");
}

/* ============================================================== 事件流主流程 */

/**
 * 跑完一轮对话，逐条 yield 事件。
 *
 * @param {object} p
 *   p.text       用户本轮原话
 *   p.sessionId  会话 id（无则新建）
 *   p.scene      非空 ⇒ 走"结构化表单/直接入参"路径（不经过 LLM）
 *   p.noPolish   非空 ⇒ 不做措辞改写（结构化开关；LLM 不可用时自动如此）
 *   p.forceIntent 非空 ⇒ 跳过意图判定，直接按 "chat"|"decide"|"ask" 走（**给自检用**，
 *                 让"三条路各自跑的是哪条"可以被确定性地验证，不用看运气等分类器）
 */
export async function* runTurn(p = {}) {
  const t0 = Date.now();
  const text = String(p.text || "").trim();
  const step = (phase, txt, state) => ({ type: "step", phase, text: txt, state: state || "ok", at: Date.now() - t0 });

  const sess = Session.getOrCreate(p.sessionId);
  const prev = Session.lastTurn(sess.id);
  yield { type: "session", sessionId: sess.id, turns: sess.turns.length };

  if (!text && !p.scene) { yield { type: "error", message: "请输入一句话。" }; yield { type: "done", ms: Date.now() - t0 }; return; }

  yield step("load", prev
    ? "已载入上文 " + sess.turns.length + " 轮（本轮可续问；但本轮的**数字只用本轮引擎输出**）"
    : "新会话：这是第一轮，没有上文", "ok");

  const llmOn = LLM.available();

  /* ---------------------------------------------------------- 结构化入参路径 */
  if (p.scene) {
    yield step("parse", "结构化入参：不经过大模型，直接进引擎", "ok");
    const rs = resolveSceneForm(p.scene);
    for (const l of rs.log) yield { type: "plan_row", row: l };
    yield* engineStage({ rs, userText: text || "（结构化表单输入）", sess, llmOn, noPolish: true, t0, formPath: true, step });
    yield { type: "done", ms: Date.now() - t0 };
    return;
  }

  /* ---------------------------------------------------------- 自然语言路径 */
  yield step("classify", "正在理解你的问题…", "run");

  /* ── 意图三分类（M1）──────────────────────────────────────────────────
     chat   → chatStage()   闲聊：真调 DeepSeek 对话补全
     decide → 工况：原链路（解析 → 引擎 → 证书 → 数字闸）
     ask    → askStage()    知识问答：本地 RAG，答案带出处

     ⚠ 纪律：**分类失败或拿不准，一律不许硬猜成工况**。
       LLM 判定失败 → 规则兜底 routeIntent()；规则也没把握 → 它返回 "ask"（保守）。 */
  /* ── F1：「关于你自己」先于一切 LLM 判定（确定性路由）────────────────────
     ⚠ 为什么必须放在**问模型之前**、而不是塞进 LLM.classify 的三分类里：
       · 分类器只会回 chat / decide / ask 三种，没有 meta 这一类，判不出来；
       · 更要紧的是**不许有波动** —— "你怎么保证不编数"这句话的答案必须是同一份模板，
         不能这一轮答工作流、下一轮又被 BM25 拽去答手册 §9（用户实测就是这么翻车的）。
     ⚠ 它不碰任何闸门：这一段不检索、不调引擎、不出数，所以闸 A/闸 B 与它无关。 */
  if (p.forceIntent === "meta" || isMetaQuestion(text)) {
    yield step("classify", "这句话问的是**我自己怎么工作**（命中 meta 判据），" +
      "按纪律走模板：不检索、不靠模型自由发挥", "ok");
    yield* metaStage({ text, sess, llmOn, t0 });
    yield { type: "done", ms: Date.now() - t0 };
    return;
  }

  let cls = null;
  if (p.forceIntent === "chat" || p.forceIntent === "decide" || p.forceIntent === "ask") {
    cls = { intent: p.forceIntent, reason: "由调用方指定（自检用）" };
    yield step("classify", "意图由调用方指定（自检用）：「" + p.forceIntent + "」", "ok");
  } else if (!llmOn) {
    yield step("classify", "AI 入口不可用，直接用规则判定", "warn");
  } else if (isRuleCertainIntent(text, prev)) {
    /* ── N1 顺带修掉的那一跳（2026-10-12）───────────────────────────────────
       实测：「介绍一下这个项目」走快速通道后，**剩下的全部耗时就是这次意图分类**
       （answer 到达 1835 ms，而 answer 的生成是 0 ms）。
       但这条问题**根本不需要问模型**：routeIntent() 的规则已经能确定它是知识问答，
       而 LLM.classify 也只会回 "ask"。为省这一次往返，加一条**只认"最没有歧义"的形态**的短路：
         · 纯寒暄（「你好」）—— 整句就是一句问候；
         · 项目概况（「介绍一下这个项目」）—— 命中具名形态且不含任何具体口径词。
       ⚠ 其余一律照旧调模型（包括所有工况句与所有口径问题）——
         这条短路**不参与任何数字判定**，判错了也只是"少问模型一次"，不会放宽任何闸门。 */
    const forced = routeIntent(text, prev);
    cls = { intent: forced, reason: "规则已足够确定（" + (forced === "chat" ? "整句就是一句寒暄" : "命中项目概况的具名形态") + "），跳过模型判定省一次往返" };
    yield step("classify", "规则已足够确定，跳过「问模型判意图」这一次往返：" + cls.reason, "ok");
  } else {
    try { cls = await LLM.classify(text, contextDigest(prev)); }
    catch (e) { yield { type: "step", phase: "classify", text: "意图判定调用失败（" + e.code + "），改用规则兜底", state: "warn", at: Date.now() - t0 }; }
  }

  let intent;
  if (cls && (cls.intent === "chat" || cls.intent === "decide" || cls.intent === "ask")) {
    intent = cls.intent;
    /* ⚠ 交叉核对（别让"最松的那条路"成为绕过数字闸门的口子）：
       模型说是闲聊，但句子里明明带着项目专有词（台账/证书/包络/年运行小时…）⇒ **升到知识问答**。
       这一条同时覆盖了两种情形：模型判断不准，以及用户拿闲聊的口吻问项目事实。 */
    if (intent === "chat" && CORPUS_MARKERS.test(text) && !CHAT_PATTERNS.some((re) => re.test(String(text).trim()))) {
      intent = "ask";
      yield step("classify", "意图判定为「闲聊」，但这句话带着项目口径/数字的词（命中项目词表）——" +
        "按纪律**升级为知识问答**：项目事实一律走检索并给出处，闲聊这条路不许凭记忆报数", "warn");
    }
    /* ⚠ G1 的交叉核对（2026-10-12 加）：模型判成 **ask**，但这句话是**用户在自己描述一处现场余热**
       （"我们这台窑，烟气挺烫的…"）⇒ 降到工况路，由引导段去问缺的参数。
       为什么必须加：实测这句话被模型判成"闲聊/知识问题"，用户拿到的是一段讲口径的长文 ——
       而他要的是"这能干什么"。降到工况路之后**闸门一个字没动**：
       它照样要过闸 A（入参必须能在原话里找到），只是缺参数时先问，而不是直接拒答。
       ⚠ 判据 `isVagueScenario` 要求"余热实词 + 现场口吻"同时成立，所以
         「年运行小时默认多少」这类**真的知识问题**不会被抢走（它没有现场口吻）。 */
    if ((intent === "ask" || intent === "chat") && isVagueScenario(text)) {
      intent = "decide";
      yield step("classify", "这句话听起来是**你自己现场的一处余热**（有热源实词 + 有现场口吻），" +
        "不是问本项目的口径 —— 按工况路走：缺的参数我会问你，不会拿默认值糊过去", "warn");
    }
  } else {
    intent = routeIntent(text, prev);
    yield step("classify", "意图判定不可用，改用规则兜底", "warn");
  }

  const INTENT_CN = {
    chat: "普通对话（闲聊）", decide: "工况计算请求", ask: "知识/口径问题",
    /* G6：与上面三条并列的**第四类回答** —— 只在"这句话里有引擎管不着的关注点"时出现 */
    out_of_scope_partial: "有半边超出我能力边界的工况请求",
  };

  /* ── G6：**超出能力边界 ⇒ 分半回答**（2026-10-12 加）────────────────────────
     判据 `isOutOfScopePartial()` 是纯规则（领域词 + 权衡语义 + 与真实工况有关），
     与意图判定**叠加**而不是抢它的活：
       · 意图判成 chat 或 ask，但句子里确有引擎管不着的关注点 ⇒ **升到工况路**，
         再在这里分半（用户要的是"这半边能不能算"，不是一段口径长文）；
       · 意图判成 decide ⇒ 原样在这里分半。
     🔴 **只分半一次**（`prev.outOfScope` 那条）：紧随其后那一轮用户把参数补齐了，
        就该**照常算**，不能再分半一次 —— 否则用户永远走不到引擎那一步。
        分半回答**本身已经承担了**"把边界说清楚"这件事，重复说是骚扰不是诚实。
     🔴 它**不碰任何闸门**：这一段不调引擎、不检索、一个数都不产出。 */
  const oosHits = isOutOfScopePartial(text) ? outOfScopeHits(text) : [];
  const outOfScopePartial = oosHits.length > 0 && !(prev && prev.outOfScope);
  if (outOfScopePartial && (intent === "ask" || intent === "chat")) {
    intent = "decide";
    yield step("classify", "不过，这句话里有**我的引擎没有的物理量/关注点**（" +
      oosHits.map((h) => h.name).join("；") + "）—— 按纪律**升到工况路**并分半回答：" +
      "能算的那半照常问参数，不能算的那半点名说清。", "warn");
  }
  /* ⚠ 类别只宣布**一次**：分半是第四类回答，所以由它自己来宣布这一句，上面那句就不再重复。
     （两条都打印会出现"听懂了：这是一个「工况计算请求」"紧跟"听懂了：这是一个「有半边超出…」"，
      读起来像判了两次 —— 实测第一版就是这样。） */
  if (outOfScopePartial) {
    yield step("classify", "听懂了：这是一个「" + INTENT_CN.out_of_scope_partial + "」" +
      "（判据是规则：领域词 + 权衡语义同时成立，见 isOutOfScopePartial）", "warn");
  } else {
    yield step("classify", "听懂了：这是一个「" + INTENT_CN[intent] + "」" +
      (cls && cls.reason ? "（" + cls.reason + "）" : "（规则判定）"), "ok");
  }

  if (outOfScopePartial) {
    yield* outOfScopePartialStage({
      text, hits: oosHits, sess, llmOn, t0,
      /* ⚠ 缺哪些参数用 `missingForPartial()`（见那个函数上面那段"为什么"）——
         它与引擎的必填项口径一致，且**只产出字段名、不产出任何值**。 */
      missing: missingForPartial(text),
    });
    yield { type: "done", ms: Date.now() - t0 };
    return;
  }

  if (intent === "chat") {
    yield* chatStage({ text, sess, llmOn, t0, step });
    yield { type: "done", ms: Date.now() - t0 };
    return;
  }

  if (intent === "ask") {
    /* ── N1 快速通道（2026-10-12 加）：泛问「介绍一下这个项目」这类问题
       ⇒ 直接取手册里已定稿的那几节，**不检索、不调模型润色**（省掉最慢的那一跳）。
       ⚠ 判定放在**这里**（而不是塞进意图分类器）：分类器只判"这是知识问答"，
       "是哪一类知识问答"由这条确定性规则说了算（可复算、可自检）。
       ⚠ 拿不准的一律**不走**快速通道（isProjectOverviewQuestion 自带具体口径词的排他表），
         这样"年运行小时默认多少"这类要逐行出处的问题仍然走原来的检索路。 */
    if (isProjectOverviewQuestion(text)) {
      yield step("route", "这类问题是**项目概况**，走快速通道（手册开头已定稿，不需要现场组织语言）", "ok");
      yield* overviewStage({ text, sess, llmOn, t0 });
    } else {
      yield* askStage({ text, sess, llmOn, t0, step });
    }
    yield { type: "done", ms: Date.now() - t0 };
    return;
  }

  /* ---- 解析入参（LLM 唯一的"入口"用途） ---- */
  let raw = null;
  if (!llmOn) {
    yield step("parse", "AI 入口当前不可用（无网络/未配 key）——不假装还能解析。请用下方「直接填参数」或离线单文件页", "bad");
    yield { type: "offer", offline: true, href: "/offline-demo", title: "AI 入口当前不可用（无网络）" };
    yield { type: "error", message: "AI 入口当前不可用（无网络）。计算这条路仍然可用：点下方「直接填参数（不经过 AI）」按钮，或打开离线单文件演示页。" };
    /* ⚠ 离线时**也要给出口**（N4）：用户点不到"再算一次"，但"这个温区有什么边界"是本地知识、
       "给你一句工况"是入口提示 —— 这两条不依赖 AI，离线照样成立。 */
    yield { type: "next", chips: nextActionsFor({ intent: "decide", text, tempC: null, tempLit: tempLiteralOf(text), need: "none" }) };
    yield { type: "done", ms: Date.now() - t0 };
    return;
  }
  yield step("parse", "正在解析场景（大模型只做翻译，不许算数）…", "run");
  try {
    const j = await LLM.parseScene(text, contextDigest(prev));
    raw = {
      tempC: num(j["温度_degC"]), tempQuote: j["温度_原文"] == null ? null : String(j["温度_原文"]),
      tempOp: j["温度_运算"] == null ? null : String(j["温度_运算"]),
      flowValue: num(j["流量_数值"]), flowUnit: j["流量_单位"] == null ? null : String(j["流量_单位"]),
      flowQuote: j["流量_原文"] == null ? null : String(j["流量_原文"]),
      flowOp: j["流量_运算"] == null ? null : String(j["流量_运算"]),
      medium: j["载体"] == null ? null : String(j["载体"]),
      demand: j["需求"] == null ? null : String(j["需求"]),
      hours: num(j["年运行小时"]), hoursQuote: j["年运行小时_原文"] == null ? null : String(j["年运行小时_原文"]),
      hoursOp: j["年运行小时_运算"] == null ? null : String(j["年运行小时_运算"]),
      dT: num(j["换热端差_degC"]), dTQuote: j["换热端差_原文"] == null ? null : String(j["换热端差_原文"]),
      dTOp: j["换热端差_运算"] == null ? null : String(j["换热端差_运算"]),
      continuity: j["连续性"] == null ? null : String(j["连续性"]),
      rawJson: j,
    };
  } catch (e) {
    yield step("parse", "解析失败（" + e.code + "）", "bad");
    yield { type: "error", message: "自然语言解析失败（" + e.code + "）：" + e.message + "。计算这件事没坏——你可以用「直接填参数（不经过 AI）」，或打开离线单文件演示页。" };
    yield { type: "offer", offline: true, href: "/offline-demo", title: "解析不可用，可走不依赖 AI 的计算入口" };
    yield { type: "next", chips: nextActionsFor({ intent: "decide", text, tempC: null, tempLit: tempLiteralOf(text), need: "none" }) };
    yield { type: "done", ms: Date.now() - t0 };
    return;
  }

  /* ---- G5：**用户明确点选**工况库预设（chips 点下去发出来的那句话）----------------
     `detectPresetPick()` 是纯规则判定，可复算。它只做一件事：
     把"点选"这件事变成用户本轮**明确说出口的字面值**（chip 的 followup 里逐字带着温度与流量）。
     🔴 三道保险，一道都不许省：
       ① 被取用的每个数都必须能通过 `numberTraceableInUserText(v, text)` —— 也就是**本轮原话里
          逐字找得到**。找不到就整条不接受（退回普通解析路），绝不"反正点了就信"。
       ② 只取预设那一行**自己**的值，且**必须**同时有两个值才算命中（防止只带一个数就冒充点选）。
       ③ 先验区间里的**其它值**（上沿 400 之类）**根本不在这条通道里** —— 它们连候选都不是。
     来源标成「用户点选（预设）」而不是「你的原话（LLM 翻译）」：因为确实不是模型翻译出来的，
     而是用户点的那一下。数字本身照旧走闸 A 的同一套判定。 */
  const pick = detectPresetPick(text);
  if (pick) {
    yield step("parse", "你点的是**工况库里的预设**：" + pick.shape.main.name +
      "（" + pick.shape.main.t + "℃ / " + pick.shape.main.flow + " kg/s / 发电）—— " +
      "这句话里逐字带着这两个数，来源记为「用户点选」；引擎仍会重新算一遍", "ok");
    raw = pick.raw;
    yield { type: "plan_row", row: { field: "（来源）", value: null, source: "用户点选（工况库预设）",
      detail: "点选等于你**明确给了这两个数**；它们逐字出现在本轮原话里，所以走的是既有入参闸。先验区间里的其它值没有进来。" } };
  }

  const rs = resolveSceneNL(raw, text, prev);
  for (const l of rs.log) yield { type: "plan_row", row: l };

  if (!rs.frame && rs.errors.length) {
    /* ── G1：缺参数 ⇒ **先引导，不直接拒答**（2026-10-12 的本次主改动）──────────────
       判据：`missingKeyParams()` 只认"没听出温度/流量"这两条（与闸 A 的报错同源）。
       其余错误（数值被闸 A 丢弃、单位不在白名单、载体不在取值集）**照旧走下面的报错路** ——
       那些不是"你说不清"，而是"你说的这个数不能用"，必须如实说、不许被引导话术盖过去。 */
    const missing = missingKeyParams(rs);
    if (missing.length) {
      yield* guidanceStage({ text, sess, rs, missing, llmOn, t0, step });
      yield { type: "done", ms: Date.now() - t0 };
      return;
    }
    yield step("parse", "还差信息，不能进引擎：" + rs.errors.join(" "), "bad");
    yield { type: "error", message: rs.errors.join(" ") };
    /* ⚠ 这里**也要给"下一步"**（N4 的实际发现）：用户问「200℃ 的热水应该用于什么」时，
       引擎其实**算不了**（缺流量）——如果这时候不给任何可点的话，用户就卡在一个红色报错上。
       但给什么必须守规矩：`need:"none"`（不依赖本轮结论）的动作才给，
       "看 LCA / 换流量再算"这类依赖引擎结果的一律不给 —— 本轮什么都没算出来。 */
    yield { type: "next", chips: nextActionsFor({ intent: "decide", text, tempC: null, tempLit: tempLiteralOf(text), need: "none" }) };
    yield { type: "detail", parse: { raw: raw.rawJson, log: rs.log }, ledger: [] };
    yield { type: "done", ms: Date.now() - t0 };
    return;
  }  yield step("parse", "已解析出场景：" + sceneOneline(null, rs.frame) + (rs.usedPrev ? "（含由上文派生的字段⚠）" : ""), "ok");
  if (rs.usedPrev) {
    yield step("parse", "注意：本轮有字段来自上文 —— 已在「解析明细」里逐条标出来源" +
      (rs.prevQuotes && rs.prevQuotes.length ? "：「" + [...new Set(rs.prevQuotes)].join("」「") + "」" : ""), "warn");
  }
  if (rs.carried && rs.carried.length) {
    yield step("parse", "续问兜底：本轮没重述的 " + rs.carried.join("、") +
      " 已按上一轮的引擎实读值续用（逐条标为「由上文续用⚠」，本轮引擎仍会重新算）", "warn");
  }

  yield* engineStage({ rs, userText: text, sess, llmOn, noPolish: !!p.noPolish, t0, formPath: false, step, rawJson: raw.rawJson });
  yield { type: "done", ms: Date.now() - t0 };
}

/** scene 一行人话（用于步骤条） */
export function sceneOneline(scene, frame) {
  const t = scene ? scene["热源温度_degC"] : frame.t_src_degC;
  const m = scene ? scene["流量_kg_s"] : frame.m_dot_kg_s;
  const med = scene ? scene["载体"] : frame.medium;
  const dem = scene ? scene["需求"] : frame.demand;
  return "热源 " + fmt(t) + "℃ ｜ " + fmt(med) + " ｜ " + fmt(m) + " kg/s ｜ 需求=" + fmt(dem);
}

/* -------------------------------------------------------------- 直接入参（不经过 LLM） */

/**
 * 直接给引擎结构化入参并算一次。**这是"不经过 AI 的那条路"的单一实现**，
 * 被 `/api/decide`（旧端点）与对话流的结构化路径共用，避免两份实现漂移。
 * 成功返回 { ok:true, frame, scene, engineResult }，失败返回 { ok:false, error, frame }。
 */
export async function directDecision(rawScene, opts = {}) {
  const { callEngine, normalizeFrame, frameToScene } = await import("./engine_bridge.mjs");
  const rs = resolveSceneForm(rawScene || {});
  /* ⚠ 注意判据是 rs.frame（成功时返回的是遥测帧，不是 scene）——
     这里写 rs.scene 会永远为假，表现为"表单填了却算不出来"，是个安静的坑。 */
  if (!rs.frame) return { ok: false, error: rs.errors.join(" "), parseLog: rs.log, errors: rs.errors, warnings: rs.warnings };
  const frame = normalizeFrame(rs.frame);
  const scene = frameToScene(frame);
  const r = await serialized(() => callEngine(scene, { wantCertificate: opts.wantCertificate !== false }));
  return { ok: true, frame, scene, engineResult: r, parseLog: rs.log, errors: rs.errors, warnings: rs.warnings };
}

/* -------------------------------------------------------------- 引擎段 + 回答段 */

async function* engineStage({ rs, userText, sess, llmOn, noPolish, t0, formPath, step, rawJson }) {
  const S = (phase, txt, state) => ({ type: "step", phase, text: txt, state: state || "ok", at: Date.now() - t0 });

  /* 走官方适配层：遥测帧 → scene（走引擎自带的适配层），再调引擎 */
  const { callEngine, normalizeFrame, frameToScene } = await import("./engine_bridge.mjs");
  const frame = normalizeFrame(rs.frame);
  const scene = frameToScene(frame);
  if (frame.quality === "over_range") yield S("parse", "遥测帧校验判定：" + frame.error + "（引擎仍会照原话拒绝）", "warn");

  yield S("resolve", "正在调用决策引擎…", "run");
  const r = await serialized(() => callEngine(scene, { wantCertificate: true }));
  yield { type: "plan", scene: r.scene, sceneIn: scene, frame: { quality: frame.quality } };

  if (r.ok === false) {
    yield S("engine", "引擎抛错：" + r.error, "bad");
    yield { type: "error", message: r.error };
    yield { type: "done", ms: Date.now() - t0 };
    return;
  }
  if (r.out_of_scope) {
    yield S("engine", "引擎明确拒绝：" + r.message, "bad");
    const tplEv = answerEvent(renderTemplate(r, rs.log), "template", citationsOf(r, rs.log));
    const tpl = tplEv.markdown;
    yield tplEv;
    yield { type: "next", chips: nextActionsFor({ intent: "decide", text: userText, tempC: null, tempLit: tempLiteralOf(userText), need: "none" }) };
    yield { type: "detail", ledger: [], certificate: null, engineRaw: r, parse: { log: rs.log, raw: rawJson || null }, scene: r.scene };
    Session.appendTurn(sess.id, {
      userText, scene: r.scene, engine: { outOfScope: true, message: r.message },
      certificate: null, answer: tpl, ledger: [], engineNumbers: [], inputNumbers: inputNumbersOf(rs.log),
      inputLog: rs.log, degraded: !llmOn,
    });
    yield { type: "turn_saved", sessionId: sess.id, turns: Session.getSession(sess.id).turns.length };
    return;
  }

  const nCand = (r.engine.keys || []).length;
  const topLabel = r.engine.topLabel;
  const topFit = r.engine.order && r.engine.order[0] ? r.engine.order[0].closeness : null;
  yield S("engine", "引擎返回：" + nCand + " 条候选，推荐 **" + topLabel + "**，贴近度 " + fmt(topFit), "ok");

  /* ---- 数字来源台账（逐个字段注明出处） ---- */
  const ledger = ledgerOf(r);
  if (!ledger.length) yield S("verify", "本轮引擎返回体里没有可登记的数字", "warn");
  else yield S("verify", "正在校验数字来源…" + ledger.length + " 项，全部可溯源 ✓（语料＝本轮引擎返回体 + 本轮解析派生式）", "ok");

  /* ---- 证书 ---- */
  const c = r.certificate && !r.certificate.error ? r.certificate : null;
  if (c) {
    const flips = (c.flippedProbes || []);
    yield S("cert", "决策证书：" + c.total + " 项扰动中有 " + c.flips + " 项会翻转" +
      (flips.length ? " —— " + flips.map((p) => p.name + " → " + p.label).join("；") : "（没有翻转项）"),
      c.flips ? "warn" : "ok");
  } else {
    yield S("cert", "本轮没有拿到决策证书（引擎未返回或抛错），回答里将不包含证书段", "warn");
  }

  /* ---- 模板正文 = 数字的唯一来源 ---- */
  const contextNote = rs.usedPrev
    ? "本轮有字段来自上一轮（" + [
        ...(rs.prevQuotes && rs.prevQuotes.length ? ["照抄引用「" + [...new Set(rs.prevQuotes)].join("」「") + "」"] : []),
        ...(rs.carried && rs.carried.length ? ["续用 " + rs.carried.join("、")] : []),
      ].join("；") + "），该依赖已在上方步骤与「解析明细」中标出。"
    : null;
  const tpl = renderTemplate(r, rs.log, { contextNote });

  // 先交付本轮已经核验的引擎原文，再等待可选的措辞整理。
  // 与 answer 分开，保留旧客户端/旧接口每轮只有一个最终 answer 的语义。
  const initialVerify = verifyAnswer(tpl, r, rs.log, { corpus: tpl });
  if (initialVerify.ok && !noPolish && llmOn) {
    const initial = answerEvent(tpl, "template", citationsOf(r, rs.log));
    yield { ...initial, type: "result", source: "engine", verify: initialVerify, at: Date.now() - t0 };
  }

  /* ---- 可选：交给大模型换个说法（必须过闸 B） ---- */
  let answer = tpl, mode = "template", llmNote = null, verify = null;
  if (!noPolish && llmOn) {
    yield S("compose", "正在组织正式回答（只许改措辞，不许改数）…", "run");
    const pol = await LLM.composeAnswer(tpl, { userText, digest: contextDigest(Session.lastTurn(sess.id)) });
    if (pol.ok && pol.text) {
      /* 闸 B 的语料 = 模型实际看到的那份模板正文（tpl），不是全精度返回体 —— 见 verifyAnswer 的说明 */
      verify = verifyAnswer(pol.text, r, rs.log, { corpus: tpl });
      if (verify.ok) {
        answer = pol.text; mode = "llm";
        yield S("gate", "数字回查通过：回答里 " + verify.numbers.checked + " 个数字全部出现在**本轮**引擎原文中" +
          (verify.facts.length ? "" : "；关键事实（推荐路径名/候选条数）与引擎一致"), "ok");
      } else {
        yield S("gate", "回答被数字闸门拦下，退回引擎模板句（" +
          (verify.numbers.missing.length ? "越界数字 " + verify.numbers.missing.slice(0, 6).join("/") : "") +
          (verify.facts.length ? (verify.numbers.missing.length ? "；" : "") + verify.facts[0] : "") + "）", "warn");
        llmNote = { rejected: true, missing: verify.numbers.missing, facts: verify.facts };
      }
    } else {
      yield S("compose", "措辞改写未采用（" + (pol.reason || "模型未返回内容") + "），直接展示引擎模板句", "warn");
      llmNote = { rejected: true, missing: pol.dropped || [], facts: [], reason: pol.reason || null };
    }
  } else if (!llmOn) {
    yield S("compose", "离线降级：不调用改写，直接展示引擎模板句（结论完全一致）", "warn");
  }

  verify = verify || verifyAnswer(answer, r, rs.log);
  /* 🔴 N2：正文过一遍内部标识降级。⚠ 必须在 verify 之后做 ——
     闸 B 的语料是**模型看到的模板正文**（tpl），降级只发生在"最终给人看的那一份"上；
     数字一个不动，所以 verify 的结论对降级后的正文同样成立（`_t_hygiene` 会断言这一点）。 */
  const decideEv = answerEvent(answer, mode, citationsOf(r, rs.log));
  answer = decideEv.markdown;
  yield decideEv;
  yield {
    type: "verify",
    checked: verify.numbers.checked,
    missing: verify.numbers.missing,
    scope: verify.scope,
    anchors: factAnchors(r),
    rejected: !!(llmNote && llmNote.rejected),
  };
  /* N4：工况之后的"下一步" —— 只从白名单里挑，且"换个温度"这类参数位取自本轮解析结果 */
  yield {
    type: "next",
    chips: nextActionsFor({ intent: "decide", text: userText, tempC: (r.scene && r.scene["热源温度_degC"]) || null, tempLit: tempLiteralOf(userText) }),
  };
  yield {
    type: "detail", ledger, certificate: c, engineRaw: r,
    parse: { log: rs.log, raw: rawJson || null }, scene: r.scene,
    boundaryNotices: r.boundaryNotices || [], warnings: r.warnings || [],
  };

  Session.appendTurn(sess.id, {
    userText, scene: r.scene,
    engine: { top: r.engine.top, topLabel, candidates: nCand, closeness: topFit, recoveredKw: r.engine.recoveredKw },
    certificate: c ? { total: c.total, flips: c.flips, statement: c.statement } : null,
    answer, ledger,
    engineNumbers: verify.corpusTokens,     // 报告用：本轮**引擎算出来**的数字
    inputNumbers: inputNumbersOf(rs.log),   // 下一轮允许被引用的白名单
    inputLog: rs.log, degraded: !llmOn,
  });
  yield { type: "turn_saved", sessionId: sess.id, turns: Session.getSession(sess.id).turns.length };
}

/** 闲聊段（**真调 DeepSeek 的一次普通对话补全**；不碰引擎、不出证书、不显示工况那串步骤）──
 *
 * 用户明确要求：像「你好」这种话，要「进入正常的聊天」，而且「正常的去用我的 API，
 * 接入 DeepSeek 对他进行回答」——所以这里**真的发一次 chat completion**，把模型的话显示出来，
 * **不是**规则/模板糊一句。
 *
 * 事件上刻意**极简**（这是用户第二条要求）：
 *   只有 {session} → 一条 "正在回复…" 的 step → {answer} → {turn_saved} → {done}。
 *   **没有** "正在解析场景" / "正在调用决策引擎" / "决策证书" / "数字来源" 那些东西 ——
 *   那是工况路径的，闲聊不该出现。
 *
 * 唯一的闸门：`isSafeChatReply()`。它拦的是"模型凭记忆报本项目的数"，
 * 因为闲聊这条路没有引擎语料可核，不拦就成了绕过数字纪律的口子。拦下 ⇒ 反问一句，不装成模型的回答。
 */
/* ================================================== F1：meta 段（「关于你自己」）
 *
 * 🔴 这一段的答案**由模板产出**：不检索（不碰 BM25）、不调模型（不润色、不自由发挥）。
 *    理由不是省时间，是**可信度**：问"你怎么工作的"最忌讳用一段模型现编的话去回答 ——
 *    那正好自证"我确实在编"。模板句是可以逐条对着代码核的。
 *
 * ⚠ 正文里**刻意不写** `**` / `##` / `<br>`：这一段是"讲纪律"的，自己就更不该
 *   把没渲染的标记露在页面上（走 answerEvent 时还会再过一遍 renderSafeAnswer）。
 */
export function metaWorkflowAnswer() {
  return [
    "我的工作过程是一条固定的六步流水线。大模型只做「翻译」和「换说法」，数字一律由引擎算出来 —— " +
      "这也是它和普通计算器最大的不同：计算器只算不解释，我会先把你的话翻译成入参、算完再把每个数的出处交出来。",
    "",
    "1. 把你的话翻译成引擎入参 —— 大模型只做翻译，不许算数。",
    "2. 入参里每个数逐字核对你的原话 —— 对不上就不许进引擎。",
    "3. 调 WHENG.runDecision() 真算一遍 —— 结论来自引擎返回体，不来自语言模型。",
    "4. 把引擎返回的每个数登记出处 —— 每个数都要能指回返回体里的哪个字段。",
    "5. 回答里每个数字再回查一遍 —— 对不上就整段退回模板句。",
    "6. 先验只用来提问，不用来出数 —— 它在结构上就进不了引擎。",
    "",
    "这一段是模板直接产出的：没有检索、也没有让模型自由发挥，所以它编不出数来。",
  ].join("\n");
}

async function* metaStage({ text, sess, llmOn, t0 }) {
  const S = (phase, txt, state) => ({ type: "step", phase, text: txt, state: state || "ok", at: Date.now() - t0 });
  yield S("meta", "这是「关于你自己怎么工作」的问题 —— 走**模板**：不检索、不调模型润色" +
    "（用模型现编一段话去回答「你怎么保证不编数」，本身就不成立）", "ok");
  const ev = answerEvent(metaWorkflowAnswer(), "meta", [], { keepNames: [/WHENG\.runDecision\(\)/g] });
  yield ev;
  yield {
    type: "verify", checked: 0, missing: [],
    scope: "工作流模板（**不经检索、不经模型生成**；因此不涉及任何引擎数字，也就没有可越界的数）",
    anchors: [], rejected: false,
  };
  yield S("meta", "六步工作流模板已产出（未检索、未调用模型）", "ok");
  yield { type: "next", chips: nextActionsFor({ intent: "chat", text }) };
  yield { type: "detail", ledger: [], parse: { log: [], raw: null }, meta: { template: true, steps: 6 } };
  Session.appendTurn(sess.id, {
    userText: text, engine: { kind: "meta", template: true }, certificate: null,
    answer: ev.markdown, ledger: [], engineNumbers: [], inputNumbers: [], inputLog: [], degraded: !llmOn,
  });
  yield { type: "turn_saved", sessionId: sess.id, turns: Session.getSession(sess.id).turns.length };
}

async function* chatStage({ text, sess, llmOn, t0, step }) {
  const S = (phase, txt, state) => ({ type: "step", phase, text: txt, state: state || "ok", at: Date.now() - t0 });

  if (!llmOn) {
    yield S("chat", "AI 入口当前不可用（无网络/未配 key）—— 闲聊这条路需要真的调一次模型，不能假装还能聊", "bad");
    yield { type: "offer", offline: true, href: "/offline-demo", title: "AI 入口当前不可用（无网络）" };
    yield { type: "error", message: "AI 入口当前不可用（无网络）。闲聊与工况解析都需要调用 DeepSeek；离线时仍可用「直接填参数（不经过 AI）」或打开离线单文件演示页。" };
    /* ⚠ 离线时也把"下一步"给出去（N4）：闲聊走不了，但入口提示与本地知识问答照样成立 ——
       比让用户对着一条红字干瞪眼强。 */
    yield { type: "next", chips: nextActionsFor({ intent: "chat", text, need: "none" }) };
    yield { type: "done", ms: Date.now() - t0 };
    return;
  }

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  yield S("chat", "正在回复…", "run");

  let reply = null, err = null, gate = null;
  try {
    /* 第一次：真的调模型 */
    reply = await LLM.chatReply(text, contextDigest(Session.lastTurn(sess.id)));
    gate = isSafeChatReply(reply);
    if (!gate.ok) {
      /* 闸门拦下 ⇒ **带着具体理由再问模型一次**（仍是真调模型，不是换模板） */
      yield S("chat", "闲聊回答被安全闸门拦下（" + gate.why + "），已让它换个说法重答一次", "warn");
      await delay(60);
      const retry = await LLM.chatReply(
        text + "\n\n（上一条回复里出现了不该出现的具体数字或内部名词。请完全不要提任何数字、" +
        "也不要提文件/台账/证书/包络这类内部说法，就自然地把这句寒暄接住。）",
        ""
      );
      const g2 = isSafeChatReply(retry);
      if (g2.ok) { reply = retry; gate = g2; }
      else { yield S("chat", "第二次仍被拦下（" + g2.why + "），改为一句反问", "warn"); reply = null; }
    }
  } catch (e) {
    err = e;
    yield S("chat", "调用 DeepSeek 失败（" + (e.code || "error") + "），未编造回复", "bad");
  }

  const usedLlm = !!reply;
  const md = usedLlm ? reply : (err
    ? "没能连上 DeepSeek，所以这句我没法回你。\n\n原因：" + String(err.message || err).slice(0, 200) +
      "\n\n（其余入口照常：给一句工况描述我可以算；问项目口径我可以查知识库并给出处。）"
    : chatClarifyText());

  const chatEv = answerEvent(md, usedLlm ? "chat" : "chat-fallback", []);
  yield chatEv;
  yield {
    type: "detail",
    chat: {
      byModel: usedLlm, mode: usedLlm ? "llm" : (err ? "llm_error" : "gate_rejected"),
      reason: usedLlm ? null : (err ? String(err.message || err).slice(0, 200) : (gate && gate.why) || "未通过安全闸门"),
      gate: gate ? { ok: gate.ok, why: gate.why || null } : null,
    },
    ledger: [], parse: { log: [], raw: null },
  };
  /* N4：闲聊之后只给"系统真能做"的下一步（闲聊之后**不许**出现工况类 chip —— 那会诱导用户以为我们算过什么） */
  yield { type: "next", chips: nextActionsFor({ intent: "chat", text }) };
  Session.appendTurn(sess.id, {
    userText: text, chat: true, scene: null,
    engine: { kind: "chat", byModel: usedLlm }, certificate: null, answer: chatEv.markdown, ledger: [],
    engineNumbers: [], inputNumbers: [], inputLog: [], degraded: !usedLlm,
  });
  yield { type: "turn_saved", sessionId: sess.id, turns: Session.getSession(sess.id).turns.length };
}

/** 知识问答段（RAG）—— 与决策同一套"步骤看得见"的形式。
 *
 * 🔴 N2（2026-10-12）：**正文不再吐出检索原文的出处行**（那些 `文件:行号`、`items[n]`
 *    正是用户说的"很凌乱"）。出处改由 `citations` + `detail.hits` 承载，
 *    前端渲染成回答下面的「出处」折叠块。
 *    ⚠ 数字闸门一字未改：语料仍是**检索到的原文片段**（`tpl`），
 *      所以"答复里的数字必须能在原文里找到"这条照样成立。
 */
async function* askStage({ text, sess, llmOn, t0, step }) {
  const { search, forbiddenHit } = await import("./rag.mjs");
  const S = (phase, txt, state) => ({ type: "step", phase, text: txt, state: state || "ok", at: Date.now() - t0 });
  yield S("rag", "正在检索知识库（BM25，本地离线，不联网）…", "run");
  const hits = search(text, { topK: 5 });
  const f = forbiddenHit(text);
  if (f) yield S("rag", "命中「不得引用」条目 " + f.items.length + " 处 —— 按项目纪律不展示其内容，只告知存在位置", "warn");
  if (!hits.length) {
    yield S("rag", "知识库里没有检索到相关片段（换个说法，或用「边界与口径」看全量）", "warn");
    const md = "知识库里没有检索到与「" + text + "」相关的内容。\n\n可以换个说法，或直接在对话里给一个工况（例如「320℃ 的窑炉烟气，流量 1.2 万标方每小时，想发电」），我让引擎算一遍。";
    const noHitEv = answerEvent(md, "template", []);
    yield noHitEv;
    yield { type: "next", chips: nextActionsFor({ intent: "ask", text }) };
    yield { type: "detail", ledger: [], parse: { log: [], raw: null }, hits: [] };
    Session.appendTurn(sess.id, { userText: text, engine: { kind: "qa", hits: 0 }, answer: noHitEv.markdown, ledger: [], engineNumbers: [], inputNumbers: [], inputLog: [], degraded: !llmOn });
    yield { type: "turn_saved", sessionId: sess.id, turns: Session.getSession(sess.id).turns.length };
    return;
  }
  /* 步骤里也不再列一串路径，只报条数与最高权威级别 */
  const nAuth = hits.filter((h) => h.chunk.authority === 1).length;
  yield S("rag", "检索到 " + hits.length + " 个片段" + (nAuth ? "（其中 " + nAuth + " 条来自权威台账/边界文件）" : "") +
    "，逐条出处见回答下方的「出处」折叠块", "ok");

  /* 🔴 N2：知识问答的正文这里有个**两个用途打架**的问题，值得写清楚：
       · 送给模型（以及当闸 B 语料）的文本要**带上片段身份**（"关于「年运行小时默认值…」"），
         否则模型不知道这段是讲什么的；
       · 直接给用户看的兜底正文**不能**照抄台账的表格行（`| 1 | **年运行小时** | 8000 → 7000 |`）
         —— 那就是用户说的"很凌乱"。
     所以做成两份：`tpl`（语料 = 模型看到的）与 `fallback`（兜底正文，自然语言 + 权威级别标注）。
     **两份的数字完全一致**，闸 B 对谁成立对另一份就成立（自检里有一条专门断言这件事）。 */
  const stripPipes = (s) => String(s).replace(/\|/g, " ").replace(/\s{2,}/g, " ").trim();
  const tpl = hits.map((h) => (h.chunk.item ? "关于「" + h.chunk.item + "」：" : "") + stripPipes(h.chunk.text)).join("\n\n");
  /* 🔴 F3（2026-10-12）：正文里**不再**印「（来源：项目知识手册 / 权威台账·边界文件）」。
     用户报的原话就是这两句直接印在正文里。出处一律搬到 answer.citations，
     由前端渲染成下方「出处（N 条）」折叠块（app.js:renderCites 已经支持）。
     ⚠ 权威级别**不能丢** —— 它原来就在这行里，所以搬进 citationsFromHits 的 what 前缀
       （authority===1 是权威台账/边界文件，2 是项目知识手册）。 */
  const fallback = hits.map((h) => {
    const c = h.chunk;
    return "**" + (c.item ? c.item : (c.heading || c.title)) + "** —— " + stripPipes(c.scope || c.text);
  }).join("\n\n");
  const cites = [...new Set(hits.map((h) => h.chunk.cite))];
  let answer = fallback, mode = "template", ver = null;

  // 检索原文及其出处先展示；不提前输出未经核验的模型生成内容。
  const initialVerify = LLM.verifyNumbers(fallback, tpl);
  if (llmOn && initialVerify.ok) {
    const initial = answerEvent(fallback, "template", citationsFromHits(hits));
    yield { ...initial, type: "result", source: "knowledge", verify: initialVerify, at: Date.now() - t0 };
  }

  if (llmOn) {
    yield S("compose", "正在整理成通顺答复（只许改措辞，不许改数）…", "run");
    const pol = await LLM.polish(tpl, "把它整理成 2~4 句通顺的中文答复。只许改措辞、不许改数；不要写文件名、路径或行号（出处会由界面单独展示）。");
    if (pol.polished) {
      /* 知识问答的语料 = 检索到的原文片段（**不含任何引擎数字**，也不含历史轮次） */
      ver = verifyNumbers(pol.text, tpl);
      if (ver.ok) { answer = pol.text; mode = "llm"; yield S("gate", "数字回查通过：" + ver.checked + " 个数字全部能在检索原文里找到", "ok"); }
      else { yield S("gate", "答复里出现检索原文中没有的数字，整段润色已丢弃：" + ver.missing.slice(0, 6).join("/"), "warn"); }
    } else {
      yield S("compose", "未采用改写（" + (pol.reason || "") + "），直接展示检索原文", "warn");
    }
  } else {
    yield S("compose", "离线降级：不调用改写，直接展示检索原文", "warn");
  }
  /* 兜底：无论走模板还是润色，正文都再过一遍内部标识降级（N2 的硬要求） */
  const askEv = answerEvent(answer, mode, citationsFromHits(hits));
  answer = askEv.markdown;
  yield askEv;
  yield {
    type: "verify", checked: (ver ? ver.checked : 0), missing: (ver ? ver.missing : []),
    scope: "检索到的原文片段（不含引擎数字，也不含历史轮次）", anchors: cites, rejected: mode !== "llm",
  };
  yield { type: "next", chips: nextActionsFor({ intent: "ask", text }) };
  yield {
    type: "detail", ledger: [], parse: { log: [], raw: null },
    hits: hits.map((h) => ({ cite: h.chunk.cite, score: +h.score.toFixed(3), authority: h.chunk.authority, source: h.chunk.title, text: h.chunk.text.slice(0, 1200) })),
    forbidden: f,
  };
  Session.appendTurn(sess.id, { userText: text, engine: { kind: "qa", hits: hits.length }, answer, ledger: [], engineNumbers: [], inputNumbers: [], inputLog: [], degraded: !llmOn });
  yield { type: "turn_saved", sessionId: sess.id, turns: Session.getSession(sess.id).turns.length };
}

/* ================================================== 项目概况快速通道（N1）
 *
 * 用户报的现象：「让他介绍一下这个项目，他就会思考很长的时间」——
 * 2026-10-12 实测：**115.4 秒**。原因见 rag.mjs:handbookOverview() 上面那段注释：
 * 泛问被 BM25 召回一堆零散片段，再送去让模型润色（25 s 超时 + 分块重试），
 * 而"项目是什么"的权威答案**手册开头就写好了**。
 *
 * 这条路做的事只有三件：
 *   ① 从手册取**具名小节**的原文（不经模型、不摘要、不改写）；
 *   ② 拼成正文（只加小标题，让"一句话 / 三个数字 / 三十秒版 / 两个痛点"分得清）；
 *   ③ 出处塞进 `citations`，前端渲染成折叠块。
 * 没有 LLM 调用 —— 所以它才可能做到"秒回"，也才不可能编数。
 *
 * ⚠ 数字纪律：正文里的每个数字都**逐字来自手册那几节**（不是我们算的、也不是模型写的）；
 *   命中的小节若含「不得引用」，rag.handbookOverview() 会整节剔除并**如实报出**。
 */
async function* overviewStage({ text, sess, llmOn, t0 }) {
  const { handbookOverview } = await import("./rag.mjs");
  const S = (phase, txt, state) => ({ type: "step", phase, text: txt, state: state || "ok", at: Date.now() - t0 });

  yield S("overview", "识别为「项目概况」问题 —— 走**快速通道**：直接取知识手册开头的定稿段落，" +
    "不检索、不调模型润色（省掉最慢的那一跳）", "ok");
  const ov = handbookOverview();
  if (!ov.items.length) {
    yield S("overview", "手册里没取到概况小节（文件缺失或整节被「不得引用」拦下），退回检索", "warn");
    yield* askStage({ text, sess, llmOn, t0, step: null });
    return;
  }
  if (ov.skipped.length) {
    yield S("overview", "有 " + ov.skipped.length + " 个小节按纪律剔除：" +
      ov.skipped.map((s) => s.heading + "（" + s.reason + "）").join("；"), "warn");
  }
  yield S("overview", "取到手册 " + ov.items.length + " 个小节（" +
    ov.items.reduce((a, x) => a + x.text.length, 0) + " 字符），全部**原样引用**、未做改写", "ok");

  /* 正文：只加小标题 + 手册原文。⚠ 手册里那段"两条台账分工/是否补登"的登记性说明
     属于**内部登记过程**，不是给外部读者看的项目介绍 —— 概览里摘掉那一句（原文仍在
     detail 里可查）。同样处理 §11.1 的待定说明。

     🔴 2026-10-13（手册换到 10-13 版时实测踩到，e2e ⑫ 当场变红）：
     新版 §2.2 多了一段**行业总量数字的内部登记说明**——它写在引用块里，正文含
     「**《对外数字台账》里没有行**」「【待补台账】」「`方案缺陷审查报告_2026-08-10.md:14`」，
     全是**内部标识**，直接违反"正文里不许出现台账名/文件名/行号"。
     ⇒ 加一条**结构性**规则（不是逐句硬编码）：**按"块"处理 —— 只要一块里提到内部台账，
     整块摘掉**。判定词就是那几本台账的名字与登记状态词；块的分隔既认空行、也认"只有 `>` 的
     引用块内空行"（手册里同一段引用块常用 `>` 分行，所以"四痛点→三分法"那句与"行业总量登记"
     说明其实是两块，能分开处置）。
     ⚠ 为什么必须**整块**摘、不能只删命中的那几行：第一版就是逐行删的，实测留下
     "…37%、14.2%、/ 那份台账只登记文献题录级引用…不补登。）" 这种**半截话** ——
     比不删更糟。摘块虽然多删一点，但留下的是**完整可读**的段落。

     ⚠ 刻意**保住**「原来的"四个痛点"已按 P2 决定改成上面的三分法」那一块（它不提台账，
     而且它正是防止答成旧口径的那句）。 */
  const INTERNAL_BOOKKEEPING = /(《对外数字台账》|《数据来源台账》|《引用台账》|【待补台账】|方案缺陷审查报告)/;
  /** 把 markdown 切成"块"：空行分隔；**只有 `>` 的行**也算分隔（引用块内空行）。 */
  const splitBlocks = (s) => String(s).split(/\r?\n/).reduce((acc, line) => {
    if (!line.trim() || /^\s*>\s*$/.test(line)) acc.push(null);
    else { if (!acc.length || acc[acc.length - 1] === null) acc.push([]); acc[acc.length - 1].push(line); }
    return acc;
  }, []).filter((b) => Array.isArray(b) && b.length).map((b) => b.join("\n"));
  const dropNotes = (s) => String(s)
    .replace(/（⚠ 曾有一条[^）]*）/g, "")
    .replace(/《引用台账》里查不到它们[^。]*。/g, "")
    .replace(/^\s*其他数字都可以查表[^\n]*$/gm, "")
    /* 整块摘掉"谈内部台账登记状态"的块（原文仍在 detail 里可查，不丢证据） */
    .split(/\n\s*\n/)
    .flatMap(splitBlocks)
    .filter((block) => !INTERNAL_BOOKKEEPING.test(block))
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const L = [];
  const order = ["0.2", "2.1", "2.2", "0.3"];
  const label = (h) => {
    if (/0\.2/.test(h)) return "一句话讲清";
    if (/0\.3/.test(h)) return "必须记住的三个数字";
    if (/2\.1/.test(h)) return "三十秒版";
    if (/2\.2/.test(h)) return "两分钟版（三个卡点）";
    return h;
  };
  for (const key of order) {
    const it = ov.items.find((x) => x.heading.includes(key));
    if (!it) continue;
    L.push("### " + label(it.heading));
    L.push("");
    L.push(dropNotes(it.text));
    L.push("");
  }
  const ovEv = answerEvent(L.join("\n").trim(), "handbook", ov.items.map((it) => ({ what: it.heading, where: it.cite, kind: "knowledge" })));
  let answer = ovEv.markdown;
  yield ovEv;
  yield {
    type: "verify", checked: 0, missing: [],
    scope: "知识手册开头的定稿小节（**原样引用，未经过任何模型生成**；因此「每个数字都能在原文里逐字找到」这条对它是构造性成立的）",
    anchors: ov.items.map((it) => it.heading), rejected: false,
  };
  yield { type: "next", chips: nextActionsFor({ intent: "ask", text }) };
  yield {
    type: "detail", ledger: [], parse: { log: [], raw: null },
    hits: ov.items.map((it) => ({ cite: it.cite, score: null, authority: 2, source: "项目知识手册 v4", text: it.text })),
    overview: { fastPath: true, sections: ov.items.map((x) => x.heading), skipped: ov.skipped },
  };
  Session.appendTurn(sess.id, {
    userText: text, engine: { kind: "overview", sections: ov.items.length }, answer, ledger: [],
    engineNumbers: [], inputNumbers: [], inputLog: [], degraded: false,
  });
  yield { type: "turn_saved", sessionId: sess.id, turns: Session.getSession(sess.id).turns.length };
}

/* ============================================================== 台账与锚点 */

/** 本轮入参里"已经落成 scene"的数字（下一轮允许被引用的白名单） */
export function inputNumbersOf(log) {
  const out = [];
  for (const l of (log || [])) if (l.value != null) out.push(String(l.value));
  return [...new Set(out)];
}

/** 把引擎对象摊平成 {量, 值, 单位, 出处} —— "数字全来自引擎"的证据表 */
export function ledgerOf(r) {
  const rows = [];
  const add = (name, value, unit, src) => {
    if (value === null || value === undefined || (typeof value === "number" && !isFinite(value))) return;
    rows.push({ name, value, unit: unit || "", source: src });
  };
  if (!r || !r.ok) return rows;
  add("λ（主观权重占比）", r.lam, "", "HFDATA.lam0");
  if (r.engine) {
    add("可回收热功率", r.engine.recoveredKw, "kW", "WHENG.recoveredHeatKw(scene)");
    for (const o of (r.engine.order || [])) {
      const label = r.engine.labels[r.engine.keys.indexOf(o.path)] || o.path;
      add(label + " · TOPSIS 贴近度", o.closeness, "", "runDecision().order[i].closeness");
      (o.row || []).forEach((v, j) => add(label + " · " + (r.engine.indicators[j] || ("指标" + j)), v, "", "runDecision().X[i][" + j + "]"));
    }
  }
  if (r.certificate && !r.certificate.error) {
    add("证书扰动项数", r.certificate.total, "项", "decisionCertificate().total");
    add("证书翻转项数", r.certificate.flips, "项", "decisionCertificate().flips");
    for (const p of (r.certificate.flippedProbes || [])) add("翻转项：" + p.name, p.label, "", "decisionCertificate().probes[]");
    for (const a of (r.certificate.assumptions || [])) if (typeof a.value === "number") add("假设 " + a.name, a.value, "", "decisionCertificate().assumptions[" + a.key + "].value");
  }
  return rows;
}

/** 关键事实锚点：回答里必须与引擎一致的几处（供界面"抽查"展示） */
export function factAnchors(r) {
  if (!r || !r.ok || r.out_of_scope) return [];
  const a = [];
  a.push({ name: "推荐路径", value: r.engine.topLabel, source: "runDecision().topLabel" });
  a.push({ name: "候选条数", value: String((r.engine.keys || []).length), source: "runDecision().keys.length" });
  if (r.engine.order && r.engine.order[0]) a.push({ name: "首位贴近度", value: String(r.engine.order[0].closeness), source: "runDecision().order[0].closeness" });
  if (r.certificate && !r.certificate.error) a.push({ name: "证书扰动 / 翻转", value: r.certificate.total + " / " + r.certificate.flips, source: "decisionCertificate()" });
  return a;
}

/* ========================================== N4：回答后的「下一步」chips（白名单）
 *
 * 用户要的是「像豆包那样，答完之后后面给几个提示」。他举的例子是
 * 「下一步提示要不要生成 LCA 动态图」。
 *
 * 🔴 但**本系统没有"动态图"这个能力** —— 不能为了迎合例子就假装有。
 *    所以这里把「下一步」做成一张**白名单表**：每一条都对应一个**系统真能做**的动作，
 *    而"真能做"的定义是**可执行的**：点下去 = 把那句话当作下一轮输入，
 *    而那句话必须能被现有的规则路由接住并走到正确的那条路（工况 / 知识问答 / 闲聊）。
 *
 * 三条硬规矩：
 *   ① **不许 LLM 生成**：候选只能从下面这张表里挑，每次最多 4 条、至少 2 条；
 *      挑不出 2 条就**只给 1 条**，连 1 条都没有就**不给**（宁少勿假）。
 *   ② **可验证**：`nextActionVerdict()` 判定"这句话在不在白名单里"，
 *      自检用它对每个 chip 做正向断言，并用一个伪造 chip（「生成动态图」）做**反向变异**。
 *   ③ **有前提的不给**：需要某个数值才能成立的 chip（"把热源温度改成 X"），
 *      X 只在**用户原话里真的出现过**时才给 —— 我们不许替用户编一个数。
 *
 * ⚠ 这张表是**能力清单**，不是**话术清单**：加一条之前先问"点了它系统真的会做这件事吗"。
 *    当前系统的全部能力就是三条路：算工况（引擎）/ 查知识库（带出处）/ 闲聊。
 */

/** 把用户原话里的数字 token 拿出来（用于"需要前提"的 chip，绝不自己编数） */
function userNumberLiterals(userText) {
  return numbersOf(userText).filter((x) => x.length <= 6);
}

export const NEXT_ACTIONS = [
  /* ---- 工况之后 ---------------------------------------------------------- */
  {
    id: "lca",
    label: "看这台机组的年降碳量（LCA 口径）",
    routes: ["decide"],
    need: "result",   /* 它说的是"**这台**机组" —— 本轮没算出结论就不能说 */
    test: (c) => c.intent === "ask" && /降碳|减碳|碳排放|碳口径/.test(c.text),
    /* ⚠ 这条只敢承诺"讲清 LCA 口径与逐项因子"，**不敢**承诺"给你算出这台机组的降碳量" ——
       因为 LCA 的逐机组年降碳量要跑动态核算那套，对话入口目前没接它（见 README 已知限制）。 */
    honest: "只讲清口径与因子来源；逐机组年降碳量要跑项目的动态核算模块，本入口没接。",
    followup: "这台机组的年降碳量按 LCA 口径怎么讲、有哪些边界要注意",
  },
  {
    id: "reflow",
    label: "换个流量再算一次（说个数就行）",
    routes: ["decide"],
    need: "result",
    test: (c) => c.intent === "ask" && /^流量/.test(c.text),
    followup: "流量"
  },
  {
    id: "boundary",
    label: "这个温区有什么边界要注意",
    routes: ["decide"],
    need: "none",   /* 边界口径是**静态知识**，不依赖本轮算没算出来 */
    test: (c) => c.intent === "ask" && /边界|包络|限制/.test(c.text),
    followup: "温度包络与边界有哪些",
  },
  {
    id: "cert",
    label: "展开这条推荐的决策证书",
    routes: ["decide"],
    need: "result",   /* "**这条**推荐"指的就是本轮算出来的那条 */
    test: (c) => c.intent === "ask" && /证书/.test(c.text),
    followup: "证书扰动多少项、几项会翻转",
  },
  {
    id: "retemp",
    /* ⚠ 参数位只在**用户原话里真的出现过温度**时才填（tempLit 由本轮解析结果带进来），
       我们不许替用户编一个数。 */
    label: (c) => (c.tempLit ? "把热源温度改成 " + c.tempLit + " ℃再算" : null),
    routes: ["decide"],
    need: "result",
    test: (c) => c.intent === "decide" && c.tempC != null,
    mk: (c) => "把热源温度改成 " + c.tempLit + " ℃再算一遍",
  },
  {
    id: "redemand",
    label: "换个用途再比一次（改成产蒸汽）",
    routes: ["decide"],
    need: "result",
    test: (c) => c.intent === "decide" && /蒸汽/.test(String(c.text || "")),
    followup: "同一工况改成产蒸汽再比一次",
  },
  {
    id: "redemand2",
    label: "换个用途再比一次（改成供冷）",
    routes: ["decide"],
    need: "result",
    test: (c) => c.intent === "decide" && !/供冷|制冷/.test(String(c.text || "")),
    followup: "同一工况改成供冷再比一次",
  },
  /* 上面 redemand / redemand2 是有意的"二选一"：用户本轮问的是产蒸汽，
     就不再推"改成产蒸汽"（那是重复）；两条都给的唯一条件是两条都不重复 —— 见 nextActionsFor 的去重。 */
  /* ---- 知识问答 / 项目概况之后 ------------------------------------------ */
  {
    id: "overview",
    label: "介绍一下这个项目",
    routes: ["ask"],
    test: (c) => c.intent === "ask" && /项目|平台/.test(c.text) && !/年运行小时|包络|证书/.test(c.text),
    followup: "介绍一下这个项目",
  },
  {
    id: "hours-default",
    label: "年运行小时默认是多少",
    routes: ["ask"],
    test: (c) => c.intent === "ask" && /年运行小时|运行小时/.test(c.text),
    followup: "年运行小时默认多少",
  },
  {
    id: "envelope",
    label: "温度包络与边界有哪些",
    routes: ["ask"],
    test: (c) => c.intent === "ask" && /包络|边界/.test(c.text),
    followup: "温度包络是多少",
  },
  {
    id: "cert-probes",
    label: "证书扰动多少项、几项会翻转",
    routes: ["ask"],
    test: (c) => c.intent === "ask" && /证书|扰动|翻转/.test(c.text),
    followup: "证书扰动多少项、几项会翻转",
  },
  {
    id: "ds9517",
    label: "9517 和 7733 是怎么回事",
    routes: ["ask"],
    test: (c) => c.intent === "ask" && /9517|7733/.test(c.text),
    followup: "9517 和 7733 是怎么回事",
  },
  {
    id: "goto-decide",
    label: "给你一句工况，让它算一遍",
    routes: ["ask", "chat", "decide"],
    need: "none",   /* 它本身就是"再给一句工况" —— 不依赖本轮结论，所以信息不足时也能给 */
    test: (c) => c.intent === "decide",
    followup: "我这儿有个 320℃ 的窑炉烟气，流量 1.2 万标方每小时，想发电",
  },
  /* ---- G1：缺参数引导轮之后 -------------------------------------------------
   * ⚠ 这条是**带参数**的动作，`followup` 里的两个数由 `guidanceChips()` 按工况库那一行现算
   *   （所以这里给的 `followup` 只是**形态示例**，与 `retemp` 同款）。
   * ⚠ 它的前提是"工况库里真的匹配到一行" —— 没匹配到（`shape=null`）就整条不给
   *   （`need:"none"` + 引导段自己判断），这正是"宁少勿假"。 */
  {
    id: "use-preset",
    label: "按工况库预设先算一遍（350℃ / 60 kg/s / 发电）",
    routes: ["decide"],
    need: "none",   /* 它本身就是"把缺的参数补上再算" —— 不依赖本轮有没有算出结论 */
    test: (c) => c.intent === "decide",
    followup: "按工况库预设先算一遍：水泥-窑尾废气 350℃ 60 kg/s 烟气 发电",
    /* ⚠ 口径必须写在明面上：**点选 = 用户明确给了这个值**（所以它能进引擎），
       而先验区间的另一头**不会**被带上。 */
    honest: "点了才算你给的值：这两个数写在发出去的那句话里，逐字对得上才准用；你没点之前一个数都不进引擎。",
  },
  /* ---- G6：分半回答之后 ------------------------------------------------------
   * ⚠ 这条是**带参数**的动作：label 与 followup 由 `outOfScopeChips()` 用**用户原话里那两个温度
   *   字面量**现算（所以这里给的是**示例形态**，与 `retemp` / `use-preset` 同款）。
   *   ⚠ 之所以做成**静态表里的一行**而不是临时拼一句：它必须和别的动作一样过
   *     `nextActionVerdict()` —— 自检对它的 label 与 followup **各断言一次**，
   *     而 `nextActionVerdict` 只认这张表（临时拼的句子过不了，那就成了"系统做不了的动作"）。
   *   ⚠ 它**不调引擎、也不承诺引擎结论**：点下去只是把"用哪个温度当热源温度"这句话说明白，
   *     缺的流量仍然要问（`need:"none"`）。 */
  {
    id: "scope-ab",
    /* ⚠ label 与 mk **刻意写成同一句话**（不加"把"字前缀那种修饰）：
       chip 上显示的就是点下去真的发出去的那句话，于是它天然满足
       `nextActionVerdict("chip.text") === true` —— 自检可以对 chip 的两侧都断言"在白名单里"。
       实测踩到：第一版写成「把 120 ℃ 和 180 ℃ 各按同一股热源算一遍」，
       而 `nextActionVerdict()` 是**锚定模板匹配**，那个"把 "前缀让 label 与 followup 对不上 ⇒
       判据判它"不在白名单"（一个点了会跑、但白名单不认的动作）。 */
    label: (c) => {
      const ts = userTempsOf(c.text || "");
      return (ts.length >= 2 && c.intent === "decide")
        ? ts[0] + " ℃ 和 " + ts[1] + " ℃ 各按同一股热源算一遍" : null;
    },
    routes: ["decide"],
    need: "none",
    test: (c) => c.intent === "decide",
    mk: (c) => {
      const ts = userTempsOf(c.text || "");
      return (ts.length >= 2)
        ? ts[0] + " ℃ 和 " + ts[1] + " ℃ 各按同一股热源算一遍" : null;
    },
    honest: "点的这一下只表示「这两个温度是你说的、我照抄」；引擎仍会重新算一遍，" +
      "而且这轮要先把流量补上 —— 引擎不会替你假设一个流量。",
  },
  /* ---- 闲聊之后 ---------------------------------------------------------- */
  {
    id: "whatcanyoudo",
    label: "你能做什么",
    routes: ["chat"],
    test: (c) => c.intent === "chat" || (c.intent === "ask" && /能做什么|能干什么/.test(c.text)),
    followup: "你能做什么",
  },
];

/**
 * 为**本轮**挑出下一步 chips（最多 4 条、至少 2 条，宁少勿假）。
 *
 * ⚠ 结构与「派生运算文法」同款：`label` 是**给人看的那个 chip**，
 *   `test` 是"这句话落回哪条路"的可执行判据，`followup` 是**点下去真的作为下一轮输入**
 *   发出去的那句话（不是 chip 上那句"人话"，而是路由真能接住的那句）。
 *   三者必须同时存在 —— 缺任何一个，这个动作就不是"系统真能做"的。
 *
 * ⚠ `c.need`：这一轮**手里有什么**。
 *   "result" = 引擎真出了结论（最强，可以推"看 LCA / 换流量再算"）
 *   "ask"    = 知识问答走通了（推"再问一条口径"）
 *   "chat"   = 闲聊（只推"给个工况"和"你能做什么"）
 *   "none"   = **这一轮什么都没算出来**（信息不足 / 引擎拒绝 / 解析失败）
 *              ⇒ 只许推"不需要任何结果"的动作，宁少勿假。
 *
 * @param {object} c { intent, text, tempC, tempLit, need }
 * @returns {Array<{id:string, text:string, followup:string, hint?:string}>}
 */
export function nextActionsFor(c) {
  const ctx = {
    intent: c && c.intent,
    text: String((c && c.text) || ""),
    tempC: (c && typeof c.tempC === "number") ? c.tempC : null,
    tempLit: (c && c.tempLit) || null,
    need: (c && c.need) || ((c && c.intent) === "decide" ? "result" : (c && c.intent) === "ask" ? "ask" : "chat"),
  };
  const out = [];
  for (const a of NEXT_ACTIONS) {
    if (!a.routes.includes(ctx.intent)) continue;
    /* `need:"result"` = 这条动作**依赖本轮的引擎结论**。本轮没算出来（信息不足/引擎拒绝/解析失败）
       就不许推它 —— 否则用户点下去会以为"刚才那台机组已经算过了"。 */
    if (ctx.need === "none" && a.need === "result") continue;
    /* 前提不成立（例如没有温度字面量）就**整条不给** —— 不许替用户编数 */
    const args = { intent: ctx.intent, text: ctx.text, tempC: ctx.tempC, tempLit: ctx.tempLit };
    const label = (typeof a.label === "function") ? a.label(args) : a.label;
    if (!label) continue;
    const followup = (typeof a.mk === "function") ? a.mk(args) : a.followup;
    if (!label || !followup) continue;          /* 没写 followup 的动作不算"真能做"，不给 */
    if (out.some((x) => x.text === label)) continue;
    out.push({ id: a.id, text: label, followup, hint: a.honest || null });
    if (out.length >= 4) break;
  }
  return out;
}

/**
 * 判定一句话"是不是白名单里的下一步动作"。
 * 自检用它做两件事：① 每个 chip 必须通过；② 伪造的 chip（「生成动态图」）必须**不**通过。
 *
 * ⚠ 判定按**形态**做：带参数的动作（"把热源温度改成 320 ℃再算"）里那个数被换成通配，
 *   所以它判的是"这句话像不像白名单里的那个动作"，不判"这个数合不合理"。
 * @returns {{ok:boolean, id?:string, why:string}}
 */
export function nextActionVerdict(text) {
  const t = String(text || "").trim();
  if (!t) return { ok: false, why: "空文本" };
  /* ⚠ G1：引导轮那条「按工况库预设先算一遍：…」是**带参数**的动作，参数由 `guidanceChips()`
     按匹配到的工况库行现算，所以静态表里存不下具体形态。这里改用**可执行判据**判它：
     它必须能被 `detectPresetPick()` 认出来 —— 而那个函数要求"两个数都逐字出现在这句话里"，
     比"文本长得像"更严（伪造一句 500℃ 是不认的，见 e2e 第 ⑲ 节 B-3）。 */
  if (PICK_PREFIX.test(t)) {
    const p = detectPresetPick(t);
    if (p) return { ok: true, id: "use-preset", why: "命中白名单动作「use-preset」（预设第 " + p.shape.main.line + " 行，两个数都逐字可查）" };
    return { ok: false, why: "写了「按工况库预设先算一遍」但数与工况库那一行对不上（伪造/手改的点选句不算数）" };
  }
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\d+(?:\.\d+)?/g, "\\d+(?:\\.\\d+)?");
  for (const a of NEXT_ACTIONS) {
    const cands = [];
    if (typeof a.label === "function") {
      cands.push(a.label({ intent: "decide", text: t, tempC: 320, tempLit: "320" }));
      cands.push(a.label({ intent: "decide", text: t, tempC: 650, tempLit: "650" }));
    } else {
      cands.push(a.label);
    }
    for (const cand of cands) {
      if (!cand) continue;
      if (new RegExp("^" + esc(cand) + "$").test(t)) return { ok: true, id: a.id, why: "命中白名单动作「" + a.id + "」" };
    }
  }
  return { ok: false, why: "不在白名单里：系统没有这个能力（宁少勿假，故不给这个 chip）" };
}

/** 白名单全表（给 /api/meta 与自检看，别让能力清单藏着）。
 *  ⚠ 带参数的动作（`label` 是函数的那些）这里给的是**示例形态**（参数位填 320）——
 *    因为具体参数要按上一轮解析结果现算，静态表里只能给形态。 */
export function nextActionCatalog() {
  return NEXT_ACTIONS.map((a) => {
    const args = { intent: "decide", text: "", tempC: 320, tempLit: "320" };
    const isTpl = typeof a.label === "function";
    return {
      id: a.id, routes: a.routes,
      label: isTpl ? a.label(args) : a.label,
      labelIsTemplate: isTpl,
      followup: (typeof a.mk === "function") ? a.mk(args) : a.followup,
      need: a.need || "result",
      honest: a.honest || null,
    };
  });
}

/* ==================================================== 出处（N2 的折叠区数据）
 *
 * 正文里不写文件名了，但**出处一个都不能丢** —— 只是搬家：
 *   · 工况路径：每条入参的"它是从哪来的"（本轮原话 / 引擎默认 / 单位换算）
 *   · 引擎路径：推荐、λ、可回收热功率、贴近度、证书 分别来自哪个引擎输出
 *   · 知识路径：检索到的每个片段来自哪份文件的哪一行
 * 前端把这三类渲染成一个「出处」折叠块（默认收起）。
 *
 * ⚠ 这里只放**描述性字符串**，不放任何新数字（数字仍然只能来自引擎/文档原文）。
 */export function citationsOf(r, parseLog) {
  const out = [];
  const add = (what, where, kind) => { if (what && where) out.push({ what: String(what), where: String(where), kind: kind || "engine" }); };

  /* ① 本轮入参的来源（原文片段不放进 where，太长；只写"哪一类来源"） */
  for (const l of (parseLog || [])) {
    if (l.field == null) continue;
    const val = (l.value == null ? "" : " = " + l.value);
    add(l.field + val, l.source || "（未标来源）", "input");
  }
  if (!r || !r.ok) return out;

  /* ② 引擎输出各自的位置 */
  add("λ（主观权重占比）", "HFDATA.lam0");
  if (r.engine) {
    add("推荐路径：" + (r.engine.topLabel || "—"), "WHENG.runDecision().topLabel");
    if (r.engine.recoveredKw != null) add("可回收热功率", "WHENG.recoveredHeatKw(scene)");
    for (const o of (r.engine.order || [])) {
      add("贴近度：" + o.path, "runDecision().order[i].closeness");
      (o.row || []).forEach((v, j) => add((r.engine.indicators[j] || ("指标" + j)) + "：" + o.path, "runDecision().X[i][" + j + "]"));
    }
    for (const s of (r.engine.stage1 || [])) add("第一级筛选：" + (s.label || s.path), "WHENG.stage1()");
  }
  const c = r.certificate;
  if (c && !c.error) {
    add("证书扰动项数 / 翻转项数", "WHENG.decisionCertificate().total / .flips");
    for (const p of (c.flippedProbes || [])) add("翻转项：" + p.name, "decisionCertificate().probes[]");
    for (const a of (c.assumptions || [])) add("假设：" + a.name, "decisionCertificate().assumptions[" + (a.key || a.name) + "]（证据等级 " + (a.grade || "—") + "）");
  }
  /* 去重（同一 where 会被很多行引用） */
  const seen = new Set();
  return out.filter((x) => { const k = x.kind + "|" + x.what + "|" + x.where; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** 知识问答 / 项目概况的出处（每条片段一条）
 *  ⚠ F3：权威级别从正文搬到这里（正文里原来印的是「（来源：项目知识手册）」）——
 *    级别放在 what 前缀里，前端不必改就能显示出来，信息一点没丢。 */
export function citationsFromHits(hits) {
  return (hits || []).map((h) => {
    const lvl = (h.chunk && h.chunk.authority) === 1 ? "权威台账/边界文件" : "项目知识手册";
    return {
      what: "（" + lvl + "）" + (h.title || h.chunk && h.chunk.title || "知识库片段"),
      where: h.cite || (h.chunk && h.chunk.cite) || "",
      kind: "knowledge",
      snip: String(h.text || (h.chunk && h.chunk.text) || "").slice(0, 80),
    };
  }).filter((x) => x.where);
}

/* ============================================================== 引擎并发闸 */

/* decisionCertificate 会临时改 PRICES 再还原（decision_core.js:2240/2255）。
   同一进程里并发调用会互相踩。Node 是单线程，但 await 点会交错，
   所以这里用一条 promise 链把引擎调用串行化。（与原版 server.mjs 同款） */
let engineChain = Promise.resolve();
export function serialized(fn) {
  const run = engineChain.then(fn, fn);
  engineChain = run.then(() => undefined, () => undefined);
  return run;
}
