"""把 content/ 与 src/ 合成两种产物：多文件站点 + 单文件 HTML。

两种产物共用同一份内容与代码，因此不可能出现"线上版与单文件版不一致"。
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import validate_content  # noqa: E402

SINGLE_NAME = "工业余热回收_新版_单文件.html"
STYLE_FILES = ["tokens.css", "base.css", "components.css", "legacy.css"]
SCRIPT_FILES = [
    # 顺序有依赖：内核与数据必须先于老站界面代码
    "util.js",
    "engine/decision_core.js",
    "engine/io.js",
    "legacy/hfdata.js",
    "legacy/ui.js",
    "legacy/adapter.js",
    "views/placeholder.js",
    "views/evidence.js",
    "views/calibration.js",
    "views/boundaries.js",
    "views/changelog.js",
    "app.js",
]
LEGACY_MARKUP = "legacy/tools.html"


def _read(path):
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def build(content_dir, src_dir, out_dir):
    data = validate_content.load_and_validate(content_dir)
    os.makedirs(out_dir, exist_ok=True)

    css = "\n".join(_read(os.path.join(src_dir, "styles", name))
                    for name in STYLE_FILES)
    js = "\n".join(_read(os.path.join(src_dir, name)) for name in SCRIPT_FILES)
    template = _read(os.path.join(src_dir, "index.html"))
    legacy = _read(os.path.join(src_dir, LEGACY_MARKUP))

    payload = json.dumps(data, ensure_ascii=False)
    title = data["site"]["title"]
    banner = data["site"].get("banner", "")

    common = (template
              .replace("__SITE_TITLE__", title)
              .replace("__SITE_BANNER__", banner)
              .replace("__CONTENT_JSON__", payload)
              .replace("<!--__LEGACY__-->", legacy))

    multi = (common
             .replace("<!--__STYLE__-->",
                      '<link rel="stylesheet" href="./assets/style.css">')
             .replace("<!--__SCRIPT__-->",
                      '<script src="./assets/app.js"></script>'))

    single = (common
              .replace("<!--__STYLE__-->", "<style>\n" + css + "\n</style>")
              .replace("<!--__SCRIPT__-->", "<script>\n" + js + "\n</script>"))

    site_dir = os.path.join(out_dir, "site")
    os.makedirs(os.path.join(site_dir, "assets"), exist_ok=True)
    with open(os.path.join(site_dir, "index.html"), "w", encoding="utf-8") as handle:
        handle.write(multi)
    with open(os.path.join(site_dir, "assets", "style.css"), "w",
              encoding="utf-8") as handle:
        handle.write(css)
    with open(os.path.join(site_dir, "assets", "app.js"), "w",
              encoding="utf-8") as handle:
        handle.write(js)

    single_path = os.path.join(out_dir, SINGLE_NAME)
    with open(single_path, "w", encoding="utf-8") as handle:
        handle.write(single)

    return {"site_dir": site_dir, "single_file": single_path}


if __name__ == "__main__":
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    result = build(os.path.join(root, "content"), os.path.join(root, "src"),
                   os.path.join(root, "dist"))
    for key, value in result.items():
        size = os.path.getsize(value) / 1024 if os.path.isfile(value) else 0
        print(f"{key}: {value}  {size:.1f} KB")
