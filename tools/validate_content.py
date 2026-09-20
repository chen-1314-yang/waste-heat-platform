"""内容文件校验。

规则来自设计文档：**没有"适用边界"（caveat）的证据条目不允许入库**。
这样做的目的是防止以后自己或别人误用外部数据。
"""
import json
import os

DECISIONS = {"pending", "accepted", "rejected"}
KINDS = {"content", "placeholder", "tool"}

REQUIRED = {
    "evidence_item": ("id", "title", "value", "scope", "source", "caveat"),
    "calibration_item": ("id", "parameter", "kernel_value", "external",
                         "finding", "impact", "decision"),
    "boundary_item": ("item", "scope", "grade"),
    "changelog_entry": ("date", "version", "title", "changes",
                        "relative_to_prior"),
}


class ContentError(Exception):
    """内容不合规。"""


def _read(content_dir, name):
    path = os.path.join(content_dir, name)
    if not os.path.exists(path):
        raise ContentError(f"{name}: 文件不存在")
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except json.JSONDecodeError as exc:
        raise ContentError(f"{name}: JSON 解析失败（{exc}）") from exc


def _check_list(payload, key, kind, filename):
    items = payload.get(key)
    if not isinstance(items, list):
        raise ContentError(f"{filename}: 缺少列表字段 {key}")
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            raise ContentError(f"{filename}[{index}]: 不是对象")
        ident = item.get("id") or item.get("item") or f"#{index}"
        for field in REQUIRED[kind]:
            value = item.get(field)
            if value is None or (isinstance(value, str) and not value.strip()):
                raise ContentError(f"{filename}[{ident}]: 字段 {field} 为空或缺失")
        if kind == "calibration_item" and item["decision"] not in DECISIONS:
            raise ContentError(
                f"{filename}[{ident}]: decision 只能是 {sorted(DECISIONS)}，"
                f"当前为 {item['decision']!r}")
        if kind == "changelog_entry" and not isinstance(item["changes"], list):
            raise ContentError(f"{filename}[{ident}]: changes 必须是列表")
    return items


def _check_tabs(payload):
    tabs = payload.get("tabs")
    if not isinstance(tabs, list) or not tabs:
        raise ContentError("tabs.json: 缺少非空 tabs 列表")
    for index, tab in enumerate(tabs):
        if not isinstance(tab, dict):
            raise ContentError(f"tabs.json[{index}]: 不是对象")
        for field in ("id", "title", "kind"):
            if not str(tab.get(field, "")).strip():
                raise ContentError(f"tabs.json[{index}]: 字段 {field} 缺失")
        if tab["kind"] not in KINDS:
            raise ContentError(
                f"tabs.json[{tab['id']}]: kind 只能是 {sorted(KINDS)}")
    seen = set()
    for tab in tabs:
        if tab["id"] in seen:
            raise ContentError(f"tabs.json: 页签 id 重复：{tab['id']}")
        seen.add(tab["id"])
    return tabs


def load_and_validate(content_dir):
    site = _read(content_dir, "site.json")
    for field in ("title", "version"):
        if not str(site.get(field, "")).strip():
            raise ContentError(f"site.json: 字段 {field} 为空或缺失")

    tabs = _check_tabs(_read(content_dir, "tabs.json"))

    evidence = _read(content_dir, "evidence.json")
    _check_list(evidence, "items", "evidence_item", "evidence.json")

    calibration = _read(content_dir, "calibration.json")
    _check_list(calibration, "items", "calibration_item", "calibration.json")

    boundaries = _read(content_dir, "boundaries.json")
    _check_list(boundaries, "items", "boundary_item", "boundaries.json")

    changelog = _read(content_dir, "changelog.json")
    _check_list(changelog, "entries", "changelog_entry", "changelog.json")

    return {"site": site, "tabs": tabs, "evidence": evidence,
            "calibration": calibration, "boundaries": boundaries,
            "changelog": changelog}
