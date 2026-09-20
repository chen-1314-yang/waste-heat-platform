window.esc = function (value) {
  if (value === null || value === undefined) { return ''; }
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

window.linkOrText = function (url, label) {
  if (!url) { return window.esc(label || ''); }
  return '<a href="' + window.esc(url) + '" target="_blank" rel="noopener">' +
         window.esc(label || url) + '</a>';
};

/* decision engine v2.1 -> JS 移植（唯一权威：11_决策内核v2_全温域/decision_core.py）
   红线（v2.1）：供冷/干燥受支持；除湿未单列；外购蒸汽驱动吸收式制冷不设废热回收路径；
   能力圈外不硬推荐；温度包络 25~650℃。 */
window.WHENG = (function () {
  "use strict";

  const PATH_KEYS = ["direct", "whb_steam", "abs_self", "abs_ext", "comp",
    "orc", "steam_pp", "tc_storage", "pcm_storage", "teg",
    "abs_cool", "comp_cool"];
  const DISPLAY = {
    direct: "直接换热",
    whb_steam: "余热锅炉直接产汽",
    abs_self: "吸收式热泵提温（余热自驱动）",
    abs_ext: "吸收式热泵（外购蒸汽驱动）",
    comp: "压缩式热泵提温（电驱动）",
    orc: "ORC 余热发电",
    steam_pp: "高温蒸汽发电（蒸汽朗肯）",
    tc_storage: "热化学储热",
    pcm_storage: "相变储热",
    teg: "TEG 热电发电",
    abs_cool: "吸收式制冷（余热驱动）",
    comp_cool: "电压缩制冷（电驱动）"
  };
  const DEMAND_SET = ["发电", "工艺蒸汽", "供暖·热水", "储热调峰", "供冷", "干燥"];
  const UNSUPPORTED_DEMAND = ["除湿", "除湿/干燥"];
  const CP = { "烟气": 1.1, "热水·冷凝水": 4.2, "工艺液体": 2.5 };

  const INDICATORS = ["能效%", "投资万元/MW", "回收期年", "CO2减排t/年", "政策分", "运行成本万元/MW·年"];
  const DIRECTIONS = ["max", "min", "min", "max", "max", "min"];

  const BASE_INDICATORS = {
    direct: [90, 60, 2.5, 0, 3, 6],
    whb_steam: [85, 100, 3.5, 0, 3, 12],
    abs_self: [170, 150, 2.7, 0, 4, 20],
    abs_ext: [170, 174, 4.2, 0, 4, 0],
    comp: [106, 120, 4.2, 0, 4, 186],
    orc: [12.3, 2380, 5.6, 0, 4, 15],
    steam_pp: [25, 550, 4.5, 0, 4, 8],
    tc_storage: [70, 900, 10.0, 0, 3, 28],
    pcm_storage: [75, 600, 8.0, 0, 3, 25],
    teg: [5, 1500, 12.0, 0, 2, 8],
    abs_cool: [70, 100, 5.5, 0, 4, 3],
    comp_cool: [190, 60, 4.2, 0, 3, 104]
  };

  const SCALE_REP_KW = { "小": 500.0, "中": 3000.0, "大": 10000.0 };
  const SCALE_EXP = { steam_pp: 0.70, orc: 0.85 };
  const SCALE_EXP_DEFAULT = 0.90;

  const COP_I_ABS_SELF = 1.7;
  const COP_II_ABS_SELF = 0.45;
  const COP_H_ABS_EXT = 1.7;
  const COP_C_ABS = 0.7;
  const ABS_COOL_T_MIN = 80.0;
  const COP_E_COOL = 5.0;
  const STEAM_PRICE = 100.0;
  const STEAM_OPS_FACTOR = 1.03;
  const GRID_EF = 0.581;
  const GAS_EF = 0.0561;
  const BOILER_EFF = 0.90;
  const ELEC_PRICE = 0.65;
  const HP_COP = 2.8;
  const GAS_PRICE = 98.0; // 元/GJ（替代天然气演示价，展示口径）

  let TABLES = null; // { orcPct, stCurve } 由 data.js 注入

  function setTables(t) { TABLES = t; }

  function pyRound(v, nd) {
    if (v === null || v === undefined || isNaN(v)) return v;
    const f = Math.pow(10, nd);
    return Math.round((v + 1e-9) * f) / f;
  }

  function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

  function validateScene(scene) {
    const s = Object.assign({}, scene);
    if (s["需求温度_degC"] === undefined || s["需求温度_degC"] === null) s["需求温度_degC"] = null;
    if (s["连续性"] === undefined || s["连续性"] === null) s["连续性"] = "连续";
    if (s["驱动来源"] === undefined || s["驱动来源"] === null) s["驱动来源"] = "余热自驱动";
    if (s["年运行小时"] === undefined || s["年运行小时"] === null) s["年运行小时"] = 8000;
    if (s["换热端差_degC"] === undefined || s["换热端差_degC"] === null) s["换热端差_degC"] = 10;
    if (s["规模_kW"] === undefined || s["规模_kW"] === null) s["规模_kW"] = null;
    if (s["流量_kg_s"] === undefined || s["流量_kg_s"] === null) s["流量_kg_s"] = null;
    const demand = s["需求"];
    if (UNSUPPORTED_DEMAND.indexOf(demand) >= 0) {
      return { ok: false, error: "需求「" + demand + "」未单列为 v2 需求类型：除湿并入供冷/干燥场景后评价，模型无法单独评价。" };
    }
    if (DEMAND_SET.indexOf(demand) < 0) {
      return { ok: false, error: "未知需求类型：" + demand };
    }
    const t = Number(s["热源温度_degC"]);
    if (!(25 <= t && t <= 650)) {
      const extra = t > 650 ? "；高于 650℃ 的发电/产汽需多压/再热锅炉专项设计" : "；低于 25℃ 需额外驱动能投入，不做评价";
      return { ok: false, error: "热源 " + t + "℃ 超出 v2 标定包络（25~650℃）" + extra };
    }
    s["热源温度_degC"] = t;
    return { ok: true, scene: s };
  }

  function recoveredHeatKw(scene) {
    const m = scene["流量_kg_s"];
    if (m) {
      const dt = Math.max(Number(scene["热源温度_degC"]) - 40.0 - Number(scene["换热端差_degC"]), 5.0);
      return Number(m) * CP[scene["载体"]] * dt;
    }
    const q = scene["规模_kW"];
    if (q) return Number(q);
    throw new Error("缺少流量或规模_kW，无法计算可回收热功率");
  }

  function scaleBand(qKw) { return qKw < 1000 ? "小" : (qKw <= 5000 ? "中" : "大"); }

  function scaleMultiplier(path, band) {
    const rep = SCALE_REP_KW[band];
    const n = SCALE_EXP[path] !== undefined ? SCALE_EXP[path] : SCALE_EXP_DEFAULT;
    return Math.pow(rep / 3000.0, n - 1.0);
  }

  function absCoolCop(t) {
    if (t >= 85.0) return 0.7;
    if (t >= ABS_COOL_T_MIN) return 0.6;
    return null;
  }

  function stage1(scene) {
    const t = Number(scene["热源温度_degC"]);
    const demand = scene["需求"];
    const tDem = scene["需求温度_degC"];
    const driver = scene["驱动来源"] || "余热自驱动";
    const cont = scene["连续性"] || "连续";
    const keep = {}, why = {};
    const setk = (p, ok, reason) => { keep[p] = ok; why[p] = reason; };

    if (demand === "发电") {
      setk("orc", 110 <= t && t <= 350,
        (110 <= t && t <= 350) ? ("热源 " + t + "℃ 在 ORC 适用区间 110~350℃")
          : (t < 110 ? ("热源 " + t + "℃ <110℃，ORC 温差不足") : ("热源 " + t + "℃ >350℃，超出 ORC 标定上限，应走蒸汽朗肯")));
      setk("steam_pp", 280 <= t && t <= 650,
        (280 <= t && t <= 650) ? ("热源 " + t + "℃ 满足蒸汽朗肯标定区间 280~650℃（锅炉出口按 min(max(t-100,180),540) 映射）")
          : (t < 280 ? ("热源 " + t + "℃ <280℃，蒸汽朗肯经济性不足") : ("热源 " + t + "℃ >650℃，超出 v2 标定上限")));
      setk("teg", t >= 40, t >= 40 ? "TEG 适合 ≥40℃ 温差发电（兜底候选）" : "温差不足");
      ["direct", "whb_steam", "abs_self", "abs_ext", "comp", "tc_storage", "pcm_storage", "abs_cool", "comp_cool"]
        .forEach((p) => setk(p, false, "需求为发电：该路径不产出电力"));
    } else if (demand === "工艺蒸汽") {
      const tSteam = tDem || 152.0;
      setk("whb_steam", t >= tSteam + 20,
        t >= tSteam + 20 ? ("热源 " + t + "℃ ≥ 蒸汽 " + tSteam + "℃ + 端差 20℃，可直接产汽")
          : ("热源 " + t + "℃ 不足以直接产生 " + tSteam + "℃ 蒸汽（需 ≥" + (tSteam + 20) + "℃）"));
      setk("abs_self", t >= 90, t >= 90 ? ("热源 " + t + "℃ 可自驱动吸收式（≥90℃）") : "吸收式自驱动需 ≥90℃ 驱动热源");
      setk("comp", true, "压缩式热泵以电驱动，不受热源温度下限限制");
      setk("abs_ext", false, "v2 中外购蒸汽驱动吸收式仅用于供暖·热水需求（扩展点）");
      ["direct", "orc", "steam_pp", "teg", "tc_storage", "pcm_storage", "abs_cool", "comp_cool"]
        .forEach((p) => setk(p, false, "需求为工艺蒸汽：该路径不产出蒸汽"));
    } else if (demand === "供暖·热水") {
      const lo = Math.max(60.0, (tDem || 60.0) + Number(scene["换热端差_degC"]));
      setk("direct", t >= lo,
        t >= lo ? ("热源 " + t + "℃ ≥ 直接换热下限 " + lo.toFixed(0) + "℃（max(60, 需求温度+端差)）")
          : ("热源 " + t + "℃ < " + lo.toFixed(0) + "℃，直接换热不可行"));
      setk("abs_self", t >= 90, t >= 90 ? "热源 ≥90℃ 可自驱动吸收式" : "吸收式自驱动需 ≥90℃ 驱动热源");
      setk("abs_ext", driver === "外购蒸汽" && t >= 25,
        (driver === "外购蒸汽" && t >= 25) ? "外购蒸汽驱动吸收式：低温余热 + 蒸汽驱动（≥25℃ 可用）"
          : (driver !== "外购蒸汽" ? "未提供外购蒸汽，外购蒸汽驱动吸收式不可用" : "热源温度过低"));
      setk("comp", true, "压缩式热泵以电驱动，适用低温余热提温");
      ["whb_steam", "orc", "steam_pp", "teg", "abs_cool", "comp_cool"]
        .forEach((p) => setk(p, false, "需求为供暖·热水：该路径不直接产热"));
      ["tc_storage", "pcm_storage"].forEach((p) => {
        setk(p, true, cont === "连续" ? "热源连续，储热非必需（保留作调峰候选）" : "间歇热源，储热用于时空解耦");
      });
    } else if (demand === "供冷") {
      if (driver === "外购蒸汽") {
        PATH_KEYS.forEach((p) => setk(p, false,
          "外购蒸汽驱动吸收式制冷是用能设备（非余热回收）；请将驱动来源改为余热自驱动（利用废热）或外购电力（电制冷）"));
      } else {
        setk("abs_cool", driver === "余热自驱动" && ABS_COOL_T_MIN <= t && t <= 650,
          (driver === "余热自驱动" && ABS_COOL_T_MIN <= t && t <= 650)
            ? ("热源 " + t + "℃ ≥" + ABS_COOL_T_MIN.toFixed(0) + "℃ 且驱动来源为余热自驱动：可驱动吸收式制冷（≥85℃ COP≈0.7；80~84℃ COP≈0.6）")
            : (driver === "余热自驱动" ? ("吸收式制冷需 ≥" + ABS_COOL_T_MIN.toFixed(0) + "℃ 驱动热源（当前 " + t + "℃）")
              : "吸收式制冷需“余热自驱动”口径（当前驱动来源=" + driver + "）"));
        setk("comp_cool", driver === "外购电力",
          driver === "外购电力" ? "电压缩制冷以电驱动（外购电力口径），无废热时作为基准方案"
            : "电压缩制冷需“外购电力”口径（当前驱动来源=" + driver + "）");
        PATH_KEYS.forEach((p) => { if (p !== "abs_cool" && p !== "comp_cool") setk(p, false, "需求为供冷：该路径不产出冷量"); });
      }
    } else if (demand === "干燥") {
      const tDry = tDem || 100.0;
      const lo = Math.max(60.0, tDry + Number(scene["换热端差_degC"]));
      setk("direct", t >= lo,
        t >= lo ? ("热源 " + t + "℃ ≥ 干燥热风下限 " + lo.toFixed(0) + "℃（默认需求温度 100℃+端差）")
          : ("热源 " + t + "℃ < " + lo.toFixed(0) + "℃，直接换热干燥不可行"));
      setk("whb_steam", t >= tDry + 20,
        t >= tDry + 20 ? ("热源 " + t + "℃ ≥ 干燥用蒸汽下限 " + (tDry + 20).toFixed(0) + "℃（默认 100℃+20℃）")
          : ("热源 " + t + "℃ 不足以直接产干燥用蒸汽（需 ≥" + (tDry + 20).toFixed(0) + "℃）"));
      setk("abs_self", t >= 90, t >= 90 ? "热源 ≥90℃ 可驱动吸收式热泵供热风（一类 COP1.7）" : "吸收式热泵需 ≥90℃ 驱动热源");
      setk("comp", true, "热泵烘干以电驱动，适用低温干燥（60~90℃）提温");
      setk("abs_ext", false, "外购蒸汽驱动仅用于供暖·热水需求（干燥请用余热自驱动/热泵）");
      ["orc", "steam_pp", "teg", "tc_storage", "pcm_storage", "abs_cool", "comp_cool"]
        .forEach((p) => setk(p, false, "需求为干燥：该路径不直接烘干"));
    } else if (demand === "储热调峰") {
      setk("tc_storage", true, "储热路径可跨时段调峰");
      setk("pcm_storage", true, "储热路径可跨时段调峰");
      setk("direct", t >= Math.max(60.0, (tDem || 60.0) + Number(scene["换热端差_degC"])), "供暖调峰候选");
      setk("abs_self", t >= 90, t >= 90 ? "提温调峰候选" : "驱动热源不足");
      setk("abs_ext", driver === "外购蒸汽" && t >= 25, "外购蒸汽驱动候选");
      setk("comp", true, "提温调峰候选");
      setk("orc", 110 <= t && t <= 350, (110 <= t && t <= 350) ? "发电调峰候选" : "超出 ORC 区间（110~350℃）");
      setk("steam_pp", 280 <= t && t <= 650, (280 <= t && t <= 650) ? "发电调峰候选" : "超出朗肯标定（280~650℃）");
      setk("teg", t >= 40, t >= 40 ? "发电兜底候选" : "温差不足");
      setk("whb_steam", t >= (tDem || 152.0) + 20, "产汽调峰候选");
      setk("abs_cool", false, "储热调峰需求不产冷");
      setk("comp_cool", false, "储热调峰需求不产冷");
    }
    PATH_KEYS.forEach((p) => { if (why[p] === undefined) setk(p, keep[p] === true, "通过第一级筛选"); });
    return { keep, reasons: why };
  }

  // ---------- 效率表查询 ----------
  function pctLookupRow(tbl, c) {
    if (!tbl || !tbl.length) return null;
    if (c <= tbl[0][0]) return tbl[0];
    if (c >= tbl[tbl.length - 1][0]) return tbl[tbl.length - 1];
    for (let i = 0; i < tbl.length - 1; i++) {
      if (c >= tbl[i][0] && c <= tbl[i + 1][0]) {
        const f = (c - tbl[i][0]) / ((tbl[i + 1][0] - tbl[i][0]) || 1);
        return tbl[i].map((v, j) => (j === 4 ? tbl[i + 1][j] : tbl[i][j] + (tbl[i + 1][j] - tbl[i][j]) * f));
      }
    }
    return tbl[tbl.length - 1];
  }

  // ORC 中位热效率（%）：heater 出口上限 = t - dT 的累计中位数
  function orcEffPct(tSrc, dT) {
    if (!TABLES || !TABLES.orcPct) return null;
    const c = clamp(tSrc - dT, 100, 360);
    const row = pctLookupRow(TABLES.orcPct, c);
    if (!row) return null;
    return row[2] / 10.0; // p50 kW/MW ÷ 10 → %
  }

  // 蒸汽朗肯中位热效率（%）：锅炉出口 = clamp(t-100,180,540)，逐点中位数曲线插值
  function steamEffPct(tSrc) {
    if (!TABLES || !TABLES.stCurve || TABLES.stCurve.length < 2) return null;
    const tb = clamp(tSrc - 100.0, 180.0, 540.0);
    const curve = TABLES.stCurve;
    if (tb <= curve[0][0]) return curve[0][1];
    if (tb >= curve[curve.length - 1][0]) return curve[curve.length - 1][1];
    for (let i = 0; i < curve.length - 1; i++) {
      if (tb >= curve[i][0] && tb <= curve[i + 1][0]) {
        const f = (tb - curve[i][0]) / ((curve[i + 1][0] - curve[i][0]) || 1);
        return curve[i][1] + (curve[i + 1][1] - curve[i][1]) * f;
      }
    }
    return curve[curve.length - 1][1];
  }

  // ---------- 减排/成本 ----------
  function heatRedGas(scene, penalty) {
    const q = recoveredHeatKw(scene);
    const heatGj = q * Number(scene["年运行小时"]) * 3.6 / 1000.0;
    return heatGj * GAS_EF / BOILER_EFF / (penalty || 1.0);
  }

  function steamDrivenAbsReduction(scene) {
    return heatRedGas(scene, 1.0) * (1.0 - 1.0 / COP_H_ABS_EXT);
  }

  function steamDrivenAbsOpexWanMw(scene) {
    const hours = Number(scene["年运行小时"]);
    return (1.0 / COP_H_ABS_EXT) * hours * 3.6 * STEAM_PRICE / 10000.0 * STEAM_OPS_FACTOR;
  }

  function coolingAbsReduction(scene) {
    const cop = absCoolCop(Number(scene["热源温度_degC"])) || COP_C_ABS;
    const qCold = cop * recoveredHeatKw(scene);
    const mwhAvoided = qCold / COP_E_COOL * Number(scene["年运行小时"]) / 1000.0;
    return mwhAvoided * GRID_EF;
  }

  function compCoolOpexWanMw(scene) {
    return (1.0 / COP_E_COOL) * Number(scene["年运行小时"]) * ELEC_PRICE * 1000.0 / 10000.0;
  }

  function compReduction(scene, cop) {
    const c = cop || HP_COP;
    const q = recoveredHeatKw(scene);
    const heatGj = q * Number(scene["年运行小时"]) * 3.6 / 1000.0;
    const elecMwh = heatGj / 3.6 / c;
    return Math.max(heatGj * GAS_EF / BOILER_EFF - elecMwh * GRID_EF, 0.0);
  }

  function powerReduction(path, scene) {
    const q = recoveredHeatKw(scene);
    const hours = Number(scene["年运行小时"]);
    let e = null;
    if (path === "orc") e = orcEffPct(Number(scene["热源温度_degC"]), Number(scene["换热端差_degC"]));
    else e = steamEffPct(Number(scene["热源温度_degC"]));
    if (!e) return 0.0;
    const mwh = (e / 100.0) * q * hours / 1000.0;
    return mwh * GRID_EF;
  }

  function buildMatrixV2(survivors, scene) {
    const X = survivors.map((p) => BASE_INDICATORS[p].slice());
    const q = recoveredHeatKw(scene);
    const band = scaleBand(q);
    const hours = Number(scene["年运行小时"]);
    const demand = scene["需求"];
    for (let i = 0; i < survivors.length; i++) {
      const p = survivors[i];
      const sf = scaleMultiplier(p, band);
      X[i][1] = BASE_INDICATORS[p][1] * sf;
      X[i][2] = BASE_INDICATORS[p][2] * sf;
      X[i][5] = BASE_INDICATORS[p][5] * (p === "comp" ? 1.0 : sf);
      if (p === "orc") {
        const e = orcEffPct(Number(scene["热源温度_degC"]), Number(scene["换热端差_degC"]));
        if (e) X[i][0] = pyRound(e, 2);
      } else if (p === "steam_pp") {
        const e = steamEffPct(Number(scene["热源温度_degC"]));
        if (e) X[i][0] = pyRound(e, 2);
      } else if (p === "abs_self") {
        const cop = demand === "工艺蒸汽" ? COP_II_ABS_SELF : COP_I_ABS_SELF;
        X[i][0] = pyRound(cop * 100.0, 2);
        const redFactor = demand === "工艺蒸汽" ? COP_II_ABS_SELF : 1.0;
        X[i][3] = pyRound(heatRedGas(scene) * redFactor, 1);
      } else if (p === "abs_ext") {
        X[i][0] = pyRound(COP_H_ABS_EXT * 100.0, 2);
        X[i][3] = pyRound(steamDrivenAbsReduction(scene), 1);
        X[i][5] = pyRound(steamDrivenAbsOpexWanMw(scene), 1);
      } else if (p === "abs_cool") {
        const cop = absCoolCop(Number(scene["热源温度_degC"])) || COP_C_ABS;
        X[i][0] = pyRound(cop * 100.0, 2);
        X[i][3] = pyRound(coolingAbsReduction(scene), 1);
      } else if (p === "comp_cool") {
        X[i][0] = pyRound(COP_E_COOL * 0.38 * 100.0, 2);
        X[i][3] = 0.0;
        X[i][5] = pyRound(compCoolOpexWanMw(scene), 1);
      } else if (p === "comp") {
        X[i][3] = pyRound(compReduction(scene), 1);
        X[i][5] = pyRound(0.357 * hours * ELEC_PRICE * 1000 / 10000, 1);
      } else if (["direct", "whb_steam", "tc_storage", "pcm_storage"].indexOf(p) >= 0) {
        X[i][3] = pyRound(heatRedGas(scene), 1);
      }
    }
    for (let i = 0; i < survivors.length; i++) {
      const p = survivors[i];
      if (p === "orc" || p === "steam_pp") X[i][3] = pyRound(powerReduction(p, scene), 1);
    }
    return X;
  }

  // ---------- 权重 / TOPSIS（与 app.py combined_weights/topsis 一致）----------
  // meta: { names:[], sub:[], obj:[] }（eval_weights.json 原样）
  const MAP_IDX = { "系统能效": 0, "初始投资": 3, "投资回收期": 4, "CO2当量减排": 5, "政策补贴适配度": 7 };

  function weight6From(arr, names) {
    const pick = (k) => arr[names.indexOf(k)];
    const w = [pick("系统能效"), pick("初始投资"), pick("投资回收期"),
      pick("CO2当量减排"), pick("政策补贴适配度"),
      0.25 * (pick("初始投资") + pick("投资回收期"))];
    const s = w.reduce((a, b) => a + b, 0);
    return w.map((v) => v / s);
  }

  function entropyWeights(X) {
    const n = X.length, m = X[0].length;
    const xmin = [], xmax = [];
    for (let j = 0; j < m; j++) {
      let a = Infinity, b = -Infinity;
      for (let i = 0; i < n; i++) { a = Math.min(a, X[i][j]); b = Math.max(b, X[i][j]); }
      xmin.push(a); xmax.push(b);
    }
    const xr = X.map((r) => r.map((v, j) => {
      const span = xmax[j] - xmin[j];
      if (span < 1e-12) return 1.0;
      return DIRECTIONS[j] === "max" ? (v - xmin[j]) / span : (xmax[j] - v) / span;
    }));
    const sumc = [];
    for (let j = 0; j < m; j++) sumc.push(xr.reduce((a, r) => a + r[j], 0) + 1e-10);
    const p = xr.map((r) => r.map((v, j) => (v + 1e-10) / sumc[j]));
    const e = [];
    for (let j = 0; j < m; j++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += p[i][j] * Math.log(p[i][j]);
      e.push(-s / Math.log(n));
    }
    const es = e.reduce((a, b) => a + (1 - b), 0);
    return e.map((v) => (1 - v) / es);
  }

  function combinedWeights(lam, X, meta) {
    const wSub6 = weight6From(meta.sub, meta.names);
    const wObj6 = X ? entropyWeights(X) : weight6From(meta.obj, meta.names);
    const wAll = wSub6.map((v, i) => lam * v + (1 - lam) * wObj6[i]);
    const s = wAll.reduce((a, b) => a + b, 0);
    return wAll.map((v) => v / s);
  }

  function topsis(matrix, weights) {
    if (matrix.length === 1) return [1.0];
    const norm = matrix.map((r) => r.map((v, j) => v / Math.sqrt(matrix.reduce((a, row) => a + row[j] * row[j], 0) + 1e-12)));
    const v = norm.map((r) => r.map((x, j) => x * weights[j]));
    const pos = [], neg = [];
    for (let j = 0; j < v[0].length; j++) {
      const col = v.map((r) => r[j]);
      pos.push(DIRECTIONS[j] === "max" ? Math.max.apply(null, col) : Math.min.apply(null, col));
      neg.push(DIRECTIONS[j] === "max" ? Math.min.apply(null, col) : Math.max.apply(null, col));
    }
    return v.map((r) => {
      const dp = Math.sqrt(r.reduce((a, x, j) => a + (x - pos[j]) * (x - pos[j]), 0));
      const dn = Math.sqrt(r.reduce((a, x, j) => a + (x - neg[j]) * (x - neg[j]), 0));
      return dn / (dp + dn + 1e-12);
    });
  }

  // ---------- 总入口 ----------
  function runDecision(scene, lam, meta) {
    const v = validateScene(scene);
    if (!v.ok) return { out_of_scope: true, message: v.error, warnings: [v.error], keys: [], labels: [], X: null, scene: null };
    const s = v.scene;
    const st = stage1(s);
    const keys = PATH_KEYS.filter((p) => st.keep[p]);
    if (!keys.length) {
      const msg = "无可行候选路径：" + PATH_KEYS.filter((p) => !st.keep[p]).map((p) => DISPLAY[p] + "：" + st.reasons[p]).join("；");
      return { out_of_scope: true, message: msg, warnings: [msg], keys: [], labels: [], X: null, scene: s };
    }
    const X = buildMatrixV2(keys, s);
    const w = combinedWeights(lam, X, meta);
    const c = topsis(X, w);
    const order = keys.map((p, i) => ({ path: p, closeness: pyRound(c[i], 4), row: X[i] }))
      .sort((a, b) => b.closeness - a.closeness);
    const warnings = [];
    const q = recoveredHeatKw(s);
    if (q < 500 && order.some((o) => o.path === "steam_pp")) {
      warnings.push("可回收热功率仅约 " + Math.round(q) + " kW（小规模），蒸汽朗肯单位造价×" +
        scaleMultiplier("steam_pp", "小").toFixed(2) + "，经济性差，建议专项可行性评估，勿直接按推荐实施");
    }
    return {
      out_of_scope: false, message: "", warnings,
      keys, labels: keys.map((p) => DISPLAY[p]), X, scene: s,
      order, top: order[0].path, topLabel: DISPLAY[order[0].path],
      weights: w
    };
  }

  // ---------- C3.2 边界提示（decision_v2_ui.boundary_notices 移植）----------
  const BOUNDARY_HIGH_SENSITIVE = 5.0;
  const BOUNDARY_NOTICE_BAND = 10.0;
  const BOUNDARY_NEAR_BAND = 5.0;

  function boundaryNotices(res) {
    if (res.out_of_scope || !res.keys || !res.keys.length || !res.scene) return [];
    const s = res.scene;
    const t = Number(s["热源温度_degC"]);
    const dT = Number(s["换热端差_degC"]);
    const demand = s["需求"];
    const driver = s["驱动来源"] || "余热自驱动";
    const keys = {};
    res.keys.forEach((p) => { keys[p] = true; });
    const notes = [];
    if (demand === "供暖·热水") {
      const tDem = s["需求温度_degC"] || 60.0;
      const lo = Math.max(60.0, tDem + dT);
      const margin = t - lo;
      if (keys.direct && margin >= 0 && margin < BOUNDARY_NOTICE_BAND) {
        if (margin < BOUNDARY_HIGH_SENSITIVE) {
          notes.push("⚠ 边界工况提示（S2 型）：热源 " + t.toFixed(0) + "℃ 仅比直接换热下限 " + lo.toFixed(0) +
            "℃（需求 " + tDem.toFixed(0) + "℃ + 换热端差 " + dT.toFixed(0) + "℃）高 " + margin.toFixed(1) +
            "℃，温度/端差的小幅扰动即可让“直接换热”失效并转向热泵（鲁棒性核验：恰处下限的场景保持概率约 50%）。工程上建议预留 ≥5℃ 端差裕量，或按“直接换热优先 + 热泵兜底”双方案设计。");
        } else {
          notes.push("⚠ 边界工况提示：热源 " + t.toFixed(0) + "℃ 距直接换热下限 " + lo.toFixed(0) + "℃（需求 " +
            tDem.toFixed(0) + "℃ + 换热端差 " + dT.toFixed(0) + "℃）仅高 " + margin.toFixed(1) +
            "℃，处于较敏感区。请用全年最低热源温度与换热器衰减后的真实端差复核，预留 ≥5℃ 裕量，避免按理想工况定容。");
        }
      } else if (!keys.direct && margin >= -BOUNDARY_NEAR_BAND && margin < 0) {
        notes.push("⚠ 边界工况提示：热源 " + t.toFixed(0) + "℃ 距直接换热下限 " + lo.toFixed(0) + "℃（需求 " +
          tDem.toFixed(0) + "℃ + 换热端差 " + dT.toFixed(0) + "℃）还差 " + (-margin).toFixed(1) +
          "℃，当前直接换热不可行、推荐转向热泵；若现场实际端差可压缩（换热端差仍应 ≥5℃）或需求温度略低，直接换热路径可恢复，请以实测换热性能曲线为准后再定案。");
      }
    } else if (demand === "干燥") {
      const tDry = s["需求温度_degC"] || 100.0;
      const lo = Math.max(60.0, tDry + dT);
      const margin = t - lo;
      if (keys.direct && margin >= 0 && margin < BOUNDARY_NOTICE_BAND) {
        if (margin < BOUNDARY_HIGH_SENSITIVE) {
          notes.push("⚠ 边界工况提示（S2 型）：热源 " + t.toFixed(0) + "℃ 仅比干燥直接热风下限 " + lo.toFixed(0) +
            "℃（需求 " + tDry.toFixed(0) + "℃ + 换热端差 " + dT.toFixed(0) + "℃）高 " + margin.toFixed(1) +
            "℃，小幅扰动即可能让该路径失效并转向热泵烘干。建议预留 ≥5℃ 端差裕量，或按“直接换热优先 + 热泵兜底”双方案设计。");
        } else {
          notes.push("⚠ 边界工况提示：热源 " + t.toFixed(0) + "℃ 距干燥直接热风下限 " + lo.toFixed(0) + "℃仅高 " +
            margin.toFixed(1) + "℃，处于较敏感区，请用全年最低温度复核后预留 ≥5℃ 裕量。");
        }
      }
    } else if (demand === "供冷" && driver === "余热自驱动" && keys.abs_cool) {
      if (t < 85.0) {
        notes.push("⚠ 边界工况提示：热源 " + t.toFixed(0) + "℃ 处于吸收式制冷驱动下限区（80~84℃ 按 COP_c=0.6 保守核算），运行温度一旦波动至 " +
          ABS_COOL_T_MIN.toFixed(0) + "℃ 以下该路径将整体失效。建议按 ≥85℃ 设计点预留裕量，或对该温度段做全年运行小时分布校核后再定容。");
      }
    }
    return notes;
  }

  // 展示用细账（ORC/蒸汽朗肯 P10/P50/P90 与净功率/收益）
  function orcDetail(tSrc, mDot, medium, hours, dT) {
    const c = clamp(tSrc - dT, 100, 360);
    const row = pctLookupRow(TABLES.orcPct, c);
    if (!row) return null;
    const q = recoveredHeatKw({ "热源温度_degC": tSrc, "载体": medium, "流量_kg_s": mDot, "换热端差_degC": dT });
    const p50 = row[2];
    const net = p50 * q / 1000;
    const mwh = net * hours / 1000;
    return { q, p10: row[1], p50, p90: row[3], n: row[4], net, mwh, co2: mwh * GRID_EF, money: mwh * 1000 * ELEC_PRICE / 10000 };
  }

  function steamDetail(tSrc, mDot, medium, hours, dT) {
    const tb = clamp(tSrc - 100.0, 180.0, 540.0);
    const row = TABLES.stPct ? pctLookupRow(TABLES.stPct, tb) : null;
    const q = recoveredHeatKw({ "热源温度_degC": tSrc, "载体": medium, "流量_kg_s": mDot, "换热端差_degC": dT });
    const p50 = steamEffPct(tSrc) * 10.0;
    const net = p50 * q / 1000;
    const mwh = net * hours / 1000;
    return { q, p10: row ? row[1] : null, p50, p90: row ? row[3] : null, n: row ? row[4] : null, net, mwh, co2: mwh * GRID_EF, money: mwh * 1000 * ELEC_PRICE / 10000 };
  }

  function heatDetail(mDot, medium, tSrc, hours, dT, cop) {
    const dt = Math.max(tSrc - 40 - dT, 5);
    const q = mDot * CP[medium] * dt;
    const heatGj = q * hours * 3.6 / 1000;
    const replaced = heatGj * GAS_EF / BOILER_EFF;
    if (cop) {
      const mwhE = heatGj / 3.6 / cop;
      const co2E = mwhE * GRID_EF;
      return { q, heatGj, co2: Math.max(replaced - co2E, 0), money: (heatGj * GAS_PRICE - mwhE * 1000 * ELEC_PRICE) / 10000 };
    }
    return { q, heatGj, co2: replaced, money: heatGj * GAS_PRICE / 10000 };
  }

  return {
    PATH_KEYS, DISPLAY, INDICATORS, DIRECTIONS, CP, BASE_INDICATORS,
    ABS_COOL_T_MIN, COP_C_ABS, COP_E_COOL, GRID_EF, ELEC_PRICE, HP_COP,
    setTables, validateScene, recoveredHeatKw, scaleBand, scaleMultiplier,
    absCoolCop, stage1, buildMatrixV2, entropyWeights, combinedWeights,
    topsis, runDecision, boundaryNotices, orcEffPct, steamEffPct,
    orcDetail, steamDetail, heatDetail, pctLookupRow
  };
})();

/* io.js —— 实时数据接入层（浏览器 + Node 双环境，零第三方依赖）
   协议：统一遥测帧 → frameToScene → WHENG.runDecision（engine 零改动）
   数据源：SimSource / FilePlaybackSource / HttpPollSource / WsSource     */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.WHIO = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const DEMAND_MAP = {
    "发电": "发电", "工艺蒸汽": "工艺蒸汽", "供暖/热水": "供暖·热水",
    "储热调峰": "储热调峰", "供冷（制冷）": "供冷", "干燥/烘干": "干燥"
  };
  const MEDIUM_MAP = { "热水/冷凝水": "热水·冷凝水", "烟气": "烟气", "工艺液体": "工艺液体" };
  const REV_DEMAND = {};
  Object.keys(DEMAND_MAP).forEach((k) => { REV_DEMAND[DEMAND_MAP[k]] = k; });
  const DEMAND_KEYS = Object.keys(DEMAND_MAP);
  const MEDIUM_KEYS = Object.keys(MEDIUM_MAP);

  function nowISO() { return new Date().toISOString(); }
  function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }
  function numOr(v) { return (v === null || v === undefined || v === "") ? null : Number(v); }

  const DEFAULT_DEMAND = "发电", DEFAULT_MEDIUM = "热水/冷凝水";

  /* 把任意来源的原始读数规范化为遥测帧 */
  function normalizeFrame(raw, defaults) {
    const d = defaults || {};
    const t = numOr(raw.t_src_degC);
    const m = numOr(raw.m_dot_kg_s);
    const scale = numOr(raw.scale_kW);
    let quality = "good", error = "";
    if (t === null || (m === null && scale === null)) {
      quality = "invalid";
      error = "缺热源温度或流量/规模";
    } else if (t < 25 || t > 650) {
      quality = "over_range";
      error = "温度超出引擎包络 25~650℃";
    }
    let medium = raw.medium || d.medium || DEFAULT_MEDIUM;
    if (MEDIUM_KEYS.indexOf(medium) < 0) medium = DEFAULT_MEDIUM;
    let demand = raw.demand || d.demand || DEFAULT_DEMAND;
    if (DEMAND_KEYS.indexOf(demand) < 0) demand = DEFAULT_DEMAND;
    const driver = raw.driver || d.driver || "余热自驱动";
    return {
      ts: raw.ts || nowISO(),
      t_src_degC: t,
      m_dot_kg_s: m,
      scale_kW: scale,
      medium, demand, continuity: raw.continuity || d.continuity || "连续",
      driver, dT_degC: numOr(raw.dT_degC) != null ? numOr(raw.dT_degC)
        : (numOr(d.dT_degC) != null ? numOr(d.dT_degC) : 10),
      hours: numOr(raw.hours) != null ? numOr(raw.hours)
        : (numOr(d.hours) != null ? numOr(d.hours) : 8000),
      quality, error, raw
    };
  }

  /* 遥测帧 → engine scene（engine 使用内核词） */
  function frameToScene(f) {
    return {
      "需求": DEMAND_MAP[f.demand],
      "热源温度_degC": f.t_src_degC,
      "载体": MEDIUM_MAP[f.medium],
      "流量_kg_s": f.m_dot_kg_s,
      "规模_kW": f.scale_kW,
      "换热端差_degC": numOr(f.dT_degC) != null ? numOr(f.dT_degC) : 10,
      "年运行小时": numOr(f.hours) != null ? numOr(f.hours) : 8000,
      "连续性": f.continuity || "连续",
      "驱动来源": f.driver || "余热自驱动"
    };
  }

  /* ---------------- 模拟源 ---------------- */
  class SimSource {
    constructor(cfg) { this.cfg = Object.assign({}, cfg); this.timer = null; this.n = 0; this._st = { state: "idle" }; }
    wave(n) {
      const c = this.cfg, base = c.t_base != null ? c.t_base : 120;
      const amp = c.t_amp != null ? c.t_amp : 20;
      const period = c.t_period_s != null ? c.t_period_s : 60;
      let t;
      if (c.t_wave === "阶跃") {
        t = base + amp * (Math.floor(n / Math.max(4, Math.round(period / 2))) % 2 === 0 ? 1 : -1);
      } else if (c.t_wave === "随机") {
        t = base + (amp / 6) * Math.sin(n * 0.4) + (amp / 12) * (((n * 7919) % 100) - 50) / 50;
      } else {
        t = base + amp * Math.sin(n * 2 * Math.PI / period) + (amp / 8) * Math.sin(n * 2 * Math.PI / (period * 1.7));
      }
      return Math.min(Math.max(t, 25), 900);
    }
    connect(cfg, onFrame) {
      if (cfg) this.cfg = Object.assign(this.cfg, cfg);
      this.cb = onFrame;
      this._st = { state: "connecting" };
      this.n = 0;
      const emit = () => {
        const f = this.cfg.f_amp ? this.cfg.f_base + this.cfg.f_amp * Math.sin(this.n * 0.12 + 1) : this.cfg.f_base;
        const flow = f != null ? Math.max(0.1, Math.min(200, f)) : 50;
        const frame = normalizeFrame({
          t_src_degC: this.wave(this.n), m_dot_kg_s: flow,
          medium: this.cfg.medium, demand: this.cfg.demand,
          continuity: this.cfg.continuity, driver: this.cfg.driver,
          dT_degC: this.cfg.dT_degC, hours: this.cfg.hours
        }, {});
        this.n += 1;
        this._st = { state: "live", lastTs: Date.now() };
        if (this.cb) this.cb(frame);
      };
      emit();
      this.timer = setInterval(emit, 1000);
      return this;
    }
    disconnect() { if (this.timer) clearInterval(this.timer); this.timer = null; this._st = { state: "idle" }; }
    status() { return this._st; }
  }

  /* ---------------- 历史文件回放 ---------------- */
  class FilePlaybackSource {
    constructor(cfg) {
      this.cfg = cfg || {};
      this.frames = [];
      this.idx = 0;
      this.timer = null;
      this._st = { state: "idle" };
    }
    async loadText(text) {
      const trimmed = text.trim();
      let data;
      if (trimmed[0] === "{" || trimmed[0] === "[") {
        data = JSON.parse(trimmed);
      } else {
        data = this._parseCsv(text);
      }
      const list = Array.isArray(data) ? data : [data];
      this.frames = list.map((r) => normalizeFrame(r, this.cfg.defaults || {}));
      this.idx = 0;
      this._st = { state: "idle", count: this.frames.length };
      return this.frames.length;
    }
    async loadFile(file) {
      return this.loadText(await file.text());
    }
    _parseCsv(text) {
      const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim());
      if (!lines.length) return [];
      const head = lines[0].split(",").map((h) => h.trim());
      return lines.slice(1).map((l) => {
        const cells = l.split(",").map((c) => c.trim());
        const o = {};
        head.forEach((h, i) => { o[h] = cells[i]; });
        return o;
      });
    }
    _emit() {
      const f = this.frames[this.idx];
      this._st = { state: "playing", frameIndex: this.idx, lastTs: Date.now() };
      if (this.cb) this.cb(f);
    }
    connect(cfg, onFrame) {
      if (cfg) Object.assign(this.cfg, cfg);
      this.cb = onFrame;
      return this;
    }
    play() {
      if (!this.frames.length) return this;
      if (this.timer) clearTimeout(this.timer);
      this._emit();
      const next = () => {
        if (this.idx + 1 >= this.frames.length) {
          this._st = { state: "ended" };
          return;
        }
        this.idx += 1;
        this._emit();
        const t0 = new Date(this.frames[this.idx - 1].ts).getTime();
        const t1 = new Date(this.frames[this.idx].ts).getTime();
        let dt = 1000;
        if (isFinite(t0) && isFinite(t1) && t1 > t0) dt = Math.min(t1 - t0, 10000);
        this.timer = setTimeout(next, dt);
      };
      this.timer = setTimeout(next, 200);
      return this;
    }
    step() {
      if (this.frames.length && this.idx + 1 < this.frames.length) {
        this.idx += 1;
        this._emit();
      }
      return this;
    }
    pause() { if (this.timer) clearTimeout(this.timer); this.timer = null; this._st = { state: "paused", frameIndex: this.idx }; return this; }
    stop() { this.pause(); this._st = { state: "idle" }; return this; }
    status() { return this._st; }
  }

  /* ---------------- HTTP/JSON 轮询 ---------------- */
  class HttpPollSource {
    constructor(cfg) {
      this.cfg = Object.assign({ url: "", interval_ms: 2000 }, cfg);
      this.timer = null;
      this.fail = 0;
      this._st = { state: "idle" };
    }
    connect(cfg, onFrame) {
      if (cfg) Object.assign(this.cfg, cfg);
      this.cb = onFrame;
      this._st = { state: "connecting" };
      const poll = async () => {
        const fetchImpl = this.cfg.fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
        if (!fetchImpl) { this._st = { state: "error", detail: "当前环境无 fetch" }; return; }
        try {
          const r = await fetchImpl(this.cfg.url);
          const raw = await r.json();
          this.fail = 0;
          this._st = { state: "live", lastTs: Date.now() };
          const frame = normalizeFrame(raw, this.cfg.defaults || {});
          if (this.cb) this.cb(frame);
        } catch (e) {
          this.fail += 1;
          if (this.fail >= 3) this._st = { state: "error", detail: "连续 3 次请求失败" };
          else this._st = { state: "stale", detail: "请求失败 " + this.fail + " 次" };
        }
      };
      poll();
      this.timer = setInterval(poll, this.cfg.interval_ms);
      return this;
    }
    disconnect() { if (this.timer) clearInterval(this.timer); this.timer = null; this._st = { state: "idle" }; }
    status() { return this._st; }
  }

  /* ---------------- WebSocket 推送 ---------------- */
  class WsSource {
    constructor(cfg) {
      this.cfg = Object.assign({ url: "", retryMs: [1000, 5000, 15000] }, cfg);
      this.ws = null;
      this.retryIdx = 0;
      this.retryTimer = null;
      this.manualClose = false;
      this._st = { state: "idle" };
    }
    connect(cfg, onFrame) {
      if (cfg) Object.assign(this.cfg, cfg);
      this.cb = onFrame;
      this.manualClose = false;
      this._open();
      return this;
    }
    _open() {
      const WsImpl = this.cfg.WsImpl || (typeof WebSocket !== "undefined" ? WebSocket : null);
      if (!WsImpl) { this._st = { state: "error", detail: "当前环境无 WebSocket" }; return; }
      this._st = { state: "connecting", attempt: this.retryIdx };
      try {
        const ws = new WsImpl(this.cfg.url);
        this.ws = ws;
        ws.onmessage = (ev) => {
          this.retryIdx = 0;
          this._st = { state: "live", lastTs: Date.now() };
          try {
            const raw = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data);
            const frame = normalizeFrame(raw, this.cfg.defaults || {});
            if (this.cb) this.cb(frame);
          } catch (e) { /* 忽略坏帧 */ }
        };
        ws.onclose = () => { if (!this.manualClose) this._scheduleRetry(); };
        ws.onerror = () => { if (this.ws) try { this.ws.close(); } catch (e) {} };
      } catch (e) {
        this._scheduleRetry();
      }
    }
    _scheduleRetry() {
      this._st = { state: "stale", detail: "连接断开，等待重连" };
      if (this.retryTimer) clearTimeout(this.retryTimer);
      const wait = this.cfg.retryMs[Math.min(this.retryIdx, this.cfg.retryMs.length - 1)];
      this.retryIdx += 1;
      this.retryTimer = setTimeout(() => this._open(), wait);
    }
    disconnect() {
      this.manualClose = true;
      if (this.retryTimer) clearTimeout(this.retryTimer);
      if (this.ws) try { this.ws.close(); } catch (e) {}
      this.ws = null;
      this._st = { state: "idle" };
    }
    status() { return this._st; }
  }

  return {
    DEMAND_MAP, MEDIUM_MAP, REV_DEMAND, DEMAND_KEYS, MEDIUM_KEYS,
    nowISO, clamp, normalizeFrame, frameToScene,
    SimSource, FilePlaybackSource, HttpPollSource, WsSource
  };
});

