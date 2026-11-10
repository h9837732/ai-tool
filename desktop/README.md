# 钥匙 · 电脑端

双击就进聊天。没有控制窗、没有浏览器地址栏、没有标签页。

## 两端是不同的东西，别混

| | 电脑端 | 手机端 |
|---|---|---|
| 角色 | **主机**，跑服务 | **客户端**，连别人 |
| 连接页显示 | 配对码 + **已配对的手机** | **扫描局域网** + 手动配对 |
| 能看到"附近的设备" | ❌ 不需要（自己就是服务器） | ✅ 扫描同一 WiFi 下的电脑 |
| 配对码 | 显示在这里，给手机用 | 不显示（读不到，服务端只给本机看） |

界面会自动判断角色：**能读到 `/api/code` 就是电脑端**，否则是手机端。
所以电脑端永远不会出现"配对电脑"这种按钮，也不会去连接自己。

## 一键打包

双击项目根目录的 **`打包电脑端.bat`**。

它做三件事：

```
1. bun run build               前端 → www/
2. py desktop\embed_assets.py   www/ → desktop\钥匙-打包用.py
3. pyinstaller --onefile        → desktop\dist\钥匙.exe
```

约 1 分钟，产物 12 MB，跑完自动打开输出目录。

> 改了前端只跑这个 bat 就行，不用记命令。
> （bat 里所有中文都用 GBK 编码写的，cmd 才能正确解析。）

### ⚠️ 用 Builder 手动打包时选哪个文件

| 文件 | 能不能打包 |
|---|---|
| `desktop\钥匙-打包用.py` | ✅ **选这个**（164 KB，界面已内嵌） |
| `desktop\keyapp_desktop.py` | ❌ 别选（34 KB，开发源码，没有界面） |

选了后者，exe 打开会弹「打包时选错了源文件」。
那个文件只在开发时用 `py desktop\keyapp_desktop.py` 直接跑。

## 用起来什么样

双击 `钥匙.exe` → 直接是聊天窗口：

```
┌─ 钥匙 · 自带 API Key 的 AI 对话 ────────  □ ✕ ┐
│ ☰  新建对话                          [正式] ＋│
├──────────────────────────────────────────────┤
│              聊天内容                        │
├──────────────────────────────────────────────┤
│ 输入消息…                            ⚙ ☆ ＋  │
└──────────────────────────────────────────────┘
```

关掉窗口，服务和进程一起退出。

### 手机连进来（不用输网址）

1. 手机上打开「钥匙」App
2. 设置 → 连接 → **扫描局域网**
3. 列表里出现这台电脑，点「用这台」→ 地址自动填好
4. 输入电脑上显示的 6 位配对码 → 完成

扫描会并发探测 254 个地址，通常 3–8 秒内就能找到。

**手填也可以**：电脑端连接页最上面那张卡有地址和配对码，
点「复制地址」复制出来发到手机上。

### 电脑端能做什么

设置 → 连接 → 电脑端专属的三块：

| 区块 | 内容 |
|---|---|
| 配对码 | 6 位数字，每次启动随机换；点「换一个」立即作废旧的 |
| 已配对的手机 | 每台手机一行，能看到名称和配对时间，点「断开」踢出（两步确认） |
| 文件 | 手机发来的文件、也能从这里发文件到电脑目录 |

## 数据放在哪

```
钥匙.exe 所在目录\
└── keyapp-data\
    ├── state.json         同步过来的对话与技能
    ├── tokens.json        已配对设备的令牌
    ├── files\             传送的文件
    ├── webview\           内嵌 WebView2 的用户数据（密钥、会话存这里，别删）
    └── window-profile\    仅在兜底用浏览器应用模式时产生（可删）
```

数据在 exe 旁边，不在 PyInstaller 的临时解压目录，换位置时连 `keyapp-data` 一起搬。

## 窗口是怎么起起来的

用 **pywebview 的 edgechromium 后端**，直接创建 WebView2 控件：

```python
window = webview.create_window("钥匙", url, width=1040, height=800, ...)
webview.start(gui="edgechromium", private_mode=False, storage_path=WEBVIEW_STORAGE)
```

- 窗口属于本进程，**不启动 msedge.exe**，任务管理器里只有 `钥匙.exe` + WebView2 运行时
- 没有地址栏、标签页、书签栏
- `storage_path` 指向 `keyapp-data/webview`，localStorage 跨启动保留（密钥不丢）
- 回答里的外链用 `js_api` 拦下来交给系统默认浏览器，不会把应用本身导航走

WebView2 **运行时**是 Windows 10/11 自带的系统组件（`msedgewebview2.exe`），
它和 Edge 浏览器本体是两个东西：不读你的浏览器书签/历史/登录态，
也不占用浏览器窗口。Windows 上要「内嵌网页」只能用它（或自己塞一个 100MB 的 Chromium）。

### 早先踩过的坑（保留记录）

最初试 pywebview 时打包失败：

```
Exception: Qt plugin directory
'C:/Users/???/AppData/.../PyQt5/Qt5/plugins' does not exist!
```

用户名是非 ASCII，`--collect-all webview` 会把 `webview.platforms.qt` 也拉进来，
触发 PyInstaller 的 PyQt5 钩子，它解析中文路径时崩掉。

现在 `desktop/build_exe.py` 里明确 `excludes=['PyQt5','PyQt6','PySide2','PySide6', 'webview.platforms.qt', ...]`，
只收 `webview.platforms.edgechromium`，打包正常。

另外命令行传 `--add-data` 带中文路径也会被 argv 编码搞坏，
所以路径全部在 `build_exe.py` 里由 Python 自己算，写成 spec 再交给 PyInstaller。

### 兜底链

pywebview 不可用（系统缺 WebView2 运行时）时依次退：

1. Chrome / Edge 的 `--app` 应用模式（会开浏览器进程，但仍是独立窗口）
2. 系统默认浏览器 + 一个显示配对码的 tk 小窗

## 已知限制

- 必须同一个 WiFi；路由器开了 **AP 隔离**（访客网络常见）扫描找不到
- 首次运行 Windows 会弹防火墙提示，要选「允许」
- 扫描用的是 HTTP 探测，某些路由器会限速，偶发漏掉
- 同步是**启动时 + 手动点**，不是实时推拉
- 同一对话两端同时改，按 `updatedAt` 取新，最后几百毫秒的改动可能丢
- 关窗即退出，没有托盘常驻

## 开发时怎么跑（不打包）

```bash
cd "F:\AI Tool"
py desktop\keyapp_desktop.py    # 有 www/ 时直接读磁盘，前端改完刷新即可
py desktop\selftest.py          # 25 项接口自测，不需要界面
```

`selftest.py` 起临时端口走完配对 / 同步 / 冲突 / 墓碑 / 文件 / 发现，
跑完自动清理，测完数据恢复空白。
