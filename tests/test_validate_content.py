"""内容模型校验的测试。

核心规则：没有"适用边界"（caveat）的证据条目不允许入库。
"""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
import validate_content  # noqa: E402


def _write(tmp_path, name, payload):
    path = tmp_path / name
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def _minimal(tmp_path):
    _write(tmp_path, "site.json", {"title": "T", "version": "1.0.0"})
    _write(tmp_path, "tabs.json", {"tabs": [
        {"id": "evidence", "title": "外部证据", "kind": "content"}]})
    _write(tmp_path, "evidence.json", {"items": []})
    _write(tmp_path, "calibration.json", {"status": "in-progress", "items": []})
    _write(tmp_path, "boundaries.json", {"items": []})
    _write(tmp_path, "changelog.json", {"entries": []})


def test_evidence_without_caveat_is_rejected(tmp_path):
    _minimal(tmp_path)
    _write(tmp_path, "evidence.json", {"items": [{
        "id": "x", "title": "标题", "value": "1", "scope": "范围",
        "source": "出处", "caveat": ""}]})
    with pytest.raises(validate_content.ContentError) as excinfo:
        validate_content.load_and_validate(str(tmp_path))
    assert "caveat" in str(excinfo.value)
    assert "x" in str(excinfo.value)


def test_calibration_bad_decision_is_rejected(tmp_path):
    _minimal(tmp_path)
    _write(tmp_path, "calibration.json", {"status": "in-progress", "items": [{
        "id": "c", "parameter": "P", "kernel_value": "1", "external": [],
        "finding": "f", "impact": "i", "decision": "maybe"}]})
    with pytest.raises(validate_content.ContentError) as excinfo:
        validate_content.load_and_validate(str(tmp_path))
    assert "decision" in str(excinfo.value)


def test_valid_content_passes(tmp_path):
    _minimal(tmp_path)
    _write(tmp_path, "evidence.json", {"items": [{
        "id": "x", "title": "标题", "value": "953 台", "scope": "范围",
        "source": "出处", "caveat": "无效率数据"}]})
    data = validate_content.load_and_validate(str(tmp_path))
    assert data["evidence"]["items"][0]["id"] == "x"