window.HFDATA = {"orcPct":[[100,73.1953,87.0479,102.4251,25],[102,73.1953,87.0479,102.4251,25],[104,73.1953,87.0479,102.4251,25],[106,73.1953,87.0479,102.4251,25],[108,73.1953,87.0479,102.4251,25],[110,76.3185,91.6707,109.2138,100],[112,76.3185,91.6707,109.2138,100],[114,76.3185,91.6707,109.2138,100],[116,76.3185,91.6707,109.2138,100],[118,76.3185,91.6707,109.2138,100],[120,77.1211,94.2423,112.3571,225],[122,77.1211,94.2423,112.3571,225],[124,77.1211,94.2423,112.3571,225],[126,77.1211,94.2423,112.3571,225],[128,77.1211,94.2423,112.3571,225],[130,80.5805,98.5522,119.8442,425],[132,80.5805,98.5522,119.8442,425],[134,80.5805,98.5522,119.8442,425],[136,80.5805,98.5522,119.8442,425],[138,80.5805,98.5522,119.8442,425],[140,81.1218,101.391,124.1729,675],[142,81.1218,101.391,124.1729,675],[144,81.1218,101.391,124.1729,675],[146,81.1218,101.391,124.1729,675],[148,81.1218,101.391,124.1729,675],[150,81.7632,102.8839,126.5454,925],[152,81.7632,102.8839,126.5454,925],[154,81.7632,102.8839,126.5454,925],[156,81.7632,102.8839,126.5454,925],[158,81.7632,102.8839,126.5454,925],[160,82.2075,103.6363,127.4122,1175],[162,82.2075,103.6363,127.4122,1175],[164,82.2075,103.6363,127.4122,1175],[166,82.2075,103.6363,127.4122,1175],[168,82.2075,103.6363,127.4122,1175],[170,82.3556,103.9777,127.8374,1425],[172,82.3556,103.9777,127.8374,1425],[174,82.3556,103.9777,127.8374,1425],[176,82.3556,103.9777,127.8374,1425],[178,82.3556,103.9777,127.8374,1425],[180,82.3047,104.1664,128.0565,1675],[182,82.3047,104.1664,128.0565,1675],[184,82.3047,104.1664,128.0565,1675],[186,82.3047,104.1664,128.0565,1675],[188,82.3047,104.1664,128.0565,1675],[190,82.1191,104.2164,128.2906,1925],[192,82.1191,104.2164,128.2906,1925],[194,82.1191,104.2164,128.2906,1925],[196,82.1191,104.2164,128.2906,1925],[198,82.1191,104.2164,128.2906,1925],[200,81.9116,104.1717,128.2151,2175],[202,81.9116,104.1717,128.2151,2175],[204,81.9116,104.1717,128.2151,2175],[206,81.9116,104.1717,128.2151,2175],[208,81.9116,104.1717,128.2151,2175],[210,81.5583,103.9797,127.9527,2425],[212,81.5583,103.9797,127.9527,2425],[214,81.5583,103.9797,127.9527,2425],[216,81.5583,103.9797,127.9527,2425],[218,81.5583,103.9797,127.9527,2425],[220,81.296,103.6955,127.6619,2675],[222,81.296,103.6955,127.6619,2675],[224,81.296,103.6955,127.6619,2675],[226,81.296,103.6955,127.6619,2675],[228,81.296,103.6955,127.6619,2675],[230,81.0277,103.5257,127.4881,2925],[232,81.0277,103.5257,127.4881,2925],[234,81.0277,103.5257,127.4881,2925],[236,81.0277,103.5257,127.4881,2925],[238,81.0277,103.5257,127.4881,2925],[240,80.7616,103.1891,127.3801,3175],[242,80.7616,103.1891,127.3801,3175],[244,80.7616,103.1891,127.3801,3175],[246,80.7616,103.1891,127.3801,3175],[248,80.7616,103.1891,127.3801,3175],[250,80.5742,102.888,127.0185,3425],[252,80.5742,102.888,127.0185,3425],[254,80.5742,102.888,127.0185,3425],[256,80.5742,102.888,127.0185,3425],[258,80.5742,102.888,127.0185,3425],[260,80.0589,102.5966,126.6103,3675],[262,80.0589,102.5966,126.6103,3675],[264,80.0589,102.5966,126.6103,3675],[266,80.0589,102.5966,126.6103,3675],[268,80.0589,102.5966,126.6103,3675],[270,79.7062,102.1712,126.3668,3925],[272,79.7062,102.1712,126.3668,3925],[274,79.7062,102.1712,126.3668,3925],[276,79.7062,102.1712,126.3668,3925],[278,79.7062,102.1712,126.3668,3925],[280,79.1556,101.8232,125.9165,4175],[282,79.1556,101.8232,125.9165,4175],[284,79.1556,101.8232,125.9165,4175],[286,79.1556,101.8232,125.9165,4175],[288,79.1556,101.8232,125.9165,4175],[290,78.7553,101.3986,125.4862,4425],[292,78.7553,101.3986,125.4862,4425],[294,78.7553,101.3986,125.4862,4425],[296,78.7553,101.3986,125.4862,4425],[298,78.7553,101.3986,125.4862,4425],[300,78.2259,101.0425,125.0914,4675],[302,78.2259,101.0425,125.0914,4675],[304,78.2259,101.0425,125.0914,4675],[306,78.2259,101.0425,125.0914,4675],[308,78.2259,101.0425,125.0914,4675],[310,77.7198,100.6081,124.7211,4925],[312,77.7198,100.6081,124.7211,4925],[314,77.7198,100.6081,124.7211,4925],[316,77.7198,100.6081,124.7211,4925],[318,77.7198,100.6081,124.7211,4925],[320,77.2842,100.1479,124.3248,5175],[322,77.2842,100.1479,124.3248,5175],[324,77.2842,100.1479,124.3248,5175],[326,77.2842,100.1479,124.3248,5175],[328,77.2842,100.1479,124.3248,5175],[330,76.7327,99.7295,123.9678,5425],[332,76.7327,99.7295,123.9678,5425],[334,76.7327,99.7295,123.9678,5425],[336,76.7327,99.7295,123.9678,5425],[338,76.7327,99.7295,123.9678,5425],[340,76.4154,99.2909,123.6935,5675],[342,76.4154,99.2909,123.6935,5675],[344,76.4154,99.2909,123.6935,5675],[346,76.4154,99.2909,123.6935,5675],[348,76.4154,99.2909,123.6935,5675],[350,75.9034,98.8784,123.1869,5925],[352,75.9034,98.8784,123.1869,5925],[354,75.9034,98.8784,123.1869,5925],[356,75.9034,98.8784,123.1869,5925],[358,75.9034,98.8784,123.1869,5925],[360,75.9034,98.8784,123.1869,5925]],"stPct":[[180,163.13,196.23,232.24,25],[182,163.13,196.23,232.24,25],[184,163.13,196.23,232.24,25],[186,163.13,196.23,232.24,25],[188,163.13,196.23,232.24,25],[190,163.13,196.23,232.24,25],[192,163.13,196.23,232.24,25],[194,163.13,196.23,232.24,25],[196,163.13,196.23,232.24,25],[198,163.13,196.23,232.24,25],[200,163.13,196.23,232.24,25],[202,163.13,196.23,232.24,25],[204,163.13,196.23,232.24,25],[206,163.13,196.23,232.24,25],[208,163.13,196.23,232.24,25],[210,163.13,196.23,232.24,25],[212,163.13,196.23,232.24,25],[214,163.13,196.23,232.24,25],[216,163.13,196.23,232.24,25],[218,163.13,196.23,232.24,25],[220,172.63,211.24,252.78,100],[222,172.63,211.24,252.78,100],[224,172.63,211.24,252.78,100],[226,172.63,211.24,252.78,100],[228,172.63,211.24,252.78,100],[230,172.63,211.24,252.78,100],[232,172.63,211.24,252.78,100],[234,172.63,211.24,252.78,100],[236,172.63,211.24,252.78,100],[238,172.63,211.24,252.78,100],[240,172.63,211.24,252.78,100],[242,172.63,211.24,252.78,100],[244,172.63,211.24,252.78,100],[246,172.63,211.24,252.78,100],[248,172.63,211.24,252.78,100],[250,172.63,211.24,252.78,100],[252,172.63,211.24,252.78,100],[254,172.63,211.24,252.78,100],[256,172.63,211.24,252.78,100],[258,172.63,211.24,252.78,100],[260,180.39,224.32,273.24,225],[262,180.39,224.32,273.24,225],[264,180.39,224.32,273.24,225],[266,180.39,224.32,273.24,225],[268,180.39,224.32,273.24,225],[270,180.39,224.32,273.24,225],[272,180.39,224.32,273.24,225],[274,180.39,224.32,273.24,225],[276,180.39,224.32,273.24,225],[278,180.39,224.32,273.24,225],[280,180.39,224.32,273.24,225],[282,180.39,224.32,273.24,225],[284,180.39,224.32,273.24,225],[286,180.39,224.32,273.24,225],[288,180.39,224.32,273.24,225],[290,180.39,224.32,273.24,225],[292,180.39,224.32,273.24,225],[294,180.39,224.32,273.24,225],[296,180.39,224.32,273.24,225],[298,180.39,224.32,273.24,225],[300,186.2,234.94,289.54,400],[302,186.2,234.94,289.54,400],[304,186.2,234.94,289.54,400],[306,186.2,234.94,289.54,400],[308,186.2,234.94,289.54,400],[310,186.2,234.94,289.54,400],[312,186.2,234.94,289.54,400],[314,186.2,234.94,289.54,400],[316,186.2,234.94,289.54,400],[318,186.2,234.94,289.54,400],[320,186.2,234.94,289.54,400],[322,186.2,234.94,289.54,400],[324,186.2,234.94,289.54,400],[326,186.2,234.94,289.54,400],[328,186.2,234.94,289.54,400],[330,186.2,234.94,289.54,400],[332,186.2,234.94,289.54,400],[334,186.2,234.94,289.54,400],[336,186.2,234.94,289.54,400],[338,186.2,234.94,289.54,400],[340,191.57,243.45,300.62,600],[342,191.57,243.45,300.62,600],[344,191.57,243.45,300.62,600],[346,191.57,243.45,300.62,600],[348,191.57,243.45,300.62,600],[350,191.57,243.45,300.62,600],[352,191.57,243.45,300.62,600],[354,191.57,243.45,300.62,600],[356,191.57,243.45,300.62,600],[358,191.57,243.45,300.62,600],[360,191.57,243.45,300.62,600],[362,191.57,243.45,300.62,600],[364,191.57,243.45,300.62,600],[366,191.57,243.45,300.62,600],[368,191.57,243.45,300.62,600],[370,191.57,243.45,300.62,600],[372,191.57,243.45,300.62,600],[374,191.57,243.45,300.62,600],[376,191.57,243.45,300.62,600],[378,191.57,243.45,300.62,600],[380,195.06,248.71,305.89,800],[382,195.06,248.71,305.89,800],[384,195.06,248.71,305.89,800],[386,195.06,248.71,305.89,800],[388,195.06,248.71,305.89,800],[390,195.06,248.71,305.89,800],[392,195.06,248.71,305.89,800],[394,195.06,248.71,305.89,800],[396,195.06,248.71,305.89,800],[398,195.06,248.71,305.89,800],[400,195.06,248.71,305.89,800],[402,195.06,248.71,305.89,800],[404,195.06,248.71,305.89,800],[406,195.06,248.71,305.89,800],[408,195.06,248.71,305.89,800],[410,195.06,248.71,305.89,800],[412,195.06,248.71,305.89,800],[414,195.06,248.71,305.89,800],[416,195.06,248.71,305.89,800],[418,195.06,248.71,305.89,800],[420,198.1,252.9,310.48,1000],[422,198.1,252.9,310.48,1000],[424,198.1,252.9,310.48,1000],[426,198.1,252.9,310.48,1000],[428,198.1,252.9,310.48,1000],[430,198.1,252.9,310.48,1000],[432,198.1,252.9,310.48,1000],[434,198.1,252.9,310.48,1000],[436,198.1,252.9,310.48,1000],[438,198.1,252.9,310.48,1000],[440,198.1,252.9,310.48,1000],[442,198.1,252.9,310.48,1000],[444,198.1,252.9,310.48,1000],[446,198.1,252.9,310.48,1000],[448,198.1,252.9,310.48,1000],[450,198.1,252.9,310.48,1000],[452,198.1,252.9,310.48,1000],[454,198.1,252.9,310.48,1000],[456,198.1,252.9,310.48,1000],[458,198.1,252.9,310.48,1000],[460,200.51,257.08,314.95,1200],[462,200.51,257.08,314.95,1200],[464,200.51,257.08,314.95,1200],[466,200.51,257.08,314.95,1200],[468,200.51,257.08,314.95,1200],[470,200.51,257.08,314.95,1200],[472,200.51,257.08,314.95,1200],[474,200.51,257.08,314.95,1200],[476,200.51,257.08,314.95,1200],[478,200.51,257.08,314.95,1200],[480,200.51,257.08,314.95,1200],[482,200.51,257.08,314.95,1200],[484,200.51,257.08,314.95,1200],[486,200.51,257.08,314.95,1200],[488,200.51,257.08,314.95,1200],[490,200.51,257.08,314.95,1200],[492,200.51,257.08,314.95,1200],[494,200.51,257.08,314.95,1200],[496,200.51,257.08,314.95,1200],[498,200.51,257.08,314.95,1200],[500,203.76,260.06,318.61,1400],[502,203.76,260.06,318.61,1400],[504,203.76,260.06,318.61,1400],[506,203.76,260.06,318.61,1400],[508,203.76,260.06,318.61,1400],[510,203.76,260.06,318.61,1400],[512,203.76,260.06,318.61,1400],[514,203.76,260.06,318.61,1400],[516,203.76,260.06,318.61,1400],[518,203.76,260.06,318.61,1400],[520,203.76,260.06,318.61,1400],[522,203.76,260.06,318.61,1400],[524,203.76,260.06,318.61,1400],[526,203.76,260.06,318.61,1400],[528,203.76,260.06,318.61,1400],[530,203.76,260.06,318.61,1400],[532,203.76,260.06,318.61,1400],[534,203.76,260.06,318.61,1400],[536,203.76,260.06,318.61,1400],[538,203.76,260.06,318.61,1400],[540,206.29,262.69,321.05,1600]],"stCurve":[[180,19.6229],[220,21.7256],[260,23.5037],[300,25.0895],[340,26.1282],[380,26.5421],[420,27.0373],[460,27.4827],[500,27.958],[540,28.469]],"pymoo":[[229.20000000000078,109.57192325935632,0.10957192325935633],[229.20000009918348,109.70703298554052,0.10970703298554052],[229.39495274949508,111.32399882960767,0.11132399882960767],[229.73183365554323,111.59628257189591,0.11159628257189591],[232.0368648684619,112.36849999321687,0.11236849999321687],[234.4143894294164,113.09319708913607,0.11309319708913607],[236.22933522810095,113.71584982560815,0.11371584982560815],[238.18728338584822,114.28118360033866,0.11428118360033866],[241.93642467854983,115.31095329785046,0.11531095329785046],[254.94547736370657,115.38738308730385,0.11538738308730384],[242.2461090207995,115.52236986861463,0.11552236986861464],[250.42818227469613,116.05362354085838,0.11605362354085838],[245.2168350128386,116.3981636084334,0.11639816360843341],[247.50819987005,117.02639566156994,0.11702639566156993],[257.4847508578302,118.07407100988135,0.11807407100988135],[256.4948288249749,118.09495057247898,0.11809495057247898],[251.48616841896003,118.11460447394413,0.11811460447394413],[263.6834805075975,119.08974256066836,0.11908974256066836],[261.48951493429684,119.44510670477402,0.11944510670477403],[258.7894809830481,119.52466575784815,0.11952466575784816],[267.34765462004196,121.12899032469687,0.12112899032469687],[270.3967814699267,121.74050580406019,0.12174050580406019],[273.20714318162953,121.9193151771187,0.12191931517711871],[267.51049778917735,121.94830249604126,0.12194830249604127],[277.2312385744264,122.88620708842194,0.12288620708842193],[277.3017981159649,123.30493946806851,0.12330493946806852],[281.5055586662817,123.9528645498601,0.1239528645498601],[278.8334016520286,124.09959391644207,0.12409959391644207],[282.96367559667186,124.27149180573099,0.124271491805731],[288.34987547568994,125.95670607968174,0.12595670607968174],[288.7577168669763,126.04021399279611,0.1260402139927961],[291.1590089583672,126.91293479852838,0.1269129347985284],[295.29662389568745,127.59606241673094,0.12759606241673094],[299.1800480254229,128.04589645599822,0.1280458964559982],[303.6246147641006,128.9816058689765,0.12898160586897647],[306.56487742567697,129.26039565624168,0.12926039565624167],[307.5221251646646,129.58857096921582,0.12958857096921583],[312.4464773408041,129.72506508521852,0.12972506508521853],[313.11257832827084,129.84219435418174,0.12984219435418173],[310.1433299055165,130.06358031745228,0.13006358031745227],[316.58187675715664,131.1380838562408,0.1311380838562408],[318.5627483477704,131.31176671080286,0.13131176671080286],[321.57769932535626,131.92900982161044,0.13192900982161043],[323.3423503940089,132.22788338764522,0.1322278833876452],[326.9712032091162,132.76304105743648,0.13276304105743647],[329.5787787142176,133.16112657340477,0.13316112657340476],[333.9887634031262,133.5347534316732,0.1335347534316732],[337.80773283894035,134.09306350104094,0.13409306350104094],[343.1337127866162,134.89721231132188,0.13489721231132187],[348.6284131321466,135.72043222489233,0.13572043222489233],[352.6549818284884,136.20286120075878,0.13620286120075878],[354.75202491196325,136.46813972726696,0.13646813972726696],[356.6688767771657,136.5502609612558,0.13655026096125578],[357.6030654567962,136.82931887205868,0.13682931887205868],[360.6688116856409,137.1940849646399,0.1371940849646399],[363.93464413617914,137.58384775289014,0.13758384775289015],[365.2738582042897,137.74008852949214,0.13774008852949216],[368.6767470965495,138.1310480800605,0.13813104808006052],[371.8740776631299,138.46276137751096,0.13846276137751096],[377.0091274412976,139.058559043677,0.139058559043677],[380.1223618381969,139.38272242754496,0.13938272242754496],[381.53877818736345,139.5349231723163,0.1395349231723163],[384.17426372322336,139.8232867678437,0.13982328676784372],[390.0262936022194,140.42647392872172,0.1404264739287217],[390.0262936034563,140.42696492418347,0.14042696492418347],[396.2215960929115,141.0499373037086,0.1410499373037086],[402.70274478352513,141.62619052161972,0.14162619052161973],[404.29273489284935,141.78401079850184,0.14178401079850184],[406.8956750626736,142.07776466694085,0.14207776466694086],[406.8956750115443,142.08126590187507,0.14208126590187506],[411.4113103098025,142.48048243094075,0.14248048243094075],[411.6662132089701,142.50929630868197,0.14250929630868198],[418.05611635561223,143.04474850462785,0.14304474850462784],[419.95304969021674,143.26569526390958,0.1432656952639096],[424.62645946937795,143.69101975685848,0.14369101975685847],[425.66967078570684,143.77477180779815,0.14377477180779816],[430.6270381646687,144.1138584241643,0.1441138584241643],[432.0055040103436,144.29445413896178,0.14429445413896178],[435.3656453052365,144.57834318435334,0.14457834318435334],[441.47059630842875,145.0663060480854,0.1450663060480854],[444.96038544655147,145.37100129648584,0.14537100129648584],[451.36921728824564,145.8772141523066,0.14587721415230662],[456.74253030297734,146.2596568749739,0.1462596568749739],[460.58417171927624,146.56885282928238,0.14656885282928236],[465.09505200557817,146.86606029584175,0.14686606029584176],[470.834817075738,147.2051113731127,0.14720511137311268],[471.77023925288034,147.37944011521776,0.14737944011521775],[476.92095644953906,147.66080169886183,0.14766080169886184],[479.0238793903943,147.86954806132596,0.14786954806132596],[483.4696213347672,148.1913386552718,0.14819133865527181],[486.70259992317364,148.33386042427378,0.14833386042427377],[489.93136389507356,148.5066105928715,0.1485066105928715],[494.25360464583935,148.82312381265612,0.1488231238126561],[495.2092576803703,148.96722579785242,0.14896722579785243],[499.34556689849137,149.18473119145762,0.14918473119145761],[504.18880440668937,149.52149188367648,0.14952149188367647],[507.9849800719329,149.76106991002493,0.14976106991002494],[512.9348515080421,150.05808986129304,0.15005808986129304],[517.8111657338867,150.3375957220039,0.1503375957220039],[520.7878820428363,150.5340338539024,0.1505340338539024]],"steam":[[196.00000000000324,293.1971505064161,0.2931971505064161],[196.0000000000023,293.19715050641855,0.29319715050641854],[196.0000000000179,297.4184326014804,0.2974184326014804],[199.96457678382424,299.58765374084686,0.29958765374084684],[203.54937507124276,301.43951486316956,0.30143951486316956],[207.08665421923743,303.1758719829895,0.3031758719829895],[210.56424013752132,304.80303915721504,0.304803039157215],[212.13890062474886,305.51538054520614,0.30551538054520616],[216.21135306140073,307.2939221746357,0.30729392217463575],[219.3931578057939,308.5225076251382,0.30852250762513816],[222.5518716267365,309.893644517933,0.309893644517933],[227.8739266680942,311.9349327761903,0.3119349327761903],[232.46281072475253,313.6031860768846,0.3136031860768846],[236.12037176818802,314.8774327795637,0.3148774327795637],[239.4246785395969,315.9894374314958,0.31598943743149577],[240.42159151796602,316.3177433909096,0.31631774339090957],[244.41106017976867,317.602120272889,0.31760212027288903],[247.3015477064407,318.5032971288539,0.3185032971288539],[251.48420930811977,319.7666799655138,0.3197666799655138],[254.87751405055013,320.75829573620473,0.32075829573620473],[261.64893043985893,322.65458156712685,0.32265458156712684],[265.02227113500714,323.5611017825302,0.3235611017825302],[266.7659076914715,324.0203013517303,0.3240203013517303],[271.01719969586776,325.1143377583885,0.3251143377583885],[277.4809272051423,326.7124668336007,0.32671246683360067],[280.02240862880313,327.3206064715549,0.3273206064715549],[282.40787309946876,327.8814499364837,0.3278814499364837],[285.8666730786858,328.67814839357413,0.3286781483935741],[288.9828444965447,329.38037575588305,0.329380375755883],[293.67028126868524,329.96959357653964,0.32996959357653965],[295.6230197889688,330.8285579919969,0.3308285579919969],[303.47845852177255,332.38584558696175,0.33238584558696177],[308.89091764078194,333.54458237480503,0.33354458237480505],[313.8430168554503,334.50432536367947,0.33450432536367947],[320.40074227454227,335.73263108923385,0.33573263108923385],[325.1741522996911,336.59859682078695,0.33659859682078697],[332.8530656439091,337.94491577258844,0.33794491577258845],[334.2237970775355,338.1794717564097,0.3381794717564097],[342.2995670937748,339.52774392153486,0.33952774392153484],[350.00757114150645,340.76404019418004,0.34076404019418005],[357.37104340165007,341.89730468225923,0.3418973046822592],[365.0894957356186,343.052793193307,0.343052793193307],[371.56238812471827,343.9866704390027,0.3439866704390027],[378.69120461948086,344.9841951621899,0.3449841951621899],[384.5411016402492,345.7783815062254,0.3457783815062254],[394.0752939026257,347.0345370041744,0.3470345370041744],[400.4267956004319,347.843201238666,0.34784320123866597],[410.2662341321853,349.05568732810707,0.34905568732810704],[421.41358061482987,350.37396285055144,0.35037396285055145],[428.15222479093893,351.14422892833113,0.35114422892833114],[431.95562816921455,351.57049216692474,0.3515704921669247],[439.32485027387224,352.3797574310503,0.35237975743105027],[449.4154938516931,353.3498451063801,0.35334984510638007],[455.5144467055114,354.08482562176584,0.35408482562176585],[456.8629787053683,354.2225885082004,0.3542225885082004],[469.8397604305661,355.51652769136587,0.3555165276913659],[473.84089024758936,355.90436369076724,0.3559043636907672],[480.7122263821846,356.5587480361118,0.3565587480361118],[489.45148860261895,357.29585244701394,0.35729585244701395],[496.03279487715247,357.96725560323966,0.35796725560323966],[498.11188597664795,358.15103587069916,0.3581510358706992],[506.95908769967355,358.93167063023685,0.35893167063023684],[513.0727685316688,359.45762539134955,0.35945762539134957],[529.9555827047675,360.86181902861847,0.36086181902861847],[542.6010365515399,361.86787449483336,0.3618678744948334],[548.4530005742739,362.3245513601048,0.36232455136010483],[565.7986415412382,363.6302648486172,0.36363026484861716],[578.8402147095,364.57309980538736,0.3645730998053874],[591.1639657893531,365.4231987260391,0.3654231987260391],[611.2799888298447,366.78627468731054,0.36678627468731057],[616.1502356186747,367.103420981354,0.367103420981354],[624.0291038057319,367.6086501054641,0.3676086501054641],[636.1072582670299,368.3650136281446,0.3683650136281446],[651.3670177259457,369.2906025974403,0.3692906025974403],[662.8205453322574,369.96434536730476,0.36996434536730477],[675.0161279697448,370.6619880479052,0.3706619880479052],[684.9322425991477,371.21632597268194,0.37121632597268195],[700.5996050801692,372.06922736345985,0.3720692273634598],[709.9035549097041,372.561939151811,0.37256193915181096],[720.6818580042467,373.1207455505468,0.3731207455505468],[733.5168333493502,373.77009806839925,0.3737700980683992],[744.232616294066,374.2993251135625,0.37429932511356245],[765.700132850239,375.32624366143256,0.3753262436614326],[773.955382536367,375.7097062734066,0.3757097062734066],[783.9439773423439,376.1655556064044,0.37616555560640436],[791.2335501883314,376.49276720106525,0.3764927672010652],[798.3079537949442,376.80600897715874,0.37680600897715877],[807.5799531918994,377.21028012661685,0.37721028012661684],[818.601566114026,377.6818269288122,0.3776818269288122],[829.4014805172179,378.1346751013855,0.3781346751013855],[839.5885326055582,378.55371474493563,0.37855371474493565],[842.7031227542993,378.680287528643,0.378680287528643],[853.7321807744718,379.0620629253195,0.37906206292531947],[860.1126284460038,379.3749715356221,0.37937497153562205],[869.0698619691346,379.7240993012622,0.37972409930126216],[886.6412763968772,380.39324939152954,0.3803932493915295],[895.1615907124851,380.71044521229067,0.38071044521229064],[903.7195841461247,381.0244425089192,0.3810244425089192],[917.0714301494809,381.48812031803686,0.38148812031803686],[931.9999907084197,382.03020594471127,0.38203020594471127]],"real14":[[236.22933522810092,113.71584982560816,0.1137158498256081],[251.48616841896003,118.11460447394413,0.1181146044739441],[295.29662389568745,127.59606241673094,0.1275960624167309],[316.58187675715664,131.1380838562408,0.1311380838562408],[333.9887634031262,133.5347534316732,0.1335347534316732],[356.6688767771657,136.5502609612558,0.1365502609612557],[368.6767470965495,138.1310480800605,0.1381310480800605],[390.0262936022194,140.42647392872172,0.1404264739287217],[411.4113103098025,142.48048243094075,0.1424804824309407],[430.6270381646687,144.1138584241643,0.1441138584241643],[456.74253030297723,146.2596568749739,0.1462596568749739],[476.92095644953906,147.66080169886183,0.1476608016988618],[495.2092576803703,148.96722579785242,0.1489672257978524],[520.7878820428363,150.5340338539024,0.1505340338539024]],"orcF":[[229.2,111.4078782055299],[252,118.2534190511679],[277.20000000000005,124.1571701563217],[304.79999999999995,129.2937950008808],[334.8,133.85774880512162],[367.19999999999993,137.963714059236],[402,141.5917894711356],[439.20000000000005,144.9115462022817],[478.79999999999995,147.9352606057486],[520.8,150.6562804346043]],"stF":[[196,297.41953737414],[236,314.8362816848922],[292,330.0462482598578],[372,344.0488694584044],[452,353.7228451814423],[612,366.83340337712576],[772,375.6194339607407],[932,382.0302062832699]],"monthly":[[0.63,43.98,43.98],[0.608,49.43,93.41],[0.584,43.94,137.35],[0.542,55.17,192.51],[0.524,52.69,245.21],[0.532,50.09,295.3],[0.529,47.96,343.26],[0.529,46.9,390.17],[0.573,44.89,435.06],[0.622,45.25,480.3],[0.627,46.4,526.7],[0.636,46.44,573.14]],"mcHist":{"lo":504,"hi":661.5,"n":40,"counts":[4,1,7,9,10,17,38,46,53,109,126,173,222,234,284,312,325,370,395,340,320,331,266,252,178,151,117,94,78,48,36,22,11,4,9,4,1,2,0,1]},"mcN":5000,"mcP5":541.8,"mcP50":576.4,"mcP95":612.4,"conds":[["钢铁-高炉煤气锅炉排烟","钢铁","高炉煤气锅炉排烟",260,80,"平稳波动",20,1,8000,"工艺蒸汽","连续","工程示例（示意）","高炉煤气锅炉余热回收典型工况"],["钢铁-烧结环冷机烟气","钢铁","烧结环冷机烟气",160,164.5,"班次阶跃",25,1,8000,"发电","连续","\"公开案例（Feng等","2024）\""],["钢铁-高炉渣显热","钢铁","高炉渣（高温粒化）",900,20,"随机游走",80,1,8000,"工艺蒸汽","间歇","工程示例（示意）","高温余热，蒸汽朗肯候选"],["水泥-窑尾废气","水泥","窑尾预热器废气",350,60,"平稳波动",30,1,8000,"发电","连续","工程示例（示意）","中温余热发电典型工况"],["水泥-篦冷机中低温废气","水泥","篦冷机废气",250,90,"班次阶跃",20,0.8,8000,"工艺蒸汽","连续","工程示例（示意）","中低温废气余热"],["玻璃-池窑烟气","玻璃","池窑烟气",450,40,"平稳波动",40,1,8000,"发电","连续","工程示例（示意）","玻璃窑炉高温烟气"],["玻璃-退火窑废气","玻璃","退火窑废气",200,30,"平稳波动",15,1,8000,"供暖/热水","连续","工程示例（示意）","中低温废气供热"],["化工-炼油塔底油余热","化工","常减压塔底油",140,100,"平稳波动",10,1,8000,"发电","连续","\"公开案例（国家发改委","2020）\""],["化工-反应器出口余热","化工","反应器出口物料",250,80,"班次阶跃",30,1,8000,"工艺蒸汽","连续","工程示例（示意）","化工过程余热回收"],["化工-裂解炉烟气","化工","裂解炉烟气",380,70,"平稳波动",35,1.2,8000,"发电","连续","工程示例（示意）","乙烯裂解炉烟气余热"],["有色-冶炼烟气","有色","冶炼炉烟气",700,30,"随机游走",60,1,8000,"发电","间歇","工程示例（示意）","高温烟气，蒸汽朗肯候选"],["热电-燃气轮机排气","热电","燃机排气",450,90,"平稳波动",25,1,8000,"工艺蒸汽","连续","工程示例（示意）","联合循环余热锅炉前烟气"],["热电-锅炉排烟","热电","燃煤锅炉排烟",150,120,"平稳波动",15,1,8000,"供暖/热水","连续","工程示例（示意）","锅炉尾部烟气低温余热"],["数据中心-冷却水回水","数据中心","IT冷却水回水",70,150,"班次阶跃",8,1,8000,"供暖/热水","连续","\"公开案例（ORNL","2024）\""],["造纸-烘干废气","轻工","造纸烘干废气",110,60,"班次阶跃",12,1,8000,"供暖/热水","连续","工程示例（示意）","低温余热，压缩式热泵候选"],["储热调峰-高温熔盐","储能","电加热熔盐（谷电充热）",380,40,"班次阶跃",50,1,6000,"储热调峰","间歇","工程示例（示意）","谷电储热-峰时放热场景"],["钢铁-高炉冲渣水余热制冷（供冷）","钢铁","高炉冲渣水",80,20,"平稳波动",5,1,8000,"供冷（制冷）","连续","\"公开案例（首钢股份能源部","2026-06）· 输入示意\""],["热电-锅炉排烟余热干燥（干燥）","热电","锅炉排烟",150,40,"平稳波动",10,1,6000,"干燥/烘干","连续","工程示例（示意）","150℃ 排烟直接热风/产汽烘干典型（直接换热/余热锅炉产汽候选）"],["造纸-低温热水热泵烘干（干燥）","轻工","低温热水",65,30,"班次阶跃",8,1,6000,"干燥/烘干","连续","工程示例（示意）","65℃ 热水+压缩式热泵烘干（60~90℃ 提温，热泵烘干候选）"]],"wSub":[0.155273,0.155273,0.155273,0.13857,0.13857,0.080535,0.080535,0.09597],"wObj":[0.098364,0.126164,0.103418,0.125538,0.140059,0.13171,0.158114,0.116634],"names":["系统能效","㶲效率","技术成熟度","初始投资","投资回收期","CO2当量减排","生命周期GWP降幅","政策补贴适配度"],"meta":{"names":["系统能效","㶲效率","技术成熟度","初始投资","投资回收期","CO2当量减排","生命周期GWP降幅","政策补贴适配度"],"sub":[0.155273,0.155273,0.155273,0.13857,0.13857,0.080535,0.080535,0.09597],"obj":[0.098364,0.126164,0.103418,0.125538,0.140059,0.13171,0.158114,0.116634]},"lam0":0.5};


