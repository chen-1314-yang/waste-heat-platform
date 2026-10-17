/* 工质适用性层（25 工质矩阵）—— 2026-09-28 新增（P2-10）

   ## 它回答什么问题

   主计算链路里的 ORC 效率表只覆盖两种工质（异丁烷、R245fa，背压 0.5~0.7 MPa）。
   一旦热源温度跑到别的区间、或者有人问"为什么不用甲醇/甲苯/硅氧烷"，
   原来的模型没有答案。这一层把项目里已经做完的 **25 工质 × 3,740 工况矩阵**
   （M1M2 成果，能量守恒偏差 9.1e-13 kW）接进来，回答：
     · 当前热源温度下有多少种工质物理可行；
     · 效率口径与比功口径的领先者分别是谁、到什么水平；
     · 有多少工质会落进"真空冷凝"（需要真空级密封，工程上要额外代价）。

   ## 为什么不直接用它替换主效率表（重要）

   两者口径不同，不能互换：
     · 主表：异丁烷/R245fa、背压 0.5~0.7 MPa（冷凝约 50~62℃）、已与 DWSIM 交叉核对；
     · 矩阵：饱和蒸发 + 5 K 过热、冷凝按水冷 30℃/空冷 40℃、25 工质，
       但**热稳定性上限一律 [待标定]** —— 只保证物理可行域，不是工程可行域。
   所以本层只做"可选域与上界"的说明，主计算仍用已标定的表。
   界面必须同时显示这两个数字与差异原因，避免读者以为可以把矩阵值直接当预测值。
*/
window.WHFLUIDS = (function () {
  "use strict";

  const M = window.WHFLUIDS_MATRIX || { bySource: [], byFluid: [], meta: {} };
  const META = M.meta || {};

  function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

  /* 折线插值（按温度取领先者时不做插值，只取最近档；数值项做线性插值） */
  function nearestRow(t) {
    const rows = M.bySource || [];
    if (!rows.length) return null;
    let best = rows[0], bestD = Infinity;
    for (let i = 0; i < rows.length; i++) {
      const d = Math.abs(rows[i][0] - t);
      if (d < bestD) { bestD = d; best = rows[i]; }
    }
    return best;
  }

  function lerpNum(t, idx) {
    const rows = M.bySource || [];
    if (!rows.length) return null;
    if (t <= rows[0][0]) return rows[0][idx];
    const last = rows[rows.length - 1];
    if (t >= last[0]) return last[idx];
    for (let i = 0; i < rows.length - 1; i++) {
      if (t >= rows[i][0] && t <= rows[i + 1][0]) {
        const f = (t - rows[i][0]) / ((rows[i + 1][0] - rows[i][0]) || 1);
        return rows[i][idx] + (rows[i + 1][idx] - rows[i][idx]) * f;
      }
    }
    return last[idx];
  }

  /* 指定热源温度下的适用性摘要 */
  function applicability(tSrc) {
    const row = nearestRow(Number(tSrc));
    if (!row) return null;
    return {
      tGrid: row[0],
      fluidCount: row[1],
      effLeader: row[2], effPct: row[3], effWork: row[4],
      workLeader: row[5], workKjKg: row[6], workEffPct: row[7],
      vacuumCount: row[8],
      effPctInterp: lerpNum(Number(tSrc), 3),
      fluidCountInterp: lerpNum(Number(tSrc), 1)
    };
  }

  /* 指定热源温度下"物理可行"的工质清单（按最佳热效率降序，取水冷口径） */
  function fluidsAt(tSrc, cooling) {
    const t = Number(tSrc);
    const mode = cooling || "水冷";
    const rows = (M.byFluid || []).filter(function (r) {
      return r[3] === mode && t >= r[7] && t <= r[8];
    });
    rows.sort(function (a, b) { return (b[9] || 0) - (a[9] || 0); });
    return rows.map(function (r) {
      return { name: r[0], fluid: r[1], family: r[2], tCritC: r[4],
               bestEffPct: r[9], bestAtC: r[10], maxWork: r[11],
               vacuum: r[12] === "是", thermalLimit: r[13] };
    });
  }

  /* 与主效率表的口径对照（用于界面上一句话说明差距来自哪里） */
  function comparison(tSrc, calibratedEffPct) {
    const a = applicability(tSrc);
    if (!a) return null;
    const gap = (calibratedEffPct && a.effPctInterp)
      ? (a.effPctInterp / calibratedEffPct) : null;
    return {
      matrixLeader: a.effLeader, matrixEffPct: a.effPctInterp,
      calibratedEffPct: calibratedEffPct, ratio: gap,
      reason: "矩阵口径：冷凝 30~40℃、饱和蒸发+5K 过热、25 种工质任选、热稳定上限未标定；" +
        "主表口径：异丁烷/R245fa、背压 0.5~0.7 MPa（冷凝约 50~62℃）、已与 DWSIM 对拍。"
    };
  }

  function hasMatrix() { return !!(M.bySource && M.bySource.length); }

  return {
    META: META, hasMatrix: hasMatrix, applicability: applicability,
    fluidsAt: fluidsAt, comparison: comparison
  };
})();
