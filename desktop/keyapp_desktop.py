# -*- coding: utf-8 -*-
"""钥匙 · 电脑端

双击就进聊天。内部做三件事：
  1. 起一个本地 Web 服务（托管内嵌的聊天界面）
  2. 用 pywebview 把界面装进一个内嵌 WebView2 的窗口
     —— 窗口属于本进程，不起浏览器、没有地址栏
  3. 组播广播，让手机 App 自动发现这台电脑

关掉那个窗口，服务和进程一起退出。

窗口技术选型：pywebview 的 edgechromium 后端，直接创建 WebView2 控件。
WebView2 运行时是 Windows 10/11 系统自带的，和 Edge 浏览器本体互不相干——
不启动 msedge.exe、不占浏览器配置文件、任务管理器里看不到浏览器进程。
（早先用的是 msedge --app 应用模式，虽然看着像独立软件，但本质还是开浏览器。）

兜底链：pywebview 不可用 → Chrome/Edge 应用模式 → 系统默认浏览器。


前端代码内嵌在文件末尾的 ASSETS_B64 里（由 embed_assets.py 生成），
所以 --onefile 打出来的 exe 不需要任何外部文件。
"""

import base64
import io
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

APP_NAME = "钥匙"
DISCOVERY_GROUP = "224.0.0.167"
DISCOVERY_PORT = 53317
DEFAULT_PORT = 8787
APP_TAG = "keyapp"

# 内嵌的前端资源（zip + base64），由 embed_assets.py 生成
ASSETS_B64 = ""


# ---------------------------------------------------------------- 路径

def base_dir():
    """数据放在 exe 旁边，而不是 PyInstaller 的临时解压目录。

    开发模式（直接跑 .py）时，本文件在 desktop/ 下，
    而前端产物 www/ 在项目根，所以往回找一层。既找不到就原地。
    """
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))

    here = os.path.dirname(os.path.abspath(__file__))
    parent = os.path.dirname(here)
    if os.path.isdir(os.path.join(parent, "www")) or os.path.isfile(os.path.join(parent, "index.html")):
        return parent
    return here


DATA_DIR = os.path.join(base_dir(), "keyapp-data")
FILE_DIR = os.path.join(DATA_DIR, "files")
STATE_FILE = os.path.join(DATA_DIR, "state.json")
TOKENS_FILE = os.path.join(DATA_DIR, "tokens.json")
PROFILE_DIR = os.path.join(DATA_DIR, "window-profile")
# 内嵌 WebView2 的 localStorage / IndexedDB 落在这个目录，换 exe 也不丢
WEBVIEW_STORAGE = os.path.join(DATA_DIR, "webview")


def ensure_dirs():
    os.makedirs(FILE_DIR, exist_ok=True)


def load_json(path, fallback):
    try:
        with io.open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return fallback


def save_json(path, value):
    tmp = path + ".tmp"
    with io.open(tmp, "w", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def local_ips():
    """返回 (主网卡 IP, 其他 IP)。主网卡用 UDP 出站地址判断，
    虚拟机/虚拟网卡排后面，免得用户不知道该填哪个。"""
    primary = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        primary = s.getsockname()[0]
        s.close()
    except Exception:
        primary = None

    others = []
    try:
        for fam, _, _, _, sockaddr in socket.getaddrinfo(socket.gethostname(), None):
            if fam != socket.AF_INET:
                continue
            ip = sockaddr[0]
            if ip.startswith("127.") or ip == primary or ip in others:
                continue
            others.append(ip)
    except Exception:
        pass

    if not primary:
        primary = others.pop(0) if others else "127.0.0.1"
    return primary, others


def fingerprint_for(port):
    raw = "%s|%d|%s" % (socket.gethostname(), port, os.name)
    h1, h2 = 0x811C9DC5, 0x01000193
    for ch in raw:
        c = ord(ch)
        h1 = ((h1 ^ c) * 0x01000193) & 0xFFFFFFFF
        h2 = (h2 + c * 31) & 0xFFFFFFFF
    return "%08x%08x" % (h1, h2)


def new_token():
    return base64.b16encode(os.urandom(24)).decode("ascii").lower()


# ---------------------------------------------------------------- 内嵌资源

def load_assets():
    """把内嵌的 zip 解成 {路径: bytes}，进程内只解一次。"""
    if not ASSETS_B64.strip():
        return None
    try:
        raw = base64.b64decode(ASSETS_B64.encode("ascii"))
        zf = zipfile.ZipFile(io.BytesIO(raw))
        return {n: zf.read(n) for n in zf.namelist() if not n.endswith("/")}
    except Exception:
        return None


_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".webmanifest": "application/manifest+json",
    ".json": "application/json",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".md": "text/markdown; charset=utf-8",
}


