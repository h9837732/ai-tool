package com.keyapp.chat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 局域网探测（照 LocalSend 的思路：组播发现 + 子网直扫兜底）。
 *
 * 为什么必须走原生：
 *   App 的页面 origin 是 https://localhost，从它 fetch http://192.168.x.x:8787
 *   属于混合内容，WebView 直接拦掉。所以扫描只能在原生层做。
 *
 * 为什么比 JS 快：
 *   用裸 Socket 连端口，连不上立刻失败（不等 HTTP 超时），
 *   一个 /24 网段 256 个地址几十毫秒就能扫完。
 */
@CapacitorPlugin(name = "NetInfo")
public class NetInfoPlugin extends Plugin {

    private static final String PING_PATH = "/api/ping";

    /** 本机所有 IPv4 地址（不含回环、不含 169.254 链路本地） */
    @PluginMethod
    public void localIps(PluginCall call) {
        JSArray arr = new JSArray();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InetAddress addr : Collections.list(ni.getInetAddresses())) {
                    if (addr instanceof Inet4Address && !addr.isLoopbackAddress()
                            && !addr.isLinkLocalAddress()) {
                        arr.put(addr.getHostAddress());
                    }
                }
            }
        } catch (Exception e) {
            // 拿不到就返回空数组，前端会退回常见网段
        }
        JSObject ret = new JSObject();
        ret.put("ips", arr);
        call.resolve(ret);
    }

    /**
     * 扫一批 IP，返回活着的钥匙服务。
     * 参数： ips: string[], port: int, timeoutMs: int, concurrency: int
     * 返回： { found: [{ip, alias, url, port}], done: int, total: int }
     */
    @PluginMethod
    public void scan(PluginCall call) {
        final JSArray ipsArr = call.getArray("ips");
        final int port = call.getInt("port", 8787);
        final int timeoutMs = call.getInt("timeoutMs", 400);
        final int concurrency = Math.max(4, call.getInt("concurrency", 64));

        final List<String> targets = new ArrayList<>();
        if (ipsArr != null) {
            for (int i = 0; i < ipsArr.length(); i++) {
                String ip = ipsArr.optString(i, null);
                if (ip != null && !ip.isEmpty()) targets.add(ip);
            }
        }
        if (targets.isEmpty()) {
            JSObject empty = new JSObject();
            empty.put("found", new JSArray());
            empty.put("done", 0);
            empty.put("total", 0);
            call.resolve(empty);
            return;
        }

        final PluginCall pending = call;

        new Thread(new Runnable() {
            @Override
            public void run() {
                final JSArray found = new JSArray();
                final AtomicInteger done = new AtomicInteger(0);
                ExecutorService pool = Executors.newFixedThreadPool(
                        Math.min(concurrency, targets.size()));
                List<Future<JSObject>> futures = new ArrayList<>();
                try {
                    for (final String ip : targets) {
                        futures.add(pool.submit(new Callable<JSObject>() {
                            @Override
                            public JSObject call() {
                                JSObject hit = probe(ip, port, timeoutMs);
                                done.incrementAndGet();
                                return hit;
                            }
                        }));
                    }
                    for (Future<JSObject> f : futures) {
                        try {
                            JSObject hit = f.get();
                            if (hit != null) found.put(hit);
                        } catch (Exception ignored) {
                            // 单个地址失败不影响整体
                        }
                    }
                    JSObject ret = new JSObject();
                    ret.put("found", found);
                    ret.put("done", done.get());
                    ret.put("total", targets.size());
                    pending.resolve(ret);
                } catch (Exception e) {
                    pending.reject("scan failed: " + e.getMessage());
                } finally {
                    pool.shutdown();
                }
            }
        }).start();
    }

    /** 连上了就发一个最小 HTTP 请求，读回身份，避免把别人的 8787 当成自己人 */
    private JSObject probe(String ip, int port, int timeoutMs) {
        Socket sock = new Socket();
        try {
            sock.connect(new InetSocketAddress(ip, port), timeoutMs);
            sock.setSoTimeout(timeoutMs);

            String req = "GET " + PING_PATH + " HTTP/1.0\r\n"
                    + "Host: " + ip + ":" + port + "\r\n"
                    + "User-Agent: keyapp-scan\r\n"
                    + "Accept: application/json\r\n"
                    + "Connection: close\r\n\r\n";
            OutputStream out = sock.getOutputStream();
            out.write(req.getBytes(StandardCharsets.UTF_8));
            out.flush();

            InputStream in = sock.getInputStream();
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[4096];
            int n;
            long deadline = System.currentTimeMillis() + timeoutMs + 500L;
            while ((n = in.read(chunk)) > 0) {
                buf.write(chunk, 0, n);
                if (buf.size() > 16384) break;
                if (System.currentTimeMillis() > deadline) break;
            }
            String text = new String(buf.toByteArray(), StandardCharsets.UTF_8);

            int brace = text.indexOf('{');
            if (brace < 0) return null;
            JSONObject j = new JSONObject(text.substring(brace));
            if (!"keyapp".equals(j.optString("app", ""))) return null;

            JSObject hit = new JSObject();
            hit.put("ip", ip);
            hit.put("port", j.optInt("port", port));
            hit.put("alias", j.optString("alias", ip));
            String url = j.optString("url", "");
            hit.put("url", url.isEmpty() ? ("http://" + ip + ":" + port) : url);
            hit.put("version", j.optString("version", ""));
            return hit;
        } catch (Exception e) {
            return null;
        } finally {
            try { sock.close(); } catch (Exception ignored) { }
        }
    }
}
