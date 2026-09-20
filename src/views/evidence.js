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