def content_type(path):
    _, ext = os.path.splitext(path.lower())
    return _TYPES.get(ext, "application/octet-stream")


# ---------------------------------------------------------------- 同步合并

def merge_state(local, remote):
    """同一个 id 取 updatedAt 更新的；墓碑比对话新就删掉。"""
    out = {"conversations": {}, "tombstones": {}, "skills": None, "skillsAt": 0, "updatedAt": 0}

    lc = (local or {}).get("conversations") or {}
    rc = (remote or {}).get("conversations") or {}
    lt = (local or {}).get("tombstones") or {}
    rt = (remote or {}).get("tombstones") or {}

    for cid in set(list(lc.keys()) + list(rc.keys())):
        a, b = lc.get(cid), rc.get(cid)
        if a and b:
            out["conversations"][cid] = b if (b.get("updatedAt") or 0) > (a.get("updatedAt") or 0) else a
        else:
            out["conversations"][cid] = a or b

    for cid in set(list(lt.keys()) + list(rt.keys())):
        out["tombstones"][cid] = max(lt.get(cid) or 0, rt.get(cid) or 0)

    for cid, ts in list(out["tombstones"].items()):
        conv = out["conversations"].get(cid)
        if conv and (conv.get("updatedAt") or 0) <= ts:
            out["conversations"].pop(cid, None)

    cutoff = int(time.time() * 1000) - 7 * 24 * 3600 * 1000
    out["tombstones"] = {k: v for k, v in out["tombstones"].items() if v >= cutoff}

    ls = (local or {}).get("skillsAt") or 0
    rs = (remote or {}).get("skillsAt") or 0
    if rs > ls:
        out["skills"] = (remote or {}).get("skills")
        out["skillsAt"] = rs
    elif ls > 0:
        out["skills"] = (local or {}).get("skills")
        out["skillsAt"] = ls

    out["updatedAt"] = int(time.time() * 1000)
    return out


# ---------------------------------------------------------------- 服务状态

class Hub(object):
    def __init__(self):
        self.lock = threading.Lock()
        self.port = DEFAULT_PORT
        self.alias = "电脑"
        self.pair_code = "%06d" % (int.from_bytes(os.urandom(3), "big") % 1000000)
        self.tokens = {}
        self.peers = {}
        self.logs = []

    def log(self, message):
        line = time.strftime("%H:%M:%S") + "  " + message
        with self.lock:
            self.logs.append(line)
            if len(self.logs) > 300:
                del self.logs[:150]
        print(line, flush=True)

    def load_tokens(self):
        with self.lock:
            self.tokens = load_json(TOKENS_FILE, {}) or {}

    def save_tokens(self):
        with self.lock:
            save_json(TOKENS_FILE, self.tokens)

    def add_token(self, device_name):
        tk = new_token()
        with self.lock:
            self.tokens[tk] = {"device": (device_name or "device")[:40], "at": int(time.time() * 1000)}
        self.save_tokens()
        return tk

    def check_token(self, tk):
        with self.lock:
            return bool(tk) and tk in self.tokens

    def note_peer(self, fp, alias, address, port, model=""):
        if not fp or fp == fingerprint_for(self.port):
            return False
        with self.lock:
            is_new = fp not in self.peers
            self.peers[fp] = {
                "fingerprint": fp,
                "alias": (alias or address)[:40],
                "address": address,
                "port": int(port or DISCOVERY_PORT),
                "deviceModel": model,
                "at": int(time.time() * 1000),
            }
        return is_new

    def peer_list(self):
        self_fp = fingerprint_for(self.port)
        cutoff = int(time.time() * 1000) - 10 * 60 * 1000
        with self.lock:
            return [p for p in self.peers.values() if p["at"] >= cutoff and p["fingerprint"] != self_fp]


