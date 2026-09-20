"""把站点构建产物发布到 GitHub Pages。

做三件事：重新构建 -> 把 dist/site 的内容放进 gh-pages 分支 -> 推送。
令牌从 ~/.config/github/deploy_token.txt 读取（项目外，不进 git）。

用法：
    python tools/deploy.py
"""
import os
import shutil
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
TOKEN_PATH = os.path.join(os.path.expanduser("~"), ".config", "github",
                          "deploy_token.txt")
REPO = "chen-1314-yang/waste-heat-platform"
BRANCH = "gh-pages"


def _run(args, cwd=None, check=True):
    result = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    if check and result.returncode != 0:
        raise RuntimeError(f"{' '.join(args)}\n{result.stdout}\n{result.stderr}")
    return result


def _push_with_retry(cwd, proxy_args, attempts=4, delay=8):
    """推送失败就退避重试（本机到 github.com 的连接不稳定）。"""
    args = (["git", "-c", "credential.helper=", "-c", "core.askPass="]
            + proxy_args + ["push", "-q", "origin", BRANCH])
    last = None
    for attempt in range(1, attempts + 1):
        result = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
        if result.returncode == 0:
            if attempt > 1:
                print(f"     第 {attempt} 次尝试推送成功。")
            return
        last = result
        print(f"     推送失败（第 {attempt}/{attempts} 次），{delay} 秒后重试 ...")
        time.sleep(delay)
    raise RuntimeError(f"{' '.join(args)}\n{last.stdout}\n{last.stderr}")


def _read_token():
    if not os.path.exists(TOKEN_PATH):
        raise RuntimeError(f"找不到令牌文件：{TOKEN_PATH}")
    with open(TOKEN_PATH, encoding="utf-8") as handle:
        token = handle.read().strip()
    if not token:
        raise RuntimeError(f"令牌文件为空：{TOKEN_PATH}")
    return token


def _system_proxy():
    """读 Windows 的代理设置。

    本机 git 直连 github.com:443 不通，必须走系统代理；而 git 不读 WinINET 设置，
    所以要显式告诉它。代理关掉时返回空串，git 就走直连。
    """
    try:
        import winreg
    except ImportError:
        return ""
    try:
        path = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings"
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path) as key:
            enabled, _ = winreg.QueryValueEx(key, "ProxyEnable")
            server, _ = winreg.QueryValueEx(key, "ProxyServer")
    except OSError:
        return ""
    if not enabled or not server:
        return ""
    return server if "://" in server else "http://" + server


def _clear_worktree(path):
    for name in os.listdir(path):
        if name == ".git":
            continue
        target = os.path.join(path, name)
        if os.path.isdir(target):
            shutil.rmtree(target)
        else:
            os.remove(target)


def main():
    token = _read_token()
    proxy = _system_proxy()
    proxy_args = (["-c", f"http.proxy={proxy}", "-c", f"https.proxy={proxy}"]
                  if proxy else [])
    remote = f"https://{token}@github.com/{REPO}.git"
    if proxy:
        print(f"     检测到系统代理 {proxy}，git 将通过它访问 GitHub。")
    fetch_remote = f"https://github.com/{REPO}.git"

    print("1/4 构建站点 ...")
    result = build.build(os.path.join(ROOT, "content"), os.path.join(ROOT, "src"),
                         os.path.join(ROOT, "dist"))
    site_dir = result["site_dir"]

    tmp = tempfile.mkdtemp(prefix="whp_deploy_")
    try:
        print("2/4 准备发布分支 ...")
        _run(["git", "clone", "--quiet", ROOT, tmp])
        _run(["git", "remote", "set-url", "origin", remote], cwd=tmp)

        fetched = _run(["git"] + proxy_args + ["fetch", "--quiet", "origin", BRANCH],
                       cwd=tmp, check=False)
        if fetched.returncode == 0:
            _run(["git", "checkout", "--quiet", "-B", BRANCH, "FETCH_HEAD"], cwd=tmp)
        else:
            _run(["git", "checkout", "--quiet", "--orphan", BRANCH], cwd=tmp)
        _clear_worktree(tmp)

        for name in os.listdir(site_dir):
            source = os.path.join(site_dir, name)
            target = os.path.join(tmp, name)
            if os.path.isdir(source):
                shutil.copytree(source, target)
            else:
                shutil.copy2(source, target)

        print("3/4 提交并推送 ...")
        _run(["git", "add", "-A"], cwd=tmp)
        diff = _run(["git", "status", "--porcelain"], cwd=tmp)
        if not diff.stdout.strip():
            print("     构建产物没有变化，无需推送。")
            return 0
        _run(["git", "-c", "user.name=chen-1314-yang",
              "-c", "user.email=chen-1314-yang@users.noreply.github.com",
              "commit", "-q", "-m", "deploy: 更新站点构建产物"], cwd=tmp)
        _push_with_retry(tmp, proxy_args)
        print("4/4 完成。")
        print(f"     网址：https://{REPO.split('/')[0]}.github.io/{REPO.split('/')[1]}/")
        print("     注意：GitHub Pages 需要约 1 分钟重新构建，稍等再刷新。")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
