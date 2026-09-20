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