HUB = Hub()


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "KeyappDesktop/2.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _cors(self):
        self.send_header("access-control-allow-origin", "*")
        self.send_header("access-control-allow-headers", "authorization, content-type, x-filename")
        self.send_header("access-control-allow-methods", "GET, POST, DELETE, OPTIONS")

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _raw(self, code, data, ctype, extra=None):
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(data)))
        # 本地服务不用缓存：改了代码重启就能看到，不会被浏览器留着旧版
        self.send_header("cache-control", "no-store, no-cache, must-revalidate")
        self._cors()
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        try:
            n = int(self.headers.get("content-length") or 0)
        except ValueError:
            n = 0
        return self.rfile.read(n) if n else b""

    def _body_json(self):
        try:
            return json.loads(self._body().decode("utf-8") or "{}")
        except Exception:
            return {}

    def _is_local(self):
        return self.client_address[0] in ("127.0.0.1", "::1", "::ffff:127.0.0.1")

    def _token(self):
        h = self.headers.get("authorization") or ""
        return h[7:].strip() if h.startswith("Bearer ") else ""

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("content-length", "0")
        self._cors()
        self.end_headers()

    def do_GET(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")

    def do_DELETE(self):
        self._route("DELETE")

    def _route(self, method):
        path = self.path.split("?")[0]

        # 手机扫描局域网时先打这个：免认证，只回一个身份标记，不含任何隐私
        # 电脑端自己看的东西（配对码、设备、文件）都走这个。
        # 本机专用：局域网其他设备拿到 403，所以不需要令牌。
        if path == "/api/host/info":
            if not self._is_local():
                return self._json(403, {"error": "local-only"})
            primary, others = local_ips()
            devices = []
            for tk, meta in list(HUB.tokens.items()):
                devices.append({
                    "tail": tk[-6:],
                    "device": meta.get("device") or "device",
                    "at": meta.get("at") or 0,
                })
            devices.sort(key=lambda x: -x["at"])
            files = []
            try:
                for n in os.listdir(FILE_DIR):
                    fp = os.path.join(FILE_DIR, n)
                    if os.path.isfile(fp):
                        st = os.stat(fp)
                        files.append({"name": n, "size": st.st_size, "at": int(st.st_mtime * 1000)})
            except Exception:
                pass
            files.sort(key=lambda x: -x["at"])
            return self._json(200, {
                "code": HUB.pair_code,
                "alias": HUB.alias,
                "port": HUB.port,
                "ip": primary,
                "url": "http://%s:%d" % (primary, HUB.port),
                "otherIps": others,
                "devices": devices[:50],
                "files": files[:200],
            })

        if path == "/api/host/kick" and method == "POST":
            if not self._is_local():
                return self._json(403, {"error": "local-only"})
            tail = str((self._body_json() or {}).get("tail") or "")
            removed = 0
            with HUB.lock:
                for tk in list(HUB.tokens.keys()):
                    if tail and tk.endswith(tail):
                        HUB.tokens.pop(tk, None)
                        removed += 1
            if removed:
                HUB.save_tokens()
                HUB.log("已断开 %d 台设备" % removed)
            return self._json(200, {"removed": removed})

        if path == "/api/host/file" and method == "POST":
            if not self._is_local():
                return self._json(403, {"error": "local-only"})
            from urllib.parse import unquote
            raw_name = unquote(self.headers.get("x-filename") or "file")
            safe = os.path.basename(raw_name)
            for ch in '\\/:*?"<>|':
                safe = safe.replace(ch, "_")
            safe = safe[:120] or "file"
            data = self._body()
            if not data:
                return self._json(400, {"error": "empty"})
            name, i = safe, 1
            while os.path.exists(os.path.join(FILE_DIR, name)):
                stem, ext = os.path.splitext(safe)
                name = "%s-%d%s" % (stem, i, ext)
                i += 1
            with open(os.path.join(FILE_DIR, name), "wb") as f:
                f.write(data)
            HUB.log("收到文件：%s（%d 字节）" % (name, len(data)))
            return self._json(200, {"name": name, "size": len(data)})

        if path.startswith("/api/host/file/"):
            if not self._is_local():
                return self._json(403, {"error": "local-only"})
            from urllib.parse import unquote, quote
            name = os.path.basename(unquote(path[len("/api/host/file/"):]))
            fp = os.path.join(FILE_DIR, name)
            if method == "DELETE":
                try:
                    os.remove(fp)
                    HUB.log("删除文件：%s" % name)
                except Exception:
                    pass
                return self._json(200, {"ok": True})
            if not os.path.isfile(fp):
                return self._json(404, {"error": "not-found"})
            with open(fp, "rb") as f:
                data = f.read()
            return self._raw(200, data, "application/octet-stream",
                             {"content-disposition": 'attachment; filename="%s"' % quote(name)})

        if path == "/api/ping":
            primary, _ = local_ips()
            return self._json(200, {
                "app": APP_TAG, "alias": HUB.alias,
                "url": "http://%s:%d" % (primary, HUB.port),
                "port": HUB.port, "version": 1
            })

        if path == "/api/code":
            if not self._is_local():
                return self._json(403, {"error": "local-only"})
            primary, others = local_ips()
            return self._json(200, {
                "code": HUB.pair_code, "port": HUB.port, "alias": HUB.alias,
                "ip": primary, "otherIps": others,
                "url": "http://%s:%d" % (primary, HUB.port),
                "devices": len(HUB.tokens),
                "version": "1.0",
            })

        if path == "/api/register" and method == "POST":
            body = self._body_json()
            if body.get("app") == APP_TAG and body.get("fingerprint"):
                HUB.note_peer(str(body["fingerprint"]), body.get("alias"), self.client_address[0],
                              body.get("port"), body.get("deviceModel", ""))
            return self._json(200, {"ok": True, "alias": HUB.alias})

        if path == "/api/pair" and method == "POST":
            body = self._body_json()
            if str(body.get("code") or "").strip() != HUB.pair_code:
                HUB.log("配对失败：配对码不对（来自 %s）" % self.client_address[0])
                return self._json(401, {"error": "bad-code"})
            tk = HUB.add_token(body.get("deviceName"))
            HUB.log("已配对：%s" % ((body.get("deviceName") or "device")[:30]))
            return self._json(200, {"token": tk})

        if path.startswith("/api/"):
            if not HUB.check_token(self._token()):
                return self._json(401, {"error": "unauthorized"})

            if path == "/api/info":
                return self._json(200, {"name": APP_NAME + " · 电脑端", "version": 1,
                                        "alias": HUB.alias, "devices": len(HUB.tokens), "port": HUB.port})

            if path == "/api/devices" and method == "GET":
                out = []
                for tk, meta in list(HUB.tokens.items()):
                    out.append({
                        "tail": tk[-6:],
                        "device": meta.get("device") or "device",
                        "at": meta.get("at") or 0,
                    })
                out.sort(key=lambda x: -x["at"])
                return self._json(200, {"devices": out})

            if path == "/api/devices" and method == "DELETE":
                body = self._body_json()
                tail = str(body.get("tail") or "")
                removed = 0
                with HUB.lock:
                    for tk in list(HUB.tokens.keys()):
                        if tail and tk.endswith(tail):
                            HUB.tokens.pop(tk, None)
                            removed += 1
                if removed:
                    HUB.save_tokens()
                    HUB.log("已断开 %d 台设备" % removed)
                return self._json(200, {"removed": removed})

            if path == "/api/peers":
                return self._json(200, {"self": {"alias": HUB.alias, "port": HUB.port},
                                        "peers": HUB.peer_list()})

            if path == "/api/sync" and method == "GET":
                return self._json(200, load_json(STATE_FILE, {"conversations": {}, "tombstones": {},
                                                              "skills": None, "skillsAt": 0}))

            if path == "/api/sync" and method == "POST":
                incoming = self._body_json()
                local = load_json(STATE_FILE, {"conversations": {}, "tombstones": {},
                                               "skills": None, "skillsAt": 0})
                merged = merge_state(local, incoming)
                save_json(STATE_FILE, merged)
                HUB.log("同步完成：%d 条对话" % len(merged["conversations"]))
                return self._json(200, {"conversations": merged["conversations"],
                                        "tombstones": merged["tombstones"],
                                        "skills": merged["skills"], "skillsAt": merged["skillsAt"],
                                        "serverTime": int(time.time() * 1000)})

            if path == "/api/files" and method == "GET":
                items = []
                try:
                    for n in os.listdir(FILE_DIR):
                        fp = os.path.join(FILE_DIR, n)
                        if os.path.isfile(fp):
                            st = os.stat(fp)
                            items.append({"name": n, "size": st.st_size, "at": int(st.st_mtime * 1000)})
                except Exception:
                    pass
                items.sort(key=lambda x: -x["at"])
                return self._json(200, {"files": items[:200]})

            if path == "/api/files" and method == "POST":
                from urllib.parse import unquote
                raw_name = unquote(self.headers.get("x-filename") or "file")
                safe = os.path.basename(raw_name)
                for ch in '\\/:*?"<>|':
                    safe = safe.replace(ch, "_")
                safe = safe[:120] or "file"
                data = self._body()
                if not data:
                    return self._json(400, {"error": "empty"})
                name, i = safe, 1
                while os.path.exists(os.path.join(FILE_DIR, name)):
                    stem, ext = os.path.splitext(safe)
                    name = "%s-%d%s" % (stem, i, ext)
                    i += 1
                with open(os.path.join(FILE_DIR, name), "wb") as f:
                    f.write(data)
                HUB.log("收到文件：%s（%d 字节）" % (name, len(data)))
                return self._json(200, {"name": name, "size": len(data)})

            if path.startswith("/api/files/"):
                from urllib.parse import unquote, quote
                name = os.path.basename(unquote(path[len("/api/files/"):]))
                fp = os.path.join(FILE_DIR, name)
                if method == "DELETE":
                    try:
                        os.remove(fp)
                        HUB.log("删除文件：%s" % name)
                    except Exception:
                        pass
                    return self._json(200, {"ok": True})
                if not os.path.isfile(fp):
                    return self._json(404, {"error": "not-found"})
                with open(fp, "rb") as f:
                    data = f.read()
                return self._raw(200, data, "application/octet-stream",
                                 {"content-disposition": 'attachment; filename="%s"' % quote(name)})

        if method == "GET":
            return self._static(path)
        return self._json(405, {"error": "method"})

    def _static(self, path):
        assets = self.server.assets
        if not path or path == "/":
            path = "/index.html"
        rel = path.lstrip("/")
        if ".." in rel:
            return self._json(400, {"error": "bad-path"})

        if assets is not None:
            data = assets.get(rel)
            if data is None:
                data = assets.get("index.html")
                if data is None:
                    return self._json(404, {"error": "not-found"})
                rel = "index.html"
            return self._raw(200, data, content_type(rel))

        fp = os.path.join(getattr(self.server, "www_dir", ""), rel)
        if not os.path.isfile(fp):
            return self._json(404, {"error": "not-found"})
        with open(fp, "rb") as f:
            return self._raw(200, f.read(), content_type(rel))


# ---------------------------------------------------------------- 组播发现

class Discovery(threading.Thread):
    def __init__(self, port):
        threading.Thread.__init__(self)
        self.daemon = True
        self.port = port
        self.fp = fingerprint_for(port)
        self.stop_flag = threading.Event()
        self.sock = None

    def _payload(self, announce):
        return json.dumps({
            "alias": HUB.alias, "version": "2.0", "deviceModel": sys.platform,
            "deviceType": "desktop", "fingerprint": self.fp, "port": self.port,
            "protocol": "http", "app": APP_TAG, "download": True, "announce": announce,
        }, ensure_ascii=False).encode("utf-8")

    def run(self):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
            except Exception:
                pass
            s.bind(("", DISCOVERY_PORT))
            mreq = struct.pack("4sl", socket.inet_aton(DISCOVERY_GROUP), socket.INADDR_ANY)
            s.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
            s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
            s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_LOOP, 1)
            s.settimeout(1.0)
            self.sock = s
        except Exception as e:
            HUB.log("组播启动失败（不影响手填地址）：%s" % e)
            return

        try:
            self.sock.sendto(self._payload(True), (DISCOVERY_GROUP, DISCOVERY_PORT))
        except Exception:
            pass
        last = time.time()

        while not self.stop_flag.is_set():
            try:
                data, addr = self.sock.recvfrom(4096)
            except socket.timeout:
                data, addr = None, None
            except Exception:
                break

            if data:
                try:
                    j = json.loads(data.decode("utf-8", "ignore"))
                except Exception:
                    j = None
                if j and j.get("app") == APP_TAG and j.get("fingerprint") != self.fp:
                    if HUB.note_peer(str(j.get("fingerprint")), j.get("alias"), addr[0],
                                     j.get("port"), j.get("deviceModel", "")):
                        HUB.log("发现设备：%s @ %s" % (j.get("alias") or addr[0], addr[0]))
                    if j.get("announce"):
                        try:
                            self.sock.sendto(self._payload(False), (addr[0], DISCOVERY_PORT))
                        except Exception:
                            pass

            if time.time() - last > 30:
                try:
                    self.sock.sendto(self._payload(True), (DISCOVERY_GROUP, DISCOVERY_PORT))
                except Exception:
                    pass
                last = time.time()

        try:
            self.sock.close()
        except Exception:
            pass

    def stop(self):
        self.stop_flag.set()


