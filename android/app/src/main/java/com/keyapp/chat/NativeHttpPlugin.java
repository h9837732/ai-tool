package com.keyapp.chat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;

/**
 * 原生 HTTP：绕开 WebView 的同源限制，让不返回 CORS 头的服务商也能用。
 * 不支持流式（一次拿完整响应），前端会在消息下方标注。
 */
@CapacitorPlugin(name = "NativeHttp")
public class NativeHttpPlugin extends Plugin {

    private static final int CONNECT_TIMEOUT = 30000;
    private static final int READ_TIMEOUT = 300000;

    @PluginMethod
    public void request(PluginCall call) {
        final String urlStr = call.getString("url");
        final String method = call.getString("method", "POST");
        final String body = call.getString("body", "");
        final JSObject headers = call.getObject("headers", new JSObject());

        if (urlStr == null || urlStr.isEmpty()) {
            call.reject("url is required");
            return;
        }
        final PluginCall pending = call;

        new Thread(new Runnable() {
            @Override
            public void run() {
                HttpURLConnection conn = null;
                try {
                    URL url = new URL(urlStr);
                    conn = (HttpURLConnection) url.openConnection();
                    conn.setRequestMethod(method);
                    conn.setConnectTimeout(CONNECT_TIMEOUT);
                    conn.setReadTimeout(READ_TIMEOUT);
                    conn.setDoInput(true);

                    Iterator<String> keys = headers.keys();
                    while (keys.hasNext()) {
                        String k = keys.next();
                        Object v = headers.get(k);
                        if (v != null) conn.setRequestProperty(k, String.valueOf(v));
                    }

                    if (body != null && !body.isEmpty() && !"GET".equalsIgnoreCase(method)) {
                        conn.setDoOutput(true);
                        byte[] payload = body.getBytes(StandardCharsets.UTF_8);
                        conn.setFixedLengthStreamingMode(payload.length);
                        OutputStream os = conn.getOutputStream();
                        os.write(payload);
                        os.flush();
                        os.close();
                    }

                    int status = conn.getResponseCode();
                    InputStream is = (status >= 200 && status < 300)
                            ? conn.getInputStream()
                            : conn.getErrorStream();

                    String text = "";
                    if (is != null) {
                        ByteArrayOutputStream bos = new ByteArrayOutputStream();
                        byte[] buf = new byte[8192];
                        int n;
                        while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
                        is.close();
                        text = new String(bos.toByteArray(), StandardCharsets.UTF_8);
                    }

                    JSObject ret = new JSObject();
                    ret.put("status", status);
                    ret.put("body", text);
                    pending.resolve(ret);
                } catch (Exception e) {
                    pending.reject("request failed: " + e.getMessage());
                } finally {
                    if (conn != null) conn.disconnect();
                }
            }
        }).start();
    }
}
