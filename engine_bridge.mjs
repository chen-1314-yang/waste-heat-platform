/* engine_bridge.mjs —— 把「浏览器全局」的决策引擎原样加载进 Node，并暴露 callEngine()。
 *
 * 用途：竞赛答辩演示件的真实引擎后端。
 *
 * 🔴 本文件不修改引擎的任何一行代码（铁律 2）。做法是**加载**，不是改：
 *    引擎源码把自身挂在 window.WHENG / window.HFxxx 上，因此这里只补一个 window 别名，
 *    再按 tools/build.py 的 SCRIPT_FILES 顺序用 vm 逐文件执行。
 *
 * 加载顺序的唯一真源：D:\Codex\2026-08-06\ni\时代杯项目材料\12_网站v4_实验版\tools\build.py
 *   L14-L50  SCRIPT_FILES
 *   L15-L33  util.js → engine/*（内核与数据必须先于老站界面代码）
 *   L30      legacy/hfdata.js（提供 window.HFDATA，含 runDecision 要的 meta）
 *   L33      legacy/eff_table_override.js（覆盖 window.HFDATA.orcPct）
 *   L36      legacy/data_patch.js
 *   L37 起   legacy/ui.js / app.js / views/* —— 这些要 DOM，本 bridge 不加载
 *
 * ⚠ 一个**刻意的不一致**，已在回报中写明：
 *     build.py 在 hfdata.js 之后还会执行 eff_table_override.js，它把 window.HFDATA.orcPct
 *     换成 60~350℃ 的新表（evidence: eff_table_override.js:20）。本 bridge 为了「尽量少加载
 *     非必要文件」，**没有**加载它 —— 后果是 60~150℃ 段的 ORC 效率表与线上站点不同。
 *     smoke_test.mjs 会实测这一点。要完全对齐线上，把 LOAD_OVERRIDE 改成 true 即可。
 */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ---------------------------------------------------------------- 项目根定位 */

/** 候选项目根（按顺序探测）。可用环境变量 WH_ROOT 覆盖。 */
const ROOT_CANDIDATES = [
  process.env.WH_ROOT,
  "D:\\Codex\\2026-08-06\\ni\\时代杯项目材料\\12_网站v4_实验版",
  "D:\\Codex\\2026-08-06\\ni\\时代杯项目材料\\12_网站v4_实验版\\dist",
  path.join(HERE, "..", "12_网站v4_实验版"),
].filter(Boolean);

function findProjectRoot() {
  for (const c of ROOT_CANDIDATES) {
    try {
      if (fs.existsSync(path.join(c, "src", "engine", "decision_core.js"))) return c;
      // dist 形态：只有单文件 HTML
      if (fs.existsSync(path.join(c, "工业余热回收_新版_单文件.html"))) return c;
    } catch { /* 忽略不可访问的候选 */ }
  }
  return null;
}

export const PROJECT_ROOT = findProjectRoot();

/* --------------------------------------------------- build.py SCRIPT_FILES 子集 */

/* 只取「引擎链条」需要的前缀，逐项与 build.py 对齐：
     util.js                        build.py L15
     engine/parasitic_table.js      L18
     engine/parasitic.js            L19
     engine/fluid_matrix.js         L21
     engine/fluids.js               L22
     engine/turbine_size.js         L23
     engine/expander_map.js         L24
     engine/chiller_grid.js         L25
     engine/two_stage_table.js      L26
     engine/orc_cond_table.js       L27
     engine/decision_core.js        L28
     engine/io.js                   L29    ← 官方适配层（frameToScene）
     legacy/hfdata.js               L30    ← window.HFDATA（含 meta）
   刻意停在 L30：L31 之后全是 DOM 界面代码。 */
const ENGINE_ORDER = [
  "util.js",
  "engine/parasitic_table.js",
  "engine/parasitic.js",
  "engine/fluid_matrix.js",
  "engine/fluids.js",
  "engine/turbine_size.js",
  "engine/expander_map.js",
  "engine/chiller_grid.js",
  "engine/two_stage_table.js",
  "engine/orc_cond_table.js",
  "engine/decision_core.js",
  "engine/io.js",
  "legacy/hfdata.js",
  // build.py L33：实测发现**不加载它会改变 ORC 效率表**，故默认补上以对齐线上。
  "legacy/eff_table_override.js",
];

