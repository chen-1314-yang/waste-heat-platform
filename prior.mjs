/* prior.mjs —— **先验表：单一来源**（本次改动 G2 的落地点）。
 *
 * ⚠ 先说清它是干什么的、**不是**干什么的（这条是本次唯一的红线）：
 *   ✅ 它只用来**提问**：告诉用户"同类工况一般在什么量级"，让"说不清"的人能开口。
 *   ❌ 它**绝不**用来出数：表里的任何数字都不许进 scene、不许进引擎。
 *      用户确认/改写之后才进引擎，那时数字的来源是**用户自己说的**（走既有的
 *      `numberTraceableInUserText` 通道，也就是 dialog.mjs 的闸 A）。
 *      自检里有一条**反向突变**专门证明这一点：把一个"只存在于本表、用户没说"的值
 *      注入入参候选 ⇒ 必须被闸 A 拦掉（见 e2e_chat_test.mjs 第 ⑱ 节）。
 *
 * 每条先验都必须能**指回具体某一行**，只有三种合法出处：
 *   ① 工况库那 19 行（`HFDATA.conds`，运行时从引擎 bridge 读，**行号就是出处**）；
 *   ② 《对外数字台账》里登记过的公开数据（`docs/对外数字台账.md:行号`，只读引用）；
 *   ③ 项目**自己**的案例回测登记（公开案例 + 行业典型口径，非实测；指到 docs 行号）。
 *   **查不到出处的参数，不进这张表** —— 那就退化成"只问、不给区间"（宁可不给，不许编）。
 *
 * ── 实测：项目里**没有**"窑尾气量典型区间"这种登记 ────────────────────────────
 *   全项目检索 `5~15 万标方` / `Nm3/h` 一类写法：**零命中**（2026-10-12 实测）。
 *   所以本表对"水泥窑尾流量"**只给点值**（工况库第 4 行 = 60 kg/s = 预设值本身），
 *   **不给区间** —— 给了区间就等于把两个不相干的数当成一个"常见范围"，那是编。
 *   "区间"这件事在温度上成立（有公开登记：300~400℃），在流量上不成立。
 *   如实写在这里，免得下一个人以为这里漏了一行。
 */

import { engineMeta } from "./engine_bridge.mjs";

/* ---------------------------------------------------------------- 工况库读行 */

/* 行号口径：**1-based**，与界面上「工况库 19 行」的说法一致（HFDATA.conds[行号-1]）。
   ⚠ 运行时读、不硬编码数组：这样"工况库改了"与"先验表过期了"不会各说各话。
   读不到（引擎加载失败）⇒ 返回 null，调用方退化成"只问、不给"，
   **绝不**用写死的数字顶上去。 */
function row(i1) {
  try {
    const M = engineMeta();
    const r = (M && M.conds) || [];
    if (i1 < 1 || i1 > r.length) return null;
    const x = r[i1 - 1];
    if (!Array.isArray(x)) return null;
    return {
      line: i1,
      name: String(x[0] || ""),          // 「水泥-窑尾废气」
      industry: String(x[1] || ""),      // 水泥
      medium: String(x[2] || ""),        // 窑尾预热器废气
      t: Number(x[3]),                   // 热源温度 ℃
      flow: Number(x[4]),                // 流量 kg/s
      hours: Number(x[8]),               // 年运行小时
      demand: String(x[9] || ""),        // 需求
      continuity: String(x[10] || ""),
      note: String(x[12] || ""),
      cite: "工况库第 " + i1 + " 行（" + x[0] + "：热源 " + x[3] + "℃ / 流量 " + x[4] + " kg/s / " + x[9] + "）",
    };
  } catch { return null; }
}

/* --------------------------------------------------- 载体/需求候选（也须有出处） */

/* 「载体」是枚举（引擎只认 烟气 / 热水·冷凝水 / 工艺液体），不涉及数值假设，
   所以它的候选直接取工况库里**真的出现过**的那几种，并用行号作证。
   ⚠ 这不是"猜用户是什么载体"，而是"引擎支持哪几种 + 库里的例子"，两件事都不产生数字。 */
export const MEDIUM_CANDIDATES = [
  { value: "烟气", citeLine: 1, example: "钢铁-高炉煤气锅炉排烟（工况库第 1 行）" },
  { value: "热水/冷凝水", citeLine: 14, example: "数据中心-IT冷却水回水 70℃（工况库第 14 行）" },
  { value: "工艺液体", citeLine: 8, example: "化工-常减压塔底油 140℃（工况库第 8 行）" },
];

