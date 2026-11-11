/* 钥匙 · 局域网桥接服务
 *
 * 作用：让手机和电脑通过同一个 WiFi 互相同步对话、传文件。
 * 为什么需要它：网页不能监听端口，所以必须有一端跑这个程序。
 *
 * 启动：
 *   bun run server/lan.mjs
 * 然后手机浏览器打开终端里打印的地址，或在已装好的 App 里
 * 「设置 → 连接」填这个地址 + 配对码。
 *
 * 数据都在本机：
 *   server/data/tokens.json    已配对设备的令牌
 *   server/data/state.json     同步过去的对话与技能
 *   server/data/files/         接收到的文件
 *
 * 安全设计：
 *   1. 所有 /api 接口除配对与本地自查外都要令牌
 *   2. 配对码 6 位，服务启动时随机生成，只在电脑本机可见
 *   3. 蓝牙过来的设备不知道配对码就拿不到任何数据
 */

import { mkdir, readFile, writeFile, readdir, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, basename, resolve, sep } from "node:path";
import { startDiscovery, makeFingerprint } from "./discovery.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const WEB_ROOT = decodeURIComponent(ROOT);
const DATA_DIR = join(WEB_ROOT, "server", "data");
const FILE_DIR = join(DATA_DIR, "files");
const PORT = Number(process.env.PORT || 8787);
const DEVICE_ALIAS = String(process.env.ALIAS || (await import("node:os")).hostname()).slice(0, 40);
const APP_NAME = "\u94a5\u5319";
const APP_VERSION = await readPkgVersion();

/* ---------- 静态资源的根 ----------
 * 以前这里直接用 WEB_ROOT（项目根），于是同一 WiFi 下任何人都能读：
 *   /package.json  /desktop/keyapp_desktop.py  /.git/config
 * 现在只允许 www/（前端产物）；退回项目根时只放行前端文件。 */
const WWW_DIR = join(WEB_ROOT, "www");
const HAS_WWW = existsSync(join(WWW_DIR, "index.html"));
const STATIC_ROOT = HAS_WWW ? WWW_DIR : WEB_ROOT;
/* 退回根目录时只认这些（和 desktop/embed_assets.py 的内嵌清单一致） */
const SAFE_FILES = new Set(["index.html", "icon.svg", "manifest.webmanifest", "sw.js"]);
const SAFE_DIRS = new Set(["css", "js"]);

/* ---------- 请求体上限 ---------- */
const MAX_JSON = 2 * 1024 * 1024;          // 对话同步的 JSON
const MAX_FILE = 64 * 1024 * 1024;         // 文件传输

/* ---------- 配对码限速 ----------
 * 6 位数字只有 100 万种，不限速的话局域网里跑一会儿就试出来了。 */
const PAIR_MAX_FAILS = 5;
const PAIR_WINDOW_MS = Number(process.env.KEYAPP_PAIR_LOCK_MS || 10 * 60 * 1000);
const pairFails = new Map();               // ip -> { n, first, until }

/* ---------- 实时推送（/api/events） ---------- */
const sseClients = new Set();

/* ---------- 写保护的串行锁 ----------
 * 同步是「读 → 合并 → 写」，两个请求交叠会互相覆盖（丢更新）。
 * Bun 是单线程 + await，等待点就会切走，所以需要显式的串行队列。 */
let stateChain = Promise.resolve();
function withStateLock(fn) {
  const run = stateChain.then(fn, fn);
  stateChain = run.then(() => {}, () => {});
  return run;
}

async function readPkgVersion() {
  try {
    const raw = await readFile(join(WEB_ROOT, "package.json"), "utf8");
    const v = JSON.parse(raw).version;
    return v ? String(v) : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/* LocalSend 风格发现的邻居设备：fingerprint → peer */
const discovered = new Map();
const SELF_FINGERPRINT = makeFingerprint(String(Number(process.env.PORT || 8787)));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".apk": "application/vnd.android.package-archive"
};

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, x-filename",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS"
};

/** 统一的 JSON 响应 */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8" }
  });
}

