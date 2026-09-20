"""从老站单文件里机械提取可复用资产，搬进新站仓库。

提取四层：
  1. 决策内核（window.WHENG）      -> src/engine/decision_core.js
  2. 实时数据接入层（window.WHIO） -> src/engine/io.js
  3. 内嵌数据（window.HFDATA）     -> src/legacy/hfdata.js
  4. 六个页签的页面骨架 + 界面代码 -> src/legacy/tools.html / src/legacy/ui.js
并把老站 CSS 加作用域（前缀 .legacy-tool）-> src/styles/legacy.css
"""
import os
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

OLD = (r"D:\Codex\2026-08-06\ni\时代杯项目材料\08_交互演示\纯前端单文件版"
       r"\工业余热回收智能决策演示平台_v3_单文件.html")
NEW = (r"D:\Codex\2026-08-06\ni\时代杯项目材料\12_网站v4_实验版")


def read(path):
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)
    print(f"  写出 {os.path.relpath(path, NEW)}  {len(text)/1024:.1f} KB")


KEYFRAME_AT = ("@keyframes", "@-webkit-keyframes", "@-moz-keyframes")
NESTED_AT = ("@media", "@supports", "@layer", "@container")


def _match_brace(css, open_index):
    """返回与 css[open_index]=='{' 配对的 '}' 的下标。"""
    depth = 0
    for i in range(open_index, len(css)):
        if css[i] == "{":
            depth += 1
        elif css[i] == "}":
            depth -= 1
            if depth == 0:
                return i
    return len(css) - 1


def scope_css(css, scope):
    """给老 CSS 的选择器加作用域前缀。

    必须识别嵌套：@keyframes 的内容（from/to/百分比）不能加前缀，
    @media 内部要递归处理。
    """
    out = []
    i = 0
    while i < len(css):
        brace = css.find("{", i)
        if brace == -1:
            out.append(css[i:])
            break
        selector = css[i:brace].strip()
        end = _match_brace(css, brace)
        body = css[brace + 1:end]

        if selector.startswith(KEYFRAME_AT):
            out.append(f"{selector}{{{body}}}")
        elif selector.startswith(NESTED_AT):
            out.append(f"{selector}{{{scope_css(body, scope)}}}")
        elif selector.startswith("@"):
            out.append(f"{selector}{{{body}}}")
        else:
            parts = []
            for one in selector.split(","):
                one = one.strip()
                if not one:
                    continue
                if one in ("body", "html", ":root"):
                    parts.append(scope)
                elif one.startswith(scope):
                    parts.append(one)
                else:
                    parts.append(f"{scope} {one}")
            out.append(", ".join(parts) + "{" + body + "}")
        i = end + 1
    return "".join(out)


NAV_BINDING = ('document.querySelectorAll("nav button").forEach'
               '((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));')

# 必须用带 addEventListener("click") 的完整一行：不带它的话，
# loadCond() 函数体里也有一处同样的开头，会把包装器插进函数中间。
INIT_MARKER = ('document.querySelectorAll(".chips .chip[data-c]")'
               '.forEach((c) => c.addEventListener("click", () => {')

ADAPTER_HEAD = """/* ===== 新站适配层（自动生成，勿手改）=====
   老站的绑定与初始化原本在脚本顶层执行，那一套假设整个页面都是它自己的。
   在新站里它只是一个页签，所以：
     1) 导航绑定交给新站外壳（下面原 NAV_BINDING 那行已被移除）；
     2) 顶层初始化收进 initLegacyTools()，由新站首次打开工具页签时调用一次；
     3) LEGACY_ON_SHOW 复刻老站 switchTab 里的"切到某页要做的事"。
   ============================================ */
window.LEGACY_ON_SHOW = {
  calc: function () { calc(); },
  realtime: function () {
    if (rtLive.kind === "sim" && !rtLive.source) ioConnect();
  },
  pareto: function () { drawParetoTabs(); },
  lca: function () { drawLca(); },
  conds: function () { drawConds($("cond-search").value); },
  method: function () {}
};

window.initLegacyTools = function () {
  if (window.__legacyReady) { return; }
  var __host = document.getElementById("legacy-host");
  try {
"""

ADAPTER_TAIL = """
    window.__legacyReady = true;
    if (__host) { __host.setAttribute("data-legacy", "ready"); }
  } catch (err) {
    var msg = String((err && err.message) || err);
    window.__legacyError = msg;
    if (__host) { __host.setAttribute("data-legacy-error", msg); }
    if (window.console && window.console.error) {
      window.console.error("[legacy] 初始化失败：", err);
    }
  }
};
"""


def adapt_ui(js):
    """把老站界面代码改成可以被新站壳调用的形态。"""
    lines = [line for line in js.split("\n") if line.strip() != NAV_BINDING]
    text = "\n".join(lines)
    hits = text.count(INIT_MARKER)
    if hits != 1:
        raise SystemExit(f"初始化标记出现 {hits} 次（应为 1 次），中止")
    head, sep, tail = text.partition(INIT_MARKER)
    if NAV_BINDING in text:
        raise SystemExit("导航绑定未被移除，中止")
    return head + ADAPTER_HEAD + sep + tail + ADAPTER_TAIL


def main():
    html = read(OLD)
    scripts = re.findall(r"<script[^>]*>(.*?)</script>", html, re.S)
    styles = re.findall(r"<style[^>]*>(.*?)</style>", html, re.S)
    print(f"老站：script 块 {len(scripts)} 个，style 块 {len(styles)} 个")
    if len(scripts) < 4 or not styles:
        raise SystemExit("老站结构不符合预期，中止")

    write(os.path.join(NEW, "src", "engine", "decision_core.js"), scripts[0])
    write(os.path.join(NEW, "src", "engine", "io.js"), scripts[1])
    write(os.path.join(NEW, "src", "legacy", "hfdata.js"), scripts[2])
    write(os.path.join(NEW, "src", "legacy", "ui.js"), adapt_ui(scripts[3]))

    legacy_css = scope_css(styles[0], ".legacy-tool")
    legacy_css += (
        "\n/* 老站用 section.tab 切页；新站导航占用了 .tab，故改名为 .legacy-section */\n"
        ".legacy-tool .legacy-section{display:none}\n"
        ".legacy-tool .legacy-section.active{display:block;"
        "animation:fadeUp .35s ease both}\n")
    write(os.path.join(NEW, "src", "styles", "legacy.css"),
          "/* 自老站 v3 迁移，选择器已加 .legacy-tool 作用域 */\n" + legacy_css)

    sections = re.findall(
        r'<section class="tab[^"]*" id="(?P<id>[^"]+)"[^>]*>(?P<body>.*?)</section>',
        html, re.S)
    print(f"提取到 {len(sections)} 个页签骨架："
          + ", ".join(name for name, _ in sections))
    parts = ["<!-- 自老站 v3 迁移的六个功能页签骨架；外层由新站壳注入 -->"]
    for name, body in sections:
        parts.append(f'<section class="legacy-section" id="{name}">{body}</section>')
    write(os.path.join(NEW, "src", "legacy", "tools.html"), "\n".join(parts))

    return 0


if __name__ == "__main__":
    sys.exit(main())