/* 「需求」同理：是引擎的 6 个枚举值（decision_core.js 的需求集），
   候选里的例子取库中行号作证。**不给任何数字**。 */
export const DEMAND_CANDIDATES = [
  { value: "发电", citeLine: 4, example: "水泥-窑尾废气（工况库第 4 行）" },
  { value: "工艺蒸汽", citeLine: 5, example: "水泥-篦冷机中低温废气（工况库第 5 行）" },
  { value: "供暖/热水", citeLine: 13, example: "热电-燃煤锅炉排烟 150℃（工况库第 13 行）" },
  { value: "供冷（制冷）", citeLine: 17, example: "钢铁-高炉冲渣水 80℃（工况库第 17 行）" },
  { value: "干燥/烘干", citeLine: 18, example: "热电-锅炉排烟 150℃ 烘干（工况库第 18 行）" },
  { value: "储热调峰", citeLine: 16, example: "储热调峰-电加热熔盐 380℃（工况库第 16 行）" },
];

/* ----------------------------------------------------------- 热源形态 → 工况库行 */

/* 结构：`{ id, match(原话), rows:[工况库行号], tempOut }`
 *   match  只做"像不像这一类热源"的形态判定，**不解析数字**
 *   rows   这一类最接近的工况库行（按相近度排序，第一行就是回答里引用的那行）
 *   tempOut 类外温度的**公开登记出处**（可选）：只有项目里真的登记过才写
 *           `{ range:"300~400", typical:"350", kind:"case", cite:"…" }` */
export const SHAPE_TABLE = [
  {
    /* ⚠ 表序 = 匹配优先级：**具体类在前、泛类在后**。
       实测踩过两次（都写在这里，免得再犯）：
         ① 把泛类 `flue-gas-generic`（匹配"烟气"）放在前面 ⇒「我们这台窑，烟气挺烫的」
            被抢到"钢铁-高炉渣显热 900℃"那去，先验温度给成了 900℃；
         ② 把 `cement-kiln-tail` 放在 `glass` 前面 ⇒「玻璃池窑的烟气很烫」被当成水泥窑。
       所以：① 泛类垫底；② 玻璃/石灰这类**自带专名**的窑排在"窑"这个泛称前面。 */
    id: "glass",
    match: (t) => /玻璃|池窑|退火窑/.test(t),
    rows: [6, 7], tempOut: null,
  },
  {
    id: "lime-kiln",
    match: (t) => /石灰窑|石灰/.test(t),
    rows: [4, 6],
    tempOut: null,   /* 项目只登记过"水泥窑/烧结"的 300~400，石灰窑没单独登记 —— 不给 */
  },
  {
    id: "cement-kiln-tail",
    /* 命中条件（两条任一）：
         ① 明确的窑尾/预热器/水泥窑/窑头专名 —— 这条是**硬命中**；
         ② 只有"窑"这个泛称，但句子里出现了烟气/废气/熟料之类的限定词 —— 记成**条件命中**
            （`soft:true`）：先验里必须写明"我按水泥窑尾读的，若不对你直接改"，
            因为"窑 + 烟气"也可能是别的窑型。 */
    match: (t) => /窑尾|预热器|水泥窑|回转窑|立窑|旋窑|窑头/.test(t) ||
      (/窑/.test(t) && /水泥|熟料|烟气|废气|尾气/.test(t)),
    soft: (t) => !/窑尾|预热器|水泥窑|回转窑|立窑|旋窑|窑头/.test(t),
    rows: [4, 3],
    /* 出处（两条，都可指回具体行）：
       ① 工况库第 4 行「水泥-窑尾废气」预设温度就是 350℃；
       ② 项目自己的案例回测登记：石门海螺 18 MW 在运工程，**温度取水泥窑行业典型 300~400℃
          的 350℃（非实测）** —— case_benchmark.py:233 的注释，
          同时登记在 docs/2026-10-03-案例回测9条逐条登记.md:116。 */
    tempOut: {
      range: "300~400", typical: "350", kind: "case",
      cite: "案例回测登记（docs/2026-10-03-案例回测9条逐条登记.md:116）——石门海螺 18 MW 在运工程，" +
        "温度取水泥窑行业典型 300~400℃ 的 350℃（**非实测**，项目自己的原话）",
    },
  },
  {
    id: "cement-clinker-cooler",
    match: (t) => /篦冷|冷却机|熟料冷却/.test(t),
    rows: [5, 4],
    tempOut: null,   /* 项目里只登记了"窑尾/窑头废气"的 300~400，没单独登记篦冷机 —— 不给 */
  },
  {
    id: "steel-sinter",
    match: (t) => /烧结|环冷/.test(t),
    rows: [2, 3],
    tempOut: {
      range: "300~400", typical: "350", kind: "case",
      cite: "案例回测登记（docs/2026-10-03-案例回测9条逐条登记.md:126）——昆钢安宁 12 MW 在运工程，" +
        "温度取烧结/环冷废气行业典型 300~400℃ 的 350℃（**非实测**）",
    },
  },
  {
    id: "steel-slag",
    match: (t) => /高炉渣|熔渣|水渣|冲渣|干熄焦/.test(t),
    rows: [17, 3], tempOut: null,
  },
  {
    id: "steel-blast-furnace-gas",
    match: (t) => /高炉煤气|煤气锅炉|热风炉/.test(t),
    rows: [1], tempOut: null,
  },
  {
    id: "chemical",
    match: (t) => /化工|炼油|裂解|塔底油|常减压|反应器/.test(t),
    rows: [8, 9, 10], tempOut: null,
  },
  {
    id: "data-center",
    match: (t) => /数据中心|机房|服务器|IT\s*冷却/i.test(t),
    rows: [14], tempOut: null,
  },
  {
    id: "paper",
    match: (t) => /造纸|烘干废气|纸机/.test(t),
    rows: [15, 19], tempOut: null,
  },
  {
    id: "power-plant",
    match: (t) => /锅炉排烟|燃煤锅炉|燃气轮机|燃机|锅炉尾|电站锅炉|热电/.test(t),
    rows: [13, 12, 18], tempOut: null,
  },
  {
    id: "nonferrous",
    match: (t) => /有色|冶炼|铜|铝|锌|铅/.test(t),
    rows: [11], tempOut: null,
  },
  {
    id: "thermal-storage",
    match: (t) => /熔盐|储热|蓄热|谷电/.test(t),
    rows: [16], tempOut: null,
  },
  {
    id: "hot-water",
    match: (t) => /热水|循环水|冷凝水|冷却水|回水|工艺水/.test(t),
    rows: [14, 17, 19], tempOut: null,
  },
  /* ---- 以下两条是**泛类**，必须垫底 ---------------------------------- */
  {
    id: "steel-generic",
    match: (t) => /钢铁|钢厂|炼钢|转炉|加热炉/.test(t),
    rows: [1, 2, 3, 17], tempOut: null,
  },
  {
    id: "flue-gas-generic",
    match: (t) => /烟气|废气|排烟|尾气|窑气/.test(t),
    rows: [3, 12], tempOut: null,
  },
];

