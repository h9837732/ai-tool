# -*- coding: utf-8 -*-
"""把前端文件压进 keyapp_desktop.py，生成可以直接打包的单文件。

用法：
    py desktop/embed_assets.py

输出：
    desktop/钥匙-打包用.py    ← 交给 Builder 打包的就是这个（名字带中文，不会选错）

为什么要内嵌：Builder 调 PyInstaller 时没有 --add-data，
所以前端必须以数据形式写在 .py 里，否则 exe 里没有界面。
"""

import base64
import io
import json
import os
import re
import sys

# 控制台编码兜底：CI（以及某些 Windows 环境的）stdout 是 cp1252/ascii，
# 直接 print 中文会抛 UnicodeEncodeError 把整个构建弄挂。
# 只放宽 errors，不改编码 —— 本地 GBK 能显示中文，行为不变。
for _stream in (sys.stdout, sys.stderr):
    try:
        _enc = (_stream.encoding or "").lower().replace("-", "")
        if _enc not in ("utf8", "utf8mb4"):
            _stream.reconfigure(errors="replace")
    except Exception:
        pass
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)

# 优先用 www/（build.mjs 的产物，含生成的 version.js），否则回落到根目录
CANDIDATES = [
    os.path.join(PROJECT, "www"),
    PROJECT,
]

INCLUDE_DIRS = ["css", "js"]
INCLUDE_FILES = ["index.html", "icon.svg", "manifest.webmanifest", "sw.js"]


def pick_root():
    for root in CANDIDATES:
        if os.path.isfile(os.path.join(root, "index.html")):
            js = os.path.join(root, "js", "app.js")
            if os.path.isfile(js):
                return root
    return None


def collect(root):
    items = []
    for name in INCLUDE_FILES:
        fp = os.path.join(root, name)
        if os.path.isfile(fp):
            items.append((name, fp))
    for d in INCLUDE_DIRS:
        base = os.path.join(root, d)
        if not os.path.isdir(base):
            continue
        for dirpath, _, filenames in os.walk(base):
            for fn in filenames:
                fp = os.path.join(dirpath, fn)
                rel = os.path.relpath(fp, root).replace("\\", "/")
                items.append((rel, fp))
    return items


def read_version():
    """package.json 是全项目唯一的版本来源。"""
    p = os.path.join(PROJECT, "package.json")
    try:
        with io.open(p, "r", encoding="utf-8") as f:
            return str(json.load(f).get("version") or "")
    except Exception:
        return ""


def version_js_of(root):
    p = os.path.join(root, "js", "version.js")
    try:
        with io.open(p, "r", encoding="utf-8") as f:
            m = re.search(r"APP_VERSION\s*=\s*'([^']*)'", f.read())
            return m.group(1) if m else ""
    except Exception:
        return ""


def main():
    root = pick_root()
    if not root:
        print("!! 找不到前端文件（需要 index.html 和 js/app.js）")
        return 1

    # 版本一致性闸门：package.json 改了但没重跑 bun run build 时，
    # 打进 exe 的版本号会是旧的，界面就一直提示「发现新版本」。
    want = read_version()
    got = version_js_of(root)
    if not want:
        print("!! 读不到 package.json 的 version")
        return 1
    if got != want:
        print("!! 版本号不一致，先跑 bun run build")
        print("   package.json        %s" % want)
        print("   %s/js/version.js   %s" % (root, got or "(缺失)"))
        return 1

    items = collect(root)
    if not items:
        print("!! 没有可打包的文件")
        return 1

    raw = io.BytesIO()
    with zipfile.ZipFile(raw, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for rel, fp in items:
            with io.open(fp, "rb") as f:
                zf.writestr(rel, f.read())
    blob = base64.b64encode(raw.getvalue()).decode("ascii")

    src_py = os.path.join(HERE, "keyapp_desktop.py")
    with io.open(src_py, "r", encoding="utf-8") as f:
        code = f.read()

    marker = 'ASSETS_B64 = ""'
    if marker not in code:
        print("!! keyapp_desktop.py 里找不到 ASSETS_B64 占位")
        return 1

    # 每 100 字符折一行，避免单行过长让某些编辑器/打包器吃不消
    wrapped = "\n".join('    "%s"' % blob[i:i + 100] for i in range(0, len(blob), 100))
    replacement = "ASSETS_B64 = (\n%s\n)" % wrapped
    code = code.replace(marker, replacement, 1)

    # 把真实版本号写进 Python 侧，/api/version 和 /api/ping 都靠它
    old_ver = 'APP_VERSION = "0.0.0-dev"'
    if old_ver in code:
        code = code.replace(old_ver, 'APP_VERSION = "%s"' % want, 1)
    else:
        print("!! keyapp_desktop.py 里找不到 APP_VERSION 占位")
        return 1

    out_py = os.path.join(HERE, "钥匙-打包用.py")
    with io.open(out_py, "w", encoding="utf-8", newline="\n") as f:
        f.write(code)

    print("源目录   : %s" % root)
    print("版本     : %s" % want)
    print("文件数   : %d" % len(items))
    print("压缩后   : %.1f KB" % (len(raw.getvalue()) / 1024.0))
    print("base64   : %.1f KB" % (len(blob) / 1024.0))
    print("生成     : %s" % out_py)
    # 顺手把旧的中间文件删掉，免得又有人选错
    stale = os.path.join(HERE, "keyapp_desktop_build.py")
    if os.path.exists(stale):
        try:
            os.remove(stale)
        except Exception:
            pass

    print("")
    print("下一步：用 Builder 打包下面这个文件（注意是「打包用」那个）")
    print("  源文件   desktop\\" + os.path.basename(out_py))
    print("  语言     Python")
    print("  勾选     单文件 + 无控制台窗口")
    print("  图标     可以选 F:\\AI Tool\\desktop\\icon.ico（如果有）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