const eng = window.WHENG;
const D = window.HFDATA;
const IO = window.WHIO;
eng.setTables(D);

const DEMAND_MAP = IO.DEMAND_MAP;
const MEDIUM_MAP = IO.MEDIUM_MAP;
const REV_DEMAND = IO.REV_DEMAND;
const ICONS = {
  orc: "⚡", steam_pp: "⚡", teg: "⚡", direct: "♨", whb_steam: "♨",
  abs_self: "♨", abs_ext: "♨", comp: "♨", tc_storage: "▦", pcm_storage: "▦",
  abs_cool: "❄", comp_cool: "❄"
};

const $ = (id) => document.getElementById(id);
const num = (x, d = 0) => (x === null || x === undefined || isNaN(x)) ? "—" :
  Number(x).toLocaleString("zh-CN", { maximumFractionDigits: d });

let state = {
  t: 120, f: 50, medium: "热水/冷凝水", dT: 10, hours: 8000,
  demand: "发电", cont: "连续", drv: "余热自驱动", lam: 0.5
};

function readInputs() {
  state.t = +$("in-t").value; state.f = +$("in-f").value;
  state.medium = $("medium").value; state.dT = +$("in-dt").value;
  state.hours = +$("in-h").value; state.demand = $("demand").value;
  state.lam = +$("in-lam").value;
  $("v-t").textContent = state.t + " ℃"; $("v-f").textContent = state.f + " kg/s";
  $("v-dt").textContent = state.dT + " ℃"; $("v-h").textContent = state.hours + " h";
  $("v-lam").textContent = state.lam.toFixed(2);
}