/** 这一类热源在工况库里最接近的那一行（找不到 ⇒ null）。
 *  `soft:true` = 只是**条件命中**（原话里没有专名，只有"窑"这种泛称），
 *  先验文案里必须写明"我按 XX 读的，不对你直接改"。 */
export function guessShape(text) {
  const t = String(text || "");
  for (const s of SHAPE_TABLE) {
    let hit = false;
    try { hit = !!s.match(t); } catch { hit = false; }
    if (!hit) continue;
    const rows = (s.rows || []).map(row).filter(Boolean);
    if (!rows.length) return null;
    let soft = false;
    try { soft = typeof s.soft === "function" ? !!s.soft(t) : false; } catch { soft = false; }
    return { id: s.id, main: rows[0], alts: rows.slice(1), tempOut: s.tempOut || null, soft };
  }
  return null;
}

/**
 * 多轮版的形态判定：本轮说「350 左右吧」时**本身不含任何热源词**，
 * 但上一轮说过「我们这台窑，烟气挺烫的」—— 那时已经认出是"水泥-窑尾"这一类了。
 * 若只看本轮，先验就会退化成"只问、不给"（实测踩到：第 2 轮问流量时参照值整段消失）。
 *
 * ⚠ 只向前回看**文本**（用户原话），不看任何数值：
 *   `turns` 里若带 `userText` 就用它，否则用 `text` 本身。找不到就返回 null
 *   ⇒ 调用方走 `blindAsk`（只问、不给），**绝不用一个"差不多的"行硬凑**。
 * @param {string} text 本轮原话
 * @param {Array<{userText?:string,text?:string}>} [turns] 最近几轮（新的在后）
 */
export function guessShapeMulti(text, turns) {
  const now = guessShape(text);
  if (now) return now;
  const arr = Array.isArray(turns) ? turns.slice(-3).reverse() : [];
  for (const t of arr) {
    const s = String((t && (t.userText || t.text)) || "");
    if (!s) continue;
    const g = guessShape(s);
    if (g) return { ...g, fromEarlierTurn: true, fromText: s.slice(0, 40) };
  }
  return null;
}

