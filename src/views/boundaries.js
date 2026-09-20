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
