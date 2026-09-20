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
