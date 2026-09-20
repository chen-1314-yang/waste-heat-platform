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
