# -*- coding: utf-8 -*-
"""电脑端密钥加密：Windows DPAPI（ctypes 实现，不引第三方库）

为什么用它：
  WebView2 的 localStorage 是明文文件，任何人拿到磁盘就能读。
  DPAPI 用当前 Windows 用户的凭据加密，别的账号/换了机器都解不开，
  而且用户不需要记密码。安卓那边对应的是 Android Keystore。

存哪里：
  keyapp-data/secrets.dat —— 一个 DPAPI 加密的 JSON 字典。
  磁盘上永远是密文，读的时候在内存里解密。
"""
import base64
import ctypes
import ctypes.wintypes as wt
import io
import json
import os
import threading

CRYPTPROTECT_UI_FORBIDDEN = 0x01


class _BLOB(ctypes.Structure):
    _fields_ = [("cbData", wt.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _to_blob(data):
    buf = ctypes.create_string_buffer(data, len(data))
    blob = _BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    return blob, buf          # 返回 buf 防止被 GC


def _from_blob(blob):
    if not blob.cbData:
        return b""
    return ctypes.string_at(blob.pbData, blob.cbData)


class DpapiStore(object):
    """按 key 加解密的本地安全存储。不可用时 is_available() 为 False。"""

    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        self._ok = None

    # ---------- DPAPI 原语 ----------

    def _protect(self, data):
        crypt32 = ctypes.windll.crypt32
        kernel32 = ctypes.windll.kernel32
        blob_in, buf_in = _to_blob(data)          # noqa: F841  buf 要保持引用
        blob_out = _BLOB()
        ok = crypt32.CryptProtectData(
            ctypes.byref(blob_in), None, None, None, None,
            CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(blob_out))
        if not ok:
            raise OSError("CryptProtectData 失败: %d" % kernel32.GetLastError())
        try:
            return _from_blob(blob_out)
        finally:
            kernel32.LocalFree(blob_out.pbData)

    def _unprotect(self, blob):
        crypt32 = ctypes.windll.crypt32
        kernel32 = ctypes.windll.kernel32
        blob_in, buf_in = _to_blob(blob)          # noqa: F841
        blob_out = _BLOB()
        ok = crypt32.CryptUnprotectData(
            ctypes.byref(blob_in), None, None, None, None,
            CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(blob_out))
        if not ok:
            raise OSError("CryptUnprotectData 失败: %d" % kernel32.GetLastError())
        try:
            return _from_blob(blob_out)
        finally:
            kernel32.LocalFree(blob_out.pbData)

    # ---------- 可用性 ----------

    def is_available(self):
        if self._ok is not None:
            return self._ok
        self._ok = False
        if os.name != "nt":
            return False
        try:
            probe = b"keyapp-dpapi-probe"
            self._ok = self._unprotect(self._protect(probe)) == probe
        except Exception:
            self._ok = False
        return self._ok

    # ---------- 数据 ----------

    def _load(self):
        if not os.path.isfile(self.path):
            return {}
        try:
            with open(self.path, "rb") as f:
                raw = f.read()
            if not raw:
                return {}
            data = json.loads(self._unprotect(raw).decode("utf-8"))
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def _save(self, data):
        parent = os.path.dirname(self.path)
        if parent and not os.path.isdir(parent):
            os.makedirs(parent, exist_ok=True)
        plain = json.dumps(data, ensure_ascii=False).encode("utf-8")
        blob = self._protect(plain)
        tmp = self.path + ".tmp"
        with open(tmp, "wb") as f:
            f.write(blob)
        try:
            os.replace(tmp, self.path)
        except Exception:
            with open(self.path, "wb") as f:
                f.write(blob)
            try:
                os.remove(tmp)
            except Exception:
                pass

    def get(self, key):
        if not self.is_available():
            return None
        with self.lock:
            return self._load().get(str(key))

    def set(self, key, value):
        if not self.is_available():
            return False
        with self.lock:
            data = self._load()
            data[str(key)] = str(value)
            self._save(data)
        return True

    def remove(self, key):
        if not self.is_available():
            return False
        with self.lock:
            data = self._load()
            if str(key) in data:
                data.pop(str(key), None)
                self._save(data)
        return True

    def keys(self):
        if not self.is_available():
            return []
        with self.lock:
            return list(self._load().keys())
