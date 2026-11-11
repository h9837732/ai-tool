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
import binascii
import hashlib
import io
import json
import os
import shutil
import socket
import struct
import subprocess
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
import threading
import time
import urllib.request
import webbrowser
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, quote

APP_NAME = "钥匙"
# 由 embed_assets.py 从 package.json 写入真实版本号，源码里保持占位。
# 这样 exe 里的版本号永远和前端一致，不会再出现「关于页显示旧版本」。
APP_VERSION = "0.0.0-dev"
APP_REPO = "h9837732/ai-tool"


def _dev_version():
    """开发模式（直接跑 .py）时版本号还是占位符，去 package.json 读一个，
    否则本地调试时「关于」页永远显示 0.0.0-dev。"""
    global APP_VERSION
    if not APP_VERSION.endswith("-dev"):
        return
    try:
        import json as _json
        path = os.path.join(base_dir(), "package.json")
        if not os.path.isfile(path):
            path = os.path.join(os.path.dirname(base_dir()), "package.json")
        with io.open(path, "r", encoding="utf-8") as f:
            APP_VERSION = str(_json.load(f).get("version") or APP_VERSION)
    except Exception:
        pass
DISCOVERY_GROUP = "224.0.0.167"
DISCOVERY_PORT = 53317
DEFAULT_PORT = 8787
APP_TAG = "keyapp"

# 本机免令牌开关（自测会把此设为 False 来验证令牌校验真的生效）
LOCAL_FREE = True

# ---------- 限额 ----------
MAX_JSON = 2 * 1024 * 1024        # 同步用的 JSON
MAX_FILE = 64 * 1024 * 1024       # 文件传输

# ---------- 配对码限速 ----------
# 6 位数字只有 100 万种，不限速的话局域网里跑一会儿就试出来了。
PAIR_MAX_FAILS = 5
# 锁定时长。可用环境变量覆盖（自测设短一点，不然两分钟内不能重跑）
try:
    PAIR_WINDOW_MS = int(os.environ.get("KEYAPP_PAIR_LOCK_MS") or 0) or 10 * 60 * 1000
except ValueError:
    PAIR_WINDOW_MS = 10 * 60 * 1000


# 自动更新只接受 https。自测需要一个本地 HTTP 服务，用这个开关放开（仅测试用）。
UPDATE_ALLOW_HTTP = False


class TooLarge(Exception):
    """请求体超过上限。"""

    def __init__(self, size):
        Exception.__init__(self, "too-large: %s" % size)
        self.size = size

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
# 密钥密文（DPAPI）
SECRETS_FILE = os.path.join(DATA_DIR, "secrets.dat")


def _make_secure_store():
    """SECRETS_FILE 依赖 DATA_DIR，而 DATA_DIR 在自测里会被改指向临时目录，
    所以不能提前创建实例，用函数惰性构造。"""
    try:
        import secure_store
    except Exception:
        return None
    return secure_store.DpapiStore(SECRETS_FILE)


def ensure_dirs():
    os.makedirs(FILE_DIR, exist_ok=True)


def load_json(path, fallback):
    try:
        with io.open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return fallback


