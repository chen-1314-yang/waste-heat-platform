/* kb_check.mjs —— 知识库入库自检（**不联网**，2026-10-13 新增）。
 *
 * 为什么要有这个文件：本轮任务的根因是"**手册换版了，但知识库还索引着旧快照**"——
 * Agent 因此一直答 10-11 的口径（P2 还在讲"四痛点"、不知道 932 已结案、不知道 T1~T10）。
 * 这种故障**不会报错**：索引照建、检索照跑、回答照出，只是答的是过期口径。
 * 所以它必须有一道**能诈胡的**自检。
 *
 * 它验七件事：
 *   ① 快照文件在声明的路径上（`kb/知识手册_正文_v4_20261013_快照.md`）
 *   ② **实测 md5 == rag.mjs 里记的 md5**（`HANDBOOK_SNAPSHOT_MD5`）—— 上一轮就是这里写过期被记过
 *   ③ 索引里**没有**旧快照（`…_20261011_快照.md` 一段都不许有）
 *   ④ 3 份源全 ok；总段数 == 各源段数之和（没有重复索引同一份文件）
 *   ⑤ 快速通道那 4 节标题逐条取得到
 *   ⑥ T2 要问的**四条新口径**的关键词，真的**进了索引语料**（不是只在磁盘文件里）
 *   ⑦ **反向变异**：把快照复制一份、改 1 个字节，同一把 md5 尺子必须判它不合格
 *      —— 「写了测试 ≠ 测试有效」，看不见变红就不算验过
 *
 * 用法：  node kb_check.mjs
 * 退出码：0 = 全通过；1 = 有断言失败
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as Rag from "./rag.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRAFT = "D:\\23549\\Documents\\handbook_draft_v4.md";

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log("  ✅ " + label); }
  else { fail++; console.log("  ❌ " + label + (extra ? "\n     " + extra : "")); }
}
function head(t) { console.log("\n" + "═".repeat(74) + "\n" + t + "\n" + "═".repeat(74)); }

const OLD_SNAPSHOT_TAG = "知识手册_正文_v4_20261011_快照";

head("① 快照文件与 md5（换文件必须同步改 rag.mjs，否则这里立刻红）");
const idx = Rag.buildIndex();
const hb = idx.manifest.find((m) => m.id === "handbook");
console.log("  声明路径 :", hb ? hb.rel : "（没有 handbook 源）");
console.log("  解析绝对 :", hb ? hb.abs : "—");
ok(!!hb && hb.ok === true, "handbook 源读到了（" + (hb && hb.abs) + "）");
ok(!!hb && fs.existsSync(hb.abs), "快照文件真的存在");
console.log("  实测 md5 :", hb && hb.md5);
console.log("  记录 md5 :", hb && hb.md5Expected);
ok(!!hb && hb.md5 === Rag.HANDBOOK_SNAPSHOT_MD5,
  "实测 md5 与 rag.mjs 记的 HANDBOOK_SNAPSHOT_MD5 一致",
  "实测 " + (hb && hb.md5) + " / 记录 " + Rag.HANDBOOK_SNAPSHOT_MD5);
ok(!!hb && hb.md5Ok === true, "manifest.md5Ok === true（换文件忘改 md5 时它会变 false）");
console.log("  快照字节 :", hb && hb.bytes);
ok(!!hb && hb.bytes === 149566, "快照 149566 B（10-13 口径；10-11 那份是 118254 B）");

head("② 索引里不许再有旧快照");
const stale = idx.chunks.filter((c) => String(c.cite || "").includes(OLD_SNAPSHOT_TAG) || String(c.rel || "").includes(OLD_SNAPSHOT_TAG));
ok(stale.length === 0, "索引里 0 段来自 " + OLD_SNAPSHOT_TAG + "（实测 " + stale.length + " 段）",
  stale.length ? "第一段：" + stale[0].cite : "");
ok(!idx.manifest.some((m) => String(m.rel || "").includes(OLD_SNAPSHOT_TAG)),
  "manifest 里也没有旧快照那条源");
/* 旧快照文件本身**必须还在**（留痕），只是不再被索引 */
const oldAbs = "D:\\Codex\\2026-08-06\\ni\\时代杯项目材料\\12_网站v4_实验版\\docs\\" + OLD_SNAPSHOT_TAG + ".md";
const oldKept = fs.existsSync(oldAbs);
console.log("  旧快照留痕 :", oldKept ? "在（" + oldAbs + "，未覆盖）" : "⚠ 不在了（沙箱/权限下探测不到）");
ok(!oldKept || Rag.md5OfFile(oldAbs) === "FBF07E82E18B904A2A3BC41082A65562",
  "旧快照仍在且 md5 未被改动（FBF07E82…5562）—— 「新增不覆盖」");

