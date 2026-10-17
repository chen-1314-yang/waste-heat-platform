/* rag.mjs —— 知识检索（朴素 BM25 + 中文字符二元切分，零第三方依赖，离线可跑）。
 *
 * 检索源（三条，全部只读）：
 *   ① docs/对外数字台账.md                      ← 对外数字的**唯一权威台账**
 *   ② content/boundaries.json                   ← 边界与口径的权威文案
 *   ③ kb/知识手册_正文_v4_20261013_快照.md        ← 知识手册（**项目概况快速通道**的取文处）
 *
 * ======================= 2026-10-13：手册换版（旧快照 → 新快照） =======================
 * 🔴 背景（这是本轮任务的根因）：手册在 10-13 被整体重写过（新增 932 结案 / T1~T10 阈值 /
 *    494 正确算式 / P1 大榭石化锚点 / P2 三分法 / 「第 10 道门不存在」/ Agent 四路由 / 文档数 68），
 *    但本索引当时还钉在 **10-11 的旧快照**上 ⇒ Agent 答的一直是 10-11 的口径
 *    （例如 P2 还在讲"四痛点"、不知道 932 已结案、不知道 T1~T10）。
 *
 * ⚠ **四个候选路径已经分叉**（2026-10-13 逐个实测 md5，与 10-12 那次"四份完全相同"相反）：
 *      D:\Codex\…\ni\outputs\project_knowledge_handbook.md                              118254 B  FBF07E82E18B904A2A3BC41082A65562   ← 旧（10-11 口径）
 *      D:\Codex\…\02_项目方案与学习材料\project_knowledge_handbook.md                    118254 B  FBF07E82E18B904A2A3BC41082A65562   ← 旧（10-11 口径）
 *      D:\Codex\…\12_网站v4_实验版\docs\知识手册_正文_v4_20261011_快照.md                 118254 B  FBF07E82E18B904A2A3BC41082A65562   ← 旧（按日期命名，**不可变，保留留痕**）
 *      D:\23549\Documents\handbook_draft_v4.md                                          149566 B  A2C2D33FBE277543D3A2C70DCC0969E3   ← **新（10-13 口径）**
 *    前三份仍是 10-11 那份旧正文；只有 D 盘那份被重写了。
 *
 * ⇒ 本轮**新增**一份按日期命名的快照 `kb/知识手册_正文_v4_20261013_快照.md`
 *    （与 handbook_draft_v4.md **逐字节相同**，md5 A2C2D33F…69E3），旧快照**一个字节都没动**。
 *    为什么放在 agent_wh/kb/ 而不是项目 docs/：本次任务只允许改 agent_wh
 *    （D:\Codex\… 只读，且运行沙箱是 workspace-write、边界就是 D:\23549\Documents），
 *    写不进去。项目侧那份 10-11 快照继续原地留痕，10-13 快照的"官方"落点见 README「已知限制」。
 *
 * 🔴 防止"md5 又写过期"（上一轮踩过一次）：SOURCES 里带 `md5` 的源，buildIndex() 会**实测**
 *    该文件的 md5 并放进 manifest（字段 md5 / md5Expected / md5Ok）⇒ /api/health 与
 *    /api/knowledge 直接可查、kb_check.mjs 会断言。换文件不改这里，md5Ok 立刻变 false。
 * =====================================================================================
 *
 * ⚠ 更早的教训：注释里写的 B73C90C0…4BE3 是过期的（文件后来被改过），以实测值为准。
 *
 * 🔴 铁律 1 的落地：本模块**只返回原文片段**（带出处），不做任何数字加工。
 *    答案里的数字只能来自这些片段 —— 上层会用 llm.verifyNumbers() 回查。
 *
 * 🔴 「台账里标【不得引用】的行，一律不许出现在回答里」的落地：
 *    索引时对每一行/每一条做黑名单标记，命中即整条 out_of_bounds，
 *    检索时直接剔除，并在被问到时明确告知"该行存在但依纪律不得引用"。
 *    ⚠ **知识手册受同一条约束**（不是只管台账）：loadMarkdown() 对**每一个小节**做同款判定。
 *    🔴 2026-10-13（R2）更正 —— 这段原先写"实测手册 92 个小节里有 1 节命中（§11.1）"，
 *      现在两个数都变了：
 *        · 手册切块 **92 → 116 段**（10-13 快照 107 段，R1 又补回 9 个被吞的编号标题）；
 *        · 被剔 **2 节 → 1 节**，且判据从"整块子串命中"换成"逐行 + 认纪律声明"。
 *      原委：§8「数字口径卡片」整节被剔，**触发它的却是该节自己那句纪律声明**
 *      （`③ 台账标"不得引用"的行，本手册也不出现具体值`）—— 它自己声明纪律、被纪律判掉了。
 *      现在这种"在讲规则"的句子放行；§11.1 那种"**一个真值**被纪律挡着"的行照旧被剔
 *      （硬门槛：小句里出现任何数字就不算声明）。逐条构造输入见 `_x_r2_criteria.mjs`。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { PROJECT_ROOT } from "./engine_bridge.mjs";

/* agent_wh 自己的目录 —— 让「随 agent 走的知识库文件」有个确定的落点（见顶部说明）。 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ----------------------------------------------------------------- 黑名单规则 */

/* 命中任一即视为"依纪律不得对外引用"。
   实测命中情况（2026-10-11 读盘）：
     docs/对外数字台账.md                 → 1 行（§一 第 13 行，蒸汽前沿 8 解）
     content/boundaries.json              → 3 条（#36 燕山石化锚点 / #46 制冷造价 / #52 两级 ORC 夹点）
   ⚠ 2026-10-13 复测：**台账那 1 行已经不在了**（`manifest[ledger].forbidden === 0`）——
     台账正文里现在一个字都不含这些模式。所以当前**唯一的命中来源是 boundaries.json(3) 与手册(2)**。 */
export const FORBIDDEN_PATTERNS = [
  /不得引用/, /不得对外/, /不得再/, /不许对外/, /不可对外/, /不得当作/, /不得作为/, /禁止对外/,
];