def save_json(path, value):
    """原子写。临时文件名必须每线程不同：
    并发时两个请求都写 state.json.tmp 会撞在一起（
    实测会抛 PermissionError: 另一个程序正在使用此文件）。"""
    tmp = "%s.%d.%d.%s.tmp" % (path, os.getpid(),
                                threading.get_ident(),
                                binascii.hexlify(os.urandom(4)).decode("ascii"))
    try:
        with io.open(tmp, "w", encoding="utf-8") as f:
            json.dump(value, f, ensure_ascii=False, indent=2)
        # Windows 上目标文件被另一个线程/杀软瞬时占用时 os.replace 会抛
        # PermissionError（WinError 5/32）。重试几次比直接 500 好。
        last = None
        for _ in range(8):
            try:
                os.replace(tmp, path)
                return
            except OSError as e:
                last = e
                time.sleep(0.02)
        raise last
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except Exception:
                pass


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
        # 实时推送：订阅了 /api/events 的连接。每项 {wfile, lock, alive, agent}
        self.sse = []
        self.sse_lock = threading.Lock()
        # 配对码限速：ip -> {"n": 失败次数, "first": 起始时, "until": 封到什么时候}
        self.pair_fails = {}
        # 同步的「读-合并-写」必须串行，否则两个并发请求会互相覆盖（丢更新）
        self.state_lock = threading.Lock()

    # ---------- 配对码限速 ----------

    def pair_blocked(self, ip):
        with self.lock:
            rec = self.pair_fails.get(ip)
            if not rec:
                return 0
            now = int(time.time() * 1000)
            if rec.get("until") and now < rec["until"]:
                return int((rec["until"] - now) / 1000) + 1
            return 0

    def note_pair_fail(self, ip):
        now = int(time.time() * 1000)
        with self.lock:
            rec = self.pair_fails.get(ip) or {"n": 0, "first": now, "until": 0}
            if now - rec["first"] > PAIR_WINDOW_MS:
                rec = {"n": 0, "first": now, "until": 0}
            rec["n"] += 1
            if rec["n"] >= PAIR_MAX_FAILS:
                rec["until"] = now + PAIR_WINDOW_MS
                rec["n"] = 0
                rec["first"] = now
            self.pair_fails[ip] = rec

    def clear_pair_fail(self, ip):
        with self.lock:
            self.pair_fails.pop(ip, None)

    # ---------- 实时推送 ----------

    def add_sse(self, client):
        with self.sse_lock:
            self.sse.append(client)

    def drop_sse(self, client):
        with self.sse_lock:
            try:
                self.sse.remove(client)
            except ValueError:
                pass

    def broadcast(self, kind, payload=None, origin_token=None):
        """给所有订阅端推一条事件。谁写失败就把谁踢掉。

        origin_token：不要推回发起方自己，否则「收到事件→同步→广播」会无限对抽。
        """
        frame = "event: %s\ndata: %s\n\n" % (
            kind, json.dumps(payload or {}, ensure_ascii=False))
        with self.sse_lock:
            targets = list(self.sse)
        dead = []
        for c in targets:
            if origin_token and c.get("token") == origin_token:
                continue
            try:
                with c["lock"]:
                    data = frame.encode("utf-8")
                    c["wfile"].write(b"%x\r\n" % len(data) + data + b"\r\n")
                    c["wfile"].flush()
            except Exception:
                dead.append(c)
        for c in dead:
            self.drop_sse(c)
            c["alive"] = False

    def sse_count(self):
        with self.sse_lock:
            return len(self.sse)

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

    def _json(self, code, obj, extra=None):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self._cors()
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _drain(self, limit=4 * 1024 * 1024):
        """把没读完的请求体丢掉再回错误。

        不排空就直接断连，客户端还在发数据时收到 RST，会报
        ConnectionAbortedError 而不是看到真正的 413。"""
        try:
            n = int(self.headers.get("content-length") or 0)
        except ValueError:
            n = 0
        left = min(n, limit)
        try:
            while left > 0:
                chunk = self.rfile.read(min(65536, left))
                if not chunk:
                    break
                left -= len(chunk)
        except Exception:
            pass

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

    # ---------- 请求体 ----------

    def _body(self, limit=None):
        """读请求体。超过上限就不读，直接抛 TooLarge（以前不限，
        局域网里发一个超大 body 就能把内存吃光）。"""
        limit = MAX_FILE if limit is None else limit
        try:
            n = int(self.headers.get("content-length") or 0)
        except ValueError:
            n = 0
        if n > limit:
            raise TooLarge(n)
        if n <= 0:
            return b""
        data = self.rfile.read(n)
        if len(data) > limit:
            raise TooLarge(len(data))
        return data

    def _body_json(self, limit=None):
        try:
            raw = self._body(MAX_JSON if limit is None else limit)
        except TooLarge as e:
            raise
        try:
            obj = json.loads(raw.decode("utf-8") or "{}")
            return obj if isinstance(obj, dict) else {}
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

    # ---------- 实时推送（SSE）----------

    def _sse(self, token=""):
        """长连接推送。用 chunked 编码，每条事件一个 chunk。"""
        self.send_response(200)
        self.send_header("content-type", "text/event-stream; charset=utf-8")
        self.send_header("cache-control", "no-store")
        self.send_header("connection", "keep-alive")
        self.send_header("transfer-encoding", "chunked")
        self.send_header("x-accel-buffering", "no")
        self._cors()
        self.end_headers()

        client = {"wfile": self.wfile, "lock": threading.Lock(), "alive": True,
                  "agent": self.client_address[0], "token": token}
        HUB.add_sse(client)
        HUB.log("实时推送：%s 已连上（共 %d 个）" % (client["agent"], HUB.sse_count()))

        def chunk(text):
            data = text.encode("utf-8")
            with client["lock"]:
                self.wfile.write(b"%x\r\n" % len(data) + data + b"\r\n")
                self.wfile.flush()

        try:
            chunk("retry: 3000\n\n")
            chunk("event: hello\ndata: %s\n\n" % json.dumps({"port": HUB.port}))
            last = time.time()
            while client["alive"]:
                time.sleep(1)
                if time.time() - last >= 15:
                    chunk(": ping\n\n")     # 注释行当心跳，EventSource 会忽略
                    last = time.time()
        except Exception:
            pass
        finally:
            client["alive"] = False
            HUB.drop_sse(client)
            self.close_connection = True
            HUB.log("实时推送：%s 断开（剩 %d 个）" % (client["agent"], HUB.sse_count()))

    def do_GET(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")

    def do_DELETE(self):
        self._route("DELETE")

    def _route(self, method):
        try:
            return self._route_inner(method)
        except TooLarge as e:
            # 先把没读完的 body 排掉，再回 413；否则客户端会看到 RST
            self._drain()
            self.close_connection = True
            return self._json(413, {"error": "too-large", "bytes": e.size},
                              {"connection": "close"})
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
            return None

    def _route_inner(self, method):
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
                "port": HUB.port, "version": APP_VERSION
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

        # 实时推送。EventSource 不能带 header，所以令牌走 ?token=；
        # 本机（电脑端自己的界面）不需要令牌。
        if path == "/api/events" and method == "GET":
            qs = self.path.split("?", 1)[1] if "?" in self.path else ""
            qtok = ""
            for part in qs.split("&"):
                if part.startswith("token="):
                    qtok = unquote(part[6:])
            if not (self._is_local() or HUB.check_token(qtok)):
                return self._json(401, {"error": "unauthorized"})
            return self._sse(qtok)

        if path == "/api/register" and method == "POST":
            body = self._body_json()
            if body.get("app") == APP_TAG and body.get("fingerprint"):
                HUB.note_peer(str(body["fingerprint"]), body.get("alias"), self.client_address[0],
                              body.get("port"), body.get("deviceModel", ""))
            return self._json(200, {"ok": True, "alias": HUB.alias})

        if path == "/api/pair" and method == "POST":
            ip = self.client_address[0]
            wait = HUB.pair_blocked(ip)
            if wait > 0:
                HUB.log("配对被限速：%s 还需等 %d 秒" % (ip, wait))
                return self._json(429, {"error": "too-many-attempts", "retryAfter": wait})
            body = self._body_json()
            if str(body.get("code") or "").strip() != HUB.pair_code:
                HUB.note_pair_fail(ip)
                HUB.log("配对失败：配对码不对（来自 %s）" % ip)
                return self._json(401, {"error": "bad-code"})
            HUB.clear_pair_fail(ip)
            tk = HUB.add_token(body.get("deviceName"))
            HUB.log("已配对：%s" % ((body.get("deviceName") or "device")[:30]))
            return self._json(200, {"token": tk})

        if path == "/api/version":
            # 电脑端界面（localhost）查版本不需要令牌
            if not ((LOCAL_FREE and self._is_local()) or HUB.check_token(self._token())):
                return self._json(401, {"error": "unauthorized"})
            return self._json(200, {
                "version": APP_VERSION,
                "app": APP_TAG,
                "repo": APP_REPO,
                "platform": "desktop",
            })

        if path.startswith("/api/"):
            # 本机（127.0.0.1）免令牌：能连到本机端口就说明已经在本机了，
            # 而电脑端自己的界面就是由这个端口托管的，它必须能读写同一份数据，
            # 否则电脑上的对话永远进不了同步。
            # LOCAL_FREE 只是给自测用的开关，默认开。
            local_free = LOCAL_FREE and self._is_local()
            if not (local_free or HUB.check_token(self._token())):
                return self._json(401, {"error": "unauthorized"})

            if path == "/api/version":
                return self._json(200, {
                    "version": APP_VERSION,
                    "app": APP_TAG,
                    "repo": APP_REPO,
                    "platform": "desktop",
                })

            # 客户端告诉中枢「我这边改了东西」→ 广播给其他端，它们自己去拉
            if path == "/api/touch" and method == "POST":
                body = self._body_json()
                HUB.broadcast("changed", {"from": body.get("device") or "device",
                                          "at": int(time.time() * 1000)},
                              origin_token=self._token())
                return self._json(200, {"ok": True, "listeners": HUB.sse_count()})

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
                # 读-合并-写串行：并发请求交叠会互相覆盖
                with HUB.state_lock:
                    local = load_json(STATE_FILE, {"conversations": {}, "tombstones": {},
                                                   "skills": None, "skillsAt": 0})
                    merged = merge_state(local, incoming)
                    save_json(STATE_FILE, merged)
                HUB.log("同步完成：%d 条对话" % len(merged["conversations"]))
                # 实时推送：把这次变更告诉其他端（发起方自己不用收，它已经拿到结果）
                HUB.broadcast("changed", {"from": str(incoming.get("device") or "device"),
                                          "at": int(time.time() * 1000)},
                              origin_token=self._token())
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
                raw_name = unquote(self.headers.get("x-filename") or "file")
                safe = os.path.basename(raw_name)
                for ch in '\\/:*?"<>|':
                    safe = safe.replace(ch, "_")
                safe = safe[:120] or "file"
                data = self._body(MAX_FILE)
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

        # 只接受干净的相对路径：拒绝 ..、反斜杠、隐藏文件（.git/.env 之类）
        if ".." in rel or "\\" in rel or "\x00" in rel:
            return self._json(400, {"error": "bad-path"})
        if any(seg.startswith(".") for seg in rel.split("/") if seg):
            return self._json(404, {"error": "not-found"})

        if assets is not None:
            data = assets.get(rel)
            if data is None:
                # SPA 回落只给「无扩展名」的路径。
                # 以前任何路径都回首页，于是 /package.json 也返回 200，
                # 既掩盖了路径探测，也让客户端分不清 404 和首页。
                if os.path.splitext(rel)[1]:
                    return self._json(404, {"error": "not-found"})
                data = assets.get("index.html")
                if data is None:
                    return self._json(404, {"error": "not-found"})
                rel = "index.html"
            return self._raw(200, data, content_type(rel))

        root = getattr(self.server, "www_dir", "") or ""
        fp = os.path.abspath(os.path.join(root, rel))
        if not root or not fp.startswith(os.path.abspath(root)):
            return self._json(400, {"error": "bad-path"})
        if not os.path.isfile(fp):
            # 无扩展名 → 回首页（同上面）
            if not os.path.splitext(rel)[1]:
                idx = os.path.join(os.path.abspath(root), "index.html")
                if os.path.isfile(idx):
                    with open(idx, "rb") as f:
                        return self._raw(200, f.read(), content_type("index.html"))
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

def _port_in_use(p):
    """有人在这个端口监听吗。

    不能只看自己能不能 bind：Windows 下别人只绑 127.0.0.1:8787 时，
    我们绑 0.0.0.0:8787 依然会成功，但客户端连 127.0.0.1 就打到别人那里去了。
    （实测：python -m http.server 占着 8787，find_free_port 仍返回 8787）"""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(0.3)
    try:
        return s.connect_ex(("127.0.0.1", p)) == 0
    except Exception:
        return False
    finally:
        s.close()


def find_free_port(start=DEFAULT_PORT, tries=20):
    """找一个真能用的端口。全被占时返回 None（以前是直接返回 start，
    结果去 bind 一个已占用的端口，进程直接崩，用户什么提示也看不到）。"""
    for p in range(start, start + tries):
        if _port_in_use(p):
            continue
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.bind(("0.0.0.0", p))
            return p
        except OSError:
            continue
        finally:
            s.close()
    return None


def already_running(port):
    """已经在跑时返回它的版本号；没跑或端口上是别的程序时返回 None。

    以前只判 HTTP 200，于是 8787 被别的软件占用时会把对方当成自己，
    弹出来的窗口里是别人的页面。现在必须真的回 app=keyapp 才算。"""
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/api/ping" % port, timeout=1.5) as r:
            if r.status != 200:
                return None
            info = json.loads(r.read().decode("utf-8") or "{}")
            if not isinstance(info, dict) or info.get("app") != APP_TAG:
                return None
            return str(info.get("version") or "")
    except Exception:
        return None


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


def fetch_sidecar_hash(url):
    """去拉 `<url>.sha256` 旁文件。返回十六进制哈希或空串。

    release 页不提供 digest 时的备选：把一个同名 .sha256 文件一起上传即可。
    内容格式随意，取里面第一个 64 位十六进制串（兼容 `hash  filename` 写法）。"""
    import re
    try:
        req = urllib.request.Request(url + ".sha256", headers={"user-agent": "keyapp-updater/1"})
        with urllib.request.urlopen(req, timeout=15) as r:
            text = r.read(4096).decode("utf-8", "replace")
        m = re.search(r"\b([0-9a-fA-F]{64})\b", text)
        return m.group(1).lower() if m else ""
    except Exception:
        return ""


def write_update_script(script_path, target, new_exe, old_path):
    """生成「等进程退出 → 改名旧版 → 放新版 → 启动」的 cmd 脚本。

    抽成独立函数是为了能单独测：直接跑这段 cmd 验证替换是否真的成功，
    不用真的下载一遍。

    为什么要重试：刚 os._exit 时 Windows 可能还没释放弃文件句柄，
    move 会失败。不能一次就放弃，否则用户点了更新什么都没发生。
    """
    lines = [
        "@echo off",
        "chcp 936 >nul",
        "timeout /t 2 /nobreak >nul",
        "set n=0",
        ":retry",
        'move /y "%s" "%s" >nul 2>&1' % (target, old_path),
        "if errorlevel 1 (",
        "  set /a n+=1",
        "  if %n% GEQ 20 goto fail",
        "  timeout /t 1 /nobreak >nul",
        "  goto retry",
        ")",
        'move /y "%s" "%s" >nul 2>&1' % (new_exe, target),
        "if errorlevel 1 goto restore",
        'del "%s" >nul 2>&1' % old_path,
        'start "" "%s"' % target,
        "exit /b 0",
        ":restore",
        'move /y "%s" "%s" >nul 2>&1' % (old_path, target),
        ":fail",
        'start "" "%s"' % target,
        "exit /b 1",
    ]
    with io.open(script_path, "w", encoding="gbk", newline="\r\n") as f:
        f.write("\r\n".join(lines))
    return script_path


class _Bridge:
    """暴露给页面的极小接口。
    open_external — 外链丢给系统浏览器，别把整个应用导航走
    self_update   — 下载新版 exe 并自己换上去（无需手动下载）
    secure_*      — Windows DPAPI 加密存密钥（不再明文放 localStorage）"""

    def secure_available(self):
        st = _make_secure_store()
        return bool(st and st.is_available())

    def secure_get(self, key):
        st = _make_secure_store()
        if not st:
            return None
        try:
            return st.get(key)
        except Exception as e:
            HUB.log("读取密钥失败：%s" % e)
            return None

    def secure_set(self, key, value):
        st = _make_secure_store()
        if not st:
            return False
        try:
            return bool(st.set(key, value))
        except Exception as e:
            HUB.log("保存密钥失败：%s" % e)
            return False

    def secure_remove(self, key):
        st = _make_secure_store()
        if not st:
            return False
        try:
            return bool(st.remove(key))
        except Exception as e:
            HUB.log("删除密钥失败：%s" % e)
            return False


    def open_external(self, url):
        try:
            if isinstance(url, str) and url.split(":", 1)[0].lower() in ("http", "https", "mailto"):
                webbrowser.open(url)
                return True
        except Exception:
            pass
        return False

    def app_version(self):
        return APP_VERSION

    def self_update(self, url, sha256=""):
        """下载并安装新版。返回 {ok, error}。

        sha256：期望的十六进制哈希（可空）。给了就必须一致才装。
          电脑端的 exe 里跑着用户的密钥，下错一个文件就把整个程序换掉了，
          所以没校验时至少去拉一个 .sha256 旁文件；两样都没有就拒装。

        Windows 不允许覆盖正在运行的 exe，但**允许改名**，所以：
          1. 下到 keyapp-data/update/new.exe
          2. 启一个分离的 cmd：等我们退出 → 改名旧 exe → 放新的 → 启动
          3. 本进程直接 _exit
        中途任何一步失败都把临时文件删干净，原 exe 不动。"""
        try:
            return self._self_update(url, sha256)
        except Exception as e:
            HUB.log("自动更新失败：%s" % e)
            return {"ok": False, "error": str(e)}

    def _self_update(self, url, sha256=""):
        ok_scheme = url.lower().startswith("https://") if isinstance(url, str) else False
        if UPDATE_ALLOW_HTTP and isinstance(url, str) and url.lower().startswith("http://127.0.0.1"):
            ok_scheme = True
        if not ok_scheme:
            return {"ok": False, "error": "bad-url"}
        if not getattr(sys, "frozen", False):
            # 开发模式（直接跑 .py）没有可替换的 exe，只开链接
            webbrowser.open(url)
            return {"ok": False, "error": "dev-mode"}

        target = os.path.abspath(sys.executable)
        if not target.lower().endswith(".exe"):
            return {"ok": False, "error": "not-exe"}

        upd_dir = os.path.join(DATA_DIR, "update")
        os.makedirs(upd_dir, exist_ok=True)
        tmp = os.path.join(upd_dir, "new.exe")
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except Exception:
                pass

        HUB.log("正在下载新版本…")
        req = urllib.request.Request(url, headers={
            "user-agent": "keyapp-updater/1",
            "accept": "application/octet-stream",
        })
        digest = hashlib.sha256()
        total = 0
        with urllib.request.urlopen(req, timeout=60) as r, open(tmp, "wb") as f:
            while True:
                chunk = r.read(262144)
                if not chunk:
                    break
                f.write(chunk)
                digest.update(chunk)
                total += len(chunk)
                if total > 400 * 1024 * 1024:
                    f.close()
                    os.remove(tmp)
                    return {"ok": False, "error": "文件太大，放弃"}
        actual = digest.hexdigest()

        size = os.path.getsize(tmp)
        if size < 3 * 1024 * 1024:
            os.remove(tmp)
            return {"ok": False, "error": "下载的内容不是 exe（%d 字节）" % size}
        with open(tmp, "rb") as f:
            if f.read(2) != b"MZ":
                os.remove(tmp)
                return {"ok": False, "error": "下载的内容不是有效的 exe"}

        # ---------- SHA-256 校验 ----------
        want = (sha256 or "").strip().lower()
        if want.startswith("sha256:"):
            want = want[7:]
        if not want:
            want = fetch_sidecar_hash(url)
        if not want:
            os.remove(tmp)
            HUB.log("更新被拒：拿不到校验值")
            return {"ok": False, "error": "no-checksum"}
        if want != actual:
            os.remove(tmp)
            HUB.log("更新被拒：校验失败 期望 %s 实际 %s" % (want[:16], actual[:16]))
            return {"ok": False, "error": "checksum-mismatch",
                    "expected": want[:16], "actual": actual[:16]}
        HUB.log("校验通过 %s…" % actual[:16])

        old = target + ".old.exe"
        script = write_update_script(
            os.path.join(upd_dir, "apply.cmd"), target, tmp, old)

        HUB.log("下载完成（%.1f MB），正在替换并重启" % (size / 1048576.0))
        subprocess.Popen(
            ["cmd.exe", "/c", script],
            creationflags=0x00000008 | 0x00000200,   # DETACHED_PROCESS | NEW_PROCESS_GROUP
            close_fds=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        def _bye():
            time.sleep(1.0)
            os._exit(0)
        threading.Thread(target=_bye, daemon=True).start()
        return {"ok": True, "size": size}


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

def err_box(title, message):
    """弹一个错误框。没 tkinter 也不崩。"""
    try:
        import tkinter as tk
        from tkinter import messagebox
        root = tk.Tk()
        root.withdraw()
        messagebox.showerror(title, message)
        root.destroy()
    except Exception:
        HUB.log(title + ": " + message.replace("\n", " "))


def main():
    ensure_dirs()
    _dev_version()
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
    if port is None:
        err_box("端口都被占用了",
                "%d 到 %d 都被其他程序占用，服务起不来。\n\n"
                "常因：上一份钥匙还在跑（去任务管理器结束「钥匙.exe」），\n"
                "或其他软件占着这些端口。\n\n"
                "关掉占用后再双击一次。" % (DEFAULT_PORT, DEFAULT_PORT + 19))
        return
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