head("③ 来源清单与段数");
const srcOk = idx.manifest.filter((m) => m.ok);
for (const m of idx.manifest) {
  console.log("  " + String(m.id).padEnd(11) + (m.ok ? "ok  " : "FAIL") +
    "  chunks=" + String(m.chunks == null ? "-" : m.chunks).padStart(4) +
    "  bytes=" + String(m.bytes == null ? "-" : m.bytes).padStart(7) +
    "  forbidden=" + (m.forbidden == null ? "-" : m.forbidden) +
    (m.md5Ok === null || m.md5Ok === undefined ? "" : "  md5Ok=" + m.md5Ok));
}
ok(srcOk.length === 3, "3 份检索源全部 ok（实测 " + srcOk.length + "）");
const sum = srcOk.reduce((a, m) => a + m.chunks, 0);
ok(sum === idx.N, "总段数 == 各源段数之和（" + sum + " == " + idx.N + "，没有重复索引同一份文件）");
console.log("  台账 " + (idx.manifest[0] || {}).chunks + " 段 / 边界 " + (idx.manifest[1] || {}).chunks +
  " 段 / 手册 " + (hb ? hb.chunks : "—") + " 段");
ok(!!hb && hb.chunks > 92, "手册段数比 10-11 那份（92 段）多（实测 " + (hb && hb.chunks) + " 段）");

head("④ 项目概况快速通道的 4 节还取得到吗");
const ov = Rag.handbookOverview();
for (const it of ov.items) console.log("  · " + it.heading + "  (" + it.text.length + " 字, " + it.cite + ")");
for (const s of ov.skipped) console.log("  ⚠ 跳过：" + s.heading + " —— " + s.reason);
ok(ov.items.length === 4, "4 节全部取到（实测 " + ov.items.length + " 节）");
ok(ov.skipped.length === 0, "没有被「不得引用」整节剔除的小节（实测 " + ov.skipped.length + " 节）");

head("⑤ T2 要问的四条新口径 —— 关键词必须真的**进了索引语料**");
const corpus = idx.chunks.map((c) => c.text).join("\n");
const GROUPS = [
  ["① P2 三分法（不是「四痛点」）", ["选型靠经验", "参数说不清", "算出来也不敢信"]],
  ["② 932 结案（两个成本代理函数 / 200 行复算 / 压力上界 10 MPa）", ["932", "10 MPa", "200 行"]],
  ["② 附带口径：净功率纵轴可跨组比、成本代理横轴不可跨组比", ["净功率", "跨组"]],
  ["③ T1~T10 放行阈值", ["**T1**", "**T5**", "**T10**", "放行阈值"]],
  ["④ 494 的正确算式（16×29 + 1×30，**不是** 17×29+30）", ["16 场景×29", "1 场景×30", "494 ＝"]],
];
for (const [name, words] of GROUPS) {
  const miss = words.filter((w) => !corpus.includes(w));
  ok(miss.length === 0, name + " —— " + words.length + " 个关键词全在语料里",
    miss.length ? "缺：" + miss.join("、") : "");
}

head("⑥ 反向变异：这把 md5 尺子**真的会红吗**");
const tmp = path.join(HERE, "_kb_check_mutant.md");
try {
  const buf = fs.readFileSync(hb.abs);
  const mutant = Buffer.from(buf);
  mutant[Math.floor(mutant.length / 2)] ^= 0x01;       /* 翻转中间那 1 个 bit */
  fs.writeFileSync(tmp, mutant);
  const mMd5 = Rag.md5OfFile(tmp);
  console.log("  变异体 md5 :", mMd5);
  ok(mMd5 !== Rag.HANDBOOK_SNAPSHOT_MD5,
    "变异体（改 1 bit）的 md5 ≠ 记录的 md5 ⇒ 守卫不是「永远为真」");
  ok(Rag.md5OfFile(tmp) !== Rag.md5OfFile(hb.abs), "变异体与原文件 md5 不同（尺子有分辨率）");
} finally {
  try { fs.unlinkSync(tmp); } catch { /* 没建起来就算了 */ }
}
ok(Rag.md5OfFile("D:\\__不存在的路径__\\nope.md") === null, "读不到的文件 md5 返回 null（不会抛错、也不会假通过）");

head("结果");
console.log("通过 " + pass + " 项 / 失败 " + fail + " 项");
if (fail) { console.log("❌ 知识库入库自检未通过"); process.exit(1); }
console.log("✅ 知识库入库自检全通过（全程未联网）");