function buildScene(t, f, medium, dT, hours, demand, cont, drv) {
  return {
    "需求": DEMAND_MAP[demand],
    "热源温度_degC": t, "载体": MEDIUM_MAP[medium], "流量_kg_s": f,
    "换热端差_degC": dT, "年运行小时": hours, "连续性": cont, "驱动来源": drv
  };
}

function currentScene() {
  return buildScene(state.t, state.f, state.medium, state.dT, state.hours,
    state.demand, state.cont, state.drv);
}

/* ---------------- 渲染 ---------------- */
function renderStage(validScene, res) {
  const st = eng.stage1(validScene);
  const rows = eng.PATH_KEYS.map((p) =>
    `<tr><td>${eng.DISPLAY[p]}</td><td class="${st.keep[p] ? "ok" : "no"}">${st.keep[p] ? "✓ 通过" : "✗ 排除"}</td><td>${st.reasons[p] || ""}</td></tr>`).join("");
  $("t-stage").innerHTML = "<tr><th>路径</th><th>结果</th><th>原因</th></tr>" + rows;
  if (res && !res.out_of_scope) {
    $("calc-note").textContent = `当前工况：${validScene["热源温度_degC"]}℃ · ${validScene["流量_kg_s"]} kg/s · ${REV_DEMAND[validScene["需求"]]} · 驱动=${validScene["驱动来源"]} · λ=${state.lam.toFixed(2)}；进入第二级候选：${res.labels.join("、") || "无"}`;
  }
}

