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
