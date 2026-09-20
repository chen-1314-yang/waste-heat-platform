window.VIEWS = window.VIEWS || {};

document.addEventListener('DOMContentLoaded', function () {
  var nav = document.getElementById('tabs');
  var tabs = window.__CONTENT__.tabs;
  var out = '';
  for (var i = 0; i < tabs.length; i++) {
    out += '<button class="tab" data-tab="' + tabs[i].id + '">' +
           tabs[i].title + '</button>';
  }
  nav.innerHTML = out;
});