function renderTopsis(res) {
  if (res.out_of_scope || !res.order) {
    $("t-topsis").innerHTML = "";
    $("ch-lam").innerHTML = "";
    $("lam-snap").textContent = "—";
    return;
  }
  const head = "<tr><th>排名</th><th>路径</th>" + eng.INDICATORS.map((h) => `<th>${h}</th>`).join("") +
    "<th>TOPSIS 贴近度</th></tr>";
  const body = res.order.map((o, i) =>
    `<tr class="${i === 0 ? "best" : ""}"><td>${i + 1}</td><td>${eng.DISPLAY[o.path]}</td>` +
    o.row.map((v, j) => {
      if (j === 3) return `<td>${v > 0 ? num(v, 1) : "—"}</td>`;
      if (j === 1 || j === 2) return `<td>${num(v, 2)}</td>`;
      if (j === 5) return `<td>${num(v, 1)}</td>`;
      return `<td>${num(v, 2)}</td>`;
    }).join("") + `<td>${o.closeness.toFixed(4)}</td></tr>`).join("");
  $("t-topsis").innerHTML = head + body;
  drawLam(res);
}

function drawLam(res) {
  const top5 = res.order.slice(0, 5);
  const names = top5.map((o) => eng.DISPLAY[o.path]);
  const X5 = top5.map((o) => o.row);
  const lines = [];
  for (let l = 0; l <= 1.0001; l += 0.05) {
    const w = eng.combinedWeights(l, X5, D.meta);
    lines.push({ l, c: eng.topsis(X5, w) });
  }
  const W = 780, H = 270, padL = 50, padB = 34, padT = 18, padR = 160;
  const X = (l) => padL + l * (W - padL - padR);
  const Y = (v) => H - padB - v * (H - padB - padT);
  const cols = ["#0E9F8A", "#3D6FB4", "#E8A33D", "#8A6BB8", "#E05252"];
  let s = `<line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="#C9D6E2"/>` +
    `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}" stroke="#C9D6E2"/>`;
  for (let k = 0; k < names.length; k++) {
    const pts = lines.map((row) => `${X(row.l).toFixed(1)},${Y(row.c[k]).toFixed(1)}`).join(" ");
    s += `<polyline points="${pts}" fill="none" stroke="${cols[k % 5]}" stroke-width="2.5"/>`;
    s += `<text x="${W - padR + 8}" y="${(Y(lines[lines.length - 1].c[k]) + 4).toFixed(1)}" font-size="12" fill="${cols[k % 5]}">${names[k]}</text>`;
  }
  for (let l = 0; l <= 1; l += 0.25) s += `<text x="${X(l)}" y="${H - 10}" text-anchor="middle" font-size="11" fill="#8AA0B4">λ=${l.toFixed(2)}</text>`;
  s += `<text x="${padL + 6}" y="${padT + 12}" font-size="11" fill="#8AA0B4">TOPSIS 贴近度</text>`;
  $("ch-lam").innerHTML = s;
  const snap = res.order.slice(0, 3).map((o) => `${eng.DISPLAY[o.path]}(${o.closeness.toFixed(3)})`).join(" ＞ ");
  $("lam-snap").textContent = `排序快照（λ=${state.lam.toFixed(2)}）：${snap}；拖动 λ 观察前几名排序变化。`;
}

function statCard(htmlId, key, val, unit) {
  $(htmlId + "-k").textContent = key;
  $(htmlId + "-v").textContent = val;
  $(htmlId + "-u").textContent = unit;
}

function renderTop(res) {
  const box = $("boundary-box"), scope = $("scope-box");
  box.innerHTML = ""; scope.innerHTML = "";
  if (res.out_of_scope || !res.top) {
    $("r-name").textContent = "—"; $("r-sub").textContent = "—";
    $("r-fit").textContent = "—"; $("r-icon").textContent = "?";
    ["s1", "s2"].forEach((k) => statCard(k, "—", "—", ""));
    $("s-co2").textContent = "—"; $("s-money").textContent = "—";
    if (res.message) scope.innerHTML = `<div class="warn">⚠ ${res.message}</div>`;
    return;
  }
  const top = res.top;
  const t = state.t, f = state.f, med = state.medium, hours = state.hours, dT = state.dT;
  const medCore = MEDIUM_MAP[med];
  let sub = "", icon = ICONS[top] || "•";
  let s1k = "可回收热功率", s1v = "—", s1u = "kW", s2k = "年发电量", s2v = "—", s2u = "MWh/年", co2 = 0, money = 0;
  if (top === "orc") {
    const d = eng.orcDetail(t, f, medCore, hours, dT);
    s1v = num(d.q, 0); s2v = num(d.mwh, 0); co2 = d.co2; money = d.money;
    sub = `ORC 净功率 P50 ${num(d.p50, 1)} kW/MW热（P10 ${num(d.p10, 1)}~P90 ${num(d.p90, 1)}，${num(d.n, 0)} 工况）· 实际回收 ${num(d.q, 0)} kW`;
  } else if (top === "steam_pp") {
    const d = eng.steamDetail(t, f, medCore, hours, dT);
    s1v = num(d.q, 0); s2v = num(d.mwh, 0); co2 = d.co2; money = d.money;
    sub = `蒸汽朗肯净功率 ${num(d.p50, 1)} kW/MW热 · 实际回收 ${num(d.q, 0)} kW`;
  } else if (top === "teg") {
    const q = eng.recoveredHeatKw(currentScene());
    s1v = num(q, 0); co2 = 0; money = 0; s2v = "—";
    sub = "TEG 温差发电兜底候选：未做发电细账（转换效率低，仅低品位备选）";
  } else if (top === "comp") {
    const d = eng.heatDetail(f, medCore, t, hours, dT, eng.HP_COP);
    s1v = num(d.q, 0); s2v = num(d.heatGj / 3.6, 0); s2u = "MWh 热/年"; co2 = d.co2; money = d.money;
    sub = `热泵提温 COP ${eng.HP_COP} · 替代天然气并扣除自身耗电（一次能源效率 ≈106%）`;
  } else if (top === "abs_cool") {
    const cop = eng.absCoolCop(t) || eng.COP_C_ABS;
    const q = eng.recoveredHeatKw(currentScene());
    const qCold = cop * q;
    const avoidedMwh = qCold / eng.COP_E_COOL * hours / 1000;
    co2 = avoidedMwh * eng.GRID_EF; money = avoidedMwh * 1000 * eng.ELEC_PRICE / 10000;
    s1v = num(q, 0); s2k = "服务冷量"; s2v = num(qCold, 0); s2u = "kW 冷";
    sub = `吸收式制冷 COP_c=${cop}（${t >= 85 ? "≥85℃ 0.7" : "80~84℃ 0.6"}）· 替代电压缩电耗 COP_e=${eng.COP_E_COOL}`;
    icon = "❄";
  } else if (top === "comp_cool") {
    s1v = "—"; s2v = "—"; s2u = ""; co2 = 0; money = 0;
    sub = "电压缩制冷为电制冷现状基准（减排记 0，与现状同口径）——本页不把它当作废热回收成果";
  } else {
    const isSteamNeed = state.demand === "工艺蒸汽";
    const d = eng.heatDetail(f, medCore, t, hours, dT, null);
    s1v = num(d.q, 0); s2v = num(d.heatGj / 3.6, 0); s2u = "MWh 热/年"; co2 = d.co2; money = d.money;
    if (top === "abs_self") {
      const cop = isSteamNeed ? 0.45 : 1.7;
      sub = `吸收式热泵 COP_h=${cop}（${isSteamNeed ? "二类制蒸汽 0.45" : "一类增热 1.7"}）· 替代天然气口径`;
    } else if (top === "abs_ext") {
      sub = "外购蒸汽驱动吸收式（哈石化余热暖民同型，COP_h≈1.7）· 已扣驱动蒸汽燃料";
    } else if (top === "direct") sub = "直接换热 · 替代天然气锅炉口径（0.0561 tCO₂/GJ ÷ 90%）";
    else if (top === "whb_steam") sub = "余热锅炉直接产汽 · 替代天然气锅炉口径";
    else sub = "储热路径 · 时空解耦（热量按替代天然气口径）";
  }
  $("r-name").textContent = eng.DISPLAY[top];
  $("r-sub").textContent = sub;
  $("r-fit").textContent = res.order[0].closeness.toFixed(3);
  $("r-icon").textContent = icon;
  statCard("s1", s1k, s1v, s1u); statCard("s2", s2k, s2v, s2u);
  $("s-co2").textContent = num(co2, 1);
  $("s-money").textContent = num(money, 1);
  eng.boundaryNotices(res).forEach((n) => {
    box.innerHTML += `<div class="warn boundary">${n}</div>`;
  });
  (res.warnings || []).forEach((w) => { scope.innerHTML += `<div class="warn">⚠ ${w}</div>`; });
}

function calc() {
  readInputs();
  const scene = currentScene();
  const v = eng.validateScene(scene);
  const scope = $("scope-box");
  scope.innerHTML = "";
  if (!v.ok) {
    renderStage(scene, null);
    renderTop({ out_of_scope: true, message: v.error });
    renderTopsis({ out_of_scope: true });
    return;
  }
  const res = eng.runDecision(v.scene, state.lam, D.meta);
  renderStage(v.scene, res);
  renderTop(res);
  renderTopsis(res);
}

/* ---------------- 实时数据接入（io.js 驱动） ---------------- */
function mediumFromType(type) {
  const s = type || "";
  if (/烟气|排烟|废气/.test(s)) return "烟气";
  if (/渣|熔盐|工艺液/.test(s)) return "工艺液体";
  return "热水/冷凝水";
}

const DEMAND_OPT_HTML = ["发电", "工艺蒸汽", "供暖/热水", "储热调峰", "供冷（制冷）", "干燥/烘干"]
  .map((d) => `<option>${d}</option>`).join("");

const rtLive = {
  kind: "sim", source: null, fileSrc: null, frame: null,
  hist: [], lastTs: 0, base: 120, ageTimer: null
};

function ioDefaults() {
  return {
    t_base: state.t, f_base: state.f, medium: state.medium, demand: state.demand,
    continuity: state.cont, driver: state.drv, dT: state.dT, hours: state.hours
  };
}

function ioRenderCfg() {
  const kind = $("io-kind").value;
  rtLive.kind = kind;
  const box = $("io-cfg");
  const d = ioDefaults();
  let h = "";
  if (kind === "sim") {
    h = `<div class="field"><label>热源基准温度 <b id="v-sim-t">${d.t_base} ℃</b></label>
      <input type="range" id="sim-t" min="25" max="900" step="5" value="${d.t_base}"></div>
      <div class="field"><label>波动幅度 <b id="v-sim-amp">20 ℃</b></label>
      <input type="range" id="sim-amp" min="0" max="120" step="5" value="20"></div>
      <div class="field"><label>波动波形</label>
      <select id="sim-wave"><option>正弦</option><option>阶跃</option><option>随机</option></select></div>
      <div class="field"><label>流量基准 <b id="v-sim-f">${d.f_base} kg/s</b></label>
      <input type="range" id="sim-f" min="0.5" max="200" step="0.5" value="${d.f_base}"></div>
      <div class="field"><label>用能需求</label><select id="sim-demand">${DEMAND_OPT_HTML}</select></div>`;
  } else if (kind === "file") {
    h = `<div class="field"><label>选择历史文件</label><input type="file" id="io-file" accept=".csv,.json"></div>
      <div class="field"><label>回放默认需求</label><select id="file-demand">${DEMAND_OPT_HTML}</select></div>
      <div class="field"><label>回放默认介质</label>
      <select id="file-medium"><option>热水/冷凝水</option><option>烟气</option><option>工艺液体</option></select></div>
      <div class="note">CSV 模板：ts,t_src_degC,m_dot_kg_s[,medium,demand,continuity,driver,dT_degC,hours]；缺失列用默认值补全；按真实时间戳回放。</div>`;
  } else if (kind === "http") {
    const host = location.hostname || "127.0.0.1";
    h = `<div class="field"><label>HTTP 地址</label>
      <input id="http-url" placeholder="http://127.0.0.1:8791/api/telemetry" value="http://${host}:8791/api/telemetry"></div>
      <div class="field"><label>轮询间隔 <b id="v-http-iv">2000 ms</b></label>
      <input type="range" id="http-iv" min="200" max="10000" step="100" value="2000"></div>`;
  } else {
    const host = location.hostname || "127.0.0.1";
    h = `<div class="field"><label>WebSocket 地址</label>
      <input id="ws-url" placeholder="ws://127.0.0.1:8787/ws" value="ws://${host}:8787/ws"></div>`;
  }
  box.innerHTML = h;
  ["sim-t", "sim-amp", "sim-f", "http-iv"].forEach((id) => {
    const el = $(id);
    if (el) {
      const lbl = { "sim-t": "v-sim-t", "sim-amp": "v-sim-amp", "sim-f": "v-sim-f", "http-iv": "v-http-iv" }[id];
      el.addEventListener("input", () => { $(lbl).textContent = el.value + (id === "http-iv" ? " ms" : (id === "sim-amp" ? " ℃" : (id === "sim-t" ? " ℃" : " kg/s"))); });
    }
  });
}

function ioStateText(st) {
  const map = { idle: "未连接", connecting: "连接中…", live: "已连接", error: "错误", stale: "数据过期" };
  return map[st.state] || st.state;
}
function ioStateColor(st) {
  return { idle: "#64748B", connecting: "#3D6FB4", live: "#0E9F8A", error: "#E05252", stale: "#B57A1E" }[st.state] || "#64748B";
}

function ioAgeTick() {
  const st = rtLive.source ? rtLive.source.status() : { state: "idle" };
  $("io-state").textContent = ioStateText(st);
  $("io-state").style.color = ioStateColor(st);
  $("io-detail").textContent = st.detail || (rtLive.kind === "file" ? "文件回放中" : "");
  const warnBox = $("io-warn");
  warnBox.innerHTML = "";
  if (st.state === "error" || st.state === "stale") {
    warnBox.innerHTML = `<div class="warn">⚠ ${st.detail || "数据连接异常"}：当前结果仅参考，请检查数据源/地址。</div>`;
  }
  if (rtLive.frame) {
    const age = Math.round((Date.now() - rtLive.lastTs) / 1000);
    $("io-age-note").innerHTML = `距上帧 <b>${age}</b> 秒 · 质量 <b>${rtLive.frame.quality}</b>` +
      (rtLive.frame.error ? ` · ${rtLive.frame.error}` : "");
    if (age > 5) warnBox.innerHTML += `<div class="warn">⚠ 数据 ${age} 秒未更新，当前结果仅参考。</div>`;
    if (rtLive.frame.quality === "over_range") {
      warnBox.innerHTML += `<div class="warn">⚠ 当前帧温度越界（${rtLive.frame.t_src_degC}℃），引擎将按能力圈外处理。</div>`;
    }
  }
}

function onIoFrame(f) {
  rtLive.frame = f;
  rtLive.lastTs = Date.now();
  rtLive.hist = rtLive.hist.slice(-59).concat([f.t_src_degC]);
  if (rtLive.base === 120 && rtLive.hist.length === 1) rtLive.base = f.t_src_degC;
  drawRtChart();
  renderRtFrame(f);
  ioAgeTick();
}

