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


def test_evidence_is_grouped_by_category(tmp_path):
    html = _single(tmp_path)
    assert "group-title" in html, "证据页应按类别分组"
    for category in ("数据集", "标准规范", "实测案例", "造价口径", "模型与工具"):
        assert category in html, f"缺少类别 {category}"


def test_evidence_item_count_is_visible(tmp_path):
    # "共 N 条" 是运行时拼的，静态产物里查不到字面串；
    # 改为直接核对内容文件本身。
    import json
    with open(os.path.join(ROOT, "content", "evidence.json"),
              encoding="utf-8") as handle:
        items = json.load(handle)["items"]
    assert len(items) == 16
    assert all(item.get("caveat") for item in items), "每条都必须有适用边界"
