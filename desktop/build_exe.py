# -*- coding: utf-8 -*-
"""钥匙 · 电脑端 —— 生成 exe 的打包脚本。

为什么不直接在 bat 里写长串 pyinstaller 命令：
1. 本机 Python 装在 C:\\Users\\苗新田\\...，中文路径一进命令行 argv 就被
   编码搞坏（--add-data 会报「Unable to find ...」）。用 spec 文件由 Python
   自己算路径，绕开 argv。
2. PyInstaller 的 PyQt5 钩子在这个中文路径下必崩（plugin dir does not exist），
   所以必须排除 Qt —— pywebview 只走 edgechromium 后端，不需要 Qt。

用法：
    py desktop/build_exe.py              # 正常打包
    py desktop/build_exe.py --keep-build # 保留中间产物，方便排查
"""
import os
import shutil
import subprocess
import sys
import sysconfig

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BUILD_PY = os.path.join(HERE, "钥匙-打包用.py")
DIST = os.path.join(HERE, "dist")
WORK = os.path.join(ROOT, "build", "keyapp")
SPEC = os.path.join(WORK, "钥匙.spec")

APP_NAME = "钥匙"


def site_packages():
    return sysconfig.get_paths()["purelib"]


def webview_lib():
    """pywebview 自带的 WebView2 DLL 目录。"""
    cand = os.path.join(site_packages(), "webview", "lib")
    if not os.path.isdir(cand):
        raise SystemExit("找不到 webview/lib，先 py -m pip install pywebview")
    return cand


def write_spec():
    lib = webview_lib()
    code = '''# -*- mode: python ; coding: utf-8 -*-
import os

block_cipher = None

a = Analysis(
    [%(script)r],
    pathex=[],
    binaries=[],
    datas=[(%(lib)r, 'webview/lib')],
    hiddenimports=[
        'webview.platforms.edgechromium',
        'clr',
        'pythonnet',
        'clr_loader',
        # 驱动 DPAPI 的密钥模块：它是在函数里惰性 import 的，
        # 静态分析能找到，但显式写上更保险（少它的话加密会静默降级成明文）
        'secure_store',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # 中文路径下 PyQt5 钩子必崩，而且我们只用 WebView2，不需要 Qt
        'PyQt5', 'PyQt6', 'PySide2', 'PySide6', 'qtpy',
        'webview.platforms.qt', 'webview.platforms.gtk',
        'webview.platforms.cef', 'webview.platforms.mshtml',
        'webview.platforms.android', 'webview.platforms.cocoa',
        'tkinter.test', 'test',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name=%(name)r,
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    icon=%(icon)r if os.path.isfile(%(icon)r) else None,
)
''' % {
        "script": BUILD_PY,
        "lib": lib,
        "name": APP_NAME,
        "icon": os.path.join(HERE, "icon.ico"),
    }
    os.makedirs(WORK, exist_ok=True)
    with open(SPEC, "w", encoding="utf-8", newline="\n") as f:
        f.write(code)
    return SPEC


def iter_toc_text(work):
    """把 work 目录下所有 .toc 的内容读出来。

    PyInstaller 把 TOC 放在 WORK/<应用名>/ 里，不是 WORK 顶层，
    所以必须递归找 —— 以前只扫顶层，等于永远查不到东西。"""
    if not os.path.isdir(work):
        return
    for root, _dirs, files in os.walk(work):
        for name in files:
            if not name.endswith(".toc"):
                continue
            try:
                with open(os.path.join(root, name), "r", encoding="utf-8", errors="ignore") as f:
                    yield os.path.join(root, name), f.read()
            except Exception:
                continue


