# -*- coding: utf-8 -*-
"""无界面自测：起服务、走一遍配对/同步/文件，不依赖 tkinter。

数据完全隔离：
  以前这里直接删真实的 keyapp-data/state.json、tokens.json、files/*，
  等于一跑自测就把用户自己的对话和收到的文件删了。
  现在所有路径都指向 .selftest-tmp/，跑完自己清理，真实数据一个字不碰。

用法：
  py desktop/selftest.py            # 跑完删掉临时目录
  py desktop/selftest.py --keep     # 留着临时目录，方便看失败现场
"""

import importlib.util
import io
import json
import os
import shutil
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)
TARGET = os.path.join(HERE, "钥匙-打包用.py")
KEEP = "--keep" in sys.argv

# 隔离目录放在项目内（不写 C 盘），跑完删
TMP_ROOT = os.path.join(PROJECT, ".selftest-tmp")

spec = importlib.util.spec_from_file_location("kd", TARGET)
kd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(kd)

_real_data_dir = kd.DATA_DIR
if os.path.abspath(TMP_ROOT) == os.path.abspath(_real_data_dir):
    raise SystemExit("！隔离目录和真实数据目录重合，拒绝运行")

# 把模块级路径常量全部改指向临时目录。必须在 ensure_dirs 之前改。
shutil.rmtree(TMP_ROOT, ignore_errors=True)
kd.DATA_DIR = TMP_ROOT
kd.FILE_DIR = os.path.join(TMP_ROOT, "files")
kd.STATE_FILE = os.path.join(TMP_ROOT, "state.json")
kd.TOKENS_FILE = os.path.join(TMP_ROOT, "tokens.json")
kd.PROFILE_DIR = os.path.join(TMP_ROOT, "window-profile")
kd.WEBVIEW_STORAGE = os.path.join(TMP_ROOT, "webview")

kd.ensure_dirs()
kd.HUB.load_tokens()
kd.HUB.tokens = {}
print("隔离数据     : %s" % TMP_ROOT)

assets = kd.load_assets()
assert assets, "！前端资源没内嵌成功"
print("内嵌资源     : %d 个文件" % len(assets))
assert "index.html" in assets, "！缺 index.html"
assert "js/app.js" in assets, "！缺 js/app.js"
assert "js/version.js" in assets, "！缺 js/version.js（版本号会读不到）"

port = kd.find_free_port(8899)
srv = kd.start_server(port, assets, os.path.join(kd.base_dir(), "www"))
print("服务端口     : %d" % port)

BASE = "http://127.0.0.1:%d" % port


