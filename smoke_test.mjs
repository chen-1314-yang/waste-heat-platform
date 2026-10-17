/* smoke_test.mjs —— 冒烟测试：**不联网**，直接调 engine_bridge 跑已知场景。
 *
 * 它验证四件事（对应验收第 1 条）：
 *   ① 引擎能被 Node 加载（加载了哪 14 个文件、共多少字符）
 *   ② HFDATA.meta 可用，runDecision 真的跑通
 *   ③ 一个"句子里来的"输入（320℃ 窑炉烟气 / 1.2 万标方每小时 / 想发电）
 *      走 io.js frameToScene → runDecision 的完整链路
 *   ④ 出界分支与证书分支都返回引擎自己的原话
 *
 * 用法：  node smoke_test.mjs
 * 退出码：0 = 全通过；1 = 有断言失败
 */
import { callEngine, frameToScene, normalizeFrame, engineMeta, engineLoadLog, PROJECT_ROOT } from "./engine_bridge.mjs";

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log("  ✅ " + label); }
  else { fail++; console.log("  ❌ " + label + (extra ? "\n     " + extra : "")); }
}
function head(t) { console.log("\n" + "═".repeat(72) + "\n" + t + "\n" + "═".repeat(72)); }

head("① 加载引擎（不联网）");
console.log("项目根：", PROJECT_ROOT);
/* ⚠ 顺序注意：engineLoadLog() 在 loadEngine() 之前是空的，所以先调一次 engineMeta()。 */
const M = engineMeta();
const log = engineLoadLog();
console.log("已加载文件（按 build.py SCRIPT_FILES 顺序）：");
let bytes = 0;
for (const l of log) { bytes += l.bytes; console.log("  " + l.file.padEnd(30) + String(l.bytes).padStart(8) + " 字符"); }
console.log("  合计 " + log.length + " 个文件 / " + bytes + " 字符");
ok(log.length === 14, "加载 14 个文件（util.js + 11 个 engine/* + hfdata.js + eff_table_override.js）");

ok(typeof M.lam0 === "number", "HFDATA.lam0 = " + M.lam0);
ok(Array.isArray(M.metaNames) && M.metaNames.length === 8, "HFDATA.meta.names 有 8 项：" + M.metaNames.join("、"));
ok(M.defaultRunHours === 6500, "DEFAULT_RUN_HOURS = " + M.defaultRunHours + " h");
ok(M.pathKeys.length === 12, "PATH_KEYS 有 12 条路径");

head("② 已知场景：320℃ 窑炉烟气 / 1.2 万标方每小时 / 想发电");
/* 1.2 万标方每小时 → kg/s 的换算（**这是本演示件自己加的，不属于引擎**）：
   标况烟气密度按 1.34 kg/Nm³ 工程取值（未在项目内找到出处，见 README「已知限制」）。
   12000 Nm³/h ÷ 3600 × 1.34 = 4.4667 kg/s */
const NM3_PER_H = 12000, RHO = 1.34;
const mDot = +(NM3_PER_H / 3600 * RHO).toFixed(3);
console.log("换算：12000 Nm³/h ÷ 3600 s/h × " + RHO + " kg/Nm³ = " + mDot + " kg/s（密度为工程取值，非项目台账）");

const frame = normalizeFrame({ t_src_degC: 320, m_dot_kg_s: mDot, medium: "烟气", demand: "发电", hours: 6500 });
ok(frame.quality === "good", "io.js normalizeFrame 判定 quality = " + frame.quality);
const scene = frameToScene(frame);
console.log("io.js frameToScene 产出的 scene：");
console.log(JSON.stringify(scene, null, 2));