function ioConnect() {
  ioDisconnect();
  const kind = rtLive.kind;
  const d = ioDefaults();
  const warnBox = $("io-warn");
  warnBox.innerHTML = "";
  let src = null;
  if (kind === "sim") {
    src = new IO.SimSource({
      t_base: +$("sim-t").value, t_amp: +$("sim-amp").value,
      t_wave: $("sim-wave").value, f_base: +$("sim-f").value, f_amp: 0,
      t_period_s: 60, medium: d.medium, demand: $("sim-demand").value,
      continuity: d.continuity, driver: d.driver, dT_degC: d.dT, hours: d.hours
    });
    rtLive.fileSrc = null;
    $("io-pause").style.display = "none"; $("io-step").style.display = "none";
  } else if (kind === "file") {
    const input = $("io-file");
    if (!input.files || !input.files.length) {
      warnBox.innerHTML = `<div class="warn">⚠ 请先选择 CSV/JSON 历史文件。</div>`;
      return;
    }
    src = new IO.FilePlaybackSource({
      defaults: { demand: $("file-demand").value, medium: $("file-medium").value,
        continuity: "连续", driver: "余热自驱动", dT_degC: d.dT, hours: d.hours }
    });
    src.connect(null, onIoFrame);
    src.loadFile(input.files[0]).then((n) => {
      rtLive.fileSrc = src;
      $("io-pause").style.display = "inline-block";
      $("io-step").style.display = "inline-block";
      src.play();
    }).catch((e) => {
      warnBox.innerHTML = `<div class="warn">⚠ 文件解析失败：${e.message}</div>`;
      ioDisconnect();
    });
    rtLive.source = src;
    ioAgeTick();
    return;
  } else if (kind === "http") {
    src = new IO.HttpPollSource({
      url: $("http-url").value.trim(), interval_ms: +$("http-iv").value,
      defaults: { demand: d.demand, medium: d.medium, continuity: d.continuity,
        driver: d.driver, dT_degC: d.dT, hours: d.hours }
    });
    $("io-pause").style.display = "none"; $("io-step").style.display = "none";
  } else {
    src = new IO.WsSource({ url: $("ws-url").value.trim() });
    $("io-pause").style.display = "none"; $("io-step").style.display = "none";
  }
  rtLive.source = src;
  rtLive.fileSrc = null;
  rtLive.lastTs = Date.now();
  src.connect(null, onIoFrame);
  ioAgeTick();
}

function ioDisconnect() {
  if (rtLive.source) { try { rtLive.source.disconnect(); } catch (e) {} }
  rtLive.source = null; rtLive.fileSrc = null;
  $("io-state").textContent = "未连接";
  $("io-state").style.color = "#64748B";
  $("io-pause").style.display = "none"; $("io-step").style.display = "none";
}

function drawRtChart() {
  const W = 900, H = 240, padL = 52, padB = 30, padT = 14, padR = 18;
  const hist = rtLive.hist.length ? rtLive.hist : [rtLive.base || 120];
  const all = hist.concat([rtLive.base || 120]);
  const tmin = Math.min.apply(null, all) - 3, tmax = Math.max.apply(null, all) + 3;
  const X = (i) => padL + (i / 59) * (W - padL - padR);
  const Y = (v) => H - padB - ((v - tmin) / (tmax - tmin)) * (H - padB - padT);
  let s = `<line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="#C9D6E2"/>` +
    `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}" stroke="#C9D6E2"/>`;
  if (hist.length > 1) {
    const pts = hist.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
    s += `<polyline points="${pts}" fill="none" stroke="#0E9F8A" stroke-width="2.5"/>`;
    const last = hist[hist.length - 1];
    s += `<circle cx="${X(hist.length - 1).toFixed(1)}" cy="${Y(last).toFixed(1)}" r="5" fill="#E05252"/>`;
    s += `<text x="${X(hist.length - 1) + 8}" y="${Y(last) - 8}" font-size="13" font-weight="800" fill="#E05252">${Number(last).toFixed(1)}℃</text>`;
  }
  for (let k = 0; k <= 4; k++) {
    const v = tmin + (k / 4) * (tmax - tmin);
    s += `<text x="${padL - 8}" y="${Y(v) + 4}" text-anchor="end" font-size="10.5" fill="#8AA0B4">${Math.round(v)}</text>`;
  }
  s += `<text x="${padL + 10}" y="${padT + 12}" font-size="11" fill="#8AA0B4">热源温度（℃）· 最近 ${hist.length} 帧</text>`;
  $("rt-chart").innerHTML = s;
  const f = rtLive.frame;
  $("rt-legend").textContent = f
    ? `数据源：${$("io-kind").selectedOptions[0].textContent} · 当前 ${Number(f.t_src_degC).toFixed(1)}℃ / ${f.m_dot_kg_s} kg/s · ${f.demand} · ${f.medium}`
    : "—";
}

function renderRtFrame(f) {
  const scene = IO.frameToScene(f);
  const box = $("rt-boundary");
  box.innerHTML = "";
  const v = eng.validateScene(scene);
  $("rt-t").textContent = Number(f.t_src_degC).toFixed(1);
  $("rt-out").textContent = "—"; $("rt-co2").textContent = "—";
  $("rt-sub").textContent = ""; $("rt-rank").innerHTML = "";
  $("rt-warn").textContent = "—";
  if (f.quality === "invalid") {
    $("rt-name").textContent = "数据无效";
    $("rt-sub").textContent = f.error || "帧缺温度或流量/规模";
    $("rt-fit").textContent = "—"; $("rt-icon").textContent = "?";
    return;
  }
  if (!v.ok) {
    $("rt-name").textContent = "能力圈外";
    $("rt-sub").textContent = v.error;
    $("rt-fit").textContent = "—"; $("rt-icon").textContent = "?";
    box.innerHTML = `<div class="warn">⚠ ${v.error}</div>`;
    return;
  }
  const res = eng.runDecision(v.scene, state.lam, D.meta);
  const top = res.top;
  $("rt-icon").textContent = top ? (ICONS[top] || "•") : "?";
  $("rt-name").textContent = top ? eng.DISPLAY[top] : "无可行候选";
  $("rt-fit").textContent = res.order && res.order.length ? res.order[0].closeness.toFixed(3) : "—";
  const t = Number(f.t_src_degC), m = Number(f.m_dot_kg_s), hours = f.hours, dT = f.dT_degC;
  const medium = f.medium;
  if (top === "orc") {
    const dd = eng.orcDetail(t, m, MEDIUM_MAP[medium], hours, dT);
    $("rt-out").textContent = num(dd.mwh, 0); $("rt-out-u").textContent = "MWh/年";
    $("rt-co2").textContent = num(dd.co2, 1);
    $("rt-sub").textContent = `ORC P50 ${num(dd.p50, 1)} kW/MW热 · 回收 ${num(dd.q, 0)} kW`;
  } else if (top === "steam_pp") {
    const dd = eng.steamDetail(t, m, MEDIUM_MAP[medium], hours, dT);
    $("rt-out").textContent = num(dd.mwh, 0); $("rt-out-u").textContent = "MWh/年";
    $("rt-co2").textContent = num(dd.co2, 1);
    $("rt-sub").textContent = `蒸汽朗肯 P50 ${num(dd.p50, 1)} kW/MW热`;
  } else if (top === "abs_cool") {
    const cop = eng.absCoolCop(t) || eng.COP_C_ABS;
    const q = eng.recoveredHeatKw(v.scene);
    $("rt-out").textContent = num(cop * q, 0); $("rt-out-u").textContent = "kW 冷";
    $("rt-co2").textContent = num(cop * q / eng.COP_E_COOL * hours / 1000 * eng.GRID_EF, 1);
    $("rt-sub").textContent = `吸收式制冷 COP_c=${cop} · 替代电压缩电耗`;
  } else if (top === "comp_cool") {
    $("rt-out").textContent = "—"; $("rt-out-u").textContent = "";
    $("rt-co2").textContent = "0";
    $("rt-sub").textContent = "电压缩制冷为电制冷现状基准（减排记 0）";
  } else if (top === "teg") {
    const q = eng.recoveredHeatKw(v.scene);
    $("rt-out").textContent = num(q, 0); $("rt-out-u").textContent = "kW 回收热";
    $("rt-co2").textContent = "0";
    $("rt-sub").textContent = "TEG 温差发电兜底候选（未做发电细账）";
  } else {
    const dd = eng.heatDetail(m, MEDIUM_MAP[medium], t, hours, dT, top === "comp" ? eng.HP_COP : null);
    $("rt-out").textContent = num(dd.heatGj / 3.6, 0); $("rt-out-u").textContent = "MWh 热/年";
    $("rt-co2").textContent = num(dd.co2, 1);
    $("rt-sub").textContent = top === "comp" ? "热泵提温 COP 2.8（扣耗电）" : "替代天然气口径";
  }
  const notes = eng.boundaryNotices(res);
  $("rt-warn").textContent = notes.length ? "见下方提示" : (res.out_of_scope ? "越界" : "无");
  $("rt-warn").style.color = notes.length ? "#B57A1E" : "#0E9F8A";
  notes.forEach((n) => { box.innerHTML += `<div class="warn boundary">${n}</div>`; });
  (res.warnings || []).forEach((w) => { box.innerHTML += `<div class="warn">⚠ ${w}</div>`; });
  if (res.order) {
    const head = "<tr><th>#</th><th>路径</th><th>贴近度</th><th>能效%</th><th>CO₂减排 t/年</th></tr>";
    const body = res.order.slice(0, 5).map((o, i) =>
      `<tr class="${i === 0 ? "best" : ""}"><td>${i + 1}</td><td>${eng.DISPLAY[o.path]}</td>` +
      `<td>${o.closeness.toFixed(3)}</td><td>${num(o.row[0], 2)}</td><td>${o.row[3] > 0 ? num(o.row[3], 1) : "—"}</td></tr>`).join("");
    $("rt-rank").innerHTML = head + body;
  }
}

/* ---------------- 帕累托前沿 ---------------- */
function svgPareto(el, points, line, extra, xlab, ylab, cur) {
  const W = 900, H = 430, padL = 66, padB = 46, padT = 18, padR = 20;
  const ptsAll = points.concat(line || []).concat(extra || []).concat(cur ? [cur] : []);
  let xmax = Math.max.apply(null, ptsAll.map((p) => p[0])) * 1.08 || 1;
  let ymax = Math.max.apply(null, ptsAll.map((p) => p[1])) * 1.08 || 1;
  const X = (x) => padL + x / xmax * (W - padL - padR);
  const Y = (y) => H - padB - y / ymax * (H - padB - padT);
  const eff = (p) => Math.min(1, Math.max(0, (p[2] - 0.09) / 0.07));
  const col = (p) => eff(p) > 0.66 ? "#E8A33D" : eff(p) > 0.33 ? "#0E9F8A" : "#6FA8DC";
  let s = `<line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="#C9D6E2"/>` +
    `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}" stroke="#C9D6E2"/>`;
  s += `<text x="${padL + (W - padL - padR) / 2}" y="${H - 8}" text-anchor="middle" font-size="13" fill="#8AA0B4">${xlab}</text>`;
  s += `<text x="15" y="${padT + (H - padB - padT) / 2}" text-anchor="middle" font-size="13" fill="#8AA0B4" transform="rotate(-90 15 ${padT + (H - padB - padT) / 2})">${ylab}</text>`;
  for (let k = 0; k <= 4; k++) {
    const t = k / 4;
    s += `<text x="${X(t * xmax)}" y="${H - padB + 20}" text-anchor="middle" font-size="11" fill="#8AA0B4">${Math.round(t * xmax)}</text>` +
      `<text x="${padL - 8}" y="${Y(t * ymax) + 4}" text-anchor="end" font-size="11" fill="#8AA0B4">${Math.round(t * ymax)}</text>`;
  }
  if (line) s += `<polyline points="${line.map((p) => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(" ")}" fill="none" stroke="#0E9F8A" stroke-width="3.2"/>`;
  points.forEach((p) => { s += `<circle cx="${X(p[0]).toFixed(1)}" cy="${Y(p[1]).toFixed(1)}" r="3.4" fill="${col(p)}" opacity="0.8"/>`; });
  (extra || []).forEach((p) => { s += `<circle cx="${X(p[0]).toFixed(1)}" cy="${Y(p[1]).toFixed(1)}" r="4.8" fill="#3D6FB4" stroke="#fff" stroke-width="1.2"/>`; });
  if (cur) s += `<circle cx="${X(cur[0]).toFixed(1)}" cy="${Y(cur[1]).toFixed(1)}" r="7" fill="#E05252" stroke="#fff" stroke-width="2"/>`;
  el.innerHTML = s;
}

function currentPerMW() {
  readInputs();
  const med = MEDIUM_MAP[state.medium];
  const scene = buildScene(state.t, state.f, state.medium, state.dT, 8000, state.demand, state.cont, state.drv);
  let orc = null, steam = null;
  if (state.t >= 110 && state.t <= 350) {
    const o = eng.orcDetail(state.t, state.f, MEDIUM_MAP[state.medium], 8000, state.dT);
    if (o) orc = [o.money, o.p50];
  }
  if (state.t >= 280 && state.t <= 650) {
    const st = eng.steamDetail(state.t, state.f, MEDIUM_MAP[state.medium], 8000, state.dT);
    if (st) steam = [st.money, st.p50];
  }
  return { orc, steam };
}

function drawParetoTabs() {
  const cur = currentPerMW();
  svgPareto($("ch-orc"), D.pymoo, D.orcF, D.real14, "设备成本代理（万元）", "净功率（kW/MW 回收热）", cur.orc);
  const co2Pts = D.orcF.map((p) => [p[0], p[1] * 8000 * eng.GRID_EF / 1000]);
  const co2Real = D.real14.map((p) => [p[0], p[1] * 8000 * eng.GRID_EF / 1000]);
  svgPareto($("ch-co2"), co2Real, co2Pts, null, "设备成本代理（万元）", "年碳减排（tCO₂）",
    cur.orc ? [cur.orc[0], cur.orc[1] * 8000 * eng.GRID_EF / 1000] : null);
  svgPareto($("ch-steam"), D.steam, D.stF, null, "设备成本代理（万元）", "净功率（kW/MW 回收热）", cur.steam);
}

/* ---------------- 动态 LCA ---------------- */
function drawLca() {
  const W = 900, H = 430, padL = 60, padB = 46, padT = 18, padR = 18;
  const maxCum = Math.max.apply(null, D.monthly.map((r) => r[2]));
  const maxM = Math.max.apply(null, D.monthly.map((r) => r[1]));
  const bw = (W - padL - padR) / 12;
  const X = (i) => padL + i * bw + bw * 0.22;
  const Y = (v) => H - padB - v / maxM * (H - padB - padT);
  let s = `<line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="#C9D6E2"/>` +
    `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}" stroke="#C9D6E2"/>`;
  D.monthly.forEach((r, i) => {
    const h = r[1] / maxM * (H - padB - padT);
    s += `<rect x="${X(i).toFixed(1)}" y="${(H - padB - h).toFixed(1)}" width="${(bw * 0.56).toFixed(1)}" height="${h.toFixed(1)}" rx="5" fill="#0E9F8A" opacity="0.92"/>`;
    s += `<text x="${(X(i) + bw * 0.28).toFixed(1)}" y="${H - padB + 20}" text-anchor="middle" font-size="11" fill="#8AA0B4">${i + 1}月</text>`;
    s += `<text x="${(X(i) + bw * 0.28).toFixed(1)}" y="${(H - padB - h - 6).toFixed(1)}" text-anchor="middle" font-size="10" fill="#5E7387">${r[1].toFixed(1)}</text>`;
  });
  const cumPts = D.monthly.map((r, i) => `${(X(i) + bw * 0.28).toFixed(1)},${(H - padB - r[2] / maxCum * 280).toFixed(1)}`).join(" ");
  s += `<polyline points="${cumPts}" fill="none" stroke="#E8A33D" stroke-width="3"/>`;
  s += `<text x="${padL + 8}" y="${padT + 14}" font-size="12" fill="#8AA0B4">月度降碳（tCO₂）· 金线 = 全年累计</text>`;
  s += `<text x="${W - padR}" y="${H - 8}" text-anchor="end" font-size="12" fill="#B57A1E">年累计 ${num(D.monthly[11][2], 1)} tCO₂</text>`;
  $("ch-lca").innerHTML = s;

  const W2 = 900, H2 = 360, padL2 = 64, padB2 = 42, padT2 = 18, padR2 = 18;
  const maxC = Math.max.apply(null, D.mcHist.counts);
  const bw2 = (W2 - padL2 - padR2) / D.mcHist.n;
  let t = "";
  D.mcHist.counts.forEach((c, i) => {
    const h = c / maxC * (H2 - padB2 - padT2);
    t += `<rect x="${(padL2 + i * bw2 + bw2 * 0.12).toFixed(1)}" y="${(H2 - padB2 - h).toFixed(1)}" width="${(bw2 * 0.76).toFixed(1)}" height="${h.toFixed(1)}" fill="#6FA8DC" opacity="0.88"/>`;
  });
  const px = (v) => padL2 + (v - D.mcHist.lo) / (D.mcHist.hi - D.mcHist.lo) * (W2 - padL2 - padR2);
  [[D.mcP5, "#E05252"], [D.mcP50, "#E8A33D"], [D.mcP95, "#E05252"]].forEach(([v, c]) => {
    t += `<line x1="${px(v).toFixed(1)}" y1="${padT2}" x2="${px(v).toFixed(1)}" y2="${H2 - padB2}" stroke="${c}" stroke-width="2" stroke-dasharray="5 4"/>`;
  });
  t += `<text x="${px(D.mcP5).toFixed(1)}" y="${padT2 + 12}" text-anchor="middle" font-size="11" fill="#E05252">P5 ${D.mcP5}</text>`;
  t += `<text x="${px(D.mcP50).toFixed(1)}" y="${padT2 + 28}" text-anchor="middle" font-size="11" fill="#B57A1E">P50 ${D.mcP50}</text>`;
  t += `<text x="${px(D.mcP95).toFixed(1)}" y="${padT2 + 12}" text-anchor="middle" font-size="11" fill="#E05252">P95 ${D.mcP95}</text>`;
  t += `<text x="${padL2 + (W2 - padL2 - padR2) / 2}" y="${H2 - 8}" text-anchor="middle" font-size="12" fill="#8AA0B4">年降碳（tCO₂/年）· ${num(D.mcN, 0)} 次抽样</text>`;
  $("ch-mc").innerHTML = t;
  $("mc-note").textContent = `年降碳基准 ${D.mcP50} tCO₂/年，P5~P95 ≈ ${D.mcP5}~${D.mcP95} tCO₂/年（与申报口径一致）。`;
}

/* ---------------- 工况库 ---------------- */
function drawConds(filter) {
  const q = (filter || "").toLowerCase();
  const rows = D.conds.filter((r) => !q || r[0].toLowerCase().includes(q) || r[1].toLowerCase().includes(q) || r[2].toLowerCase().includes(q));
  $("t-conds").innerHTML = "<tr><th>工况名称</th><th>行业</th><th>热源类型</th><th>温度℃</th><th>流量kg/s</th><th>需求</th><th>连续性</th><th>数据来源</th></tr>" +
    rows.map((r, ri) => {
      const i = D.conds.indexOf(r);
      return `<tr class="cond-row" data-i="${i}"><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td>${r[3]}</td><td>${r[4]}</td><td>${r[9]}</td><td>${r[10]}</td><td>${r[11]}</td></tr>`;
    }).join("");
  document.querySelectorAll("#t-conds .cond-row").forEach((el) => {
    el.addEventListener("click", () => loadCond(+el.dataset.i));
  });
}

function applyCondToUi(r) {
  $("in-t").value = r[3]; $("in-f").value = r[4]; $("demand").value = r[9];
  $("in-h").value = r[8] || 8000;
  const med = mediumFromType(r[2]);
  $("medium").value = med;
  document.querySelectorAll(".chips .chip[data-c]").forEach((c) => c.classList.toggle("active", c.dataset.c === r[10]));
  document.querySelectorAll(".chips .chip[data-drv]").forEach((c) => c.classList.toggle("active", c.dataset.drv === "余热自驱动"));
}

function loadCond(i) {
  const r = D.conds[i];
  applyCondToUi(r);
  state.cont = r[10]; state.drv = "余热自驱动";
  $("preset").value = r[0];
  calc();
  switchTab("calc");
}

function fillPreset() {
  const name = $("preset").value;
  if (!name) return;
  const i = D.conds.findIndex((c) => c[0] === name);
  if (i >= 0) loadCond(i);
}

/* ---------------- 切换 / 绑定 / 初始化 ---------------- */
function switchTab(name) {
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll("section.tab").forEach((s) => s.classList.toggle("active", s.id === "tab-" + name));
  if (name === "pareto") drawParetoTabs();
  if (name === "lca") drawLca();
  if (name === "conds") drawConds($("cond-search").value);
  if (name === "realtime" && rtLive.kind === "sim" && !rtLive.source) ioConnect();
}

