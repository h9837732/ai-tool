package com.keyapp.chat;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 应用内更新：下载 APK 并拉起系统安装界面。
 *
 * 为什么必须原生：WebView 下不了 apk 也不能装，安卓也不允许网页直接启动安装器。
 *
 * 权限：
 *   - REQUEST_INSTALL_PACKAGES（AndroidManifest 里声明）
 *     首次使用会跳一次「允许安装未知应用」，用户确认后不再问。
 *   - FileProvider 把缓存目录里的 apk 以 content:// 暴露给安装器，
 *     直接给 file:// 在 Android 7+ 会抛 FileUriExposedException。
 */
@CapacitorPlugin(name = "ApkUpdater")
public class ApkUpdaterPlugin extends Plugin {

    private static final int CONNECT_TIMEOUT = 30000;
    private static final int READ_TIMEOUT = 300000;

    /** 当前系统版本号，给更新界面显示 */
    @PluginMethod
    public void info(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            android.content.pm.PackageInfo pi =
                    getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            ret.put("versionName", pi.versionName);
            ret.put("versionCode", Build.VERSION.SDK_INT >= 28 ? (int) pi.getLongVersionCode() : pi.versionCode);
        } catch (Exception e) {
            ret.put("versionName", "");
            ret.put("versionCode", 0);
        }
        ret.put("sdk", Build.VERSION.SDK_INT);
        ret.put("canInstall", canInstall());
        call.resolve(ret);
    }

    /** 有没有「安装未知应用」的权限 */
    private boolean canInstall() {
        if (Build.VERSION.SDK_INT < 26) return true;
        try {
            return getContext().getPackageManager().canRequestPackageInstalls();
        } catch (Exception e) {
            return false;
        }
    }

    /** 打开系统的「允许安装未知应用」开关页 */
    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getContext().getPackageName()));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                final Intent intent = i;
                getActivity().runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            getContext().startActivity(intent);
                        } catch (Exception ignored) { }
                    }
                });
                call.resolve(new JSObject().put("ok", true));
                return;
            }
        } catch (Exception e) {
            // 落下去当失败
        }
        call.resolve(new JSObject().put("ok", false));
    }

    /**
     * 下载并安装。参数：url
     * 返回 { ok, error }
     */
    @PluginMethod
    public void install(final PluginCall call) {
        final String urlStr = call.getString("url");
        if (urlStr == null || !urlStr.startsWith("http")) {
            call.reject("url is required");
            return;
        }
        final PluginCall pending = call;

        new Thread(new Runnable() {
            @Override
            public void run() {
                HttpURLConnection conn = null;
                File out = null;
                try {
                    File dir = new File(getContext().getCacheDir(), "updates");
                    if (!dir.exists()) dir.mkdirs();
                    /* 旧包先清掉，免得越积越多 */
                    File[] old = dir.listFiles();
                    if (old != null) {
                        for (File f : old) f.delete();
                    }
                    out = new File(dir, "keyapp-update.apk");

                    URL url = new URL(urlStr);
                    conn = (HttpURLConnection) url.openConnection();
                    conn.setInstanceFollowRedirects(true);
                    conn.setConnectTimeout(CONNECT_TIMEOUT);
                    conn.setReadTimeout(READ_TIMEOUT);
                    conn.setRequestProperty("User-Agent", "keyapp-updater");

                    int status = conn.getResponseCode();
                    if (status < 200 || status >= 300) {
                        fail(pending, "HTTP " + status);
                        return;
                    }

                    InputStream in = conn.getInputStream();
                    FileOutputStream fos = new FileOutputStream(out);
                    byte[] buf = new byte[65536];
                    long total = 0;
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        fos.write(buf, 0, n);
                        total += n;
                        if (total > 400L * 1024 * 1024) {
                            throw new Exception("file too large");
                        }
                    }
                    fos.flush();
                    fos.close();
                    in.close();

                    if (total < 1024 * 100) {
                        out.delete();
                        fail(pending, "downloaded file too small: " + total);
                        return;
                    }

                    /* 必须是 zip（apk 就是 zip），首两字节 PK */
                    java.io.FileInputStream fis = new java.io.FileInputStream(out);
                    byte[] magic = new byte[2];
                    int read = fis.read(magic);
                    fis.close();
                    if (read < 2 || magic[0] != 'P' || magic[1] != 'K') {
                        out.delete();
                        fail(pending, "not an apk");
                        return;
                    }

                    if (!canInstall()) {
                        /* 没权限：先让用户去开，装不了但文件留着，再点一次就装 */
                        getActivity().runOnUiThread(new Runnable() {
                            @Override
                            public void run() {
                                openInstallSettings(pending);
                            }
                        });
                        return;
                    }

                    Uri apkUri = FileProvider.getUriForFile(
                            getContext(),
                            getContext().getPackageName() + ".fileprovider",
                            out);

                    final Intent intent = new Intent(Intent.ACTION_VIEW);
                    intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
                    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    /* 必须在主线程起 Activity，后台线程调会抛异常 */
                    getActivity().runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            try {
                                getContext().startActivity(intent);
                                pending.resolve(new JSObject().put("ok", true));
                            } catch (Exception e) {
                                fail(pending, String.valueOf(e.getMessage()));
                            }
                        }
                    });
                } catch (Exception e) {
                    if (out != null && out.exists()) out.delete();
                    fail(pending, String.valueOf(e.getMessage()));
                } finally {
                    if (conn != null) conn.disconnect();
                }
            }
        }).start();
    }

    private void fail(PluginCall call, String msg) {
        JSObject ret = new JSObject();
        ret.put("ok", false);
        ret.put("error", msg == null ? "failed" : msg);
        call.resolve(ret);
    }
}
