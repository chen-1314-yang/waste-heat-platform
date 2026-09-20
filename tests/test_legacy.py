"""老站六个功能页签迁移的校验。

这些测试锁住三件事，防止以后改动悄悄破坏迁移：
  1. 四层资产确实进了构建产物；
  2. 六个页签骨架都在，且新站导航没有占用老站的 .tab 语义；
  3. 老站 CSS 已加作用域，不会污染新站样式。
"""
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
import build  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
LEGACY_SECTIONS = ["tab-calc", "tab-realtime", "tab-pareto", "tab-lca",
                   "tab-conds", "tab-method"]


def _single(tmp_path):
    result = build.build(os.path.join(ROOT, "content"),
                         os.path.join(ROOT, "src"), str(tmp_path))
    return open(result["single_file"], encoding="utf-8").read()


def _css(tmp_path):
    result = build.build(os.path.join(ROOT, "content"),
                         os.path.join(ROOT, "src"), str(tmp_path))
    return open(os.path.join(result["site_dir"], "assets", "style.css"),
                encoding="utf-8").read()


def test_engine_and_data_are_bundled(tmp_path):
    html = _single(tmp_path)
    for marker in ("window.WHENG", "window.WHIO", "window.HFDATA"):
        assert marker in html, f"缺少老站资产：{marker}"


def test_adapter_is_bundled(tmp_path):
    html = _single(tmp_path)
    assert "window.showLegacyTool" in html
    assert "window.isLegacyTool" in html
    assert "window.LEGACY_ON_SHOW" in html


def test_six_legacy_sections_present(tmp_path):
    html = _single(tmp_path)
    for section_id in LEGACY_SECTIONS:
        assert f'id="{section_id}"' in html, f"缺少页签骨架 {section_id}"


def test_nav_binding_is_removed_from_legacy_ui(tmp_path):
    """老站的导航绑定必须移除，否则它会把新站的导航按钮当成自己的。"""
    ui = open(os.path.join(ROOT, "src", "legacy", "ui.js"),
              encoding="utf-8").read()
    nav_binding = ('document.querySelectorAll("nav button")'
                   '.forEach((b) => b.addEventListener("click"')
    assert nav_binding not in ui
    assert "window.initLegacyTools = function () {" in ui


def test_legacy_css_is_scoped(tmp_path):
    # 只看老站那一份：合并产物里的 body{} 是新站自己的规则，属合法
    css = open(os.path.join(ROOT, "src", "styles", "legacy.css"),
               encoding="utf-8").read()
    assert ".legacy-tool .legacy-section" in css
    # 未加作用域的裸 body / section.tab 规则不应存在
    assert not re.search(r"(^|\})\s*body\s*\{", css), "存在未加作用域的 body 规则"
    assert not re.search(r"(^|\})\s*section\.tab\s*\{", css), "存在未加作用域的 section.tab"


def test_keyframes_not_broken_by_scoping(tmp_path):
    css = _css(tmp_path)
    assert re.search(r"@keyframes fadeUp\s*\{\s*from\s*\{", css), "keyframes 被作用域破坏"
    assert "legacy-tool to" not in css, "作用域前缀穿透进了 keyframes"