/* ===== 新站适配层（自动生成，勿手改）=====
   老站的绑定与初始化原本在脚本顶层执行，那一套假设整个页面都是它自己的。
   在新站里它只是一个页签，所以：
     1) 导航绑定交给新站外壳（下面原 NAV_BINDING 那行已被移除）；
     2) 顶层初始化收进 initLegacyTools()，由新站首次打开工具页签时调用一次；
     3) LEGACY_ON_SHOW 复刻老站 switchTab 里的"切到某页要做的事"。
   ============================================ */
window.LEGACY_ON_SHOW = {
  calc: function () { calc(); },
  realtime: function () {
    if (rtLive.kind === "sim" && !rtLive.source) ioConnect();
  },
  pareto: function () { drawParetoTabs(); },
  lca: function () { drawLca(); },
  conds: function () { drawConds($("cond-search").value); },
  method: function () {}
};

window.initLegacyTools = function () {
  if (window.__legacyReady) { return; }
  var __host = document.getElementById("legacy-host");
  try {
document.querySelectorAll(".chips .chip[data-c]").forEach((c) => c.addEventListener("click", () => {
  document.querySelectorAll(".chips .chip[data-c]").forEach((x) => x.classList.remove("active"));
  c.classList.add("active"); state.cont = c.dataset.c; calc();
}));
document.querySelectorAll(".chips .chip[data-drv]").forEach((c) => c.addEventListener("click", () => {
  document.querySelectorAll(".chips .chip[data-drv]").forEach((x) => x.classList.remove("active"));
  c.classList.add("active"); state.drv = c.dataset.drv; calc();
}));
$("btn").addEventListener("click", calc);
$("preset").addEventListener("change", fillPreset);
$("cond-search").addEventListener("input", () => drawConds($("cond-search").value));
[$("in-t"), $("in-f"), $("in-dt"), $("in-h"), $("in-lam"), $("medium"), $("demand")].forEach((el) => {
  el.addEventListener("input", readInputs);
  el.addEventListener("change", calc);
});

$("io-kind").addEventListener("change", () => { ioDisconnect(); ioRenderCfg(); });
$("io-connect").addEventListener("click", ioConnect);
$("io-disconnect").addEventListener("click", ioDisconnect);
$("io-pause").addEventListener("click", () => {
  if (!rtLive.fileSrc) return;
  const st = rtLive.fileSrc.status().state;
  if (st === "playing") {
    rtLive.fileSrc.pause();
    $("io-pause").textContent = "▶ 继续";
  } else {
    rtLive.fileSrc.play();
    $("io-pause").textContent = "⏸ 暂停";
  }
  ioAgeTick();
});
$("io-step").addEventListener("click", () => {
  if (rtLive.fileSrc) { rtLive.fileSrc.step(); ioAgeTick(); }
});
rtLive.ageTimer = setInterval(ioAgeTick, 1000);

// 初始化
D.conds.forEach((c) => {
  const o = document.createElement("option"); o.value = c[0]; o.textContent = c[0];
  $("preset").appendChild(o);
});
calc();
drawLca();
drawConds("");
ioRenderCfg();

    window.__legacyReady = true;
    if (__host) { __host.setAttribute("data-legacy", "ready"); }
  } catch (err) {
    var msg = String((err && err.message) || err);
    window.__legacyError = msg;
    if (__host) { __host.setAttribute("data-legacy-error", msg); }
    if (window.console && window.console.error) {
      window.console.error("[legacy] 初始化失败：", err);
    }
  }
};

/* 新站壳 <-> 老站工具 的桥接层。

老站那六个页签（计算/实时模拟/帕累托/LCA/工况库/方法说明）整体搬了过来，
但它们假设"整个页面都是自己的"。这一层负责：
  1. 新站切到工具页签时，把对应的 legacy-section 显示出来；
  2. 首次进入时调用 initLegacyTools() 一次（老站的绑定与初始化在里面）；
  3. 之后每次进入调用 LEGACY_ON_SHOW[页签]（复刻老站切页时要做的重算）。
*/

window.LEGACY_TOOL_IDS = ["calc", "realtime", "pareto", "lca", "conds", "method"];

window.isLegacyTool = function (tabId) {
  return window.LEGACY_TOOL_IDS.indexOf(tabId) >= 0;
};

window.showLegacyTool = function (tabId) {
  var host = document.getElementById("legacy-host");
  if (!host) { return; }

  var sections = host.querySelectorAll(".legacy-section");
  for (var i = 0; i < sections.length; i++) {
    var on = sections[i].id === "tab-" + tabId;
    if (on) {
      sections[i].classList.add("active");
    } else {
      sections[i].classList.remove("active");
    }
  }

  if (typeof window.initLegacyTools === "function") {
    window.initLegacyTools();
  }
  var hook = window.LEGACY_ON_SHOW && window.LEGACY_ON_SHOW[tabId];
  if (typeof hook === "function") {
    hook();
  }
};

/* 学习实验室的模型层。

基准来自内嵌的仿真分位表（HFDATA.orcPct，131 行，温度 100~360℃），
单位是「每 MW 回收热的净功率 kW」。可学习的部分是叠加在上面的一个偏置修正。

注意：基准 P50 在 198~260℃ 区间本身并不单调（有 16 处逆序），
这是数据的事实，因此"单调性"门控只能定义为"更新不得让它变得更差"，
不能定义为"必须单调"。
*/
window.WHLAB_MODEL = (function () {
  var DOMAIN = { min: 100, max: 350 };
  var SINK_C = 25;

  function table() {
    return (window.HFDATA && window.HFDATA.orcPct) || [];
  }

  function baseline(t) {
    var rows = table();
    if (!rows.length) { return null; }
    var first = rows[0];
    var last = rows[rows.length - 1];
    if (t <= first[0]) { return first[2]; }
    if (t >= last[0]) { return last[2]; }
    for (var i = 0; i < rows.length - 1; i++) {
      var a = rows[i];
      var b = rows[i + 1];
      if (t >= a[0] && t <= b[0]) {
        var span = b[0] - a[0];
        var w = span > 0 ? (t - a[0]) / span : 0;
        return a[2] * (1 - w) + b[2] * w;
      }
    }
    return last[2];
  }

  function biasOf(state) {
    return (state && typeof state.bias === "number") ? state.bias : 0;
  }

  function predict(t, state) {
    var base = baseline(t);
    return base === null ? null : base * (1 + biasOf(state));
  }

  /* 热效率（比例）：净功率 kW / 回收热 kW */
  function efficiency(t, state) {
    var p = predict(t, state);
    return p === null ? null : p / 1000;
  }

  /* 卡诺上限，冷源按 25℃ */
  function carnot(t) {
    var th = t + 273.15;
    var tc = SINK_C + 273.15;
    return th <= tc ? 0 : 1 - tc / th;
  }

  function grid(step) {
    var out = [];
    var s = step || 10;
    for (var t = DOMAIN.min; t <= DOMAIN.max + 1e-9; t += s) {
      out.push(Math.round(t));
    }
    return out;
  }

  /* 适用域内的单调性逆序数 */
  function monotonicityViolations(state) {
    var rows = table();
    var count = 0;
    for (var i = 0; i < rows.length - 1; i++) {
      if (rows[i][0] < DOMAIN.min || rows[i + 1][0] > DOMAIN.max) { continue; }
      var p1 = predict(rows[i][0], state);
      var p2 = predict(rows[i + 1][0], state);
      if (p1 !== null && p2 !== null && p1 > p2 + 1e-9) { count++; }
    }
    return count;
  }

  function calibrationSet() {
    return (window.HFDATA && window.HFDATA.real14) || [];
  }

  /* 在 14 个实测留出点上的平均绝对百分比误差 */
  function calibrationError(state) {
    var rows = calibrationSet();
    if (!rows.length) { return null; }
    var sum = 0;
    var n = 0;
    for (var i = 0; i < rows.length; i++) {
      var observed = rows[i][1];
      var p = predict(rows[i][0], state);
      if (p === null || !observed) { continue; }
      sum += Math.abs(p - observed) / Math.abs(observed);
      n++;
    }
    return n ? sum / n : null;
  }

  return {
    DOMAIN: DOMAIN,
    SINK_C: SINK_C,
    baseline: baseline,
    predict: predict,
    efficiency: efficiency,
    carnot: carnot,
    grid: grid,
    monotonicityViolations: monotonicityViolations,
    calibrationSetSize: function () { return calibrationSet().length; },
    calibrationError: calibrationError
  };
})();

/* 五道门控：全部通过才允许更新模型。

设计意图：这不是"防呆"，而是**用外部物理证据给在线更新当守门人**。
所有门控都是纯函数，便于单独测试。
*/
window.WHLAB_GATES = (function () {
  var M = window.WHLAB_MODEL;

  function scan(state, fn) {
    var pts = M.grid(10);
    var best = null;
    for (var i = 0; i < pts.length; i++) {
      var v = fn(pts[i]);
      if (v === null) { continue; }
      if (best === null || v.value > best.value) {
        best = { value: v.value, at: pts[i] };
      }
    }
    return best;
  }

  /* G1 物理上限：任何温度点上，热效率不得超过卡诺效率的 90% */
  function g1(state) {
    var worst = scan(state, function (t) {
      var eta = M.efficiency(t, state);
      var c = M.carnot(t);
      return c > 0 ? { value: eta / c } : null;
    });
    if (!worst) {
      return { id: "G1", name: "物理上限", pass: false, detail: "无法计算" };
    }
    return {
      id: "G1", name: "物理上限",
      pass: worst.value <= 0.9,
      detail: "最高达卡诺效率的 " + (worst.value * 100).toFixed(1) +
              "%（阈值 90%，出现在 " + worst.at + " ℃）"
    };
  }

  /* G2 能量守恒：净功率不得超过回收热量 */
  function g2(state) {
    var worst = scan(state, function (t) {
      var eta = M.efficiency(t, state);
      return eta === null ? null : { value: eta };
    });
    if (!worst) {
      return { id: "G2", name: "能量守恒", pass: false, detail: "无法计算" };
    }
    return {
      id: "G2", name: "能量守恒",
      pass: worst.value <= 1,
      detail: "最高热效率 " + (worst.value * 100).toFixed(2) +
              "%（上限 100%，出现在 " + worst.at + " ℃）"
    };
  }

  /* G3 单调性不恶化：基准本身有逆序，故只要求更新后不增加 */
  function g3(state, prev) {
    var now = M.monotonicityViolations(state);
    var before = prev ? M.monotonicityViolations(prev) : now;
    return {
      id: "G3", name: "单调性不恶化",
      pass: now <= before,
      detail: "逆序 " + before + " 处 → " + now + " 处（基准本身有 " +
              M.monotonicityViolations(null) + " 处，属数据既有事实）"
    };
  }

  /* G4 适用域：新数据点必须落在标定区间内 */
  function g4(state, prev, point) {
    var t = point && point.t;
    var ok = typeof t === "number" && t >= M.DOMAIN.min && t <= M.DOMAIN.max;
    return {
      id: "G4", name: "适用域",
      pass: ok,
      detail: ok
        ? "注入点 " + t + " ℃ 在标定区间 " + M.DOMAIN.min + "~" +
          M.DOMAIN.max + " ℃ 内"
        : "注入点 " + t + " ℃ 超出标定区间 " + M.DOMAIN.min + "~" +
          M.DOMAIN.max + " ℃"
    };
  }

  /* G5 校准不恶化：留出实测点上的误差不得变差超过 5% */
  function g5(state, prev) {
    var now = M.calibrationError(state);
    var before = prev ? M.calibrationError(prev) : now;
    if (now === null || before === null || before === 0) {
      return { id: "G5", name: "校准不恶化", pass: false,
               detail: "缺少留出校准集，无法判定" };
    }
    var ratio = now / before;
    var delta = (ratio >= 1 ? "+" : "") + ((ratio - 1) * 100).toFixed(2);
    return {
      id: "G5", name: "校准不恶化",
      pass: ratio <= 1.05,
      detail: "留出 " + M.calibrationSetSize() + " 个实测点平均误差 " +
              (before * 100).toFixed(2) + "% → " + (now * 100).toFixed(2) +
              "%（容许变差 5%，实际 " + delta + "%）"
    };
  }

  /* 依次跑五道门控，返回全部结果与总判定 */
  function run(state, prev, point) {
    var results = [g1(state), g2(state), g3(state, prev), g4(state, prev, point),
                   g5(state, prev)];
    var failed = [];
    for (var i = 0; i < results.length; i++) {
      if (!results[i].pass) { failed.push(results[i].id); }
    }
    return { results: results, passed: failed.length === 0, failed: failed };
  }

  return { run: run, g1: g1, g2: g2, g3: g3, g4: g4, g5: g5 };
})();

/* 学习实验室的持久化层。

存在浏览器本地（IndexedDB），**不上传、不跨用户、不跨设备**。
隐私模式或 IDB 不可用时自动退回内存存储，此时刷新即丢失——
页面会如实提示，不会假装还在。
*/
window.WHLAB_STORE = (function () {
  var DB_NAME = "whlab";
  var DB_VERSION = 1;
  var STORES = ["state", "events", "snapshots"];
  var memory = { state: [], events: [], snapshots: [] };
  var dbPromise = null;
  var usingMemory = false;

  function openDB() {
    if (dbPromise) { return dbPromise; }
    dbPromise = new Promise(function (resolve) {
      var req;
      try {
        req = window.indexedDB.open(DB_NAME, DB_VERSION);
      } catch (err) {
        usingMemory = true;
        resolve(null);
        return;
      }
      req.onupgradeneeded = function () {
        var db = req.result;
        STORES.forEach(function (name) {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name, { keyPath: "key" });
          }
        });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { usingMemory = true; resolve(null); };
    });
    return dbPromise;
  }

  function put(store, key, value) {
    return openDB().then(function (db) {
      if (!db) {
        memory[store] = memory[store].filter(function (r) { return r.key !== key; });
        memory[store].push({ key: key, value: value });
        return true;
      }
      return new Promise(function (resolve) {
        var tx = db.transaction(store, "readwrite");
        tx.objectStore(store).put({ key: key, value: value });
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { resolve(false); };
      });
    });
  }

  function get(store, key) {
    return openDB().then(function (db) {
      if (!db) {
        var hit = memory[store].filter(function (r) { return r.key === key; })[0];
        return hit ? hit.value : null;
      }
      return new Promise(function (resolve) {
        var tx = db.transaction(store, "readonly");
        var req = tx.objectStore(store).get(key);
        req.onsuccess = function () { resolve(req.result ? req.result.value : null); };
        req.onerror = function () { resolve(null); };
      });
    });
  }

  function all(store) {
    return openDB().then(function (db) {
      if (!db) {
        return memory[store].map(function (r) { return r.value; });
      }
      return new Promise(function (resolve) {
        var tx = db.transaction(store, "readonly");
        var req = tx.objectStore(store).getAll();
        req.onsuccess = function () {
          resolve((req.result || []).map(function (r) { return r.value; }));
        };
        req.onerror = function () { resolve([]); };
      });
    });
  }

  function clear(store) {
    return openDB().then(function (db) {
      if (!db) { memory[store] = []; return true; }
      return new Promise(function (resolve) {
        var tx = db.transaction(store, "readwrite");
        tx.objectStore(store).clear();
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { resolve(false); };
      });
    });
  }

  return {
    get: get,
    put: put,
    all: all,
    clear: clear,
    isMemoryOnly: function () { return usingMemory; }
  };
})();

/* 自主学习实验室的编排层：版本、提交、门控、回滚。

对外口径（务必与页面提示一致）：
  - 这是"受限自主更新"：模型能在运行中更新，但必须过五道门控，且可回滚；
  - 学习状态只存在本浏览器；交付版不含此功能，行为固定在提交时的状态；
  - 每条计算结果都应带上产生它的模型版本号。
*/
window.WHLAB = (function () {
  var M = window.WHLAB_MODEL;
  var G = window.WHLAB_GATES;
  var S = window.WHLAB_STORE;
  var MAX_SNAPSHOTS = 10;

  var BASE = { version: "1.0.0", bias: 0, samples: 0, updatedAt: null,
               note: "交付基线（未经过在线更新）" };

  var state = null;
  var events = [];
  var ready = false;
  var listeners = [];

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function bumpVersion(version) {
    var parts = String(version).split(".");
    var patch = parseInt(parts[2] || "0", 10) + 1;
    return parts[0] + "." + parts[1] + "." + patch;
  }

  function notify() {
    listeners.forEach(function (fn) { try { fn(); } catch (e) {} });
  }

  function init() {
    if (ready) { return Promise.resolve(state); }
    return S.get("state", "current").then(function (saved) {
      state = saved ? clone(saved) : clone(BASE);
      /* 事件与快照都以"单个 key 存整个列表"的方式落盘，
         所以要用 get 读回，不能用 all（all 返回的是记录数组，会多一层嵌套）。 */
      return S.get("events", "list");
    }).then(function (rows) {
      events = Array.isArray(rows) ? rows : [];
      events.sort(function (a, b) { return a.seq - b.seq; });
      ready = true;
      return state;
    });
  }

  function snapshot(reason) {
    return S.get("snapshots", "list").then(function (rows) {
      var list = Array.isArray(rows) ? rows.slice() : [];
      list.sort(function (a, b) { return a.seq - b.seq; });
      list.push({ key: String(Date.now()) + "_" + Math.random().toString(36).slice(2, 8),
                  seq: Date.now(), state: clone(state), reason: reason });
      while (list.length > MAX_SNAPSHOTS) { list.shift(); }
      return S.put("snapshots", "list", list);
    });
  }

  function logEvent(ev) {
    ev.seq = events.length ? events[events.length - 1].seq + 1 : 1;
    ev.ts = new Date().toISOString();
    events.push(ev);
    return S.put("events", "list", events);
  }

  /* 提交一个数据点。observed 单位与基准一致：每 MW 回收热的净功率 kW */
  function submit(input) {
    return init().then(function () {
      var t = Number(input.t);
      var observed = Number(input.observed);
      if (!isFinite(t) || !isFinite(observed) || observed <= 0) {
        return { accepted: false, reason: "输入不合法：温度和实测值都必须是正数",
                 gates: [] };
      }
      var prev = clone(state);
      var predicted = M.predict(t, prev);
      var residual = predicted ? (observed / predicted - 1) : 0;
      var samples = (prev.samples || 0) + 1;
      var candidate = clone(prev);
      candidate.bias = ((prev.bias || 0) * (prev.samples || 0) + residual) / samples;
      candidate.samples = samples;

      var verdict = G.run(candidate, prev, { t: t, observed: observed });

      if (!verdict.passed) {
        return logEvent({
          type: "reject", point: { t: t, observed: observed,
                                   note: input.note || "", source: input.source || "" },
          predicted: predicted, residual: residual,
          from: prev.version, to: prev.version,
          gates: verdict.results, failed: verdict.failed,
          reason: "门控未通过：" + verdict.failed.join("、")
        }).then(function () {
          notify();
          return { accepted: false, gates: verdict.results,
                   failed: verdict.failed, state: clone(state),
                   reason: "门控未通过：" + verdict.failed.join("、") };
        });
      }

      return snapshot("更新前").then(function () {
        var next = clone(candidate);
        next.version = bumpVersion(prev.version);
        next.updatedAt = new Date().toISOString();
        next.note = "在线更新 " + next.samples + " 次";
        state = next;
        return S.put("state", "current", state);
      }).then(function () {
        return logEvent({
          type: "accept",
          point: { t: t, observed: observed, note: input.note || "",
                   source: input.source || "" },
          predicted: predicted, residual: residual,
          from: prev.version, to: state.version,
          biasFrom: prev.bias, biasTo: state.bias,
          gates: verdict.results, failed: [],
          reason: "五道门控全部通过"
        });
      }).then(function () {
        notify();
        return { accepted: true, gates: verdict.results, state: clone(state),
                 reason: "已更新到 " + state.version };
      });
    });
  }

  function rollback(version) {
    return init().then(function () {
      return S.get("snapshots", "list");
    }).then(function (rows) {
      var list = Array.isArray(rows) ? rows.slice() : [];
      list.sort(function (a, b) { return a.seq - b.seq; });
      var target = null;
      for (var i = list.length - 1; i >= 0; i--) {
        if (list[i].state.version === version) { target = list[i]; break; }
      }
      if (!target) { return { ok: false, reason: "没有该版本的快照" }; }
      var from = state.version;
      state = clone(target.state);
      return S.put("state", "current", state).then(function () {
        return logEvent({ type: "rollback", from: from, to: state.version,
                          reason: "手动回滚" });
      }).then(function () {
        notify();
        return { ok: true, state: clone(state) };
      });
    });
  }

  function reset() {
    return init().then(function () {
      var from = state.version;
      return snapshot("重置前");
    }).then(function () {
      state = clone(BASE);
      return S.put("state", "current", state);
    }).then(function () {
      return logEvent({ type: "reset", from: null, to: state.version,
                        reason: "回到交付基线" });
    }).then(function () {
      notify();
      return { ok: true, state: clone(state) };
    });
  }

  return {
    init: init,
    current: function () { return state ? clone(state) : clone(BASE); },
    events: function () { return events.slice(); },
    base: function () { return clone(BASE); },
    submit: submit,
    rollback: rollback,
    reset: reset,
    snapshots: function () { return S.get("snapshots", "list").then(function (rows) {
      return Array.isArray(rows) ? rows : [];
    }); },
    onChange: function (fn) { listeners.push(fn); },
    memoryOnly: function () { return S.isMemoryOnly(); }
  };
})();

