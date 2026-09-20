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
