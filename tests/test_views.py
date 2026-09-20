"""四个内容页签的渲染测试。"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
import build  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def _single(tmp_path):
    result = build.build(os.path.join(ROOT, "content"),
                         os.path.join(ROOT, "src"), str(tmp_path))
    return open(result["single_file"], encoding="utf-8").read()


def test_evidence_view_registered(tmp_path):
    html = _single(tmp_path)
    assert "VIEWS.evidence" in html or 'VIEWS["evidence"]' in html


def test_calibration_shows_pending_badge(tmp_path):
    html = _single(tmp_path)
    assert "待定" in html, "校准页必须把未拍板项显示为待定"


def test_boundaries_view_registered(tmp_path):
    html = _single(tmp_path)
    assert "VIEWS.boundaries" in html or 'VIEWS["boundaries"]' in html


def test_changelog_view_registered(tmp_path):
    html = _single(tmp_path)
    assert "VIEWS.changelog" in html or 'VIEWS["changelog"]' in html


def test_evidence_caveat_is_rendered(tmp_path):
    html = _single(tmp_path)
    assert "适用边界" in html, "证据条目必须把适用边界显示出来"