def assert_no_qt(dist_exe, work):
    """D12 的闸门：确保 Qt 没被偷偷打进去。

    本机 Python 装在 C:\\Users\\苗新田\\...，PyInstaller 的 PyQt5 钩子
    解这种路径会崩（'C:/Users/???/...Qt5/plugins does not exist'）。
    以前只是 excludes 挡着，万一以后有个 --collect-all 把 Qt 拉进来，
    打包会以一个看不懂的错误失败。这里直接说清楚原因。"""
    hits = []

    # 只认真实的 DLL 名和真实路径片段。
    # 不能只搜 "PyQt5"：Analysis-00.toc 里就带着我们自己的 excludes 清单，
    # 里面明写着 'PyQt5'，那样会把自己的配置当成污染。
    QT_TOKENS = (
        "Qt5Core.dll", "Qt6Core.dll",
        "/PyQt5/", "\\PyQt5\\", "/PyQt6/", "\\PyQt6\\",
        "/PySide2/", "\\PySide2\\", "/PySide6/", "\\PySide6\\",
        "Qt5/plugins", "Qt6/plugins",
    )
    for path, txt in iter_toc_text(work):
        for token in QT_TOKENS:
            if token in txt:
                hits.append(token + " @ " + os.path.basename(os.path.dirname(path)) + "/" + os.path.basename(path))

    try:
        with open(dist_exe, "rb") as f:
            blob = f.read()
        for token in (b"Qt5Core.dll", b"Qt6Core.dll"):
            if token in blob:
                hits.append(token.decode() + " @ exe")
    except Exception:
        pass

    if hits:
        print("")
        print("!! 打包结果里混进了 Qt：" + ", ".join(sorted(set(hits))))
        print("   本机路径含中文，Qt 钩子在此环境下会崩，也会让体积膨胀几十 MB。")
        print("   检查是不是加了 --collect-all / --hidden-import 把 Qt 拉了进来。")
        return False
    return True


def non_ascii_path_note():
    """路径含中文时打个提醒。不是错误，我们已经有对策。"""
    sp = site_packages()
    if all(ord(c) < 128 for c in sp):
        return
    print("")
    print("注意：Python 站点包路径含非 ASCII 字符")
    print("   " + sp)
    print("   已自动排除全部 Qt（PyQt/PySide），不要加 --collect-all webview。")


def pkg_version():
    import json
    try:
        with open(os.path.join(ROOT, "package.json"), "r", encoding="utf-8") as f:
            return str(json.load(f).get("version") or "")
    except Exception:
        return ""


def assert_version_baked():
    """确保要打包的 .py 里已经写入了当前版本号。
    （A1 的根因：改了 package.json 却没重跑 embed_assets，
    exe 里的版本停在旧版，界面永远提示「发现新版本」。）"""
    import re
    want = pkg_version()
    if not want:
        raise SystemExit("读不到 package.json 的 version")
    try:
        with open(BUILD_PY, "r", encoding="utf-8", errors="ignore") as f:
            head = f.read(4000)
    except Exception as e:
        raise SystemExit("读不到 %s: %s" % (BUILD_PY, e))
    m = re.search(r'APP_VERSION = "([^"]*)"', head)
    got = m.group(1) if m else ""
    if got != want:
        raise SystemExit(
            "版本号不一致，先跑 py desktop/embed_assets.py\n"
            "   package.json          %s\n   钥匙-打包用.py  %s" % (want, got or "(缺失)"))
    print("版本     : %s" % want)


def assert_secure_store(dist_exe, work):
    """确认 DPAPI 那个模块真的进包了。

    少它不会崩，只会静默退回明文存密钥 —— 这种“降级失败”最难发现，
    所以打包时直接查一下。"""
    hits = []
    for path, txt in iter_toc_text(work):
        if "secure_store" in txt:
            hits.append(os.path.basename(path))
    if not hits:
        print("")
        print("!! 打包结果里没有 secure_store，密钥会降级成明文存储")
        return False
    return True


def main():
    if not os.path.isfile(BUILD_PY):
        raise SystemExit("缺 %s，先跑 py desktop/embed_assets.py" % BUILD_PY)

    size = os.path.getsize(BUILD_PY)
    if size < 60000:
        raise SystemExit(
            "%s 只有 %d 字节，界面没内嵌进去。先跑 py desktop/embed_assets.py"
            % (BUILD_PY, size)
        )

    spec = write_spec()
    os.makedirs(DIST, exist_ok=True)

    assert_version_baked()
    non_ascii_path_note()

    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm",
        "--distpath", DIST,
        "--workpath", WORK,
        spec,
    ]
    print("打包中（约 1-2 分钟）...")
    rc = subprocess.call(cmd)
    if rc != 0:
        raise SystemExit("PyInstaller 失败，退出码 %d" % rc)

    out = os.path.join(DIST, APP_NAME + ".exe")
    if not os.path.isfile(out):
        raise SystemExit("没生成 %s" % out)

    ok = assert_no_qt(out, WORK)
    ok_secure = assert_secure_store(out, WORK)

    if "--keep-build" not in sys.argv:
        shutil.rmtree(WORK, ignore_errors=True)

    if not ok or not ok_secure:
        raise SystemExit("打包结果不合格，已中止")

    print("")
    print("完成: %s  (%.1f MB)" % (out, os.path.getsize(out) / 1048576.0))
    return 0


if __name__ == "__main__":
    sys.exit(main())
