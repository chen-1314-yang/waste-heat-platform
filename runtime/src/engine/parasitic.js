/* 系统寄生损失修正（工质泵 + 管路压降）—— 2026-09-28 新增（P1-1）

   ## 为什么要有这一层

   效率表（src/legacy/eff_table_override.js）来自纯热力学循环模型，它的假设写在
   03_程序代码/cycle_models.py 头部：**泵等熵效率 0.80、忽略管道压损与散热**。
   也就是说那张表算的是"理想循环的净输出"，而真实机组还要多付两笔：
     ① 泵本身效率远低于 0.80（小机组尤其低），而且电机还有损耗；
     ② 管路/换热器/阀门的压降要额外加压升。

   两条实测反证（第五轮外部检索）：
     · MDPI 2019 小涡旋 ORC 台架：仿真 8.2% vs 实测 6.8%（**高 17%**），
       作者归因就是漏算泵功与管路压降；
     · FlexGeo 可逆机组实测（Zenodo 10.5281/zenodo.20830203）：工质泵中位 407 W、
       膨胀机轴功率中位 1 963 W（p_high 9.05 bar、p_low 2.59 bar、230.7 g/s）——
       按理想公式只有约 115 W，反算"泵等熵×电机"总效率仅约 **0.28**。

   ## 这一层怎么算

      泵真实功 = (泵压升 + 管路压降允许量) ÷ (液相密度 × 泵总效率)     [kJ/kg]
      效率修正 = 100 × (泵真实功 − 表中泵功) ÷ 吸热量                  [百分点]
      交付净效率 = 效率表值 − 效率修正

   泵压升、吸热量、液相密度都取自生成表（每个温度档的中位数，与效率表同口径）；
   泵总效率按"机组净电功率"查工程折线（表内 meta.etaPCurve）。

   ⚠ 诚实性边界（已登记在边界页）：
     · 泵总效率折线只有两个实测锚点（2 kW 级 0.28）＋ 大机组工程惯例，
       属**工程假设**，不是实测标定；
     · 管路压降允许量 100 kPa 是**工程允许量**（典型 50~200 kPa），不是某个项目的实测值；
     · 本层只修正"电输出类"路径（ORC、蒸汽朗肯）。用热类路径的输配泵电耗未计入，
       属已知未闭合项。
*/
window.WHPARASITIC = (function () {
  "use strict";

  const T = window.WHPARASITIC_TABLE || { orc: [], steam: [], meta: {} };
  const META = T.meta || {};
  const CURVE = META.etaPCurve || [[1, 0.28], [5000, 0.68]];
  const ETA_FLOOR = META.etaFloor || 0.25;
  const ETA_CEIL = META.etaCeil || 0.70;

  /* 管路 + 换热器 + 阀门的压降允许量（Pa）。典型值 50~200 kPa，取 100 kPa。
     来源：工程允许量，非项目实测。敏感性见 docs/2026-09-28-P1批次_精度与口径修正.md */
  const DP_EXTRA_PA = 100e3;

  function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

  /* 按温度查表并线性插值：[温度℃, 泵功 kJ/kg, 吸热量 kJ/kg, 泵压升 Pa, 密度 kg/m3, n] */
  function lookup(rows, t) {
    if (!rows || !rows.length) return null;
    if (t <= rows[0][0]) return rows[0];
    if (t >= rows[rows.length - 1][0]) return rows[rows.length - 1];
    for (let i = 0; i < rows.length - 1; i++) {
      if (t >= rows[i][0] && t <= rows[i + 1][0]) {
        const f = (t - rows[i][0]) / ((rows[i + 1][0] - rows[i][0]) || 1);
        return rows[i].map(function (v, j) {
          return j === 5 ? rows[i][5] : v + (rows[i + 1][j] - v) * f;
        });
      }
    }
    return rows[rows.length - 1];
  }

  /* 泵总效率（等熵 × 电机）：随"机组净电功率 kW"对数插值 */
  function pumpEta(powerKw) {
    const p = Math.max(Number(powerKw) || 1.0, 1e-6);
    let v;
    if (p <= CURVE[0][0]) v = CURVE[0][1];
    else if (p >= CURVE[CURVE.length - 1][0]) v = CURVE[CURVE.length - 1][1];
    else {
      v = CURVE[CURVE.length - 1][1];
      for (let i = 0; i < CURVE.length - 1; i++) {
        if (p >= CURVE[i][0] && p <= CURVE[i + 1][0]) {
          const f = (Math.log10(p) - Math.log10(CURVE[i][0])) /
            (Math.log10(CURVE[i + 1][0]) - Math.log10(CURVE[i][0]));
          v = CURVE[i][1] + (CURVE[i + 1][1] - CURVE[i][1]) * f;
          break;
        }
      }
    }
    return clamp(v, ETA_FLOOR, ETA_CEIL);
  }

  /* 修正量（百分点）。kind: "orc" | "steam"；tDesign: 设计蒸发/锅炉出口温度℃；
     netCapKw: 修正前算得的净电功率（作为"泵所在机组规模"的代理量）。 */
  function lossPct(kind, tDesignC, netCapKw) {
    const row = lookup(T[kind], Number(tDesignC));
    if (!row) return 0.0;
    const wpTable = row[1], qin = row[2], dp = row[3], rho = row[4];
    if (!(qin > 0) || !(rho > 0)) return 0.0;
    const eta = pumpEta(netCapKw);
    const wReal = (dp + DP_EXTRA_PA) / (rho * eta) / 1000.0;   // kJ/kg
    const loss = 100.0 * (wReal - wpTable) / qin;
    return loss > 0 ? loss : 0.0;
  }

  function hasTable(kind) {
    return !!(T[kind] && T[kind].length);
  }

  return {
    DP_EXTRA_PA: DP_EXTRA_PA, META: META,
    lookup: lookup, pumpEta: pumpEta, lossPct: lossPct, hasTable: hasTable
  };
})();