# ---------------------------------------------------------------- 启停

def find_free_port(start=DEFAULT_PORT, tries=20):
    for p in range(start, start + tries):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.bind(("0.0.0.0", p))
            return p
        except OSError:
            continue
        finally:
            s.close()
    return start


def already_running(port):
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/api/code" % port, timeout=1.2) as r:
            return r.status == 200
    except Exception:
        return False


def start_server(port, assets, www_dir):
    HUB.port = port
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    srv.daemon_threads = True
    srv.assets = assets
    srv.www_dir = www_dir
    t = threading.Thread(target=srv.serve_forever)
    t.daemon = True
    t.start()
    return srv


# ---------------------------------------------------------------- 应用窗口
#
# 首选：pywebview 的 edgechromium 后端 → 内嵌 WebView2 控件。
#       窗口属于本进程，不起浏览器，localStorage 落在 WEBVIEW_STORAGE。
# 次选：Chrome/Edge 的 --app 应用模式（看着像独立软件，但仍是浏览器进程）。
# 末选：系统默认浏览器 + 一个能看配对码的 tk 小窗。

BROWSER_CANDIDATES = [
    r"%ProgramFiles%\Google\Chrome\Application\chrome.exe",
    r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe",
    r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe",
    r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe",
    r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe",
]

# 窗口标题里出现这个就认为是我们的界面
WINDOW_TITLE_HINT = "钥匙"