/* ------------------------------------------------------------------ 先验条目 */

/**
 * **先验表本体**（给自检与回报看；别让"它到底引了什么"藏着）。
 *
 * 每条形如 `{ param, kind, asks, ... , cites[] }`：
 *   `asks`  里面就是**问题的一部分** —— 候选区间/典型值 + 一句话依据。
 *   `cites` 每一条都指回"工况库第 N 行"或"台账/登记第 N 行"。
 *
 * @param {string} text 用户本轮原话（只用于**选哪一类热源**，不做任何数字解析）
 * @returns {Array<object>}
 */
export function priorFor(text) {
  const t = String(text || "");
  const shape = guessShape(t);
  const out = [];

  /* ---- 温度 ------------------------------------------------------------- */
  const tCites = [];
  let tRange = null, tTypical = null, tBasis = "";
  /* ⚠ `soft` 的用法（"听着像"这句话必须**有条件**）：原话里没有窑尾/水泥窑这种专名时，
     先验只能"按最接近的那一类读"，所以文案里必须写明"我按 XX 读的，读错了你直接改"。 */
  const softNote = (shape && shape.soft)
    ? "⚠ 你原话里没有点名是哪种窑，我是**按最接近的那一类读**的（读错了你直接说，我按你说的算）。"
    : "";
  if (shape) {
    if (shape.tempOut) {
      tRange = shape.tempOut.range;
      tTypical = shape.tempOut.typical;
      tBasis = "同类工况的行业典型区间是 " + tRange + "℃（项目自己的案例回测登记里就是这么取值的）";
      tCites.push(shape.tempOut.cite);
    }
    tCites.push(shape.main.cite + " —— 这一行的热源温度就是 " + shape.main.t + "℃");
    if (!shape.tempOut) {
      tTypical = shape.main.t;
      tBasis = "工况库里最接近的那一行，热源温度是 " + shape.main.t + "℃";
    }
  } else {
    tTypical = null;
    tBasis = "没对上工况库里的哪一类热源";
  }
  out.push({
    param: "温度", unit: "℃",
    range: tRange, typical: tTypical,
    asks: (tRange
      ? "**大概多少度？** " + softNote + tBasis + "，也就是 **" + tRange + "℃** 这个量级；工况库里最接近的预设是 **" +
        (shape ? shape.main.t : "—") + "℃**（" + (shape ? shape.main.name : "—") + "）。"
      : (tTypical
        ? "**大概多少度？** " + softNote + tBasis + "，可以照这个量级比一比；⚠ 项目里**没有登记过**这一类热源的温度" +
          "**区间**，所以这里只给这一个**点值**当参照（不编一个 300~400 那样的范围给你）。"
        : "**大概多少度？** 这一条我在工况库里找不到同类预设、公开登记里也没有同类区间，" +
          "**所以既不给区间也不给典型值** —— 你说个数，我按你说的算。")),
    basis: tBasis,
    cites: tCites,
    asked: true,
  });

  /* ---- 流量 -------------------------------------------------------------
     ⚠ 实测：项目里**没有**"窑尾气量典型区间"的登记（全项目检索零命中）。
        所以这里只给"工况库里那个预设用的是多少"这个**点值**，不给区间。
        给了区间就是编 —— 这一条刻意留白，别在这里补一个好看的数。 */
  const fCites = [];
  let fTypical = null;
  if (shape) {
    fTypical = shape.main.flow;
    fCites.push(shape.main.cite + " —— 这一行的流量是 " + shape.main.flow + " kg/s");
    for (const a of shape.alts) fCites.push(a.cite + " —— 同类另一行是 " + a.flow + " kg/s");
  }
  out.push({
    param: "流量", unit: "kg/s",
    range: null,
    typical: fTypical,
    /* 换算式：纯单位换算，密度是**本演示件自己的工程取值**（dialog.mjs:CONV 里那条 caveat），
       这里只是把"你熟悉的单位"换算给用户看，不产生任何结果数。 */
    convert: { density_kg_per_Nm3: 1.34, caveat: "标方↔kg/s 要乘一个标况密度，那个密度是**本演示件的工程取值、未在项目台账找到出处**，只是方便你换算，不改任何结论" },
    asks: (fTypical != null
      ? "**气量（或水量）呢？** " + softNote + "同类预设用的是 **" + fTypical + " kg/s**（" +
        (shape ? shape.main.name : "—") + "，工况库第 " + (shape ? shape.main.line : "—") + " 行）。" +
        "⚠ 项目里**没有登记过**" + (shape ? shape.main.industry : "") + "这类热源的气量典型区**区间**，" +
        "所以这里只给这一个**点值**当参照，不编一个范围给你。你也可以直接说 kg/s 或 t/h。"
      : "**气量（或水量）呢？** 这一条我在工况库里找不到同类预设，**所以不给参照值** —— 你说个数（kg/s 或 t/h），我按你说的算。"),
    basis: fTypical != null ? "工况库同类预设的流量列（点值，非区间）" : "无同类预设",
    cites: fCites,
    asked: true,
  });

  /* ---- 载体 ------------------------------------------------------------- */
  out.push({
    param: "载体", unit: "",
    range: null, typical: null,
    options: MEDIUM_CANDIDATES.map((m) => ({
      value: m.value, cite: "工况库第 " + m.citeLine + " 行：" + m.example,
    })),
    asks: "**这股热是什么载体？** 引擎只认三种：**烟气 / 热水·冷凝水 / 工艺液体**" +
      (shape ? "（听你这句话，像是**" + (/热水|循环水|冷凝水|冲渣水/.test(t) ? "热水/冷凝水" :
        (/油|熔盐|工艺液|物料|渣/.test(t) ? "工艺液体" : "烟气")) + "**，但这只是我从字面上读的，你确认）" : "") + "。",
    basis: "引擎的载体取值集（三选一），例证取工况库真实行",
    cites: MEDIUM_CANDIDATES.map((m) => "工况库第 " + m.citeLine + " 行：" + m.example),
    asked: true,
  });

  /* ---- 需求 ------------------------------------------------------------- */
  out.push({
    param: "需求", unit: "",
    range: null, typical: null,
    options: DEMAND_CANDIDATES.map((d) => ({
      value: d.value, cite: "工况库第 " + d.citeLine + " 行：" + d.example,
    })),
    asks: "**这股热你想用来做什么？** 引擎支持六种：发电 / 工艺蒸汽 / 供暖·热水 / 储热调峰 / 供冷（制冷）/ 干燥·烘干。" +
      "⚠ 你上一句没提用途，我**不替你假设成「发电」** —— 默认值会改变结论，这个必须你说了算。",
    basis: "引擎的需求取值集（六选一），例证取工况库真实行",
    cites: DEMAND_CANDIDATES.map((d) => "工况库第 " + d.citeLine + " 行：" + d.example),
    asked: true,
  });

  return out;
}

