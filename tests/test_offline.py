"""离线自足性与体积预算校验。

单文件版必须完全自足：不加载任何外部资源（script src / link href /
@import url / url(http）。正文里的来源链接（<a href="https://…">）是内容，
不是加载资源，允许保留。
"""
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
import build  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def _build(tmp_path):
    return build.build(os.path.join(ROOT, "content"),
                       os.path.join(ROOT, "src"), str(tmp_path))


def test_no_external_subresources(tmp_path):
    html = open(_build(tmp_path)["single_file"], encoding="utf-8").read()
    for pattern in (r'<script[^>]+src="https?://',
                    r'<link[^>]+href="https?://',
                    r"@import\s+url\(",
                    r"url\(https?://"):
        assert not re.search(pattern, html, re.I), f"发现外部资源：{pattern}"


def test_single_file_self_contained(tmp_path):
    html = open(_build(tmp_path)["single_file"], encoding="utf-8").read()
    assert "<style>" in html
    assert html.count("<script") >= 2
    assert "window.__CONTENT__" in html


def test_single_file_size_budget(tmp_path):
    path = _build(tmp_path)["single_file"]
    size_kb = os.path.getsize(path) / 1024
    assert size_kb < 400, f"单文件 {size_kb:.0f} KB 超出预算 400 KB"
