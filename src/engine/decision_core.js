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
