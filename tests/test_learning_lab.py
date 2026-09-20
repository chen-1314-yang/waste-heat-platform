"""自主学习实验室的完整链路测试（提交 / 拒绝 / 接受 / 回滚 / 落盘形状）。"""
import json
import os
import shutil
import subprocess

import pytest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
HARNESS = os.path.join(ROOT, "tests", "js", "run_lab.js")


@pytest.fixture(scope="module")
def result():
    node = shutil.which("node")
    if not node:
        pytest.skip("环境里没有 node")
    proc = subprocess.run([node, HARNESS], capture_output=True, text=True,
                          encoding="utf-8")
    assert proc.returncode == 0, proc.stderr
    data = json.loads(proc.stdout)
    assert "error" not in data, data.get("error")
    return data


def test_bad_point_is_rejected_and_version_unchanged(result):
    assert result["badAccepted"] is False
    assert "G1" in result["badFailed"]
    assert result["versionAfterBad"] == "1.0.0"
    assert result["eventsAfterBad"] == 1


def test_good_point_is_accepted_and_version_bumps(result):
    assert result["goodAccepted"] is True
    assert result["versionAfterGood"] == "1.0.1"
    assert result["biasAfterGood"] > 0
    assert result["eventsAfterGood"] == 2


def test_events_persist_flat_not_nested(result):
    """本轮修掉的 bug：单 key 存列表时不能用 all() 读回，否则会套一层。"""
    assert result["eventsOnDisk"] == 2
    assert result["eventsOnDiskShape"] == "flat"
    assert result["allShape"] == "nested", "all() 的返回形状变了，读法需复核"


def test_snapshot_written_before_update(result):
    assert result["snapshotsOnDisk"] >= 1


def test_rollback_restores_previous_version(result):
    assert result["rollbackOk"] is True
    assert result["versionAfterRollback"] == "1.0.0"
    assert result["eventsAfterRollback"] == 3


def test_rollback_to_missing_version_fails(result):
    assert result["rollbackMissing"] is False
