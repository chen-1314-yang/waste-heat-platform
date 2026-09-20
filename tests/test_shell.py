"""页签外壳与路由测试。"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
import build  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
TAB_IDS = ["calc", "realtime", "pareto", "lca", "conds", "method",
           "evidence", "calibration", "boundaries", "changelog", "learning"]


def _single(tmp_path):
    result = build.build(os.path.join(ROOT, "content"),
                         os.path.join(ROOT, "src"), str(tmp_path))
    return open(result["single_file"], encoding="utf-8").read()


def test_all_eleven_tabs_registered(tmp_path):
    html = _single(tmp_path)
    for tab_id in TAB_IDS:
        assert f'"{tab_id}"' in html, f"页签 {tab_id} 未注册"


def test_router_functions_exist(tmp_path):
    html = _single(tmp_path)
    assert "window.renderTab" in html
    assert "window.currentTab" in html


def test_tab_titles_come_from_content(tmp_path):
    html = _single(tmp_path)
    assert "外部证据" in html and "校准工作台" in html
