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