/* ------------------------------------------------------------------- shim */

/* 引擎全部文件只用到 window 这一个浏览器全局（已实测：engine/*.js 里没有
   document / localStorage / navigator 的引用，见回报「四、引擎是怎么加载的」）。
   所以 shim 只需两件事：window 别名 + self 别名（io.js 的 UMD 包装读 self）。 */
let loaded = false;
let loadLog = [];
export function loadEngine() {
  if (loaded) return { WHENG: globalThis.WHENG, WHIO: globalThis.WHIO, HFDATA: globalThis.HFDATA };
  if (!PROJECT_ROOT) {
    throw new Error(
      "找不到项目根。请设置环境变量 WH_ROOT 指向 12_网站v4_实验版 目录。\n" +
      "已尝试：\n  " + ROOT_CANDIDATES.join("\n  ")
    );
  }
  if (!globalThis.window) globalThis.window = globalThis;
  if (!globalThis.self) globalThis.self = globalThis;

  const ctx = vm.createContext(globalThis);
  for (const rel of ENGINE_ORDER) {
    const abs = path.join(PROJECT_ROOT, "src", rel);
    if (!fs.existsSync(abs)) throw new Error("缺少引擎文件：" + abs);
    const code = fs.readFileSync(abs, "utf8");
    vm.runInContext(code, ctx, { filename: abs });
    loadLog.push({ file: rel, bytes: code.length, abs });
  }
  const eng = globalThis.WHENG, D = globalThis.HFDATA, IO = globalThis.WHIO;
  if (!eng || typeof eng.runDecision !== "function") throw new Error("加载后 window.WHENG.runDecision 不可用");
  if (!D || !D.meta) throw new Error("加载后 window.HFDATA.meta 不可用（runDecision 需要它）");
  eng.setTables(D);            // ui.js:5 同款调用：把 HFDATA 交给内核
  loaded = true;
  return { WHENG: eng, WHIO: IO, HFDATA: D };
}

export function engineLoadLog() { return loadLog.slice(); }

/* --------------------------------------------------------------- 场景校验 */

/* scene 字段与可用值，逐个标注出处（见回报「四」）：
   "需求"            io.js:11-14 DEMAND_MAP 映射到内核词；内核合法值 decision_core.js:28 DEMAND_SET
   "热源温度_degC"    decision_core.js:572-577 包络 25~650
   "载体"            decision_core.js:30 CP 的键 —— 只有 烟气 / 热水·冷凝水 / 工艺液体
   "流量_kg_s"       decision_core.js:590-600 recoveredHeatKw
   "规模_kW"         decision_core.js:597-598（与流量二选一）
   "换热端差_degC"    decision_core.js:555 缺省 10
   "年运行小时"       decision_core.js:338 DEFAULT_RUN_HOURS=6500；:580-586 供暖·热水按 3200 折算
   "连续性"          decision_core.js:550 缺省「连续」
   "驱动来源"        decision_core.js:551 缺省「余热自驱动」
   "需求温度_degC"    decision_core.js:549 缺省 null；ui.js:26 注释说明其作用 */
export const CORE_DEMANDS = ["发电", "工艺蒸汽", "供暖·热水", "储热调峰", "供冷", "干燥"];
export const CORE_MEDIA = ["烟气", "热水·冷凝水", "工艺液体"];

/* --------------------------------------------------------------- 主入口 */

/**
 * 用真实引擎算一次决策。
 * @param {object} scene 引擎 scene（内核中文键）
 * @param {object} [opts] { lam, wantCertificate, wantBoundaryNotices }
 */
