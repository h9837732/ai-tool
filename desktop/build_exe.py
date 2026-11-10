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

    if "--keep-build" not in sys.argv:
        shutil.rmtree(WORK, ignore_errors=True)

    print("")
    print("完成: %s  (%.1f MB)" % (out, os.path.getsize(out) / 1048576.0))
    return 0


if __name__ == "__main__":
    sys.exit(main())
