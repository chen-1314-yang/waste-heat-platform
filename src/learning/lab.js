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
