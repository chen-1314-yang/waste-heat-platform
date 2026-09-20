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
