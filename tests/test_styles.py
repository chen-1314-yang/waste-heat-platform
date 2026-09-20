"""样式系统测试：令牌齐全、无外部字体、组件选择器存在。"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
import build  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
TOKENS = ["--bg", "--ink", "--accent", "--blue", "--gold", "--red"]


def _css(tmp_path):
    result = build.build(os.path.join(ROOT, "content"),
                         os.path.join(ROOT, "src"), str(tmp_path))
    return open(os.path.join(result["site_dir"], "assets", "style.css"),
                encoding="utf-8").read()


def test_tokens_present(tmp_path):
    css = _css(tmp_path)
    for token in TOKENS:
        assert token in css, f"缺少样式令牌 {token}"


def test_no_remote_font_or_import(tmp_path):
    css = _css(tmp_path)
    assert "@import" not in css
    assert "url(http" not in css


def test_component_selectors_exist(tmp_path):
    css = _css(tmp_path)
    for selector in (".tabs", ".tab", ".card", ".stat", ".chip"):
        assert selector in css, f"缺少选择器 {selector}"
