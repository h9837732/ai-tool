# -*- coding: utf-8 -*-
"""钥匙 · 电脑端

一个窗口 + 一个本地 Web 服务：
  · 窗口负责配对码、访问地址、已发现设备、日志
  · Web 服务托管界面、提供同步与文件接口
  · 组播广播让手机 App 自动发现这台电脑

前端界面已经内嵌在这个文件里（见文件末尾的 ASSETS_B64），
所以用 PyInstaller --onefile 打成单个 exe 后不需要任何外部文件。

只用 Python 标准库：tkinter + http.server + sqlite 都不需要，没有第三方依赖。
"""

import base64
import io
import json
import os
import socket
import struct
import sys
import threading
import time
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
    """数据放在 exe 旁边，而不是 PyInstaller 的临时解压目录。"""
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


DATA_DIR = os.path.join(base_dir(), "keyapp-data")
FILE_DIR = os.path.join(DATA_DIR, "files")
STATE_FILE = os.path.join(DATA_DIR, "state.json")
TOKENS_FILE = os.path.join(DATA_DIR, "tokens.json")


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
    虚拟机/虚拟网卡会排在后面，不干扰用户选择。"""
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
    """把内嵌的 zip 解成 {路径: (bytes, content_type)}，进程内只解一次。"""
    if not ASSETS_B64.strip():
        return None
    try:
        raw = base64.b64decode(ASSETS_B64.encode("ascii"))
        zf = zipfile.ZipFile(io.BytesIO(raw))
        out = {}
        for name in zf.namelist():
            if name.endswith("/"):
                continue
            out[name] = zf.read(name)
        return out
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
    """同一 id 取 updatedAt 更新的；墓碑比对话新就删掉。与 JS 侧逻辑一致。"""
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

    # 墓碑生效
    for cid, ts in list(out["tombstones"].items()):
        conv = out["conversations"].get(cid)
        if conv and (conv.get("updatedAt") or 0) <= ts:
            out["conversations"].pop(cid, None)

    # 7 天前的墓碑可以忘掉
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
    """服务端共享状态。GUI 和 HTTP 线程都读写它，用锁保护。"""

    def __init__(self):
        self.lock = threading.Lock()
        self.port = DEFAULT_PORT
        self.alias = "电脑"
        self.pair_code = "%06d" % (int.from_bytes(os.urandom(3), "big") % 1000000)
        self.tokens = {}
        self.peers = {}
        self.logs = []
        self.running = False
        self.server = None
        self.discovery = None

    # 日志 ------------------------------------------------------
    def log(self, message):
        line = time.strftime("%H:%M:%S") + "  " + message
        with self.lock:
            self.logs.append(line)
            if len(self.logs) > 500:
                del self.logs[:200]
        print(line)

    def take_logs(self):
        with self.lock:
            out = list(self.logs)
            self.logs = []
        return out

    # 令牌 ------------------------------------------------------
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

    # 邻居 ------------------------------------------------------
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
    server_version = "KeyappDesktop/1.0"
    protocol_version = "HTTP/1.1"

    # 让日志走自己的 GUI 而不是 stderr
    def log_message(self, fmt, *args):
        pass

    # ---- 工具 ----
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
        host = self.client_address[0]
        return host in ("127.0.0.1", "::1", "::ffff:127.0.0.1")

    def _token(self):
        h = self.headers.get("authorization") or ""
        return h[7:].strip() if h.startswith("Bearer ") else ""

    # ---- 分发 ----
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

        # 本机才能读配对码
        if path == "/api/code":
            if not self._is_local():
                return self._json(403, {"error": "local-only"})
            primary, others = local_ips()
            return self._json(200, {"code": HUB.pair_code, "port": HUB.port,
                                     "alias": HUB.alias, "ip": primary, "otherIps": others})

        # 发现应答（不需要令牌）
        if path == "/api/register" and method == "POST":
            body = self._body_json()
            if body.get("app") == APP_TAG and body.get("fingerprint"):
                HUB.note_peer(str(body["fingerprint"]), body.get("alias"), self.client_address[0],
                              body.get("port"), body.get("deviceModel", ""))
            return self._json(200, {"ok": True, "alias": HUB.alias})

        # 配对
        if path == "/api/pair" and method == "POST":
            body = self._body_json()
            if str(body.get("code") or "").strip() != HUB.pair_code:
                HUB.log("配对失败：配对码不对（来自 %s）" % self.client_address[0])
                return self._json(401, {"error": "bad-code"})
            tk = HUB.add_token(body.get("deviceName"))
            HUB.log("已配对：%s（%s）" % ((body.get("deviceName") or "device")[:30], self.client_address[0]))
            return self._json(200, {"token": tk})

        if path.startswith("/api/"):
            if not HUB.check_token(self._token()):
                return self._json(401, {"error": "unauthorized"})

            if path == "/api/info":
                return self._json(200, {"name": APP_NAME + " · 电脑端", "version": 1,
                                        "alias": HUB.alias, "devices": len(HUB.tokens), "port": HUB.port})

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
                raw_name = self.headers.get("x-filename") or "file"
                try:
                    from urllib.parse import unquote
                    raw_name = unquote(raw_name)
                except Exception:
                    pass
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
                from urllib.parse import unquote
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
                from urllib.parse import quote
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
                # 单页应用：未知路径回落到 index.html
                data = assets.get("index.html")
                if data is None:
                    return self._json(404, {"error": "not-found"})
                rel = "index.html"
            return self._raw(200, data, content_type(rel))

        # 开发模式：直接读磁盘上的 www/
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

    def _announce(self, announce=True):
        body = json.dumps({
            "alias": HUB.alias, "version": "2.0", "deviceModel": sys.platform,
            "deviceType": "desktop", "fingerprint": self.fp, "port": self.port,
            "protocol": "http", "app": APP_TAG, "download": True, "announce": announce,
        }, ensure_ascii=False).encode("utf-8")
        try:
            self.sock.sendto(body, (DISCOVERY_GROUP, DISCOVERY_PORT))
        except Exception as e:
            HUB.log("广播失败：%s" % e)

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
            HUB.log("组播发现已启动（%s:%d）" % (DISCOVERY_GROUP, DISCOVERY_PORT))
        except Exception as e:
            HUB.log("组播启动失败（不影响手动填地址）：%s" % e)
            return

        self._announce(True)
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
                    is_new = HUB.note_peer(str(j.get("fingerprint")), j.get("alias"), addr[0],
                                           j.get("port"), j.get("deviceModel", ""))
                    if is_new:
                        HUB.log("发现设备：%s @ %s" % (j.get("alias") or addr[0], addr[0]))
                    # 对方在主动喊，回一发让它也认识我
                    if j.get("announce"):
                        body = json.dumps({
                            "alias": HUB.alias, "version": "2.0", "deviceModel": sys.platform,
                            "deviceType": "desktop", "fingerprint": self.fp, "port": self.port,
                            "protocol": "http", "app": APP_TAG, "download": True, "announce": False,
                        }, ensure_ascii=False).encode("utf-8")
                        try:
                            self.sock.sendto(body, (addr[0], DISCOVERY_PORT))
                        except Exception:
                            pass

            if time.time() - last > 30:
                self._announce(True)
                last = time.time()

        try:
            self.sock.close()
        except Exception:
            pass

    def stop(self):
        self.stop_flag.set()


# ---------------------------------------------------------------- 服务启停

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
    """同一台机器上是不是已经有一个钥匙服务在跑。"""
    import urllib.request
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/api/code" % port, timeout=1.2) as r:
            return r.status == 200
    except Exception:
        return False


def start_server(port, assets, www_dir):
    # 这里是所有启动路径的唯一入口：端口先落到 HUB 上，
    # 否则换端口时 fingerprint 仍按 8787 算，自我回声过滤会失效
    HUB.port = port
    handler = Handler
    srv = ThreadingHTTPServer(("0.0.0.0", port), handler)
    srv.daemon_threads = True
    srv.assets = assets
    srv.www_dir = www_dir
    t = threading.Thread(target=srv.serve_forever)
    t.daemon = True
    t.start()
    return srv


# ---------------------------------------------------------------- 界面

import tkinter as tk
from tkinter import ttk, scrolledtext, messagebox

BG = "#F2F8FF"
CARD = "#FFFFFF"
LINE = "#D7DED6"
TEXT = "#17211C"
MUTED = "#5C6D63"
ACCENT = "#2E7BD6"
OK_GREEN = "#2E8B57"
FONT = ("Microsoft YaHei UI", 9)
FONT_BIG = ("Consolas", 30, "bold")
FONT_MONO = ("Consolas", 9)


def startup_dir():
    ad = os.environ.get("APPDATA")
    if not ad:
        return None
    return os.path.join(ad, "Microsoft", "Windows", "Start Menu", "Programs", "Startup")


def autostart_file():
    d = startup_dir()
    return os.path.join(d, "钥匙自动启动.cmd") if d else None


class App(object):
    def __init__(self, root, assets, www_dir, port, opened_by_hand):
        self.root = root
        self.assets = assets
        self.www_dir = www_dir
        self.port = port
        self.srv = None
        self.disc = None
        self.opened_by_hand = opened_by_hand

        root.title("钥匙 · 电脑端")
        root.configure(bg=BG)
        root.minsize(560, 720)
        try:
            root.iconphoto(True, tk.PhotoImage(width=1, height=1))
        except Exception:
            pass

        self._build()
        self.start()
        self._poll()

    # ---- 布局 ----
    def _card(self, parent, title=None, pad=12):
        outer = tk.Frame(parent, bg=CARD, highlightbackground=LINE, highlightthickness=1)
        outer.pack(fill="x", padx=12, pady=6)
        inner = tk.Frame(outer, bg=CARD)
        inner.pack(fill="both", expand=True, padx=pad, pady=pad)
        if title:
            tk.Label(inner, text=title, bg=CARD, fg=MUTED, font=FONT, anchor="w").pack(fill="x")
        return inner

    def _build(self):
        # 顶部
        head = tk.Frame(self.root, bg=ACCENT, height=52)
        head.pack(fill="x")
        head.pack_propagate(False)
        tk.Label(head, text="钥匙 · 电脑端", bg=ACCENT, fg="white",
                 font=("Microsoft YaHei UI", 13, "bold")).pack(side="left", padx=14)
        self.lbl_state = tk.Label(head, text="", bg=ACCENT, fg="white", font=FONT)
        self.lbl_state.pack(side="right", padx=14)

        body = tk.Frame(self.root, bg=BG)
        body.pack(fill="both", expand=True)

        # 配对码
        c1 = self._card(body, "配对码")
        row = tk.Frame(c1, bg=CARD)
        row.pack(fill="x", pady=(6, 2))
        self.lbl_code = tk.Label(row, text=HUB.pair_code, bg=CARD, fg=ACCENT, font=FONT_BIG)
        self.lbl_code.pack(side="left")
        tk.Button(row, text="复制", command=self.copy_code, bg=CARD, fg=ACCENT,
                  relief="solid", bd=1, font=FONT, padx=10).pack(side="left", padx=12)
        tk.Button(row, text="换一个", command=self.rotate_code, bg=CARD, fg=MUTED,
                  relief="solid", bd=1, font=FONT, padx=10).pack(side="left")
        tk.Label(c1, text="手机 App →「设置 → 连接」→ 填这个码。每次启动都会换。",
                 bg=CARD, fg=MUTED, font=FONT, anchor="w").pack(fill="x", pady=(4, 0))

        # 地址
        c2 = self._card(body, "访问地址")
        self.addr_box = tk.Frame(c2, bg=CARD)
        self.addr_box.pack(fill="x", pady=(4, 0))
        self.render_addresses()

        # 邻居
        c3 = self._card(body, "附近的设备")
        bar = tk.Frame(c3, bg=CARD)
        bar.pack(fill="x", pady=(4, 4))
        self.lbl_peers = tk.Label(bar, text="", bg=CARD, fg=MUTED, font=FONT)
        self.lbl_peers.pack(side="left")
        tk.Button(bar, text="刷新", command=self.refresh_peers, bg=CARD, fg=ACCENT,
                  relief="solid", bd=1, font=FONT, padx=8).pack(side="right")
        self.peer_list = tk.Listbox(c3, height=3, bg="#FAFCFE", fg=TEXT, font=FONT_MONO,
                                    relief="flat", highlightthickness=1,
                                    highlightbackground=LINE, activestyle="none")
        self.peer_list.pack(fill="x")

        # 日志
        c4 = self._card(body, "日志")
        self.log_box = scrolledtext.ScrolledText(c4, height=9, bg="#FAFCFE", fg=TEXT,
                                                 font=FONT_MONO, relief="flat",
                                                 highlightthickness=1, highlightbackground=LINE)
        self.log_box.pack(fill="both", expand=True, pady=(4, 0))
        self.log_box.configure(state="disabled")

        # 底部
        foot = tk.Frame(self.root, bg=BG)
        foot.pack(fill="x", padx=12, pady=(0, 10))

        r1 = tk.Frame(foot, bg=BG)
        r1.pack(fill="x", pady=(0, 6))
        tk.Label(r1, text="设备名称", bg=BG, fg=MUTED, font=FONT).pack(side="left")
        self.alias_var = tk.StringVar(value=HUB.alias)
        e = tk.Entry(r1, textvariable=self.alias_var, width=16, font=FONT, relief="solid", bd=1)
        e.pack(side="left", padx=8)
        tk.Button(r1, text="应用", command=self.apply_alias, bg=CARD, fg=MUTED,
                  relief="solid", bd=1, font=FONT, padx=8).pack(side="left")
        self.autostart_var = tk.BooleanVar(value=bool(autostart_file() and os.path.exists(autostart_file())))
        tk.Checkbutton(r1, text="开机自动启动", variable=self.autostart_var,
                       command=self.toggle_autostart, bg=BG, fg=MUTED, font=FONT,
                       activebackground=BG, selectcolor=CARD).pack(side="right")

        r2 = tk.Frame(foot, bg=BG)
        r2.pack(fill="x")
        self.btn_toggle = tk.Button(r2, text="停止服务", command=self.toggle_service,
                                    bg=ACCENT, fg="white", relief="flat", font=FONT, padx=14, pady=5)
        self.btn_toggle.pack(side="left")
        tk.Button(r2, text="打开界面", command=self.open_browser, bg=CARD, fg=ACCENT,
                  relief="solid", bd=1, font=FONT, padx=12, pady=5).pack(side="left", padx=8)
        tk.Button(r2, text="数据目录", command=self.open_data_dir, bg=CARD, fg=MUTED,
                  relief="solid", bd=1, font=FONT, padx=12, pady=5).pack(side="left")
        tk.Label(r2, text="关闭窗口即停止服务", bg=BG, fg=MUTED, font=FONT).pack(side="right")

        self.root.protocol("WM_DELETE_WINDOW", self.on_close)

    def render_addresses(self):
        for w in self.addr_box.winfo_children():
            w.destroy()

        primary, others = local_ips()

        def row(url, strong, note=""):
            r = tk.Frame(self.addr_box, bg=CARD)
            r.pack(fill="x", pady=1)
            tk.Label(r, text=url, bg=CARD, font=FONT_MONO,
                     fg=ACCENT if strong else MUTED, anchor="w").pack(side="left")
            if note:
                tk.Label(r, text=note, bg=CARD, fg=MUTED, font=FONT).pack(side="left", padx=6)
            tk.Button(r, text="复制", font=FONT, bg=CARD, fg=MUTED, relief="flat",
                      command=lambda x=url: self.copy_text(x)).pack(side="right")

        # 手机要用的就是这个
        row("http://%s:%d" % (primary, self.port), True, "← 手机填这个")
        row("http://localhost:%d" % self.port, False, "← 只在本机用")

        if others:
            self.more_open = getattr(self, "more_open", False)
            link = tk.Label(self.addr_box, bg=CARD, fg=MUTED, font=FONT, anchor="w",
                            cursor="hand2",
                            text=("隐藏其他网卡" if self.more_open else "其他网卡（%d 个，一般用不到）" % len(others)))
            link.pack(fill="x", pady=(4, 0))
            link.bind("<Button-1>", lambda e: self._toggle_more())
            if self.more_open:
                for ip in others:
                    row("http://%s:%d" % (ip, self.port), False, "")

        tk.Label(self.addr_box,
                 text="手机和电脑要在同一个 WiFi。首次可能弹防火墙提示，选「允许」。",
                 bg=CARD, fg=MUTED, font=FONT, anchor="w").pack(fill="x", pady=(6, 0))

    def _toggle_more(self):
        self.more_open = not getattr(self, "more_open", False)
        self.render_addresses()

    # ---- 动作 ----
    def copy_text(self, text):
        self.root.clipboard_clear()
        self.root.clipboard_append(text)
        self.write_log("已复制：" + text)

    def copy_code(self):
        self.copy_text(HUB.pair_code)

    def rotate_code(self):
        old = HUB.pair_code
        HUB.pair_code = "%06d" % (int.from_bytes(os.urandom(3), "big") % 1000000)
        self.lbl_code.configure(text=HUB.pair_code)
        self.write_log("配对码已更换：%s → %s（旧令牌仍有效）" % (old, HUB.pair_code))

    def apply_alias(self):
        a = self.alias_var.get().strip()[:40]
        if not a:
            return
        HUB.alias = a
        self.write_log("设备名称改为：" + a)

    def toggle_autostart(self):
        f = autostart_file()
        if not f:
            self.write_log("这台机器找不到启动文件夹，跳过")
            return
        try:
            if self.autostart_var.get():
                if getattr(sys, "frozen", False):
                    target = os.path.abspath(sys.executable)
                else:
                    target = os.path.abspath(__file__)
                with io.open(f, "w", encoding="gbk", errors="ignore") as fh:
                    fh.write("@echo off\r\n")
                    if getattr(sys, "frozen", False):
                        fh.write('start "" "%s"\r\n' % target)
                    else:
                        fh.write('start "" pythonw "%s"\r\n' % target)
                self.write_log("已加入开机启动：" + f)
            else:
                if os.path.exists(f):
                    os.remove(f)
                self.write_log("已取消开机启动")
        except Exception as e:
            self.write_log("设置开机启动失败：%s" % e)

    def open_browser(self):
        webbrowser.open("http://127.0.0.1:%d/" % self.port)

    def open_data_dir(self):
        try:
            os.startfile(DATA_DIR)
        except Exception:
            self.write_log("数据目录：" + DATA_DIR)

    def toggle_service(self):
        if self.srv:
            self.stop()
        else:
            self.start()

    def start(self):
        if self.srv:
            return
        try:
            self.srv = start_server(self.port, self.assets, self.www_dir)
        except Exception as e:
            messagebox.showerror("启动失败", "端口 %d 无法监听：\n%s" % (self.port, e))
            return
        self.disc = Discovery(self.port)
        self.disc.start()
        HUB.running = True
        self.btn_toggle.configure(text="停止服务", bg="#B0453B")
        self.lbl_state.configure(text="●  运行中  :%d" % self.port)
        self.write_log("服务已启动 http://localhost:%d" % self.port)
        if not self.opened_by_hand:
            self.root.after(600, self.open_browser)

    def stop(self):
        if self.srv:
            try:
                self.srv.shutdown()
                self.srv.server_close()
            except Exception:
                pass
            self.srv = None
        if self.disc:
            self.disc.stop()
            self.disc = None
        HUB.running = False
        self.btn_toggle.configure(text="启动服务", bg=ACCENT)
        self.lbl_state.configure(text="●  已停止")
        self.write_log("服务已停止")

    def on_close(self):
        self.stop()
        self.root.destroy()

    # ---- 日志与刷新 ----
    def write_log(self, message):
        line = time.strftime("%H:%M:%S") + "  " + message
        self.log_box.configure(state="normal")
        self.log_box.insert("end", line + "\n")
        self.log_box.see("end")
        self.log_box.configure(state="disabled")

    def refresh_peers(self):
        peers = HUB.peer_list()
        self.peer_list.delete(0, "end")
        for p in peers:
            self.peer_list.insert("end", "%-14s %s:%d" % (p["alias"][:14], p["address"], p["port"]))
        self.lbl_peers.configure(text=("共 %d 台" % len(peers)) if peers else "还没有发现别的设备")

    def _poll(self):
        for line in HUB.take_logs():
            self.log_box.configure(state="normal")
            self.log_box.insert("end", line + "\n")
            self.log_box.see("end")
            self.log_box.configure(state="disabled")
        self.refresh_peers()
        self.root.after(1200, self._poll)


# ---------------------------------------------------------------- 入口

def main():
    ensure_dirs()
    HUB.load_tokens()

    # 已经在跑就直接打开界面，不开第二个实例
    if already_running(DEFAULT_PORT):
        webbrowser.open("http://127.0.0.1:%d/" % DEFAULT_PORT)
        return

    assets = load_assets()
    www_dir = os.path.join(base_dir(), "www")
    if assets is None and not os.path.isdir(www_dir):
        root = tk.Tk()
        root.withdraw()
        messagebox.showerror(
            "缺少界面资源",
            "这个程序里没有内嵌前端文件，旁边也没有 www 目录。\n\n"
            "请用 embed_assets.py 生成带资源的版本后再打包。")
        return

    port = find_free_port(DEFAULT_PORT)
    root = tk.Tk()
    App(root, assets, www_dir, port, opened_by_hand=False)
    root.mainloop()


if __name__ == "__main__":
    main()