const res = callEngine(scene, { wantCertificate: true });
ok(res.ok === true && res.out_of_scope === false, "runDecision 返回可行解");
console.log("\n--- 引擎原样输出（**这就是 smoke_test 的真实结果**）---");
console.log("推荐路径        :", res.engine.top, "/", res.engine.topLabel);
console.log("进入第二级候选  :", res.engine.labels.join("、"));
console.log("可回收热功率 kW :", res.engine.recoveredKw);
console.log("λ               :", res.lam, "（HFDATA.lam0）");
console.log("六指标名        :", res.engine.indicators.join(" | "));
console.log("\nTOPSIS 排序（closeness + 六指标原值，全部来自引擎）：");
for (const o of res.engine.order) {
  console.log("  " + o.path.padEnd(12) + res.engine.labels[res.engine.keys.indexOf(o.path)].padEnd(26) +
    " closeness=" + o.closeness.toFixed(4) + "  X=[" + o.row.map((v) => Number(v).toFixed(4)).join(", ") + "]");
}
ok(res.engine.top === "steam_pp", "320℃/6500h 下推荐 = steam_pp（高温蒸汽发电）", "实际：" + res.engine.top);

head("③ 决策证书（也是引擎产出的，不是我们编的）");
const c = res.certificate;
ok(!!c && !c.error, "decisionCertificate 返回成功");
console.log("证书 statement（引擎原话，原样打印）：");
console.log("  " + c.statement);
console.log("  扰动项：" + c.flips + " / " + c.total + " 会翻转；候选 {" + c.candidates.join("、") + "}");
console.log("  翻转项明细：");
for (const p of (c.flippedProbes || [])) console.log("    ★ " + p.name + "  ⇒ " + p.label + "   （" + p.detail + "）");
console.log("  假设清单 " + c.assumptions.length + " 条，前 3 条：");
for (const a of c.assumptions.slice(0, 3)) console.log("    - " + a.name + " = " + a.value + "  【证据 " + a.grade + "】" + a.source);
ok(c.total > 0 && c.flips >= 0, "证书扰动项数 > 0（实测 " + c.total + " 项）");
ok(Array.isArray(c.assumptions) && c.assumptions.length === 16, "证书假设清单 16 条（实测 " + c.assumptions.length + " 条）");

head("④ 出界分支：必须回**引擎自己的原话**，不许我们编");
for (const t of [20, 700]) {
  const f2 = normalizeFrame({ t_src_degC: t, m_dot_kg_s: 4.4667, medium: "烟气", demand: "发电" });
  const r2 = callEngine(frameToScene(f2), { wantCertificate: false });
  console.log("  " + t + "℃ → quality=" + f2.quality + " | out_of_scope=" + r2.out_of_scope);
  console.log("      引擎原话：" + r2.message);
  ok(r2.out_of_scope === true && /包络/.test(r2.message), t + "℃ 被引擎明确拒绝且给了原因");
}

head("⑤ 工况库 19 行全跑一遍（确认 bridge 对整库稳定）");
let okRows = 0, oosRows = 0, throwRows = 0;
for (const row of M.conds) {
  const medium = /烟气|排烟|废气/.test(row[2]) ? "烟气" : (/渣|熔盐|工艺液/.test(row[2]) ? "工艺液体" : "热水/冷凝水");
  const fr = normalizeFrame({ t_src_degC: row[3], m_dot_kg_s: row[4], medium, demand: row[9], hours: row[8] || 8000, continuity: row[10] });
  const sc = frameToScene(fr);
  if (row.length > 13 && row[13] !== null && row[13] !== undefined) sc["需求温度_degC"] = row[13];
  const r = callEngine(sc, { wantCertificate: false, wantBoundaryNotices: false });
  if (!r.ok) { throwRows++; console.log("    ✗ 抛错: " + row[0] + " → " + r.error); continue; }
  if (r.out_of_scope) { oosRows++; console.log("    · 超包络/无候选: " + row[0] + " → " + r.message.slice(0, 60)); }
  else { okRows++; }
}
console.log("  可评 " + okRows + " 行 / 超包络或不可行 " + oosRows + " 行 / 抛错 " + throwRows + " 行");
ok(throwRows === 0, "19 行无一行抛异常");
ok(okRows + oosRows === 19, "19 行全部有结果（可评或明确拒绝）");

head("结果");
console.log("通过 " + pass + " 项 / 失败 " + fail + " 项");
if (fail) { console.log("❌ 冒烟测试未全通过"); process.exit(1); }
console.log("✅ 冒烟测试全通过（全程未联网）");
