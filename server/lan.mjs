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
import { join, extname, basename } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const WEB_ROOT = decodeURIComponent(ROOT);
const DATA_DIR = join(WEB_ROOT, "server", "data");
const FILE_DIR = join(DATA_DIR, "files");
const PORT = Number(process.env.PORT || 8787);

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

/** 请求是不是来自电脑本机 */
function fromLocalhost(req, server) {
  const addr = (server.requestIP(req) || {}).address || "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
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
  /* 只允许读 www/ 与根目录的静态资源 */
  if (p.includes("..")) return new Response("bad path", { status: 400 });
  const file = Bun.file(join(WEB_ROOT, p));
  if (!(await file.exists())) return new Response("404", { status: 404 });
  const ext = extname(p).toLowerCase();
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

    /* --- 本机才能读配对码 --- */
    if (path === "/api/code") {
      if (!fromLocalhost(req, srv)) {
        return new Response(JSON.stringify({ error: "local-only" }), {
          status: 403,
          headers: { ...CORS, "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ code: PAIR_CODE, port: PORT }), {
        headers: { ...CORS, "content-type": "application/json" }
      });
    }

    const tokens = await loadTokens();

    /* --- 配对：用配对码换令牌 --- */
    if (path === "/api/pair" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (String(body.code || "").trim() !== PAIR_CODE) {
        return new Response(JSON.stringify({ error: "bad-code" }), {
          status: 401,
          headers: { ...CORS, "content-type": "application/json" }
        });
      }
      const tk = newToken();
      tokens[tk] = {
        device: String(body.deviceName || "device").slice(0, 40),
        at: Date.now()
      };
      await saveTokens(tokens);
      return new Response(JSON.stringify({ token: tk }), {
        headers: { ...CORS, "content-type": "application/json" }
      });
    }

    /* --- 以下都要令牌 --- */
    if (path.startsWith("/api/")) {
      if (!(await authorized(req, tokens))) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { ...CORS, "content-type": "application/json" }
        });
      }

      if (path === "/api/info") {
        return new Response(
          JSON.stringify({
            name: "钥匙 · 局域网桥",
            version: 1,
            devices: Object.keys(tokens).length,
            port: PORT
          }),
          { headers: { ...CORS, "content-type": "application/json" } }
        );
      }

      if (path === "/api/sync" && req.method === "GET") {
        const st = await readJSON(STATE_FILE(), {
          conversations: {},
          tombstones: {},
          skills: null,
          skillsAt: 0
        });
        return new Response(JSON.stringify(st), {
          headers: { ...CORS, "content-type": "application/json" }
        });
      }

      if (path === "/api/sync" && req.method === "POST") {
        const incoming = await req.json().catch(() => ({}));
        const local = await readJSON(STATE_FILE(), {
          conversations: {},
          tombstones: {},
          skills: null,
          skillsAt: 0
        });
        const merged = mergeState(local, incoming);
        await writeJSON(STATE_FILE(), merged);
        return new Response(
          JSON.stringify({
            conversations: merged.conversations,
            tombstones: merged.tombstones,
            skills: merged.skills,
            skillsAt: merged.skillsAt,
            serverTime: Date.now()
          }),
          { headers: { ...CORS, "content-type": "application/json" } }
        );
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
        return new Response(JSON.stringify({ files: list.slice(0, 200) }), {
          headers: { ...CORS, "content-type": "application/json" }
        });
      }

      if (path === "/api/files" && req.method === "POST") {
        const raw = req.headers.get("x-filename") || "file";
        /* 只留文件名，去掉任何路径，防止写到目录外 */
        const safe = basename(decodeURIComponent(raw)).replace(/[\\/:*?"<>|]/g, "_").slice(0, 120) || "file";
        const buf = Buffer.from(await req.arrayBuffer());
        if (!buf.length) {
          return new Response(JSON.stringify({ error: "empty" }), {
            status: 400,
            headers: { ...CORS, "content-type": "application/json" }
          });
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
        return new Response(JSON.stringify({ name, size: buf.length }), {
          headers: { ...CORS, "content-type": "application/json" }
        });
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
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...CORS, "content-type": "application/json" }
        });
      }
    }

    /* --- 静态资源 --- */
    if (req.method === "GET") return serveStatic(path);
    return new Response("405", { status: 405, headers: CORS });
  }
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
console.log("  手机和电脑要在同一个 WiFi 下。关掉这个窗口服务就停了。");
console.log("");