export function callEngine(scene, opts = {}) {
  const { WHENG: eng, HFDATA: D } = loadEngine();
  const lam = typeof opts.lam === "number" ? opts.lam : (D.lam0 != null ? D.lam0 : 0.5);

  const v = eng.validateScene(scene);
  if (!v.ok) {
    /* 引擎自己的拒绝原话 —— 原样回传，不加工（铁律 1） */
    return {
      ok: true, out_of_scope: true,
      message: v.error,
      warnings: [v.error],
      scene: null, engineMessage: v.error, rejectBy: "validateScene",
    };
  }
  const s = v.scene;

  let res;
  try {
    res = eng.runDecision(s, lam, D.meta);   // meta 必传：decision_core.js:2030-2040
  } catch (e) {
    return { ok: false, error: "runDecision 抛错：" + (e && e.message), stack: String(e && e.stack) };
  }

  const out = {
    ok: true,
    out_of_scope: !!res.out_of_scope,
    message: res.message || "",
    warnings: res.warnings || [],
    /* 场景：引擎 validateScene 之后的**实际**读入值（含它补的默认值） */
    scene: res.scene || s,
    sceneIn: scene,
    lam,
    engine: {
      keys: res.keys || [],
      labels: res.labels || [],
      top: res.top || null,
      topLabel: res.topLabel || null,
      order: res.order || [],
      X: res.X || null,
      indicators: eng.INDICATORS,
      directions: eng.DIRECTIONS,
      econGrade: res.econGrade || [],
      weights: res.weights || null,
      weightNames: D.meta.names,
      /* stage1 的逐路径保留/排除与理由 —— 让评委看到"为什么它没进候选" */
      stage1: (() => {
        try {
          const st = eng.stage1(res.scene || s);
          return eng.PATH_KEYS.map((p) => ({
            path: p, label: eng.DISPLAY[p], keep: !!st.keep[p], reason: st.reasons[p] || "",
          }));
        } catch { return null; }
      })(),
      recoveredKw: (() => { try { return eng.recoveredHeatKw(res.scene || s); } catch { return null; } })(),
    },
    certificate: null,
    boundaryNotices: [],
  };

  if (!res.out_of_scope && res.top) {
    if (opts.wantBoundaryNotices !== false) {
      try { out.boundaryNotices = eng.boundaryNotices(res) || []; } catch { out.boundaryNotices = []; }
    }
    if (opts.wantCertificate !== false) {
      try {
        const cert = eng.decisionCertificate(res, res.scene || s, lam, D.meta);
        if (cert) {
          /* ⚠ 口径陷阱（实测）：证书里的 `flips` 是**数字**（`flips: flips.length`，
             decision_core.js:2375），而 `probes` 是全部扰动项。
             网页要渲染"翻成什么"，所以这里另给一个 flippedProbes 数组 ——
             不改引擎对象，只在 bridge 上派生。 */
          cert.flippedProbes = (cert.probes || []).filter((p) => p.flipped);
        }
        out.certificate = cert;
      } catch (e) { out.certificate = { error: "decisionCertificate 抛错：" + (e && e.message) }; }
    }
  }
  return out;
}

/** 官方适配层：遥测帧 → scene（io.js:61-73 frameToScene） */
export function frameToScene(frame) {
  const { WHIO } = loadEngine();
  return WHIO.frameToScene(frame);
}

/** 任意原始读数 → 遥测帧（io.js:28-58 normalizeFrame，含 25~650 包络判定） */
export function normalizeFrame(raw, defaults) {
  const { WHIO } = loadEngine();
  return WHIO.normalizeFrame(raw, defaults);
}

/** 引擎暴露的枚举 / 常量（供网页下拉框与文档使用） */
export function engineMeta() {
  const { WHENG: eng, WHIO: IO, HFDATA: D } = loadEngine();
  return {
    projectRoot: PROJECT_ROOT,
    demandMap: IO.DEMAND_MAP,
    mediumMap: IO.MEDIUM_MAP,
    demanKeys: IO.DEMAND_KEYS,
    mediumKeys: IO.MEDIUM_KEYS,
    pathKeys: eng.PATH_KEYS,
    display: eng.DISPLAY,
    indicators: eng.INDICATORS,
    defaultRunHours: eng.DEFAULT_RUN_HOURS,
    heatingSeasonHours: eng.HEATING_SEASON_HOURS,
    lam0: D.lam0,
    conds: D.conds,
    metaNames: D.meta.names,
  };
}

/** 供 smoke_test 用：加载了哪些文件 */
export { ENGINE_ORDER };
