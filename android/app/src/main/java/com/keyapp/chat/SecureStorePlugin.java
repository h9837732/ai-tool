package com.keyapp.chat;

import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * 用 Android Keystore 里的 AES-GCM 密钥加密小段文本（API Key 等）。
 * 密钥材料在 TEE/StrongBox 里，不出应用；密文存在 SharedPreferences。
 */
@CapacitorPlugin(name = "SecureStore")
public class SecureStorePlugin extends Plugin {

    private static final String KEY_ALIAS = "keyapp_master_v1";
    private static final String PREFS = "keyapp_secure";
    private static final String TRANSFORM = "AES/GCM/NoPadding";
    private static final int TAG_BITS = 128;
    private static final int IV_BYTES = 12;

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, 0);
    }

    private SecretKey getOrCreateKey() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(KEY_ALIAS)) {
            return (SecretKey) ks.getKey(KEY_ALIAS, null);
        }
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build();
        kg.init(spec);
        return kg.generateKey();
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject ret = new JSObject();
        boolean ok;
        try {
            getOrCreateKey();
            ok = true;
        } catch (Exception e) {
            ok = false;
        }
        ret.put("available", ok);
        ret.put("value", ok);
        call.resolve(ret);
    }

    @PluginMethod
    public void set(PluginCall call) {
        String key = call.getString("key");
        String value = call.getString("value");
        if (key == null || value == null) {
            call.reject("key and value are required");
            return;
        }
        try {
            SecretKey sk = getOrCreateKey();
            Cipher c = Cipher.getInstance(TRANSFORM);
            c.init(Cipher.ENCRYPT_MODE, sk);
            byte[] iv = c.getIV();
            byte[] ct = c.doFinal(value.getBytes(StandardCharsets.UTF_8));

            byte[] packed = new byte[iv.length + ct.length];
            System.arraycopy(iv, 0, packed, 0, iv.length);
            System.arraycopy(ct, 0, packed, iv.length, ct.length);

            prefs().edit()
                    .putString(key, Base64.encodeToString(packed, Base64.NO_WRAP))
                    .apply();
            call.resolve(new JSObject().put("value", true));
        } catch (Exception e) {
            call.reject("encrypt failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void get(PluginCall call) {
        String key = call.getString("key");
        if (key == null) {
            call.reject("key is required");
            return;
        }
        String stored = prefs().getString(key, null);
        if (stored == null) {
            call.resolve(new JSObject().put("value", null));
            return;
        }
        try {
            byte[] packed = Base64.decode(stored, Base64.NO_WRAP);
            if (packed.length <= IV_BYTES) {
                call.resolve(new JSObject().put("value", null));
                return;
            }
            byte[] iv = new byte[IV_BYTES];
            byte[] ct = new byte[packed.length - IV_BYTES];
            System.arraycopy(packed, 0, iv, 0, IV_BYTES);
            System.arraycopy(packed, IV_BYTES, ct, 0, ct.length);

            Cipher c = Cipher.getInstance(TRANSFORM);
            c.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(TAG_BITS, iv));
            String plain = new String(c.doFinal(ct), StandardCharsets.UTF_8);
            call.resolve(new JSObject().put("value", plain));
        } catch (Exception e) {
            // 解密失败（换机、清过钥匙库）时返回 null，让前端保留原有明文副本
            call.resolve(new JSObject().put("value", null));
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String key = call.getString("key");
        if (key == null) {
            call.reject("key is required");
            return;
        }
        prefs().edit().remove(key).apply();
        call.resolve(new JSObject().put("value", true));
    }
}
