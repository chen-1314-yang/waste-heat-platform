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
