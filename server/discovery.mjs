/* 局域网发现：照 LocalSend 协议的做法，UDP 组播广播 + HTTP 应答。
 *
 * 为什么要这一步：现在配对要手抄 IP 和配对码。LocalSend 的做法是
 * 设备一启动就往组播组喊一声「我是谁、在哪个端口」，其他设备收到后
 * 通过 HTTP 回一声，双方就互相知道了。手机打开 App 就能看到电脑，
 * 点一下就连上，不用填任何东西。
 *
 * 协议要点（简化自 LocalSend Protocol v2.2）：
 *   - 组播组 224.0.0.167，端口 53317（LocalSend 的默认值，直接沿用，
 *     这样同一台机器上跑 LocalSend 也不会冲突，因为端口会复用）
 *   - 广播体里带 alias / fingerprint / port / protocol
 *   - 收到广播的设备用 POST /api/register 回自己的信息
 *   - fingerprint 用来识别「这是我自己」，避免自发现
 *
 * 与 LocalSend 的差异（有意为之）：
 *   - 不做 HTTPS 自签证书：证书在手机浏览器里会被拦，
 *     而我们是网页 + APK 双端，用配对码 + 令牌做鉴权更实际
 *   - 只发现「钥匙」自己的服务，不参与 LocalSend 的文件传输
 */

import dgram from "node:dgram";
import os from "node:os";

export const GROUP = "224.0.0.167";
export const DISCOVERY_PORT = 53317;

/* 一组稳定的指纹：优先用 MAC，退化为主机名 + 端口 */
export function makeFingerprint(seed) {
  const nets = Object.values(os.networkInterfaces()).flat()
    .filter((n) => n && !n.internal && n.family === "IPv4");
  const mac = nets.find((n) => n.mac && n.mac !== "00:00:00:00:00:00")?.mac || "";
  const raw = [mac, os.hostname(), seed].filter(Boolean).join("|");
  return simpleHash(raw);
}

function simpleHash(s) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = (h1 ^ c) * 0x01000193 >>> 0;
    h2 = (h2 + c * 31) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/* 本机所有非回环 IPv4 */
export function localAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((n) => n && n.family === "IPv4" && !n.internal)
    .map((n) => n.address);
}

/**
 * 启动发现服务。
 *
 * @param {object} opts
 *   port        本机 HTTP 端口（别人据此访问你）
 *   alias       设备显示名
 *   info        额外信息提供者，返回 { devices, version }
 *   onPeer      发现到别的设备时回调 (peer)
 *   log         日志函数
 * @returns {{ stop: () => Promise<void>, broadcast: () => void, peers: () => object[] }}
 */
export async function startDiscovery(opts) {
  const port = Number(opts.port) || 8787;
  const alias = String(opts.alias || os.hostname()).slice(0, 40);
  const log = opts.log || (() => {});
  const fingerprint = makeFingerprint(String(port));

  /* 已发现的设备：fingerprint → peer */
  const peers = new Map();

  const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });

  function announceBody(extra) {
    return JSON.stringify({
      alias,
      version: "2.0",
      deviceModel: os.platform(),
      deviceType: "desktop",
      fingerprint,
      port,
      protocol: "http",
      app: "keyapp",
      download: true,
      announce: true,
      ...extra
    });
  }

  /* 向组播组广播 */
  function broadcast() {
    const msg = Buffer.from(announceBody());
    try {
      sock.setMulticastTTL(2);
    } catch (e) { /* 某些系统不支持，忽略 */ }
    sock.send(msg, 0, msg.length, DISCOVERY_PORT, GROUP, (err) => {
      if (err) log("broadcast failed: " + err.message);
    });
  }

  /* 收到别人的广播：回一发自己的信息，让双方都认识 */
  async function handleIncoming(buf, rinfo) {
    let j;
    try {
      j = JSON.parse(buf.toString("utf8"));
    } catch {
      return; // 不是我们的协议
    }
    if (!j || j.app !== "keyapp") return;
    if (j.fingerprint === fingerprint) return; // 自己的回声

    const peer = {
      fingerprint: String(j.fingerprint || rinfo.address),
      alias: String(j.alias || rinfo.address).slice(0, 40),
      address: rinfo.address,
      port: Number(j.port) || DISCOVERY_PORT,
      deviceModel: j.deviceModel || ""
    };

    const isNew = !peers.has(peer.fingerprint);
    peers.set(peer.fingerprint, { ...peer, at: Date.now() });
    if (isNew) log(`发现设备 ${peer.alias} @ ${peer.address}:${peer.port}`);

    /* 只有对方主动 announce 时才回，避免互相无限回环 */
    if (j.announce) {
      try {
        const res = await fetch(`http://${rinfo.address}:${peer.port}/api/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: announceBody({ announce: false }),
          signal: AbortSignal.timeout(2000)
        });
        if (res.ok && isNew && opts.onPeer && peer.fingerprint !== fingerprint) opts.onPeer(peer);
      } catch {
        /* 对方可能已经关了，忽略 */
      }
    } else if (isNew && opts.onPeer && peer.fingerprint !== fingerprint) {
      opts.onPeer(peer);
    }
  }

  sock.on("message", (buf, rinfo) => {
    handleIncoming(buf, rinfo).catch(() => {});
  });

  sock.on("error", (e) => log("discovery socket error: " + e.message));

  await new Promise((resolve) => {
    sock.bind(DISCOVERY_PORT, () => {
      try {
        sock.addMembership(GROUP);
        sock.setMulticastLoopback(true);
      } catch (e) {
        log("multicast join failed: " + e.message);
      }
      resolve();
    });
  });

  /* 启动就喊一次，之后每 30 秒再喊一次 */
  broadcast();
  const timer = setInterval(broadcast, 30000);

  /* 10 分钟内没再听到的设备视为离线 */
  const sweeper = setInterval(() => {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [k, v] of peers) {
      if (v.at < cutoff) peers.delete(k);
    }
  }, 60 * 1000);

  return {
    fingerprint,
    broadcast,
    peers: () => Array.from(peers.values()),
    stop: async () => {
      clearInterval(timer);
      clearInterval(sweeper);
      await new Promise((r) => {
        try {
          sock.close(r);
        } catch {
          r();
        }
      });
    }
  };
}