WEBVIEW_STATE = {"checked": False, "ok": False, "why": ""}


class _Bridge:
    """暴露给页面的极小接口。目前只有一个用途：
    回答里的外链点开时丢给系统默认浏览器，别把整个应用导航走。"""

    def open_external(self, url):
        try:
            if isinstance(url, str) and url.split(":", 1)[0].lower() in ("http", "https", "mailto"):
                webbrowser.open(url)
                return True
        except Exception:
            pass
        return False


# 页内装一层外链兵，只拦 http(s)/mailto，站内跳转不管。
_LINK_GUARD_JS = """
(function () {
  if (window.__keyappLinkGuard) return;
  window.__keyappLinkGuard = true;
  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (!/^(https?:|mailto:)/i.test(href)) return;
    ev.preventDefault();
    ev.stopPropagation();
    try {
      if (window.pywebview && window.pywebview.api && window.pywebview.api.open_external) {
        window.pywebview.api.open_external(href);
      } else {
        window.open(href, '_blank');
      }
    } catch (e) {}
  }, true);
})();
"""


def webview_available():
    """能不能用内嵌 WebView2。结果缓存，只探测一次。"""
    if WEBVIEW_STATE["checked"]:
        return WEBVIEW_STATE["ok"]

    WEBVIEW_STATE["checked"] = True
    try:
        import webview  # noqa: F401
    except Exception as e:
        WEBVIEW_STATE["why"] = "pywebview 导入失败: %s" % e
        return False

    # 后端要能实例化（缺 pythonnet / WebView2 DLL 时这里会报）
    try:
        from webview.platforms import edgechromium  # noqa: F401
    except Exception as e:
        WEBVIEW_STATE["why"] = "WebView2 后端不可用: %s" % e
        return False

    WEBVIEW_STATE["ok"] = True
    return True


