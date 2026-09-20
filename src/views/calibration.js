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