/** SSE 长连接响应（Bun 的 ReadableStream + 定时心跳） */
function sseResponse(token) {
  let client;
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      let alive = true;
      client = {
        token: token || "",
        send(text) {
          if (!alive) throw new Error("closed");
          controller.enqueue(enc.encode(text));
        },
        close() {
          alive = false;
          try { controller.close(); } catch {}
        }
      };
      sseClients.add(client);
      client.send("retry: 3000\n\n");
      client.send(sseFrame("hello", { port: PORT }));
      /* 心跳：没有它中间设备会掐掉空闲连接 */
      const timer = setInterval(() => {
        try {
          client.send(": ping\n\n");
        } catch {
          clearInterval(timer);
          sseClients.delete(client);
        }
      }, 15000);
      if (timer.unref) timer.unref();
      client.timer = timer;
    },
    cancel() {
      if (client) {
        if (client.timer) clearInterval(client.timer);
        sseClients.delete(client);
      }
    }
  });
  return new Response(stream, {
    headers: {
      ...CORS,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no"
    }
  });
}

/** 已配对设备的公开视图（只给尾部，不暴露完整令牌） */
function devicesOf(tokens) {
  return Object.entries(tokens)
    .map(([tk, meta]) => ({
      tail: tk.slice(-6),
      device: (meta && meta.device) || "device",
      at: (meta && meta.at) || 0
    }))
    .sort((a, b) => b.at - a.at);
}

/** 自己所在的局域网 IP（给扫描端回来用） */
async function primaryIp() {
  try {
    const os = await import("node:os");
    const nets = Object.values(os.networkInterfaces()).flat();
    for (const n of nets) {
      if (n && n.family === "IPv4" && !n.internal) return n.address;
    }
  } catch {}
  return "127.0.0.1";
}

async function ensureDirs() {
  await mkdir(FILE_DIR, { recursive: true });
}

async function readJSON(file, fallback) {
  try {
    const t = await readFile(file, "utf8");
    return JSON.parse(t);
  } catch {
    return fallback;
  }
}

async function writeJSON(file, value) {
  await writeFile(file, JSON.stringify(value, null, 2), "utf8");
}

/* ---------- 配对码 ---------- */

/** 每次启动生成一个 6 位数字，只打印在电脑终端里 */
const PAIR_CODE = String(Math.floor(100000 + Math.random() * 900000));
const STATE_FILE = () => join(DATA_DIR, "state.json");
const TOKENS_FILE = () => join(DATA_DIR, "tokens.json");

async function loadTokens() {
  const t = await readJSON(TOKENS_FILE(), null);
  return t && typeof t === "object" ? t : {};
}
async function saveTokens(t) {
  await writeJSON(TOKENS_FILE(), t);
}

function newToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function tokenOf(req) {
  const h = req.headers.get("authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}

async function authorized(req, tokens) {
  const tk = tokenOf(req);
  return !!tk && Object.prototype.hasOwnProperty.call(tokens, tk);
}

/** 请求是不是来自本机（电脑端界面自己） */
function fromLocalhost(req, server) {
  const addr = (server.requestIP(req) || {}).address || "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/* ---------- 实时推送 ---------- */

function sseFrame(event, payload) {
  return `event: ${event}\ndata: ${JSON.stringify(payload || {})}\n\n`;
}

function broadcast(event, payload, originToken) {
  const frame = sseFrame(event, payload);
  for (const c of [...sseClients]) {
    if (originToken && c.token === originToken) continue;   // 不推回发起方
    try {
      c.send(frame);
    } catch {
      sseClients.delete(c);
      try { c.close(); } catch {}
    }
  }
}

/* ---------- 配对码限速 ---------- */

function pairBlocked(ip) {
  const rec = pairFails.get(ip);
  if (!rec) return 0;
  if (rec.until && Date.now() < rec.until) return Math.ceil((rec.until - Date.now()) / 1000);
  return 0;
}

function notePairFail(ip) {
  const now = Date.now();
  const rec = pairFails.get(ip) || { n: 0, first: now, until: 0 };
  if (now - rec.first > PAIR_WINDOW_MS) { rec.n = 0; rec.first = now; rec.until = 0; }
  rec.n++;
  if (rec.n >= PAIR_MAX_FAILS) {
    rec.until = now + PAIR_WINDOW_MS;
    rec.n = 0;
    rec.first = now;
  }
  pairFails.set(ip, rec);
}

function clearPairFail(ip) { pairFails.delete(ip); }

/** 读 JSON 物体，超过上限直接拒绝 */
async function readJsonBody(req, limit) {
  const len = Number(req.headers.get("content-length") || 0);
  if (len > limit) throw new Error("too-large");
  const text = await req.text();
  if (text.length > limit) throw new Error("too-large");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** 把不要的请求体排掉。
 * 不排空就直接回 413，客户端还在上传时收到 RST，会报
 * WinError 10053（连接被中止）而不是看到真正的 413。 */
async function drain(req, cap = 32 * 1024 * 1024) {
  try {
    const body = req.body;
    if (!body) return;
    const reader = body.getReader();
    let seen = 0;
    while (seen < cap) {
      const { done, value } = await reader.read();
      if (done) return;
      seen += value ? value.length : 0;
    }
    try { await reader.cancel(); } catch {}
  } catch {
    /* 对端已经断了，无所谓 */
  }
}

/* ---------- 同步合并 ---------- */

/* 同一 id 取 updatedAt 更大的；tombstone 比对话更新就删掉。
   纯函数，方便单测。 */
function mergeState(local, remote) {
  const out = {
    conversations: {},
    tombstones: {},
    skills: null,
    skillsAt: 0,
    updatedAt: 0
  };

  const lc = (local && local.conversations) || {};
  const rc = (remote && remote.conversations) || {};
  const lt = (local && local.tombstones) || {};
  const rt = (remote && remote.tombstones) || {};

  const ids = new Set([...Object.keys(lc), ...Object.keys(rc)]);
  for (const id of ids) {
    const a = lc[id];
    const b = rc[id];
    let win = null;
    if (a && b) win = (b.updatedAt || 0) > (a.updatedAt || 0) ? b : a;
    else win = a || b;
    out.conversations[id] = win;
  }

  const tids = new Set([...Object.keys(lt), ...Object.keys(rt)]);
  for (const id of tids) {
    const a = lt[id] || 0;
    const b = rt[id] || 0;
    out.tombstones[id] = Math.max(a, b);
  }

  /* tombstone 生效：删掉比墓碑旧的对话 */
  for (const id of Object.keys(out.tombstones)) {
    const conv = out.conversations[id];
    if (conv && (conv.updatedAt || 0) <= out.tombstones[id]) {
      delete out.conversations[id];
    }
  }

  /* 墓碑清理：7 天前的可以忘掉了，避免无界增长 */
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  for (const id of Object.keys(out.tombstones)) {
    if (out.tombstones[id] < cutoff) delete out.tombstones[id];
  }

  /* 技能按最后写入合并 */
  const ls = local && local.skills ? local.skillsAt || 0 : 0;
  const rs = remote && remote.skills ? remote.skillsAt || 0 : 0;
  if (rs > ls) {
    out.skills = remote.skills;
    out.skillsAt = rs;
  } else if (ls > 0) {
    out.skills = local.skills;
    out.skillsAt = ls;
  }

  out.updatedAt = Date.now();
  return out;
}

/* ---------- 静态文件 ---------- */

async function serveStatic(pathname) {
  let p = pathname;
  if (p === "/" || p === "") p = "/index.html";

  /* 只接受干净的相对路径：拒绝 ..、反斜杠、百分号编码后的点、隐藏文件 */
  let decoded;
  try {
    decoded = decodeURIComponent(p);
  } catch {
    return new Response("bad path", { status: 400 });
  }
  if (decoded.includes("..") || decoded.includes("\\") || decoded.includes("\0")) {
    return new Response("bad path", { status: 400 });
  }

  const rel = decoded.replace(/^\/+/, "");
  const segments = rel.split("/").filter(Boolean);
  /* 任何一段以 . 开头都算（.git / .env / .github ...） */
  if (segments.some((s) => s.startsWith("."))) {
    return new Response("404", { status: 404 });
  }

  /* 没走 www/ 时只放行白名单（防止读到源码、配置、数据库） */
  if (!HAS_WWW && segments.length) {
    const top = segments[0];
    const allowed = segments.length === 1
      ? SAFE_FILES.has(top)
      : SAFE_DIRS.has(top);
    if (!allowed) return new Response("404", { status: 404 });
  }

  const full = resolve(STATIC_ROOT, rel || "index.html");
  /* 最后一道：解析后的真实路径必须还在 STATIC_ROOT 里面 */
  const rootWithSep = STATIC_ROOT.endsWith(sep) ? STATIC_ROOT : STATIC_ROOT + sep;
  if (full !== STATIC_ROOT && !full.startsWith(rootWithSep)) {
    return new Response("bad path", { status: 400 });
  }

  const file = Bun.file(full);
  if (!(await file.exists())) {
    /* SPA 回落：未知路径给首页，但只对无扩展名的路径这么做 */
    if (!extname(rel)) {
      const idx = Bun.file(join(STATIC_ROOT, "index.html"));
      if (await idx.exists()) {
        return new Response(idx, {
          headers: { "content-type": MIME[".html"], "cache-control": "no-store" }
        });
      }
    }
    return new Response("404", { status: 404 });
  }
  const ext = extname(full).toLowerCase();
  return new Response(file, {
    headers: {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": "no-store"
    }
  });
}

/* ---------- 主服务 ---------- */

await ensureDirs();

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req, srv) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    /* --- 8、扫描局域网用的身份标记（免认证，不含隐私） --- */
    if (path === "/api/ping") {
      const ip = await primaryIp();
      return json({
        app: "keyapp", alias: DEVICE_ALIAS,
        url: `http://${ip}:${PORT}`, port: PORT,
        version: APP_VERSION
      });
    }

    /* --- 版本查询（本机或持令牌） --- */
    if (path === "/api/version") {
      const tokens0 = await loadTokens();
      if (!(fromLocalhost(req, srv) || (await authorized(req, tokens0)))) {
        return json({ error: "unauthorized" }, 401);
      }
      return json({ version: APP_VERSION, app: "keyapp", platform: "bun" });
    }

    /* --- 本机才能读配对码 --- */
    if (path === "/api/code") {
      if (!fromLocalhost(req, srv)) {
        return json({ error: "local-only" }, 403);
      }
      return json({ code: PAIR_CODE, port: PORT, alias: DEVICE_ALIAS });
    }

    const tokens = await loadTokens();

    /* --- LocalSend 风格的自报家门：对方收到广播后回这一发 --- */
    if (path === "/api/register" && req.method === "POST") {
      let body;
      try {
        body = await readJsonBody(req, MAX_JSON);
      } catch {
        return json({ error: "too-large" }, 413);
      }
      /* 邻居表最多留 64 条，防止被灌爆 */
      if (discovered.size > 64) {
        const oldest = [...discovered.entries()].sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
        for (let i = 0; i < oldest.length - 64; i++) discovered.delete(oldest[i][0]);
      }
      /* 自己回声不要记进邻居列表 */
      if (body && body.app === "keyapp" && body.fingerprint && String(body.fingerprint) !== SELF_FINGERPRINT) {
        discovered.set(String(body.fingerprint), {
          fingerprint: String(body.fingerprint),
          alias: String(body.alias || "unknown").slice(0, 40),
          address: (srv.requestIP(req) || {}).address || "",
          port: Number(body.port) || 0,
          at: Date.now()
        });
      }
      return json({ ok: true, alias: DEVICE_ALIAS });
    }

    /* --- 配对：用配对码换令牌（带限速） --- */
    if (path === "/api/pair" && req.method === "POST") {
      const ip = (srv.requestIP(req) || {}).address || "unknown";
      const wait = pairBlocked(ip);
      if (wait > 0) {
        return json({ error: "too-many-attempts", retryAfter: wait }, 429);
      }
      let body;
      try {
        body = await readJsonBody(req, MAX_JSON);
      } catch {
        return json({ error: "too-large" }, 413);
      }
      if (String(body.code || "").trim() !== PAIR_CODE) {
        notePairFail(ip);
        return json({ error: "bad-code" }, 401);
      }
      clearPairFail(ip);
      const tk = newToken();
      tokens[tk] = {
        device: String(body.deviceName || "device").slice(0, 40),
        at: Date.now()
      };
      await saveTokens(tokens);
      return json({ token: tk });
    }

    /* --- 以下要令牌；本机（电脑端自己的界面）免令牌 --- */
    if (path.startsWith("/api/")) {
      if (!(fromLocalhost(req, srv) || (await authorized(req, tokens)))) {
        return json({ error: "unauthorized" }, 401);
      }

      /* 实时推送：SSE 长连接。EventSource 不能带 header，令牌走 ?token= */
      if (path === "/api/events" && req.method === "GET") {
        const qtok = url.searchParams.get("token") || "";
        if (!(fromLocalhost(req, srv) || (await authorized(req, await loadTokens())) )) {
          return json({ error: "unauthorized" }, 401);
        }
        return sseResponse(qtok || tokenOf(req));
      }

      /* 「我这边改了东西」→ 通知其他端去拉 */
      if (path === "/api/touch" && req.method === "POST") {
        let body = {};
        try {
          body = await readJsonBody(req, MAX_JSON);
        } catch {
          return json({ error: "too-large" }, 413);
        }
        broadcast("changed", { from: String(body.device || "device"), at: Date.now() }, tokenOf(req));
        return json({ ok: true, listeners: sseClients.size });
      }

      /* 已配对的设备列表 / 踢人（和电脑端同一套协议） */
      if (path === "/api/devices" && req.method === "GET") {
        return json({ devices: devicesOf(tokens) });
      }
      if (path === "/api/devices" && req.method === "DELETE") {
        let body = {};
        try {
          body = await readJsonBody(req, MAX_JSON);
        } catch {
          return json({ error: "too-large" }, 413);
        }
        const tail = String(body.tail || "");
        let removed = 0;
        for (const tk of Object.keys(tokens)) {
          if (tail && tk.endsWith(tail)) {
            delete tokens[tk];
            removed++;
          }
        }
        if (removed) await saveTokens(tokens);
        return json({ removed });
      }

      if (path === "/api/peers") {
        return new Response(
          JSON.stringify({
            self: { alias: DEVICE_ALIAS, port: PORT },
            peers: Array.from(discovered.values()).filter((p) => p.fingerprint !== SELF_FINGERPRINT)
          }),
          { headers: { ...CORS, "content-type": "application/json" } }
        );
      }

      if (path === "/api/info") {
        return json({
          app: "keyapp",
          name: APP_NAME + " · 局域网桥",
          version: 1,
          versionString: APP_VERSION,
          alias: DEVICE_ALIAS,
          devices: Object.keys(tokens).length,
          port: PORT
        });
      }

      if (path === "/api/sync" && req.method === "GET") {
        const st = await readJSON(STATE_FILE(), {
          conversations: {},
          tombstones: {},
          skills: null,
          skillsAt: 0
        });
        return json(st);
      }

      if (path === "/api/sync" && req.method === "POST") {
        let incoming;
        try {
          incoming = await readJsonBody(req, MAX_JSON);
        } catch {
          await drain(req);
          return json({ error: "too-large" }, 413);
        }
        /* 读-合并-写必须串行，否则两个请求交叠会互相覆盖 */
        const merged = await withStateLock(async () => {
          const local = await readJSON(STATE_FILE(), {
            conversations: {},
            tombstones: {},
            skills: null,
            skillsAt: 0
          });
          const m = mergeState(local, incoming);
          await writeJSON(STATE_FILE(), m);
          return m;
        });
        broadcast("changed", { from: String(incoming.device || "device"), at: Date.now() }, tokenOf(req));
        return json({
          conversations: merged.conversations,
          tombstones: merged.tombstones,
          skills: merged.skills,
          skillsAt: merged.skillsAt,
          serverTime: Date.now()
        });
      }

      /* --- 文件 --- */
      if (path === "/api/files" && req.method === "GET") {
        const names = await readdir(FILE_DIR).catch(() => []);
        const list = [];
        for (const n of names) {
          if (n.endsWith(".meta.json")) continue;
          const s = await stat(join(FILE_DIR, n)).catch(() => null);
          if (!s || !s.isFile()) continue;
          list.push({ name: n, size: s.size, at: s.mtimeMs });
        }
        list.sort((a, b) => b.at - a.at);
        return json({ files: list.slice(0, 200) });
      }

      if (path === "/api/files" && req.method === "POST") {
        const raw = req.headers.get("x-filename") || "file";
        /* 体积上限：以前不限，一个大文件就能把电脑的内存/磁盘塞满 */
        const declared = Number(req.headers.get("content-length") || 0);
        if (declared > MAX_FILE) return json({ error: "too-large" }, 413);
        /* 只留文件名，去掉任何路径，防止写到目录外 */
        const safe = basename(decodeURIComponent(raw)).replace(/[\\/:*?"<>|]/g, "_").slice(0, 120) || "file";
        const buf = Buffer.from(await req.arrayBuffer());
        if (buf.length > MAX_FILE) return json({ error: "too-large" }, 413);
        if (!buf.length) {
          return json({ error: "empty" }, 400);
        }
        let name = safe;
        let i = 1;
        while (await Bun.file(join(FILE_DIR, name)).exists()) {
          const dot = safe.lastIndexOf(".");
          name = dot > 0
            ? safe.slice(0, dot) + "-" + i + safe.slice(dot)
            : safe + "-" + i;
          i++;
        }
        await writeFile(join(FILE_DIR, name), buf);
        return json({ name, size: buf.length });
      }

      if (path.startsWith("/api/files/") && req.method === "GET") {
        const name = basename(decodeURIComponent(path.slice("/api/files/".length)));
        const f = Bun.file(join(FILE_DIR, name));
        if (!(await f.exists())) return new Response("404", { status: 404 });
        return new Response(f, {
          headers: {
            ...CORS,
            "content-type": "application/octet-stream",
            "content-disposition": 'attachment; filename="' + name + '"'
          }
        });
      }

      if (path.startsWith("/api/files/") && req.method === "DELETE") {
        const name = basename(decodeURIComponent(path.slice("/api/files/".length)));
        await unlink(join(FILE_DIR, name)).catch(() => {});
        return json({ ok: true });
      }
    }

    /* --- 静态资源 --- */
    if (req.method === "GET") return serveStatic(path);
    return new Response("405", { status: 405, headers: CORS });
  }
});

/* ---------- 局域网发现（照 LocalSend 的组播思路） ---------- */

let discovery = null;
try {
  discovery = await startDiscovery({
    port: PORT,
    alias: DEVICE_ALIAS,
    log: (m) => console.log("  [发现] " + m),
    onPeer: (peer) => {
      discovered.set(peer.fingerprint, { ...peer, at: Date.now() });
    }
  });
} catch (e) {
  console.log("  [发现] 组播启动失败（不影响手动填地址）：" + e.message);
}

process.on("SIGINT", async () => {
  if (discovery) await discovery.stop();
  console.log("");
  console.log("  已停止");
  process.exit(0);
});

/* ---------- 启动提示 ---------- */

const nets = Object.values(
  (await import("node:os")).networkInterfaces()
)
  .flat()
  .filter((n) => n && n.family === "IPv4" && !n.internal)
  .map((n) => n.address);

console.log("");
console.log("  钥匙 · 局域网桥已启动");
console.log("");
console.log("  配对码  " + PAIR_CODE);
console.log("");
for (const ip of nets) {
  console.log("  手机访问  http://" + ip + ":" + PORT);
}
console.log("  电脑访问  http://localhost:" + PORT);
console.log("");
if (discovery) {
  console.log("  已开启自动发现：手机装好 App 打开「连接」页就能看到这台电脑。");
}
console.log("  手机和电脑要在同一个 WiFi 下。关掉这个窗口服务就停了。");
console.log("");