def run_embedded_window(url, width=1040, height=800):
    """内嵌 WebView2 起窗口。阻塞到窗口关闭。
    返回 True = 用户正常关窗；False = 起不来（调用方该走兜底）。"""
    try:
        import webview
    except Exception as e:
        HUB.log("内嵌窗口不可用: %s" % e)
        return False

    try:
        os.makedirs(WEBVIEW_STORAGE, exist_ok=True)
    except Exception:
        pass

    try:
        window = webview.create_window(
            APP_NAME,
            url,
            width=width,
            height=height,
            min_size=(720, 520),
            text_select=True,
            confirm_close=False,
            js_api=_Bridge(),
        )
    except Exception as e:
        HUB.log("创建窗口失败: %s" % e)
        return False

    opened = {"ok": False}

    def _on_loaded():
        if not opened["ok"]:
            opened["ok"] = True
            HUB.log("窗口已就绪（内嵌 WebView2），关掉它就会退出")
        # 外链交给系统浏览器，别把应用本身导航走
        try:
            window.evaluate_js(_LINK_GUARD_JS)
        except Exception:
            pass

    try:
        window.events.loaded += _on_loaded
    except Exception:
        pass

    try:
        webview.start(
            gui="edgechromium",          # 明确指定，别让它去试 Qt/GTK
            private_mode=False,          # 要持久化 localStorage（密钥、会话）
            storage_path=WEBVIEW_STORAGE,
            debug=False,
        )
    except Exception as e:
        HUB.log("内嵌窗口启动失败: %s" % e)
        return False

    if not opened["ok"]:
        # start() 立刻返回、连页面都没加载 —— 当作启动失败去走兜底
        HUB.log("内嵌窗口没加载出页面")
        return False

    HUB.log("窗口已关闭，正在退出")
    return True