window.VIEWS = window.VIEWS || {};

window.VIEWS.placeholder = function (content) {
  return '<section class="card"><h2>本页尚未迁移到新版</h2>' +
         '<p class="muted">该页签的原有能力将在后续计划中迁移过来。</p></section>';
};

window.VIEWS = window.VIEWS || {};

window.VIEWS.evidence = function (content) {
  var items = content.evidence.items || [];
  var head = '<h2>外部证据</h2>' +
    '<p class="muted small">路演之后分四轮检索得到的外部数据与标准，共 ' +
    items.length + ' 条。' +
    '<strong>每条都标注了适用边界</strong>——这是为了防止这些数据被误用。</p>';

  if (!items.length) {
    return '<section class="card">' + head + '<p class="muted">暂无条目</p></section>';
  }

  function cardHtml(item) {
    var html = '<div class="card">';
    html += '<h3>' + window.esc(item.title) + '</h3>';
    html += '<span class="stat" style="display:block;border:none;padding:0">' +
            '<span class="value">' + window.esc(item.value) + '</span></span>';
    html += '<p class="small"><span class="muted">覆盖范围：</span>' +
            window.esc(item.scope) + '</p>';
    html += '<p class="small"><span class="muted">来源：</span>' +
            window.linkOrText(item.url, item.source) + '</p>';
    html += '<p class="small"><span class="chip gold">适用边界</span> ' +
            window.esc(item.caveat) + '</p>';
    html += '</div>';
    return html;
  }

  // 按类别分组，保持 category 在 items 里首次出现的顺序
  var order = [];
  var groups = {};
  items.forEach(function (item) {
    var key = item.category || "其他";
    if (!groups[key]) { groups[key] = []; order.push(key); }
    groups[key].push(item);
  });

  var sections = order.map(function (key) {
    var cards = groups[key].map(cardHtml).join('');
    return '<h3 class="group-title">' + window.esc(key) +
           '<span class="muted small"> · ' + groups[key].length + ' 条</span></h3>' +
           '<div class="grid">' + cards + '</div>';
  }).join('');

  return '<section class="card">' + head + '</section>' + sections;
};

window.VIEWS = window.VIEWS || {};

window.VIEWS.calibration = function (content) {
  var items = content.calibration.items || [];
  var badge = {
    pending: '<span class="chip gold">待定</span>',
    accepted: '<span class="chip">已采纳</span>',
    rejected: '<span class="chip grey">未采纳</span>'
  };

  var head = '<h2>校准工作台</h2>' +
    '<div class="note">未拍板的校准项显示为「待定」，' +
    '<strong>不参与演示数值计算</strong>——因此在拍板之前，' +
    '本站算出的数字与已提交的材料保持一致。</div>';

  if (!items.length) {
    return '<section class="card">' + head + '<p class="muted">暂无条目</p></section>';
  }

  var rows = items.map(function (item) {
    var external = (item.external || []).map(function (entry) {
      var text = window.esc(entry.value);
      if (entry.scope) { text += '<br><span class="muted small">' + window.esc(entry.scope) + '</span>'; }
      return '<div><span class="chip blue">' + window.esc(entry.source) + '</span> ' + text + '</div>';
    }).join('');
    return '<tr>' +
      '<td><strong>' + window.esc(item.parameter) + '</strong></td>' +
      '<td>' + window.esc(item.kernel_value) + '</td>' +
      '<td>' + external + '</td>' +
      '<td class="small">' + window.esc(item.finding) + '</td>' +
      '<td class="small">' + window.esc(item.impact) + '</td>' +
      '<td>' + (badge[item.decision] || window.esc(item.decision)) + '</td>' +
      '</tr>';
  }).join('');

  return '<section class="card">' + head +
    '<table><thead><tr><th>参数</th><th>内核现值</th><th>外部口径</th>' +
    '<th>差异分析</th><th>可能影响</th><th>状态</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table></section>';
};

window.VIEWS = window.VIEWS || {};

window.VIEWS.boundaries = function (content) {
  var items = content.boundaries.items || [];
  var gradeClass = {'推算，非实测': 'blue', '演示估算': 'gold',
                    '示意，非报价': 'gold', '示意': 'gold', '待替换': 'red'};

  var head = '<h2>边界与口径</h2>' +
    '<p class="muted small">这一页把散落在各处的诚实性说明集中起来：' +
    '哪些是实测、哪些是推算、哪些只是示意。对外表述以本页为准。</p>';

  if (!items.length) {
    return '<section class="card">' + head + '<p class="muted">暂无条目</p></section>';
  }

  var rows = items.map(function (item) {
    var cls = gradeClass[item.grade] || 'grey';
    return '<tr><td>' + window.esc(item.item) + '</td>' +
           '<td>' + window.esc(item.scope) + '</td>' +
           '<td><span class="chip ' + cls + '">' + window.esc(item.grade) +
           '</span></td></tr>';
  }).join('');

  return '<section class="card">' + head +
    '<table><thead><tr><th>项目</th><th>口径</th><th>等级</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table></section>';
};

window.VIEWS = window.VIEWS || {};

window.VIEWS.changelog = function (content) {
  var entries = content.changelog.entries || [];
  var head = '<h2>演进记录</h2>' +
    '<p class="muted small">本站自己的版本记录。每条都写清改了什么，' +
    '以及有没有影响已提交材料的口径。</p>';

  if (!entries.length) {
    return '<section class="card">' + head + '<p class="muted">暂无条目</p></section>';
  }

  var cards = entries.map(function (entry) {
    var changes = (entry.changes || []).map(function (line) {
      return '<li>' + window.esc(line) + '</li>';
    }).join('');
    return '<div class="card">' +
      '<div class="kv"><span class="chip">v' + window.esc(entry.version) + '</span>' +
      '<span>' + window.esc(entry.date) + '</span></div>' +
      '<h3>' + window.esc(entry.title) + '</h3>' +
      '<ul class="small">' + changes + '</ul>' +
      '<p class="small"><span class="chip gold">与既有口径的关系</span> ' +
      window.esc(entry.relative_to_prior) + '</p>' +
      '</div>';
  }).join('');

  return '<section class="card">' + head + '</section>' + cards;
};

window.VIEWS = window.VIEWS || {};

/* 界面骨架。动态部分在 VIEW_AFTER.learning 里填充与绑定。 */
window.VIEWS.learning = function (content) {
  var M = window.WHLAB_MODEL;
  return '' +
  '<section class="card">' +
    '<h2>自主学习实验室</h2>' +
    '<div class="note warn">' +
      '<strong>这是实验功能，请连同下面三句话一起理解：</strong>' +
      '<ol class="small" style="margin:6px 0 0 18px">' +
        '<li>学习到的状态<strong>只存在于你这一台浏览器</strong>' +
          '（IndexedDB），不上传、不跨用户、不跨设备。</li>' +
        '<li><strong>交付版不含本功能</strong>，交付版行为固定在提交时的状态：' +
          '同一输入必然得到同一输出。</li>' +
        '<li>本页里"同一输入可能给出不同答案"是<strong>故意的</strong>，' +
          '所以每条结果都必须带模型版本号。</li>' +
      '</ol>' +
    '</div>' +
    '<p class="small muted">这是"受限自主更新"（guarded continual learning）：' +
    '模型可以在运行中更新，但必须通过五道门控，且随时可回滚。' +
    '它不等于"模型会自己学习"——训练仍由人触发，每一项更新都留档。</p>' +
  '</section>' +

  '<section class="card">' +
    '<h3>当前模型状态</h3>' +
    '<div class="grid" id="lab-state"></div>' +
    '<div class="kv" id="lab-storage" style="margin-top:8px"></div>' +
  '</section>' +

  '<section class="card">' +
    '<h3>五道门控</h3>' +
    '<div id="lab-gates"></div>' +
  '</section>' +

  '<section class="card">' +
    '<h3>提交一个数据点</h3>' +
    '<p class="small muted">单位与基准一致：每 MW 回收热的净功率（kW）。' +
    '标定区间 ' + M.DOMAIN.min + '~' + M.DOMAIN.max + ' ℃。</p>' +
    '<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(190px,1fr))">' +
      '<div class="field"><label>热源温度（℃）</label>' +
        '<input id="lab-t" type="number" min="0" max="900" step="1" value="200"></div>' +
      '<div class="field"><label>实测净功率（kW/MW热）</label>' +
        '<input id="lab-v" type="number" min="0" step="0.1" value="120"></div>' +
      '<div class="field"><label>备注</label>' +
        '<input id="lab-note" type="text" placeholder="例如：某厂实测" value=""></div>' +
    '</div>' +
    '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">' +
      '<button class="btn" id="lab-submit">提交并过门控</button>' +
      '<button class="btn ghost" id="lab-demo-ok">填入一个合理点</button>' +
      '<button class="btn ghost" id="lab-demo-bad">填入一个物理上不可能的点</button>' +
    '</div>' +
    '<div id="lab-result" style="margin-top:12px"></div>' +
  '</section>' +

  '<section class="card">' +
    '<h3>事件记录</h3>' +
    '<p class="small muted">每一次接受、拒绝、回滚、重置都留档。' +
    '被拒绝的更新同样记录——它本身就是"门控在起作用"的证据。</p>' +
    '<div id="lab-events"></div>' +
    '<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">' +
      '<button class="btn ghost" id="lab-reset">回到交付基线</button>' +
    '</div>' +
  '</section>';
};

window.VIEW_AFTER = window.VIEW_AFTER || {};

window.VIEW_AFTER.learning = function () {
  var M = window.WHLAB_MODEL;
  var L = window.WHLAB;

  function el(id) { return document.getElementById(id); }

  function statCard(value, label) {
    return '<div class="stat"><span class="value">' + window.esc(value) +
           '</span><span class="label">' + window.esc(label) + '</span></div>';
  }

  function renderState() {
    var s = L.current();
    el("lab-state").innerHTML =
      statCard("v" + s.version, "模型版本") +
      statCard((s.bias >= 0 ? "+" : "") + (s.bias * 100).toFixed(2) + "%",
               "效率偏置修正") +
      statCard(String(s.samples), "已吸收的实测点") +
      statCard(s.updatedAt ? s.updatedAt.slice(0, 19).replace("T", " ") : "—",
               "最近更新");
    el("lab-storage").innerHTML =
      '<span>存储：' + (L.memoryOnly()
        ? '<span class="chip red">仅内存（刷新即丢失）</span>'
        : '<span class="chip">本浏览器 IndexedDB</span>') + '</span>' +
      '<span>基准：内嵌仿真分位表 P50（131 行，100~360 ℃）</span>' +
      '<span>留出校准集：' + M.calibrationSetSize() + ' 个实测点</span>';
    var baseErr = M.calibrationError(null);
    if (baseErr !== null) {
      el("lab-storage").innerHTML +=
        '<span>基准对留出实测点的平均误差：<strong>' +
        (baseErr * 100).toFixed(2) + '%</strong>（基准系统性偏低，' +
        '所以正向偏置通常能改善校准）</span>';
    }
  }

  function renderGates() {
    var s = L.current();
    var prev = { version: s.version, bias: 0, samples: 0 };
    var verdict = window.WHLAB_GATES.run(s, prev, { t: 200 });
    var rows = verdict.results.map(function (g) {
      var chip = g.pass ? '<span class="chip">通过</span>'
                        : '<span class="chip red">未通过</span>';
      return '<tr><td>' + window.esc(g.id) + '</td><td>' + window.esc(g.name) +
             '</td><td>' + chip + '</td><td class="small">' +
             window.esc(g.detail) + '</td></tr>';
    }).join('');
    var base = M.monotonicityViolations(null);
    el("lab-gates").innerHTML =
      '<table><thead><tr><th>编号</th><th>门控</th><th>当前状态</th><th>判据</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>' +
      '<p class="small muted" style="margin-top:8px">' +
      '注：基准分位表在 ' + M.DOMAIN.min + '~' + M.DOMAIN.max +
      ' ℃ 区间内本身存在 <strong>' + base + ' 处效率逆序</strong>' +
      '（P50 随温度升高反而略降，集中在 198~260 ℃）。这是数据既有事实，' +
      '因此 G3 的口径是"更新不得让它变得更坏"，而不是"必须单调"。</p>';
  }

  function renderEvents() {
    var evs = L.events().slice().reverse();
    if (!evs.length) {
      el("lab-events").innerHTML = '<p class="muted small">暂无记录。</p>';
      return;
    }
    var rows = evs.map(function (e) {
      var badge = { accept: '<span class="chip">接受</span>',
                    reject: '<span class="chip red">拒绝</span>',
                    rollback: '<span class="chip gold">回滚</span>',
                    reset: '<span class="chip grey">重置</span>' }[e.type] || '';
      var point = e.point
        ? '注入 ' + e.point.t + ' ℃ / ' + e.point.observed + ' kW' +
          (e.point.note ? '（' + e.point.note + '）' : '')
        : '';
      var ver = e.from && e.to ? e.from + ' → ' + e.to : (e.to || '');
      var extra = e.type === "accept" && typeof e.residual === "number"
        ? '残差 ' + (e.residual * 100).toFixed(2) + '%'
        : (e.failed && e.failed.length ? '未过：' + e.failed.join('、') : e.reason);
      /* 每条"接受"事件都提供回到更新前版本的入口（那时已存过快照） */
      var roll = (e.type === "accept" && e.from)
        ? '<button class="btn ghost small" data-rollback="' + window.esc(e.from) +
          '" style="margin-left:6px">回滚到 ' + window.esc(e.from) + '</button>'
        : '';
      return '<tr><td class="small">' + window.esc(e.ts.slice(0, 19).replace("T", " ")) +
             '</td><td>' + badge + '</td><td class="small">' + window.esc(ver) +
             '</td><td class="small">' + window.esc(point) + '</td><td class="small">' +
             window.esc(extra) + roll + '</td></tr>';
    }).join('');
    el("lab-events").innerHTML =
      '<table><thead><tr><th>时间</th><th>类型</th><th>版本</th>' +
      '<th>数据点</th><th>说明</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function renderAll() {
    renderState();
    renderGates();
    renderEvents();
  }

  function showResult(html) { el("lab-result").innerHTML = html; }

  el("lab-submit").addEventListener("click", function () {
    var t = parseFloat(el("lab-t").value);
    var v = parseFloat(el("lab-v").value);
    showResult('<p class="muted small">正在过门控……</p>');
    L.submit({ t: t, observed: v, note: el("lab-note").value,
               source: "手动提交" }).then(function (r) {
      var list = r.gates.map(function (g) {
        return '<li>' + (g.pass ? '✓' : '✗') + ' <strong>' + window.esc(g.id) +
               ' ' + window.esc(g.name) + '</strong>：' + window.esc(g.detail) + '</li>';
      }).join('');
      var head = r.accepted
        ? '<div class="note"><strong>更新已生效</strong>，模型版本 ' +
          window.esc(r.state.version) + '，效率偏置 ' +
          (r.state.bias * 100).toFixed(2) + '%。</div>'
        : '<div class="note warn"><strong>更新被拒绝</strong>：' +
          window.esc(r.reason) + '。模型版本保持 ' +
          window.esc(r.state.version) + ' 不变。</div>';
      showResult(head + '<ul class="small" style="margin:6px 0 0 18px">' + list + '</ul>');
      renderAll();
    });
  });

  el("lab-demo-ok").addEventListener("click", function () {
    var s = L.current();
    var t = 250;
    var base = M.predict(t, s);
    el("lab-t").value = t;
    el("lab-v").value = (base * 1.02).toFixed(1);
    el("lab-note").value = "合理点示例（比模型高 2%）";
  });

  el("lab-demo-bad").addEventListener("click", function () {
    el("lab-t").value = 250;
    el("lab-v").value = "900";
    el("lab-note").value = "物理上不可能（远超卡诺上限）";
  });

  el("lab-reset").addEventListener("click", function () {
    L.reset().then(function () { renderAll(); showResult(""); });
  });

  el("lab-events").addEventListener("click", function (ev) {
    var v = ev.target && ev.target.getAttribute && ev.target.getAttribute("data-rollback");
    if (!v) { return; }
    L.rollback(v).then(function (r) {
      renderAll();
      showResult(r.ok
        ? '<div class="note">已回滚到 ' + window.esc(r.state.version) + '。</div>'
        : '<div class="note warn">' + window.esc(r.reason) + '</div>');
    });
  });

  L.init().then(renderAll);
};

window.VIEWS = window.VIEWS || {};

function renderTabs() {
  var nav = document.getElementById('tabs');
  var tabs = window.__CONTENT__.tabs;
  var out = '';
  for (var i = 0; i < tabs.length; i++) {
    out += '<button class="tab" data-tab="' + tabs[i].id + '">' +
           tabs[i].title + '</button>';
  }
  nav.innerHTML = out;
}

window.renderTab = function (tabId) {
  var content = window.__CONTENT__;
  var viewHost = document.getElementById('view');
  var legacyHost = document.getElementById('legacy-host');
  var useLegacy = typeof window.isLegacyTool === 'function' &&
                  window.isLegacyTool(tabId);

  if (useLegacy) {
    // 老站搬过来的六个功能页签：由桥接层接管
    viewHost.innerHTML = '';
    viewHost.hidden = true;
    legacyHost.hidden = false;
    window.showLegacyTool(tabId);
  } else {
    legacyHost.hidden = true;
    viewHost.hidden = false;
    var view = window.VIEWS[tabId] || window.VIEWS.placeholder;
    viewHost.innerHTML = view(content);
    var after = window.VIEW_AFTER && window.VIEW_AFTER[tabId];
    if (typeof after === 'function') { after(); }
  }

  var buttons = document.querySelectorAll('.tab');
  for (var i = 0; i < buttons.length; i++) {
    if (buttons[i].dataset.tab === tabId) {
      buttons[i].classList.add('active');
    } else {
      buttons[i].classList.remove('active');
    }
  }
  if (location.hash !== '#' + tabId) { location.hash = tabId; }
};

window.currentTab = function () {
  var id = (location.hash || '').replace('#', '');
  var tabs = window.__CONTENT__.tabs;
  for (var i = 0; i < tabs.length; i++) {
    if (tabs[i].id === id) { return id; }
  }
  return tabs[0].id;
};

document.addEventListener('DOMContentLoaded', function () {
  renderTabs();
  document.getElementById('tabs').addEventListener('click', function (event) {
    var id = event.target.dataset ? event.target.dataset.tab : null;
    if (id) { window.renderTab(id); }
  });
  window.renderTab(window.currentTab());
});

window.addEventListener('hashchange', function () {
  window.renderTab(window.currentTab());
});
