# -*- coding: utf-8 -*-
"""README 与代码一致性检查。

存在的理由：1.5.0 发版时 README 里还写着 1.4.1，版本历史和功能区两部分
描述新功能、但“当前版本”忘了改 —— 这种错误不会让任何测试失败，
只有人去看才会发现。所以把它变成一条可执行的检查。

用法：
  py desktop/check_docs.py
退出码 0 = 一致；1 = 有不一致（CI 里可以直接当门禁用）
"""
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

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
README = os.path.join(ROOT, "README.md")
PKG = os.path.join(ROOT, "package.json")

problems = []
notes = []


def read(path):
    with io.open(path, "r", encoding="utf-8") as f:
        return f.read()


def ok(cond, msg):
    print(("  [OK]   " if cond else "  [FAIL] ") + msg)
    if not cond:
        problems.append(msg)


def main():
    if not os.path.isfile(README):
        raise SystemExit("找不到 README.md")
    pkg = json.loads(read(PKG))
    version = str(pkg.get("version") or "")
    doc = read(README)

    print("package.json version = %s" % version)
    print("")

    # ---------- 1. 版本号 ----------
    m = re.search(r"当前版本[：:]\s*\*\*([0-9][^*]*)\*\*", doc)
    declared = m.group(1).strip() if m else ""
    ok(declared == version, "「当前版本」= package.json（README=%r）" % declared)

    # ---------- 2. 版本历史要覆盖当前版本 ----------
    major, minor = (version.split(".") + ["", ""])[:2]
    # 标题可能是 ### 1.5.x 或 ### 1.5.0，两种都算
    ok(re.search(r"###\s*%s\.%s(?:\.[0-9]+)?\s*[\.x—\-]" % (major, minor), doc) is not None,
       "版本历史里有 %s.%s 这一节" % (major, minor))
    too_new = [v for v in re.findall(r"###\s*(\d+)\.(\d+)", doc)
               if tuple(int(x) for x in v) > (int(major), int(minor))]
    ok(not too_new, "版本历史里没有高于当前版本的条目 %s" % (too_new or ""))

    # ---------- 3. 更新提示里举的例子 ----------
    m2 = re.search(r"发现新版本\s*([0-9][0-9.]*)", doc)
    shown = m2.group(1) if m2 else ""
    ok(shown == version, "更新提示示例 = 当前版本（README=%r）" % shown)

    # ---------- 4. 功能描述和代码对得上 ----------
    checks = [
        ("DPAPI 密钥加密", "CryptProtectData", os.path.join(HERE, "secure_store.py")),
        ("SHA-256 校验", "sha256", os.path.join(HERE, "keyapp_desktop.py")),
        ("配对码限速", "PAIR_MAX_FAILS", os.path.join(HERE, "keyapp_desktop.py")),
        ("Bun 端静态资源收敛", "STATIC_ROOT", os.path.join(ROOT, "server", "lan.mjs")),
    ]
    for label, token, path in checks:
        in_code = os.path.isfile(path) and token in read(path)
        in_doc = any(k in doc for k in label.split())
        ok(in_code, "%s：代码里真的有" % label)
        if in_code:
            key = label.split()[0]
            ok(key in doc, "%s：README 里提到了" % label)

    # ---------- 5. 别再出现这些过时说法 ----------
    stale = [
        ("不是实时的", "实时同步已做（SSE）"),
        ("没有后端、没有账号", "已经有局域网桥，说法过时"),
        ("App 里仍是明文", "密钥已加密"),
        ("交给系统浏览器打开 APK", "已改为应用内更新"),
    ]
    for phrase, why in stale:
        ok(phrase not in doc, "无过时说法「%s」（%s）" % (phrase, why))

    print("")
    if problems:
        print("不一致 %d 处：" % len(problems))
        for p in problems:
            print("  - " + p)
        return 1
    print("README 与代码一致")
    return 0


if __name__ == "__main__":
    sys.exit(main())
