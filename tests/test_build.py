"""构建管线的测试：一次构建产出两种产物，且单文件自足。"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
import build  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def _run(tmp_path):
    return build.build(os.path.join(ROOT, "content"),
                       os.path.join(ROOT, "src"), str(tmp_path))


def test_build_produces_two_artifacts(tmp_path):
    result = _run(tmp_path)
    assert os.path.isfile(os.path.join(result["site_dir"], "index.html"))
    assert os.path.isfile(result["single_file"])


def test_site_index_carries_content(tmp_path):
    result = _run(tmp_path)
    html = open(os.path.join(result["site_dir"], "index.html"),
                encoding="utf-8").read()
    assert "外部证据" in html
    assert "953 台" in html


def test_single_file_is_self_contained(tmp_path):
    result = _run(tmp_path)
    html = open(result["single_file"], encoding="utf-8").read()
    assert "<style>" in html
    assert 'src="./assets' not in html