export function isForbiddenText(t) {
  const s = String(t || "");
  return FORBIDDEN_PATTERNS.some((re) => re.test(s));
}

/** 命中的**第一条**模式（含位置），没命中返回 null。给"逐节打印是哪个词命中"用。 */
export function firstForbiddenHit(t) {
  const s = String(t || "");
  for (const re of FORBIDDEN_PATTERNS) {
    const m = re.exec(s);
    if (m) return { pattern: String(re), word: m[0], at: m.index };
  }
  return null;
}

/* ------------------------------------------------- 纪律声明：被自己的规则误伤的形态
 *
 * 🔴 R2（2026-10-13）根因：
 *   手册 §8「数字口径卡片」整节被剔掉，而触发它的是**该节自己那句纪律声明**：
 *      ③ 台账标"不得引用"的行，本手册也不出现具体值；
 *   另一处同类：`| **6 · LCA 中位口径** | … | **只能当量级参考、不得对外** |`（§11.1，**确实该剔**）。
 *   ⇒ 前者是**在讲纪律**，后者是**一个真值被纪律挡着**。旧判据分不开它们（都是子串命中）。
 *
 * 🔴 判据：一条命中**只有在它是在"给某个词加引号、进而声明规则"时**才不算泄露 —— 四条同时成立：
 *   ① 命中的那个词（或它所在的一小段）**紧挨着引号**：
 *        ASCII `"`、成对全角 `“ ”`、或**同一个字符连续两次**（Markdown 里 `"不得引用"` 常被写成 `"…"`）；
 *   ② 拿掉引号后，整条小句长度 ≤ LIMIT（规则声明必然是短句，值陈述必然长）；
 *   ③ 小句里**一个数字都没有** —— 这一条最关键：它挡住的正是"声明里夹带一个真值"的形态。
 *      （"不得引用"在被声明时是**属性值**，本就不含数；任何含数的表述都不是在讲纪律，
 *        而是在用纪律标记某个具体的量。）
 *   ④ 小句里出现**讲规则**的字眼（不得/不许/不可/禁止/一律/必须…）。
 *
 * 🔴 为什么把 ③ 当成硬门槛：这样"声明句里藏一个值会怎样"就不是靠人守了 ——
 *   值一出现，③ 立刻不成立 ⇒ 该行照旧被剔。
 *
 * ⚠ 作用域刻意**只到行**：一节里可以"第一行是大白话声明、后面几行是真值"，
 *   逐行判才能既放行声明、又拦住值（见 `_x_r2_criteria.mjs` 的混合节构造）。
 */