def find_browser():
    for raw in BROWSER_CANDIDATES:
        p = os.path.expandvars(raw)
        if "%" in p:
            continue
        if os.path.isfile(p):
            return p
    for name in ("chrome.exe", "msedge.exe"):
        p = shutil.which(name)
        if p:
            return p
    return None


def app_window_exists():
    """有没有一个可见窗口，标题包含 WINDOW_TITLE_HINT。
    只用 ctypes 调 user32，不引第三方库。"""
    if os.name != "nt":
        return False
    try:
        import ctypes
        from ctypes import wintypes
    except Exception:
        return False

    try:
        user32 = ctypes.windll.user32
    except Exception:
        return False

    found = [False]
    ENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def cb(hwnd, _lparam):
        try:
            if not user32.IsWindowVisible(hwnd):
                return True
            n = user32.GetWindowTextLengthW(hwnd)
            if n <= 0:
                return True
            buf = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(hwnd, buf, n + 1)
            text = buf.value or ""
            if WINDOW_TITLE_HINT in text:
                rect = wintypes.RECT()
                user32.GetWindowRect(hwnd, ctypes.byref(rect))
                # 排除掉樱桃自己的对话窗、以及那些很小的提示窗
                if (rect.right - rect.left) >= 480:
                    found[0] = True
                    return False
        except Exception:
            pass
        return True

    try:
        user32.EnumWindows(ENUMPROC(cb), 0)
    except Exception:
        return False
    return found[0]


def launch_app_window(url, width=1040, height=800):
    """浏览器应用模式（兜底用）。返回进程，可能很快就自己退出。"""
    exe = find_browser()
    if not exe:
        return None
    try:
        os.makedirs(PROFILE_DIR, exist_ok=True)
    except Exception:
        pass

    args = [
        exe,
        "--app=" + url,
        "--window-size=%d,%d" % (width, height),
        "--user-data-dir=" + PROFILE_DIR,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=Translate,msEdgeSidebarV2,msEdgeCollections",
        "--disable-background-timer-throttling",
    ]
    try:
        return subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        return None


def watch_window(url):
    """等窗口出现，然后等它消失。返回 True 表示正常经历了一个开→关周期。"""
    appeared = False
    for _ in range(25):                 # 最多等 25 秒让它起来
        if app_window_exists():
            appeared = True
            break
        time.sleep(1)

    if not appeared:
        HUB.log("没看到界面窗口，可能浏览器把它并到了已有窗口里")
        return False

    HUB.log("窗口已就绪，关掉它就会退出")
    idle = 0
    while True:
        time.sleep(2)
        if app_window_exists():
            idle = 0
            continue
        # 关窗后给 3 秒缓冲：浏览器有时会在换 tab 时短暂消失
        idle += 1
        if idle >= 2:
            HUB.log("窗口已关闭，正在退出")
            return True