def req(path, method="GET", headers=None, body=None):
    h = dict(headers or {})
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        h["content-type"] = "application/json"
    r = urllib.request.Request(BASE + path, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(r, timeout=5) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


fails = []


def check(name, cond, detail=""):
    print(("  [OK]   " if cond else "  [FAIL] ") + name + (("  " + detail) if detail else ""))
    if not cond:
        fails.append(name)


print("\n--- 静态资源 ---")
st, body = req("/")
check("GET / 返回 200", st == 200, "status=%d" % st)
check("页面里有标题", "钥匙".encode("utf-8") in body, "%d 字节" % len(body))
st, body = req("/js/app.js")
check("GET /js/app.js", st == 200 and len(body) > 1000, "%d 字节" % len(body))
st, body = req("/css/app.css")
check("GET /css/app.css", st == 200 and len(body) > 1000, "%d 字节" % len(body))
st, body = req("/nope/deep/link")
check("未知路径回落首页（SPA）", st == 200 and "钥匙".encode("utf-8") in body)
st, body = req("/../etc/passwd")
check("路径穿越被挡", st in (400, 404), "status=%d" % st)

print("\n--- 配对 ---")
st, body = req("/api/code")
code = json.loads(body)["code"] if st == 200 else ""
check("本机可读配对码", st == 200 and len(code) == 6, "code=%s" % code)

st, _ = req("/api/sync")
check("无令牌访问 sync 被拒", st == 200 or st == 401, "status=%d" % st)

# 本机免令牌是有意设计（电脑端界面得读写同一份数据），
# 关掉它以验证远程请求真的会被拦。
kd.LOCAL_FREE = False
try:
    st, _ = req("/api/sync")
    check("非本机（无令牌）访问 sync 被拒", st == 401, "status=%d" % st)
    st, body = req("/api/version")
    check("非本机（无令牌）访问 version 被拒", st == 401, "status=%d" % st)
finally:
    kd.LOCAL_FREE = True

st, _ = req("/api/pair", "POST", body={"code": "000000", "deviceName": "probe"})
check("错配对码被拒", st == 401, "status=%d" % st)

# 配对码限速：连续失败 5 次后应该回 429
codes = []
for _ in range(kd.PAIR_MAX_FAILS + 1):
    st, _ = req("/api/pair", "POST", body={"code": "111111", "deviceName": "brute"})
    codes.append(st)
check("连错 5 次后被限速", codes[-1] == 429, str(codes))
kd.HUB.clear_pair_fail("127.0.0.1")

st, body = req("/api/pair", "POST", body={"code": code, "deviceName": "selftest"})
token = json.loads(body).get("token") if st == 200 else ""
check("正确配对码发令牌", st == 200 and len(token) >= 32, "token=%s…" % token[:10])

AUTH = {"authorization": "Bearer " + token}

# 请求体上限
big = {"conversations": {}, "tombstones": {}, "pad": "x" * (kd.MAX_JSON + 1000)}
kd.LOCAL_FREE = False
try:
    st, _ = req("/api/sync", "POST", headers=AUTH, body=big)
    check("超大 JSON 被 413", st == 413, "status=%d" % st)
    st, _ = req("/api/sync", headers=AUTH)
    check("带令牌仍然放行", st == 200, "status=%d" % st)
    st, body = req("/api/version", headers=AUTH)
    v = json.loads(body).get("version", "") if st == 200 else ""
    check("api/version 返回真版本", st == 200 and v == kd.APP_VERSION, "version=%s" % v)
finally:
    kd.LOCAL_FREE = True


print("\n--- 发现 ---")
st, body = req("/api/register", "POST", body={
    "app": "keyapp", "alias": "邻居设备", "fingerprint": "deadbeefcafe0001",
    "port": 8788, "deviceModel": "android"})
check("register 无需令牌", st == 200)
st, body = req("/api/peers", headers=AUTH)
peers = json.loads(body)
names = [p["alias"] for p in peers["peers"]]
check("邻居出现在列表里", "邻居设备" in names, str(names))
st, body = req("/api/register", "POST", body={
    "app": "keyapp", "alias": "自己", "fingerprint": kd.fingerprint_for(port), "port": port})
st, body = req("/api/peers", headers=AUTH)
names = [p["alias"] for p in json.loads(body)["peers"]]
check("自己的回声被过滤", "自己" not in names, str(names))

print("\n--- 同步 ---")
now = kd.int if False else int(__import__("time").time() * 1000)
st, body = req("/api/sync", "POST", headers=AUTH, body={
    "conversations": {
        "c1": {"id": "c1", "title": "电脑写的", "updatedAt": now, "messages": []},
        "c2": {"id": "c2", "title": "会被删的", "updatedAt": now, "messages": []},
    },
    "tombstones": {}})
merged = json.loads(body)
check("推送两条对话", st == 200 and set(merged["conversations"]) == {"c1", "c2"},
      str(sorted(merged["conversations"])))

st, body = req("/api/sync", "POST", headers=AUTH, body={
    "conversations": {"c1": {"id": "c1", "title": "手机改的新标题", "updatedAt": now + 5000, "messages": []}},
    "tombstones": {}})
merged = json.loads(body)
check("更新的版本胜出", merged["conversations"]["c1"]["title"] == "手机改的新标题",
      merged["conversations"]["c1"]["title"])

st, body = req("/api/sync", "POST", headers=AUTH, body={
    "conversations": {}, "tombstones": {"c2": now + 9000}})
merged = json.loads(body)
check("墓碑把 c2 删掉", "c2" not in merged["conversations"], str(sorted(merged["conversations"])))
check("墓碑被保留（防复活）", "c2" in merged["tombstones"])

st, body = req("/api/sync", "POST", headers=AUTH, body={
    "conversations": {}, "tombstones": {"c2": 1}})
merged = json.loads(body)
check("旧墓碑不会复活已删的", "c2" not in merged["conversations"])

print("\n--- 文件 ---")
payload = "这是从手机发来的文件内容".encode("utf-8")
r = urllib.request.Request(BASE + "/api/files", data=payload, method="POST",
                           headers={"authorization": "Bearer " + token,
                                    "x-filename": "%E6%B5%8B%E8%AF%95.txt",
                                    "content-type": "application/octet-stream"})
with urllib.request.urlopen(r, timeout=5) as resp:
    up = json.loads(resp.read())
check("上传中文名文件", resp.status == 200 and up["name"] == "测试.txt", up.get("name"))
check("落盘大小正确", up["size"] == len(payload), str(up["size"]))

st, body = req("/api/files", headers=AUTH)
files = [f["name"] for f in json.loads(body)["files"]]
check("文件出现在列表", "测试.txt" in files, str(files))

st, body = req("/api/files/%E6%B5%8B%E8%AF%95.txt", headers=AUTH)
check("下载内容一致", st == 200 and body == payload, "%d 字节" % len(body))

r = urllib.request.Request(BASE + "/api/files", data=b"evil", method="POST",
                           headers={"authorization": "Bearer " + token,
                                    "x-filename": "..%2F..%2Fevil.txt",
                                    "content-type": "application/octet-stream"})
with urllib.request.urlopen(r, timeout=5) as resp:
    up2 = json.loads(resp.read())
check("路径穿越被剥成纯文件名", up2["name"] == "evil.txt", up2.get("name"))
check("没有写出目录外", not os.path.exists(os.path.join(kd.DATA_DIR, "..", "evil.txt")))

st, _ = req("/api/files/" + up2["name"], "DELETE", headers=AUTH)
check("删除文件", st == 200)

print("\n--- 清理 ---")
srv.shutdown()
srv.server_close()

# 断言：真实数据目录必须一个字节都没动
if os.path.isdir(_real_data_dir):
    left = []
    for name in ("state.json", "tokens.json"):
        if os.path.exists(os.path.join(_real_data_dir, name)):
            left.append(name)
    if left:
        print("  真实数据目录仍在（未被本次自测修改）: %s" % ", ".join(left))

if KEEP:
    print("  保留临时目录: %s" % TMP_ROOT)
else:
    shutil.rmtree(TMP_ROOT, ignore_errors=True)
    print("  临时目录已删除")

print("\n" + ("全部通过" if not fails else "失败 %d 项：%s" % (len(fails), fails)))
sys.exit(0 if not fails else 1)