/** 只要某几个参数（按优先级取前 N 个）。缺省 = 全部四项。
 *  @param {string} text  用来选"哪一类热源"的文本
 *  @param {string[]} params
 *  @param {string} [searchText] 若形态是从**上一轮**认出来的，这里传那一轮的原话，
 *         否则本轮说"350 左右吧"时会因为选不中热源类而退化成"只问、不给"（实测踩到）。 */
export function priorForParams(text, params, searchText) {
  const want = params && params.length ? params : ["温度", "流量", "载体", "需求"];
  const all = priorFor(String(searchText || text || ""));
  const idx = new Map(all.map((x) => [x.param, x]));
  return want.map((p) => idx.get(p)).filter(Boolean);
}

/* ------------------------------------------------------------ 只问不给（退化态） */

/**
 * 「查不到出处 ⇒ 不给区间，只问"大概是多少"」的**可判定**出口。
 * 自检的反向变异 A 就是拿一个本表不覆盖的载体去调它，断言 `range/typical/options` 全为空。
 * @returns {{param:string, range:null, typical:null, options:null, asks:string, cites:string[]}}
 */
export function blindAsk(param) {
  const p = String(param || "温度");
  return {
    param: p, unit: p === "温度" ? "℃" : (p === "流量" ? "kg/s" : ""),
    range: null, typical: null, options: null,
    asks: "**" + p + "大概是多少？** 我按你说的算。",
    basis: "工况库里没有可引用的同类预设，公开登记里也没有 ⇒ **宁可不给，不许编**",
    cites: [],
    blind: true,
  };
}

/* ------------------------------------------------------------------ 自检入口 */

/** 先验表**全表**（不依赖用户原话，用于 /api/meta 与自检打印）。 */
export function priorCatalog() {
  return priorFor("窑尾烟气");
}

/** 表里每一条的出处清单是否非空 —— 自检用（"每条都要能指回某一行"）。 */
export function priorRowsWithCites() {
  return priorFor("窑尾烟气").filter((x) => (x.cites || []).length > 0).map((x) => x.param);
}