def fallback_window(url):
    """最后兜底：默认浏览器 + 一个能看配对码的小窗。"""
    import tkinter as tk

    primary, _ = local_ips()
    root = tk.Tk()
    root.title(APP_NAME + " · 电脑端")
    root.configure(bg="#F2F8FF")
    root.geometry("420x260")

    tk.Label(root, text=APP_NAME + " · 电脑端", bg="#2E7BD6", fg="white",
             font=("Microsoft YaHei UI", 12, "bold")).pack(fill="x", ipady=10)
    tk.Label(root, text="配对码", bg="#F2F8FF", fg="#5C6D63",
             font=("Microsoft YaHei UI", 9)).pack(pady=(14, 0))
    tk.Label(root, text=HUB.pair_code, bg="#F2F8FF", fg="#2E7BD6",
             font=("Consolas", 26, "bold")).pack()
    tk.Label(root, text="手机访问  http://%s:%d" % (primary, HUB.port),
             bg="#F2F8FF", fg="#17211C", font=("Consolas", 9)).pack(pady=(6, 2))
    tk.Label(root, text="界面已在默认浏览器打开。\n关掉这个窗口服务就停。",
             bg="#F2F8FF", fg="#5C6D63", font=("Microsoft YaHei UI", 8),
             justify="center").pack(pady=8)

    tk.Button(root, text="再打开一次界面", command=lambda: webbrowser.open(url),
              bg="#2E7BD6", fg="white", relief="flat",
              font=("Microsoft YaHei UI", 9), padx=12, pady=4).pack(pady=6)
    webbrowser.open(url)
    root.mainloop()


def show_window(url):
    """按 内嵌 → 浏览器应用模式 → 默认浏览器 的顺序起界面。阻塞到关窗。
    返回 True 表示窗口正常开过并关掉了。"""
    if webview_available():
        if run_embedded_window(url):
            return True
        HUB.log("内嵌窗口失败，改用浏览器应用模式")

    win = launch_app_window(url)
    if win is not None:
        return watch_window(url)

    HUB.log("没找到可用的浏览器窗口，改用系统默认浏览器")
    fallback_window(url)
    return True


# ---------------------------------------------------------------- 入口

def main():
    ensure_dirs()
    HUB.load_tokens()

    # 已经有服务在跑：把窗口带出来就行，不起第二个
    if already_running(DEFAULT_PORT):
        url = "http://127.0.0.1:%d/" % DEFAULT_PORT
        if webview_available():
            # 只是把界面挂上去看，关窗不影响那已经在跑的服务
            run_embedded_window(url)
            return
        if launch_app_window(url) is None:
            webbrowser.open(url)
        else:
            watch_window(url)
        return

    assets = load_assets()
    www_dir = os.path.join(base_dir(), "www")
    if assets is None and not os.path.isdir(www_dir):
        try:
            import tkinter as tk
            from tkinter import messagebox
            root = tk.Tk()
            root.withdraw()
            messagebox.showerror(
                "打包时选错了源文件",
                "这个 exe 里没有内嵌界面。\n\n"
                "原因是打包时选了「keyapp_desktop.py」（开发源码，\n"
                "里面没有界面资源），应该选：\n\n"
                "    desktop\\钥匙-打包用.py\n\n"
                "先运行 打包电脑端.bat（或 py desktop\\embed_assets.py）\n"
                "生成这个文件，再用它打包。")
        except Exception:
            pass
        return

    port = find_free_port(DEFAULT_PORT)
    srv = start_server(port, assets, www_dir)
    disc = Discovery(port)
    disc.start()

    url = "http://127.0.0.1:%d/" % port
    HUB.log("服务已启动 %s" % url)

    try:
        show_window(url)
    except KeyboardInterrupt:
        pass
    finally:
        disc.stop()
        srv.shutdown()
        srv.server_close()


if __name__ == "__main__":
    main()
