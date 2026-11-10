package com.keyapp.chat;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 本地插件要在 super.onCreate 之前注册，否则 Bridge 拿不到
        registerPlugin(SecureStorePlugin.class);
        registerPlugin(NativeHttpPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