const DISC_QUOTE = /["“”]|([^\s])\1/;
const DISC_RULE_WORDS = /(不得|不许|不可|禁止|一律|必须|纪律|不许当|标["“”']?不得)/;
const DISC_CLAUSE_LIMIT = 60;

/**
 * 这条命中是不是"纪律声明"（即：在讲规则，不是在泄露被规则挡着的值）。
 * @param {string} line 含命中的**一行**原文
 * @param {{at:number, word:string}} hit firstForbiddenHit() 的结果
 * @returns {boolean}
 */
export function isDisciplineDeclaration(line, hit) {
  const s = String(line || "");
  if (!hit) return false;
  const a = Math.max(0, hit.at - DISC_CLAUSE_LIMIT);
  const b = Math.min(s.length, hit.at + hit.word.length + DISC_CLAUSE_LIMIT);
  const clause = s.slice(a, b);
  if (/\d/.test(clause)) return false;                 /* ③ 夹带数字 ⇒ 不是声明 */
  if (!DISC_QUOTE.test(clause)) return false;          /* ① 没有引号/着重标记 ⇒ 不是声明 */
  if (!DISC_RULE_WORDS.test(clause)) return false;     /* ④ 没有讲规则的字眼 ⇒ 不是声明 */
  return true;
}

/**
 * 文本里是否还有**没被"纪律声明"解释掉**的命中。
 * 逐行判（行被压成一行空白归一化的形式，便于跨行的引号/小句不被切断）。
 * @returns {{forbidden:boolean, hits:Array<{line:number,word:string,at:number,exempt:boolean}>}}
 */
export function forbiddenScan(text) {
  const hits = [];
  const lines = String(text || "").split(/\n/);
  for (let i = 0; i < lines.length; i++) {
    const h = firstForbiddenHit(lines[i]);
    if (!h) continue;
    const exempt = isDisciplineDeclaration(lines[i], h);
    hits.push({ line: i + 1, word: h.word, at: h.at, pattern: h.pattern, exempt });
  }
  return { forbidden: hits.some((h) => !h.exempt), hits };
}

/** 手册/台账：按行判，返回"是否仍有未被解释掉的命中"。 */
function isForbiddenByLines(text) {
  return forbiddenScan(text).forbidden;
}

/* ------------------------------------------------------------------- 切块 */

const DOCS = () => path.join(PROJECT_ROOT, "docs");
const CONTENT = () => path.join(PROJECT_ROOT, "content");

/** 手册快照的**期望 md5**（换文件必须同步改这里，否则 md5Ok 变 false）。
 *  实测：2026-10-13，D:\23549\Documents\handbook_draft_v4.md（149566 B）逐字节一致。 */
export const HANDBOOK_SNAPSHOT_MD5 = "A2C2D33FBE277543D3A2C70DCC0969E3";
export const HANDBOOK_SNAPSHOT_REL = "kb/知识手册_正文_v4_20261013_快照.md";

/**
 * 把 SOURCES 里的 `rel` 解析成绝对路径。
 * @param {{rel:string, base?:string}} s
 * @returns {string}
 *   base 省略 / "project" ⇒ 相对 PROJECT_ROOT（台账、边界文件）
 *   base "self"           ⇒ 相对 agent_wh 自身目录（手册快照：随 agent 走，不随项目走）
 *   rel 本身是绝对路径     ⇒ 原样返回
 */
export function sourceAbs(s) {
  if (!s) return null;
  if (/^[A-Za-z]:[\\/]/.test(s.rel)) return s.rel;
  if (s.base === "self") return path.join(HERE, s.rel);
  return PROJECT_ROOT ? path.join(PROJECT_ROOT, s.rel) : path.join(HERE, s.rel);
}

/** 一个文件的 md5（大写十六进制），读不到返回 null。 */
export function md5OfFile(abs) {
  try { return crypto.createHash("md5").update(fs.readFileSync(abs)).digest("hex").toUpperCase(); }
  catch { return null; }
}

const SOURCES = [
  {
    id: "ledger",
    title: "对外数字台账",
    rel: "docs/对外数字台账.md",
    authority: 1,        // 1 = 权威
    note: "对外数字的唯一权威台账。四问纪律：哪个量/哪个工具/哪个分母/来自哪个文件。",
    load: loadLedger,
  },
  {
    id: "boundaries",
    title: "边界与口径",
    rel: "content/boundaries.json",
    authority: 1,
    note: "边界与口径的权威文案；等级列说明每条数是实测、推算还是示意。",
    load: loadBoundaries,
  },
  {
    id: "handbook",
    title: "项目知识手册 v4",
    rel: HANDBOOK_SNAPSHOT_REL,
    base: "self",        // ⚠ 相对 agent_wh，不是相对 PROJECT_ROOT
    md5: HANDBOOK_SNAPSHOT_MD5,
    authority: 2,        // 2 = 参考
    note: "项目知识手册 v4 · **2026-10-13 快照**（149566 B，md5 A2C2D33F…69E3，2026-10-13 实测）；" +
      "上一版是 10-11 快照（118254 B，md5 FBF07E82…5562，项目 docs/ 里仍留痕、**已不再被索引**）。" +
      "**非台账**，数值若与台账冲突，以台账为准。" +
      "「介绍一下这个项目」这类问题由 handbookOverview() 直接取它开头几节作答（不经大模型润色）。",
    load: (p) => loadMarkdown(p, "handbook", 2, HANDBOOK_SNAPSHOT_REL),
  },
  /* ⚠ 2026-10-13 状态：**四个候选路径已经分叉**（旧三份 FBF07E82… / 新那份 A2C2D33F…，见文件头）。
     本索引刻意钉在**快照**（kb/…_20261013_快照.md）而不是 D:\23549\Documents\handbook_draft_v4.md ——
     后者是**可变的工作副本**（作者随时会改），索引它会让"我们答的是哪一版"再次说不清。
     快照与工作副本现在逐字节相同；一旦作者再改 D 盘副本，md5 守卫会把差异显性报出来，而不是悄悄跟着变。 */
];

/* ------------------------------------------------- 单个来源的 load 实现 */

/** 台账：**按行**建块，markdown 表格行保留原样（含 # 序号），便于给出 line 号出处。 */
function loadLedger(abs) {
  const text = fs.readFileSync(abs, "utf8");
  const lines = text.split(/\r?\n/);
  const chunks = [];
  let heading = "";
  lines.forEach((line, i) => {
    const ln = i + 1;
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) { heading = h[1].trim(); return; }
    const body = line.trim();
    if (!body) return;
    /* 表格分隔行 |---|---| 不入索引（没有信息） */
    if (/^\|[\s:|-]+\|$/.test(body)) return;
    const forbidden = isForbiddenText(body);
    chunks.push({
      sourceId: "ledger", title: "对外数字台账", rel: "docs/对外数字台账.md",
      authority: 1, line: ln, heading,
      text: body,
      forbidden,
      cite: "docs/对外数字台账.md:" + ln + (heading ? "（§" + heading + "）" : ""),
    });
  });
  return { text, chunks };
}

/** boundaries.json：**按条目**建块（73 条）。 */
function loadBoundaries(abs) {
  const raw = fs.readFileSync(abs, "utf8");
  let j;
  try { j = JSON.parse(raw); } catch (e) { return { text: raw, chunks: [] }; }
  const items = Array.isArray(j) ? j : (j.items || []);
  const chunks = items.map((it, i) => {
    const scope = String(it.scope == null ? "" : it.scope);
    const grade = String(it.grade == null ? "" : it.grade);
    const item = String(it.item == null ? "" : it.item);
    const forbidden = isForbiddenText(scope) || isForbiddenText(grade) || isForbiddenText(item);
    return {
      sourceId: "boundaries", title: "边界与口径", rel: "content/boundaries.json",
      authority: 1, line: null, index: i, heading: "items[" + i + "]",
      item, scope, grade,
      text: "项目：" + item + " ｜ 口径：" + scope + " ｜ 等级：" + grade,
      forbidden,
      cite: "content/boundaries.json → items[" + i + "]「" + item + "」",
    };
  });
  return { text: raw, chunks };
}

/** markdown：**按小节**建块（以 ## / ### 切）。
 *  @param {string} abs        绝对路径（读盘用）
 *  @param {string} sourceId
 *  @param {number} authority
 *  @param {string} [displayRel] 出处里显示的路径。⚠ 必须是**相对的可读路径**
 *         （例如 `kb/知识手册_正文_v4_20261013_快照.md`），不许把本机绝对路径
 *         （`D:\23549\…`）写进出处 —— 它会顺着 citations 一路吐到网页上，
 *         既难看、又暴露本机目录结构。省略时退回绝对路径（仅历史调用方）。
 */
function loadMarkdown(abs, sourceId, authority, displayRel) {
  const text = fs.readFileSync(abs, "utf8");
  const lines = text.split(/\r?\n/);
  const chunks = [];
  const showPath = String(displayRel || abs).replace(/\\/g, "/");
  let buf = [], start = 1, heading = "";
  /* 🔴 R1（2026-10-13）：**被吞掉的标题**。
     切块规则是"遇到标题就 flush、然后把 heading 换成新标题"。
     于是「标题 A 后面紧跟着标题 B」（A 下面一个字的正文都没有）时：
       flush() 拿到空 buf ⇒ **什么都不产出**，接着 heading 被 B 覆盖
       ⇒ **A 这个标题一个字都没进索引**。
     实测手册里有 9 个标题是这样丢的（见 _x_r1_layers.mjs），其中 6 个是 §5.1~§5.7 ——
     §5.7「成本前沿的上界 932：**结案**（2026-10-12）」正是被吞的那个，
     它的正文全部挂在内部子标题（"A. 这是什么问题"…）名下，
     ⇒ 用户问「932 是怎么回事」时，"932"只出现在**正文**里、标题里一个都没有，
        加上数字当时还没分词，这一段就彻底浮不上来。
     修法：把被吞的标题**补成一条只含标题的短片段**（routeHeading）。
     ⚠ 为什么不是"把父标题拼到每个子片段前面"：§5.7 那一节有 5 个子片段，
       拼 5 遍会让"成本前沿的上界 932"这个词的 df 从 1 涨到 5、idf 掉下来，
       反而更难被"932 是怎么回事"这种短查询选中。补一条**唯一的**标题片段，
       它的 idf 最高、也最像"这一节在讲什么"的摘要，正好补上缺的那一环。 */
  const swallowed = [];
  const flush = (why) => {
    const body = buf.join("\n").trim();
    if (body) {
      chunks.push({
        sourceId, title: showPath.split("/").pop(), rel: showPath, authority,
        line: start, heading,
        text: body,
        /* 🔴 R2（2026-10-13）：从 isForbiddenText()（纯子串）换成 forbiddenScan()（逐行、
           且认得出"纪律声明"）。这样 §8 那句"台账标『不得引用』的行，本手册也不出现具体值"
           不再把整节判掉；而 §11.1 那种"一个真值被纪律挡着"的行**照旧被判掉**（它含数字）。
           判据与反例见 rag.mjs 顶部 isDisciplineDeclaration() 的说明与 `_x_r2_criteria.mjs`。 */
        forbidden: forbiddenScan(body).forbidden,
        cite: showPath + ":" + start + (heading ? "（" + heading + "）" : ""),
      });
    } else if (heading) {
      swallowed.push({ heading, line: start, why });
    }
    buf = [];
  };
  lines.forEach((line, i) => {
    const h = line.match(/^#{1,4}\s+(.*)$/);
    if (h) { flush("被下一个标题顶掉"); start = i + 1; heading = h[1].trim(); return; }
    buf.push(line);
  });
  flush("文末");
  /* 把被吞的标题补成片段。`text` 里放标题原文（供 BM25/相关性用），
     heading 留空以免 cite 里把同一串标题写两遍。 */
  const routeHeading = new Map();   /* heading 行号 → 片段下标，便于自检查找 */
  for (const s of swallowed) {
    if (!s.heading || s.heading.length < 2) continue;
    routeHeading.set(s.line, chunks.length);
    chunks.push({
      sourceId, title: showPath.split("/").pop(), rel: showPath, authority,
      line: s.line, heading: "",
      text: s.heading,
      forbidden: forbiddenScan(s.heading).forbidden,
      cite: showPath + ":" + s.line + "（" + s.heading + "）",
      headingOnly: true,
    });
  }
  return { text, chunks, swallowed };
}

/* ------------------------------------------------------------------- 索引 */

let _idx = null;

export function buildIndex() {
  if (_idx) return _idx;
  const chunks = [];
  const manifest = [];
  for (const s of SOURCES) {
    const abs = sourceAbs(s);
    if (!abs || !fs.existsSync(abs)) {
      manifest.push({ id: s.id, title: s.title, rel: s.rel, base: s.base || "project", ok: false, reason: "文件不存在：" + abs });
      continue;
    }
    let r;
    try { r = s.load(abs); } catch (e) {
      manifest.push({ id: s.id, title: s.title, rel: s.rel, base: s.base || "project", ok: false, reason: "读取失败：" + e.message });
      continue;
    }
    for (const c of r.chunks) { c.source = s; chunks.push(c); }
    /* 🔴 md5 守卫（2026-10-13 加）：声明了 md5 的源，实测一遍再报出来。
       目的就是"换文件忘改 md5"这件事**不可能悄悄过去** —— 它会在 API 与自检里显性变 false。 */
    const md5 = md5OfFile(abs);
    manifest.push({
      id: s.id, title: s.title, rel: s.rel, base: s.base || "project", abs,
      ok: true, authority: s.authority,
      chunks: r.chunks.length,
      forbidden: r.chunks.filter((c) => c.forbidden).length,
      bytes: Buffer.byteLength(r.text, "utf8"),
      md5,
      md5Expected: s.md5 || null,
      md5Ok: s.md5 ? (md5 === s.md5) : null,
      note: s.note,
    });
  }
  /* BM25 预处理：中文字符二元 + ASCII 词 */
  const df = new Map();
  const docs = chunks.map((c) => {
    const toks = tokenize(c.text + " " + (c.item || "") + " " + (c.heading || ""));
    c._tf = new Map();
    for (const t of toks) c._tf.set(t, (c._tf.get(t) || 0) + 1);
    c._len = toks.length;
    for (const t of c._tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    return c;
  });
  const avgdl = docs.reduce((a, c) => a + c._len, 0) / Math.max(1, docs.length);
  /* 相关性门槛用的 idf 上限（全部词 idf 的中位数 × 3）：避免个别超稀有词把覆盖率整体压垮。
     语料是固定的，这里算一次即可。见 relevanceOf()。 */
  const idfAll = [...df.keys()]
    .map((t) => Math.log(1 + (docs.length - df.get(t) + 0.5) / (df.get(t) + 0.5)))
    .sort((a, b) => a - b);
  const _idfCap = (idfAll.length ? idfAll[Math.floor(idfAll.length / 2)] : 1) * 3;
  _idx = { chunks: docs, df, avgdl, N: docs.length, manifest, _idfCap };
  return _idx;
}

export function indexManifest() { return buildIndex().manifest; }

/** 🔴 丢掉进程内缓存，下次 buildIndex() 重新读盘。
 *  ⚠ 为什么必须有：buildIndex() 是**进程级缓存**（`_idx`）。任何"改了盘上文件再验证"的自检
 *  （例如 kb_check 的反向变异）若不先 reset，第二次拿到的还是**变异之前**那份索引 ——
 *  于是"守卫看起来没红"，得出的是**假阴性**。本项目的 _kb_mutation.mjs 就真踩过一次。 */
export function resetIndex() { _idx = null; return true; }

/* ------------------------------------------------------------------ 分词 */

const STOP = new Set(["的", "了", "是", "在", "和", "与", "或", "有", "为", "对", "把", "被", "就",
  "这", "那", "一个", "什么", "怎么", "如何", "多少", "吗", "呢", "啊", "请", "我", "你", "它",
  "the", "a", "of", "is", "and", "to", "in", "for"]);

export function tokenize(s) {
  const t = String(s || "").toLowerCase();
  const out = [];
  /* ⚠ 这里原先是 `/[a-z][a-z0-9_.+\-/]{1,}/g` —— **首字符必须是 a-z**，
     所以纯数字（"932"）和数字开头的（"10mpa"）**一个都进不了词表**。
     实测后果（2026-10-13，见 _x_r1_layers.mjs）：
       tokenize("932")      = []        tokenize("6500 h") = []
       tokenize("0.12")     = []        tokenize("5.7")    = []
       ⇒ 用户问「932 是怎么回事」，"932" 这个词**根本不存在**，BM25 无从命中；
         手册 §5.7 靠标题里那个 "932" 才能被认出来的路也一并断了。 */
  for (const m of t.matchAll(/[a-z][a-z0-9_.+\-/]{1,}/g)) if (!STOP.has(m[0])) out.push(m[0]);
  /* 数字词（**R1 新增**）：独立切片，且 **一律要求至少 2 位整数部分** ——
     1 位数（1、0、4…）在语料里到处都是，放进来只会像"命中即用"那批噪声词一样稀释打分。
     ⚠ 刻意不匹配"紧跟在字母/数字后面的数字"（`(?<![a-z0-9])`）：
       否则 "t10" 会被切出一个 "10"、`items[58]` 会被切出 "58"，
       凭空给索引添一批谁都不会用到的词元。 */
  for (const m of t.matchAll(/(?<![a-z0-9.])\d{2,}(?:\.\d+)?/g)) out.push(m[0]);
  /* 中文：单字 + 二元组（单字保召回，二元保精度） */
  const cjk = t.replace(/[^\u4e00-\u9fff]+/g, " ");
  for (const seg of cjk.split(/\s+/)) {
    if (!seg) continue;
    for (let i = 0; i < seg.length; i++) {
      const c = seg[i];
      if (!STOP.has(c)) out.push(c);
      if (i + 1 < seg.length) out.push(seg.slice(i, i + 2));
    }
  }
  return out;
}

/* --------------------------------------------------- 相关性门槛（F4，2026-10-12 加）
 *
 * 用户实测报的现象（原话）：「检索**命中即用**：BM25 大概是因为"过程"这类词命中了
 * §9 与"过程等熵效率"那节，**但它显然不相关，系统却照贴**。没有相关性门槛。」
 *
 * ⇒ 加一道**可复算**的门槛：两条件都过，才算"与这个问题相关的片段"：
 *   ① **命中内容词数 ≥ 2**：内容词 = 中文二元组 + ASCII 词（**单字不算**——"气/热/水"
 *      这类单字在语料里到处都是，正是"命中即用"的根源）；
 *      查询本身内容词不足 2 个时（例如「证书」「边界」这种单词查询）门槛降为 1，不许把短查询一棒打死。
 *   ② **idf 加权覆盖率 ≥ RELEVANCE_MIN**：覆盖率 = Σidf(命中内容词) / Σidf(查询内容词)。
 *      它衡量的是"你问的那些**有信息量**的词，有多少真的在这段里"，而不是"随便蹭到几个字"。
 *      权重按 idf 取，并对 idf 设上限（中位数的 3 倍），避免一个超稀有词把覆盖率整体压垮。
 *
 * 🔴 另加一条**整句判定**：**BM25 排第一的那段过不了门槛 ⇒ 整句视为"没检索到"**。
 *    理由：排名第一的都不相关，后面更弱的片段更没有理由贴出来（那正是"照贴"的形态）。
 *
 * ⚠ 阈值不是拍脑袋定的：标定脚本 `_f4_calibrate.mjs` 用
 *    「标定组 5 相关 + 5 不相关」定阈值，再用「留出组 10 相关 + 6 不相关 + 2 擦边」验证。
 *
 * 🔴 2026-10-12 第二轮修正（**上一轮的"13/13 全拦"是不成立的**）：
 *    复跑 28 条标定句发现 **1 条漏网**：
 *      「推荐一部好看的电影」⇒ top1 手册 §7.2，matched=2（推荐 / 好看）、覆盖率 0.201 > 0.12 ⇒ **放行**。
 *    病根不是阈值大小，而是**"命中 2 个"这条判据与查询长度无关**：
 *      长句里有更多机会蹭到 2 个词，而且只要其中一个词很稀有（"好看"的 idf 很高），
 *      覆盖率就被它一个人抬过门槛。也就是说"2"对长句太松。
 *    改法（**有依据，不是调参**）：把"命中数"要求**随查询长度放大** ——
 *      内容词 ≤2 个 ⇒ 需 1；≤4 个 ⇒ 需 2；≥5 个 ⇒ 需 3。
 *    依据：`_f4_sep.mjs` 把 28 条标定句的 top1 证据摊开后，穷举 36 组候选规则，
 *      **只有 3 组能做到"相关 15/15 全进 + 不相关 13/13 全拦"**，且它们的共同点就是这条长度缩放
 *      （覆盖率门槛在 0.12 / 0.16 / 0.20 三档下结果一致 ⇒ 结论对阈值不敏感，取最小的 0.12）。
 *      实测分离度：相关组 top1 命中数最低 2（3 词查询）/3（5~7 词查询），覆盖率最低 0.2359；
 *                不相关组最高命中共 2（6 词查询「推荐一部好看的电影」—— 正是被这条新规拦下的那条），覆盖率最高 0.2922。
 */
export const RELEVANCE_MIN = 0.12;
export const RELEVANCE_MIN_MATCH = 2;
/** 长查询（内容词 ≥5）要求的最低命中数 —— 见上面第二轮修正的说明 */
export const RELEVANCE_MIN_MATCH_LONG = 3;

/**
 * 这个查询需要命中几个内容词才算"相关"（**随查询长度放大**）。
 * @param {number} len relevanceTokens() 的长度
 * @returns {number}
 */
export function relevanceNeed(len) {
  if (len <= 2) return 1;
  if (len <= 4) return RELEVANCE_MIN_MATCH;
  return RELEVANCE_MIN_MATCH_LONG;
}

/** 疑问句的"脚手架"二元组：它们不是内容词，不该参与相关性判定（否则会把覆盖率压低） */
const REL_STOP_BIGRAMS = new Set(["什么", "怎么", "哪些", "哪里", "哪个", "多少", "多大", "多久",
  "几项", "几个", "几种", "几条", "是否", "可以", "能不能", "如何", "为什么", "咋样", "怎样",
  "什么样", "是吗", "的话"]);
/* 含这些字的二元组一律不当内容词：它们几乎只出现在疑问/语气脚手架里（热是 / 书是 / 是怎…） */
const REL_PARTICLES = /[是的吗呢吧啊什幺么哪些怎]/;

/**
 * 查询里"有信息量"的词（相关性判定专用，**不改索引、不改 BM25 打分**）。
 * @param {string} query
 * @returns {string[]} 去重后的内容词
 */
export function relevanceTokens(query) {
  return [...new Set(tokenize(query))].filter((t) =>
    (/^[a-z]/.test(t) || [...t].length >= 2) && !REL_STOP_BIGRAMS.has(t) && !REL_PARTICLES.test(t));
}

/**
 * 查询里的**主题词**：>=2 位的数字（R1 新增）。
 *
 * 🔴 为什么需要它（2026-10-13 实测，不修就答错）：
 *   「932 是怎么回事」这个词元里只有 `932` 一个词说的是"**在问哪个东西**"，
 *   其余（是怎/怎/怎么/么/么回/回/回事/事）全是疑问脚手架。
 *   实测这一条 query 的 top5 是：自测清单 / 台账说法卡 / §9.2 / §0.4 / 台账三 ——
 *   **全是"提了一句 932"的地方，没有一条是"解释 932"的**（§5.7 的正文一个都没进）。
 *   而把脚手架去掉、只问「932」时，检索结果**恰好正确**：
 *     台账:146 / 台账:64 / §5.7 标题:654 / §5.7 C:670（200 行复算）/ §5.7 D:678（使用口径）。
 *   ⇒ 病根不是"932 没进索引"（R1 已修），而是**脚手架词把主题挤掉了**：
 *     "回事"这个词在别的片段里也算命中，于是那些片段跟"真正在讲 932 的片段"**平起平坐**。
 *
 * 🔴 这条规则是**收紧**门槛，不是放松（对照前面两条纪律）：
 *   有主题词的查询，候选**必须命中主题词**才算出线。没主题词的查询，行为**一字不改**。
 *   所以它只会让"答非所问"的片段更少，不会让"没检索到"的片段更多。
 */
export function subjectTokens(query) {
  return [...new Set(tokenize(query))].filter((t) => /^\d{2,}(?:\.\d+)?$/.test(t));
}

/**
 * 一段文本与一个查询的相关性。
 * @param {object} chunk 索引里的片段（要有 _tf）
 * @param {string[]} qtokens relevanceTokens() 的结果
 * @param {string[]} [subjects] subjectTokens() 的结果（给了就要求必须命中至少一个）
 * @returns {{matched:number, need:number, rel:number, ok:boolean, why:string}}
 */
export function relevanceOf(chunk, qtokens, subjects) {
  const idx = buildIndex();
  const idfOf = (t) => {
    const df = idx.df.get(t) || 0;
    return Math.log(1 + (idx.N - df + 0.5) / (df + 0.5));
  };
  const list = qtokens || [];
  /* idf 上限：中位数的 3 倍（在 buildIndex 时算好，见 _idfCap） */
  const cap = idx._idfCap || Infinity;
  let tot = 0, hit = 0, matched = 0;
  for (const t of list) {
    const w = Math.min(idfOf(t), cap);
    tot += w;
    if (chunk._tf.has(t)) { hit += w; matched++; }
  }
  const rel = tot > 0 ? hit / tot : 0;
  const need = relevanceNeed(list.length);
  const sj = Array.isArray(subjects) ? subjects : [];
  const hitSubjects = sj.filter((t) => chunk._tf.has(t));
  /* 主题词门槛（有主题词时才生效）：命中主题词 = 这段真的在讲你在问的那个东西 */
  const subjectOk = sj.length === 0 || hitSubjects.length > 0;
  const ok = subjectOk && matched >= need && rel >= RELEVANCE_MIN;
  return {
    matched, need, rel: +rel.toFixed(4), ok,
    subjects: sj, hitSubjects, subjectOk,
    why: !subjectOk
      ? ("没有命中你问的那个数（" + sj.join("/") + "）—— 它只是碰巧含疑问词的片段")
      : (matched < need
        ? ("命中内容词只有 " + matched + " 个（需 ≥" + need + "）")
        : (rel < RELEVANCE_MIN ? ("覆盖率 " + rel.toFixed(3) + " 低于门槛 " + RELEVANCE_MIN) : "通过")),
  };
}

/* ------------------------------------------------------------------- 检索 */

const K1 = 1.4, B = 0.72;

/**
 * BM25 打分（**不过相关性门槛**）。search 与 forbiddenHit 共用这一层。
 * @returns {Array<{chunk:object, score:number}>} 已按分数降序
 */
export function scoreAll(query, opts = {}) {
  const idx = buildIndex();
  const q = tokenize(query);
  if (!q.length) return [];
  const qtf = new Map();
  for (const t of q) qtf.set(t, (qtf.get(t) || 0) + 1);
  const scored = [];
  for (const c of idx.chunks) {
    if (c.forbidden && !opts.includeForbidden) continue;
    if (opts.authorityMax && c.authority > opts.authorityMax) continue;
    let s = 0;
    for (const [t, qn] of qtf) {
      const f = c._tf.get(t);
      if (!f) continue;
      const df = idx.df.get(t) || 0;
      const idf = Math.log(1 + (idx.N - df + 0.5) / (df + 0.5));
      s += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * c._len / idx.avgdl)) * (1 + Math.log(qn));
    }
    if (s > 0) {
      /* 权威来源加权：台账/边界 ×1.35，手册 ×1.0，草稿 ×0.7 */
      const w = c.authority === 1 ? 1.35 : (c.authority === 2 ? 1.0 : 0.7);
      scored.push({ chunk: c, score: s * w });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * **相关性闸门**（F4）：给一批已打分的片段过门槛。
 *
 * 🔴 这是一个**纯函数**（输入 same ⇒ 输出 same），所以自检可以拿它做**反向变异**：
 *    把一条明显不相关的片段强行排到第一位，再调它 —— 必须返回"一段都不采用"。
 *    这样"门槛真在工作"是可验证的，而不是"看起来像在工作"。
 *
 * @param {string} query 用户原话
 * @param {Array<{chunk:object, score:number}>} scored scoreAll() 的结果（可被测试改写顺序）
 * @param {object} [opts] { topK }
 * @returns {{hits:Array, top:object|null, passed:number, dropped:number, reason:string}}
 *          hits 为空 + reason 说明为什么（调用方据此如实说"没检索到"）
 */
export function applyRelevance(query, scored, opts = {}) {
  const topK = opts.topK || 6;
  const list = scored || [];
  if (!list.length) return { hits: [], top: null, passed: 0, dropped: 0, reason: "知识库里没有任何片段命中这个词" };
  const qt = relevanceTokens(query);
  const sj = subjectTokens(query);
  const judged = list.map((h) => {
    const j = relevanceOf(h.chunk, qt, sj);
    return { ...h, rel: j.rel, relMatched: j.matched, relNeed: j.need, relOk: j.ok, relWhy: j.why,
      relHitSubjects: j.hitSubjects };
  });
  const top = judged[0];
  /* 🔴 排第一的都过不了 ⇒ 整句视为"没检索到"（不贴更弱的片段）
     ⚠ R1 之后这条也更严了：若查询带主题词（例如「932 是怎么回事」），
       而**排第一的片段压根不含 932**，那它过不了 ⇒ 整句不采用。
       这不违背后面的"排第一过不了就整句不检索"—— 它正是同一条纪律的延伸：
       **宁可说没检索到，也不贴一段答非所问的**。 */
  if (!top.relOk) {
    return { hits: [], top, passed: judged.filter((h) => h.relOk).length, dropped: judged.length, reason: "最相关的一段也没过相关性门槛：" + top.relWhy };
  }
  const kept = judged.filter((h) => h.relOk);
  return { hits: kept.slice(0, topK), top, passed: kept.length, dropped: judged.length - kept.length, reason: "通过" };
}

/**
 * 检索（**带相关性门槛**）。**默认把 forbidden 的块整条剔除**（除非 opts.includeForbidden）。
 *
 * ⚠ 与改动前的差别（F4）：这里不再"命中即用"。门槛没过 ⇒ 返回空数组，
 *   调用方必须如实说"我在知识库里没检索到与这个问题相关的内容"。
 * @returns {Array<{chunk:object, score:number, rel:number, relOk:boolean}>}
 */
export function search(query, opts = {}) {
  const { hits } = applyRelevance(query, scoreAll(query, opts), opts);
  return hits;
}

/** 被问到的内容**恰好命中** forbidden 块时，给一个诚实的回答（不含被禁内容）。
 *
 *  ⚠ F4 说明：这里刻意**不走相关性门槛**，只用 scoreAll() 的原始打分。
 *    理由：这条路的语义是"你问的这个东西**存在，但按纪律不许引用**"——
 *    它本身就是在解释"为什么我不给内容"，属于诚实性机制；
 *    若套上门槛，用户问那件事时会连"存在但不能引用"都听不到（那反而更像在隐瞒）。
 *    它**不产出任何正文数字**，所以不构成"命中即用"的口子。 */
export function forbiddenHit(query) {
  const hits = scoreAll(query, { includeForbidden: true })
    .slice(0, 3)
    .filter((h) => h.chunk.forbidden);
  if (!hits.length) return null;
  return {
    items: hits.map((h) => ({ cite: h.chunk.cite, item: h.chunk.item || h.chunk.heading })),
  };
}

/** 把检索结果拼成给 LLM 的上下文（**只含原文**，并显式标注出处与权威级别） */
export function contextBlock(hits) {
  return hits.map((h, i) => {
    const c = h.chunk;
    const lvl = c.authority === 1 ? "权威" : (c.authority === 2 ? "参考" : "草稿·不得作为数字依据");
    return "[片段" + (i + 1) + "][" + lvl + "] 出处：" + c.cite + "\n" + c.text;
  }).join("\n\n");
}

/** 供网页展示"知识库里有哪几份文件" */
export function knowledgeBase() {
  const idx = buildIndex();
  return idx.manifest.map((m) => ({
    ...m,
    source: (SOURCES.find((s) => s.id === m.id) || {}).note || "",
  }));
}

/* ============================================ 项目概况快速通道（N1，2026-10-12 加）
 *
 * 用户报的现象：问「介绍一下这个项目」，要等很久，而且答得乱
 * （把台账行、自测清单、检索片段一股脑堆上来，还全是文件名）。
 *
 * 原因不是模型笨，而是**这条问题本来就不该走"检索 + 让模型润色"**：
 *   ① BM25 对「介绍一下这个项目」这种泛问召回的是一堆零散片段（实测召回的是
 *      年运行小时那条台账、自测清单、第 6 天学习计划…），没有一条正中要害；
 *   ② 润色那一跳要发一次 2000~2500 token 预算的补全，实测 25 s 超时后还要再分块重试，
 *      整轮 115 s（2026-10-12 实测，见回报）。
 * 而"这个项目是什么"的权威答案，**手册开头就写好了**（§0.2 一句话、§0.3 三个数字、
 * §2.1 三十秒版、§2.2 两个痛点/我们做的事）。它不需要润色，需要的是**原样取出来**。
 *
 * 🔴 纪律：
 *   ① 只取**具名小节**（标题必须逐字匹配），不做任何改写、不做摘要、不加过渡句；
 *   ② 取到的每一节都要过 isForbiddenText()（与检索同一条黑名单规则）——
 *      命中即整节丢弃，并在返回值里**如实报出来**，不悄悄少给；
 *   ③ 只读源文件，不写；不缓存到磁盘。
 */

/** 快速通道要用的小节（标题**逐字**匹配；顺序即用户看到的顺序） */
const OVERVIEW_SECTION_IDS = [
  "0.2 一句话讲清这个项目",
  "0.3 你必须带走的三个数字",
  "2.1 三十秒版",
  "2.2 两分钟版",
];

/**
 * 从知识手册里按**具名小节**取原文（不含标题行本身）。
 * @param {string} idSub 小节标题的子串（例如 "0.2 一句话讲清这个项目"）
 * @returns {{heading:string, text:string, line:number, chars:number}|null}
 *          null = 手册不可读 / 找不到该小节
 */
export function handbookSection(idSub) {
  const src = SOURCES.find((s) => s.id === "handbook");
  if (!src) return null;
  const abs = sourceAbs(src);          /* ⚠ 必须走 sourceAbs()：手册快照在 agent_wh 下，不是 PROJECT_ROOT 下 */
  let text;
  try {
    if (!fs.existsSync(abs)) return null;
    text = fs.readFileSync(abs, "utf8");
  } catch { return null; }
  const lines = text.split(/\r?\n/);
  let start = -1, heading = "";
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^#{1,4}\s+(.*)$/);
    if (!h) continue;
    if (start < 0) {
      if (h[1].trim().includes(idSub)) { start = i + 1; heading = h[1].trim(); }
    } else {
      break;    /* 撞到下一个标题 ⇒ 本小节结束 */
    }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^#{1,4}\s+/.test(lines[i])) { end = i; break; }
  }
  const body = lines.slice(start, end).join("\n")
    .replace(/^\s*-{3,}\s*$/gm, "")     /* 小节之间的 --- 分隔线去掉，它不是内容 */
    .trim();
  return { heading, text: body, line: start + 1, chars: body.length, cite: src.rel.replace(/\\/g, "/") + ":" + (start + 1) + "（" + heading + "）" };
}

/**
 * 项目概况的**原文素材**：手册开头那几节，原样取出、逐节标注出处。
 *
 * 快速通道与自检都用它 —— 保证"回答里的说法"与"手册里的说法"是同一份文本。
 * @returns {{items:Array<{heading,text,cite,line}>, skipped:Array<{heading,reason}>, source:string|null}}
 */
export function handbookOverview() {
  const src = SOURCES.find((s) => s.id === "handbook");
  const abs = sourceAbs(src);          /* 同 handbookSection()：快照在 agent_wh/kb 下 */
  const items = [], skipped = [];
  for (const id of OVERVIEW_SECTION_IDS) {
    let s = null;
    try { s = handbookSection(id); } catch { s = null; }
    if (!s) { skipped.push({ heading: id, reason: "手册里找不到这一节（或手册不可读）" }); continue; }
    /* 与检索同一条黑名单规则（R2 后是"逐行 + 认纪律声明"那一版）：命中 ⇒ 整节不进快速通道 */
    if (isForbiddenByLines(s.text) || isForbiddenByLines(s.heading)) {
      skipped.push({ heading: s.heading, reason: "该节命中「不得引用」纪律词，整节剔除（不进检索、也不进快速通道）" });
      continue;
    }
    items.push({ heading: s.heading, text: s.text, cite: s.cite, line: s.line });
  }
  return { items, skipped, source: abs };
}

/**
 * 「这句话是不是在问项目概况/我们做了什么」。
 *
 * ⚠ 刻意做成**保守**的白名单式判据：必须同时有"项目指代词 + 泛问词"，
 *   或直接用"介绍 + 项目"。像「年运行小时默认多少」这种**具体口径**问题
 *   会被 SPECIFIC_FACT 挡掉，仍然走原来的检索路（那里能给出逐行出处）。
 *   理由：快速通道给的是手册原文，它回答不了"某个数登记在哪一行"。
 */
const OVERVIEW_PATTERNS = [
  /* 「介绍一下（你们的）项目 / 平台 / 作品…」 */
  /介\s*绍[一一下]*\s*[^。！？!?；;]{0,8}?(项目|平台|作品|系统|工具|产品|课题)/,
  /* 「这个项目/平台是做什么的、能干什么」 */
  /[^。！？!?；;]{0,8}?(项目|平台|作品|系统|工具|产品)[^。！？!?；;]{0,6}(是什么|是做什么的|做什么的|干什么的|干啥的|有什么用|能做什么|能干什么|干什么用|干嘛的)/,
  /* 「你们做的是什么」 */
  /(你们|你们俩|咱们|我们)做的?(是|了)?(什么|啥)/,
];
/* 具体口径/数字类问题：即使句子里带了"项目"，也**不许**走快速通道
   （那些问题要的是逐行出处，手册开头的概况答不了，硬答等于答非所问） */
const OVERVIEW_BLOCK = /(年运行小时|运行小时|温度包络|包络|台账|证书|扰动|翻转|贴近度|可回收热|口径|出处|依据|来源|边界|阈值|默认值|工况库|端差|流量|焓|效率|投资|回收期|多少|几项|几条|哪个文件|哪一行|怎么算|怎么来的)/;

/**
 * @param {string} text 用户本轮原话
 * @returns {boolean}
 */
export function isProjectOverviewQuestion(text) {
  const t = String(text || "").trim();
  if (!t || t.length > 60) return false;          // 概况问句都很短；长句一律按具体问题处理
  if (!OVERVIEW_PATTERNS.some((re) => re.test(t))) return false;
  if (OVERVIEW_BLOCK.test(t)) return false;
  return true;
}
