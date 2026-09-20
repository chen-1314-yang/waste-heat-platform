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

window.VIEWS = window.VIEWS || {};

window.VIEWS.placeholder = function (content) {
  return '<section class="card"><h2>本页尚未迁移到新版</h2>' +
         '<p class="muted">该页签的原有能力将在后续计划中迁移过来。</p></section>';
};

window.VIEWS = window.VIEWS || {};

window.VIEWS.evidence = function (content) {
  var items = content.evidence.items || [];
  var head = '<h2>外部证据</h2>' +
    '<p class="muted small">路演之后分四轮检索得到的外部数据与标准。' +
    '每条都标注了适用边界——这是为了防止这些数据被误用。</p>';

  if (!items.length) {
    return '<section class="card">' + head + '<p class="muted">暂无条目</p></section>';
  }

  var cards = items.map(function (item) {
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
  }).join('');

  return '<section class="card">' + head + '</section>' +
         '<div class="grid">' + cards + '</div>';
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
  var view = window.VIEWS[tabId] || window.VIEWS.placeholder;
  document.getElementById('view').innerHTML = view(content);

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
