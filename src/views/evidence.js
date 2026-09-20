window.VIEWS = window.VIEWS || {};

window.VIEWS.evidence = function (content) {
  var items = content.evidence.items || [];
  var head = '<h2>外部证据</h2>' +
    '<p class="muted small">路演之后分四轮检索得到的外部数据与标准，共 ' +
    items.length + ' 条。' +
    '<strong>每条都标注了适用边界</strong>——这是为了防止这些数据被误用。</p>';

  if (!items.length) {
    return '<section class="card">' + head + '<p class="muted">暂无条目</p></section>';
  }

  function cardHtml(item) {
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
  }

  // 按类别分组，保持 category 在 items 里首次出现的顺序
  var order = [];
  var groups = {};
  items.forEach(function (item) {
    var key = item.category || "其他";
    if (!groups[key]) { groups[key] = []; order.push(key); }
    groups[key].push(item);
  });

  var sections = order.map(function (key) {
    var cards = groups[key].map(cardHtml).join('');
    return '<h3 class="group-title">' + window.esc(key) +
           '<span class="muted small"> · ' + groups[key].length + ' 条</span></h3>' +
           '<div class="grid">' + cards + '</div>';
  }).join('');

  return '<section class="card">' + head + '</section>' + sections;
};
