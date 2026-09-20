/* 新站壳 <-> 老站工具 的桥接层。

老站那六个页签（计算/实时模拟/帕累托/LCA/工况库/方法说明）整体搬了过来，
但它们假设"整个页面都是自己的"。这一层负责：
  1. 新站切到工具页签时，把对应的 legacy-section 显示出来；
  2. 首次进入时调用 initLegacyTools() 一次（老站的绑定与初始化在里面）；
  3. 之后每次进入调用 LEGACY_ON_SHOW[页签]（复刻老站切页时要做的重算）。
*/

window.LEGACY_TOOL_IDS = ["calc", "realtime", "pareto", "lca", "conds", "method"];

window.isLegacyTool = function (tabId) {
  return window.LEGACY_TOOL_IDS.indexOf(tabId) >= 0;
};

window.showLegacyTool = function (tabId) {
  var host = document.getElementById("legacy-host");
  if (!host) { return; }

  var sections = host.querySelectorAll(".legacy-section");
  for (var i = 0; i < sections.length; i++) {
    var on = sections[i].id === "tab-" + tabId;
    if (on) {
      sections[i].classList.add("active");
    } else {
      sections[i].classList.remove("active");
    }
  }

  if (typeof window.initLegacyTools === "function") {
    window.initLegacyTools();
  }
  var hook = window.LEGACY_ON_SHOW && window.LEGACY_ON_SHOW[tabId];
  if (typeof hook === "function") {
    hook();
  }
};
