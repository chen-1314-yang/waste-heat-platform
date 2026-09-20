/* 用内存版存储层模拟 IndexedDB 语义，跑完整的提交/拒绝/回滚链路。

内存版刻意复刻真实存储的语义：all() 返回"所有记录的值"，
所以"单 key 存整个列表"的写法读回来会多一层嵌套——
这正是本轮修掉的那个 bug，这里把它锁住。
*/
const fs = require("fs");
const path = require("path");
const vm = require("vm");

global.window = global;
const ROOT = path.resolve(__dirname, "..", "..");

const store = {};
global.window.WHLAB_STORE = {
  get: function (name, key) {
    return Promise.resolve(store[name] && key in store[name]
      ? JSON.parse(JSON.stringify(store[name][key])) : null);
  },
  put: function (name, key, value) {
    store[name] = store[name] || {};
    store[name][key] = JSON.parse(JSON.stringify(value));
    return Promise.resolve(true);
  },
  all: function (name) {
    return Promise.resolve(Object.keys(store[name] || {})
      .map(function (k) { return store[name][k]; }));
  },
  clear: function (name) { store[name] = {}; return Promise.resolve(true); },
  isMemoryOnly: function () { return true; }
};

["src/legacy/hfdata.js", "src/learning/model.js", "src/learning/gates.js",
 "src/learning/lab.js"].forEach(function (f) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), "utf8"),
                      { filename: f });
});

const L = window.WHLAB;
const S = window.WHLAB_STORE;

const out = {};

L.init().then(function () {
  out.baseVersion = L.current().version;

  /* 1) 物理上不可能的点应被拒绝 */
  return L.submit({ t: 250, observed: 900, note: "不可能的点" });
}).then(function (r) {
  out.badAccepted = r.accepted;
  out.badFailed = r.failed;
  out.versionAfterBad = L.current().version;
  out.eventsAfterBad = L.events().length;

  /* 2) 合理点应被接受并升版本 */
  return L.submit({ t: 250, observed: 104.9, note: "合理点" });
}).then(function (r) {
  out.goodAccepted = r.accepted;
  out.versionAfterGood = L.current().version;
  out.biasAfterGood = L.current().bias;
  out.eventsAfterGood = L.events().length;

  /* 3) 落盘形状：事件列表必须是一维数组，不能嵌套 */
  return S.get("events", "list");
}).then(function (rows) {
  out.eventsOnDisk = Array.isArray(rows) ? rows.length : -1;
  out.eventsOnDiskShape = Array.isArray(rows) && rows.length
    ? (Array.isArray(rows[0]) ? "nested" : "flat") : "empty";
  /* 对照组：all() 的返回形状（这正是不能用 all 读的原因） */
  return S.all("events");
}).then(function (rows) {
  out.allShape = Array.isArray(rows) && rows.length
    ? (Array.isArray(rows[0]) ? "nested" : "flat") : "empty";
  return S.get("snapshots", "list");
}).then(function (rows) {
  out.snapshotsOnDisk = Array.isArray(rows) ? rows.length : -1;

  /* 4) 回滚 */
  return L.rollback("1.0.0");
}).then(function (r) {
  out.rollbackOk = r.ok;
  out.versionAfterRollback = L.current().version;
  out.eventsAfterRollback = L.events().length;

  /* 5) 空版本回滚应失败 */
  return L.rollback("9.9.9");
}).then(function (r) {
  out.rollbackMissing = r.ok;
  process.stdout.write(JSON.stringify(out));
}).catch(function (err) {
  process.stdout.write(JSON.stringify({ error: String(err && err.message || err) }));
});
