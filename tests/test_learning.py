"""自主学习实验室的门控与模型测试。

门控是纯函数，放在 node 里跑；pytest 负责判断结果。
"""
import json
import os
import shutil
import subprocess
import sys

import pytest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
HARNESS = os.path.join(ROOT, "tests", "js", "run_gates.js")


@pytest.fixture(scope="module")
def result():
    node = shutil.which("node")
    if not node:
        pytest.skip("环境里没有 node，跳过门控测试")
    proc = subprocess.run([node, HARNESS], capture_output=True, text=True,
                          encoding="utf-8")
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


def _build(tmp_path):
    sys.path.insert(0, os.path.join(ROOT, "tools"))
    import build
    return build.build(os.path.join(ROOT, "content"), os.path.join(ROOT, "src"),
                       str(tmp_path))


def test_baseline_prediction_in_range(result):
    assert 87.0 <= result["baselineAt200"] <= 104.5


def test_baseline_has_known_violations(result):
    """基准表本身的单调性逆序数——数据既有事实，锁住它防止被误改。"""
    assert result["violationsBase"] == 16


def test_calibration_set_present(result):
    assert result["calibrationSetSize"] == 14
    assert result["calibrationErrorBase"] is not None


def test_baseline_passes_all_gates(result):
    assert result["g1Baseline"]["passed"] is True


def test_domain_gate_rejects_out_of_range(result):
    assert result["g4InDomain"]["pass"] is True
    assert result["g4OutDomain"]["pass"] is False
    assert result["g4BelowDomain"]["pass"] is False


def test_reasonable_update_passes_all_gates(result):
    assert result["goodUpdate"]["passed"] is True
    assert result["goodUpdate"]["failed"] == []


def test_physically_impossible_update_is_rejected(result):
    assert result["badUpdate"]["passed"] is False
    assert "G1" in result["badUpdate"]["failed"]


def test_mild_update_is_allowed(result):
    """正常量级的偏差不该被拦住——门控要拦的是离谱值。"""
    assert result["mildUpdate"]["passed"] is True


def test_extreme_degradation_is_caught(result):
    """效率被拉向 0 时不违反上限，但会破坏校准，G5 必须拦住。"""
    assert result["extremeUpdate"]["passed"] is False
    assert "G5" in result["extremeUpdate"]["failed"]


def test_learning_modules_are_bundled(tmp_path):
    html = open(_build(tmp_path)["single_file"], encoding="utf-8").read()
    for marker in ("window.WHLAB_MODEL", "window.WHLAB_GATES",
                   "window.WHLAB_STORE", "window.WHLAB ", "VIEWS.learning",
                   "VIEW_AFTER.learning"):
        assert marker in html, f"缺少 {marker}"


def test_boundary_notice_is_rendered(tmp_path):
    """三条边界声明必须出现在产物里，不能只写在文档中。"""
    html = open(_build(tmp_path)["single_file"], encoding="utf-8").read()
    assert "只存在于你这一台浏览器" in html
    assert "交付版不含本功能" in html
    assert "故意的" in html
    assert "受限自主更新" in html
