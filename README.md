# 钥匙 · 自带 API Key 的 AI 对话客户端

一个纯前端的对话界面：你填自己的 API Key，请求从浏览器（或打包后的 App）直接发到服务商，
对话记录只留在本机。没有后端、没有账号、没有中转服务器。

当前版本：**1.1.0**　模型名核对时间：**2026-11**

---

## 1.1.0 更新了什么

- **设置搬进对话列表**：底栏「设置」在「导出全部」左边，聊天输入区只剩「技能」和「＋」
- **设置分成四类**：密钥 / 外观 / 语言 / 关于，点页签切换
- **中英文界面**：语言页签里切换，只改界面文字，不动你和模型的对话
- **默认主题**：蓝白·大肥鱼（浅色 + 蓝色强调），老用户原来的配色不会被改掉
- **密钥加密**：App 里用 Android Keystore 的 AES-GCM 加密，明文副本在加密成功后删除
- **临时对话可直接保存**：顶栏「保存」按钮，输入框「＋」菜单里也有一个
- **跨域服务商可用**：智谱、混元这类不给 CORS 头的，在 App 里自动改走原生请求
- **升级不丢数据**：有版本号 + 迁移逻辑，只补不删

---

## 切换模型

顶栏模型名旁边有个小箭头，点开就是模型切换面板：

```
deepseek-flash ▾   ← 点这里
```

面板做的事：

1. **实时问服务商要列表**：请求 `GET {baseUrl}/models`，拿到「服务商这一刻真实可用」的模型
2. 列出来给你点，带搜索框过滤
3. 拉不到（比如地址填错、服务商不给列表）就**回落到预设的几个模型**，仍然能选
4. 最下面有「手动输入模型名」，服务商没返回的、或者刚上线还没进列表的，直接填

选完立刻生效：下一条消息就用新模型，顶栏和底部状态行同步更新。

### 三个细节

**① 列表会缓存**（存在密钥条目上），下次打开先秒显上次的结果，再后台刷新。
不会每次都要等网络。

**② 只换模型，不换密钥。** 模型记在密钥条目上，所以给 DeepSeek 换模型不影响你的 Kimi 条目。
要换服务商就去「设置 → 密钥」点另一条。

**③ 对话中途换模型会记录下来。** 已经发过消息的对话，切换时会往 `modelSwitches` 里记一笔，
回看历史时能知道哪一条之后换了模型，不会被"同样的对话前后风格突变"搞懵。

### 为什么不能全自动

`/v1/models` 返回的是**模型 ID 列表**，但各家的格式并不统一：

| 服务商 | 返回形态 |
|---|---|
| OpenAI / DeepSeek / Kimi | `{ data: [{ id: "..." }] }` |
| Anthropic | `{ data: [{ id: "..." }] }`，但需要 `anthropic-version` 头 |
| 部分自建 / 中转 | `{ models: ["..."] }` 纯字符串数组 |
| 少数服务商 | 直接 404，不提供这个接口 |

代码里三种都兼容了。但**模型的能力差异（上下文长度、是否支持看图、是否支持思考）无法从列表里获知**，
所以强度滑条、图片支持这些仍然按「服务商」级别配置，不能按「模型」自动判断。

## 更新提示是怎么做的

App 启动 3.5 秒后查一次版本（6 小时内不重复查），发现新版就在顶栏下方出一条提示：
「发现新版本 1.2.0　[下载]　×」。点「下载」交给系统浏览器打开 APK 地址，点 × 记住跳过这个版本。
设置 → 关于 里也有「检查更新」按钮，随时手动查。

版本号来源只有一个：`package.json` 的 `version`。`build.mjs` 会把它写成 `js/version.js`，
界面显示的当前版本、和远端比对用的都是它，不会出现两处不一致。

### 数据源（按顺序）

1. **自定义 JSON**（设置 → 关于 → 更新地址里填）
2. **GitHub Releases API**（`repos/h9837732/ai-tool/releases/latest`）

**仓库已经设置为公开**，所以默认源直接可用，不用任何配置：

```
https://api.github.com/repos/h9837732/ai-tool/releases/latest
→ { "tag_name": "v1.1.0", "assets": [{ "browser_download_url": "...apk" }] }
```

| 场景 | 能不能只用默认源 |
|---|---|
| 仓库公开 + 打了 `v*` 标签 | ✅ 零配置，已实测可用 |
| 仓库私有 | ❌ 匿名请求返回 404，需要自填「更新地址」 |

以后发版的完整流程：

```bash
git tag v1.2.0
git push origin v1.2.0
```

→ CI 编出签名 release APK → 挂到 Release → 已装的 App 下次启动就能看到「发现新版本 1.2.0」。

```json
{ "version": "1.2.0", "url": "https://你的下载地址/keyapp-1.2.0.apk", "notes": "改了什么" }
```

可选：GitHub Gist（新建 secret gist 后点 Raw 拿链接）、Cloudflare Pages、对象存储，都行。
JSON 必须返回 `access-control-allow-origin`，否则 App 里的 `fetch` 读不到。

### 一个必须知道的坑

**签名要一致，否则装不上。** 现在的 `钥匙-vX-debug.apk` 是 debug 包，签名由 Android 的调试证书生成。
如果之后换成签名 release 包，**两者不能互相覆盖安装**，手机会报「应用未安装 / 签名不一致」，
必须卸载重装（对话和密钥会一起没）。所以要么一直用 debug 包，要么从一开始就用同一个 keystore。

## 三种用法

| 用法 | 怎么做 | 适用 |
|---|---|---|
| 电脑上试 | `python -m http.server 8000`，开 `http://localhost:8000` | 开发调试 |
| 手机浏览器 | 整个文件夹丢到任意静态托管，手机打开后「添加到主屏幕」 | 马上能用 |
| 安卓 App | 推到 GitHub，Actions 自动编译出 APK | 要真 App、要绕开跨域 |

---

## 打包成安卓 App

工程已经建好了（Capacitor 8 + Android），`android/` 目录就是完整的 Android Studio 项目。

### 不用装任何东西：云端出包

1. 把整个 `F:\AI Tool` 推到 GitHub（私有库也行）
2. 仓库 → Actions → **Build APK** → `Run workflow`
3. 等 3～5 分钟，在运行记录的 Artifacts 里下载 `keyapp-debug-apk`
4. 传到手机上安装（需要允许「安装未知来源应用」）

也可以打标签自动出正式版：

```bash
git tag v1.0.0
git push origin v1.0.0
```

APK 会挂在 Release 页面，可以直接下载。

### 本机有 Android Studio 的话

```bash
bun install
bun run sync          # 把前端同步到 www/ 并灌进 android/
npx cap open android  # 用 Android Studio 打开，点 Run
```

或者命令行：

```bash
cd android && ./gradlew assembleDebug
# 产物在 android/app/build/outputs/apk/debug/
```


### 签名已配置好（固定密钥）

现在所有构建都用同一把密钥签名，**升级可以覆盖安装**，不用卸载。

| 项目 | 值 |
|---|---|
| 证书 SHA-256 | `E1:34:73:55:99:34:6E:23:3D:15:2A:03:FC:D0:A1:73:48:62:78:D1:F8:83:74:DB:1D:EC:0E:86:E1:61:CB:27` |
| 别名 | `keyapp` |
| 类型 | PKCS12 / RSA 2048 / 10000 天 |
| 存放 | 主仓库 Actions Secrets（CI 用）+ 私有仓库 `keyapp-vault`（加密备份） |

验证方式：CI 每次构建都会跑 `apksigner verify --print-certs`，
把 debug 和 release 两个包的指纹写进 job summary，对得上才说明签名正确。

> ⚠️ **一次性卸载**：你手机上如果装的是之前那个「每次构建换签名」的 debug 包，
> 第一次装这个新版必须**先卸载**（对话和 Key 会丢，先导出备份）。
> 从这版之后，所有更新都能直接覆盖。

> ⚠️ **别重复跑** `Make Keystore (一次性)` 这个 workflow，再跑会生成新密钥。

### 手动生成签名（原始步骤，仅作参考）

1. 本地生成一份 keystore（一次就够，**务必备份**，丢了就没法覆盖更新）：

```bash
keytool -genkeypair -v -keystore keyapp-release.keystore   -alias keyapp -keyalg RSA -keysize 2048 -validity 10000
```

2. 转成 base64 放进仓库 Secrets：

```bash
# Linux / macOS
base64 -w0 keyapp-release.keystore
# Windows PowerShell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("keyapp-release.keystore"))
```

3. 仓库 → Settings → Secrets and variables → Actions，加 4 个：

| Secret | 内容 |
|---|---|
| `KEYSTORE_BASE64` | 上一步的 base64 整串 |
| `KEYSTORE_PASSWORD` | 密钥库口令 |
| `KEY_ALIAS` | 别名，例如 `keyapp` |
| `KEY_PASSWORD` | 密钥口令 |

4. 打标签推送，Release 页面就会出现签名后的 APK：

```bash
git tag v1.1.0
git push origin v1.1.0
```

没配 Secrets 也能跑，会退回出未签名的 release 包。

### 打包带来的两个变化

- **不再受浏览器跨域限制**：自己写了个 `NativeHttp` 插件，正常请求仍走 `fetch`（有流式打字机效果），
  只有在跨域被拦下时才自动改走原生请求（这条会失去流式，消息下方有说明）。
  没有用 Capacitor 自带的 `CapacitorHttp`，因为它会接管 `window.fetch` 并把响应变成非流式，
  所有服务商都会失去逐字输出
- **不再注册离线缓存**：资源本来就在安装包里，再挂 Service Worker 会让更新不生效

### 改完前端要重新同步

```bash
bun run sync
```

`www/` 是从根目录复制出来的，别直接改 `www/` 里的文件。

---

## 支持的服务商（2026-11 核对）

| 服务商 | 当前模型 | 看图 | 强度 | 网页直连 |
|---|---|---|---|---|
| DeepSeek | `deepseek-flash`（V4.1-Flash-1017）、`deepseek-v4-pro` | ✅ | ✅ none/low/high/max | ✅ |
| Kimi 月之暗面 | `kimi-k3.1-pro`、`kimi-k3.1-pro-highspeed`、`kimi-k3` | ✅ | — | ✅ |
| 通义千问 | `qwen3.8-max`、`qwen3.7-plus`、`qwen3.8-flash` | ✅ | — | ✅ |
| 豆包（火山方舟） | `doubao-seed-evolving` | ✅ | — | ✅ |
| 智谱 GLM | `glm-5.3`、`glm-5.3-flash`、`glm-5v-turbo` | — | ✅ low/high/max（关不掉） | ❌ 需打包 |
| 硅基流动 | `deepseek-ai/DeepSeek-V4.1-Flash`、`zai-org/GLM-5.3-Flash` | ✅ | — | ✅ |
| OpenRouter | `deepseek/deepseek-v4-pro`、`anthropic/claude-opus-5-5` 等 | ✅ | ✅ | ✅ |
| OpenAI | `gpt-6.1-sol`、`gpt-6.1-terra`、`gpt-6-luna`、`gpt-6-astra` | ✅ | ✅ | ✅ |
| Claude | `claude-sonnet-5-5`、`claude-opus-5-5`、`claude-haiku-5-5`、`claude-fable-5-2` | ✅ | ✅ thinking 预算 | ✅ |
| Gemini | `gemini-4-argon`、`gemini-3.8-flash`、`gemini-3.6-flash` | ✅ | ✅ | ✅ |
| Groq | `openai/gpt-oss-120b`、`llama-3.3-70b-versatile` | ✅ | ✅ | ✅ |
| Grok（xAI） | `grok-4.7` | ✅ | ✅ | ✅ |
| 腾讯混元 / 讯飞星火 | 支持 OpenAI 协议，但预设里没放 | — | — | ❌ 需打包 |

> 模型名一直在变。真要用的时候点设置里的**「拉取列表」**，它会打 `/v1/models` 拿到这家
> 服务商**此刻**真实可用的模型，比任何写死的清单都准。

只要对方是 OpenAI 兼容接口（`POST {baseUrl}/chat/completions` + Bearer + SSE），
选「自定义」填个地址就能接。本地 Ollama、LM Studio、各种中转站都行。

---

## 第一次使用

1. 页面自动弹出设置 → 点「新增」建一条密钥
2. 选服务商（自动带出接口地址和默认模型）→ 填 Key → 保存
3. 关掉设置，开始聊

每个 Key 存成独立一条，可以建多条随时切换。**只在设置里显示**，其他界面看不到密钥信息。

---

## 界面说明

```
┌──────────────────────────────────────┐
│ ☰   标题                    [正式] ＋ │  ← ＋ 新建对话，空对话时可切临时
│     模型名                            │
├──────────────────────────────────────┤
│                                      │
│  消息流（左色标：蓝灰=你，铜色=模型） │
│                                      │
├──────────────────────────────────────┤
│  ┌────────────────────────────────┐  │
│  │ [附件卡片]                      │  │
│  │ 输入框                          │  │
│  │ ⚙ ☆ ＋        ⌃中 ◯ 🎤 ➤       │  │  ← ⚙设置 ☆技能 ＋附件
│  └────────────────────────────────┘  │
│  模型 · 强度 · 技能数 · 临时          │
└──────────────────────────────────────┘
```

- **⚙**：密钥与设置
- **☆**：技能库，数字是启用的个数
- **＋**：相册 / 图片、文件
- **⌃中**：思考强度，点开是五档滑条
- **◯**：上下文占用环
- **🎤**：语音输入（Chrome 可用）
- **＋（顶栏）**：新建对话

---

## 临时对话

顶栏在**空对话**时可以切「正式 / 临时」：

| 模式 | 行为 |
|---|---|
| 正式 | 自动存到对话列表 |
| 临时 | 不写入本机，离开就没了 |

临时对话发出消息后，顶栏出现**保存**按钮，点一下转正式。带着临时对话离开会弹确认。

---

## 强度滑条

五档：关闭 / 低 / 中 / 高 / 无限制。不同服务商的落地方式：

| 档位 | DeepSeek | OpenAI 系 | 智谱 GLM | Claude |
|---|---|---|---|---|
| 关闭 | `reasoning_effort: none` | 不发字段 | 不发（GLM 关不掉） | 不发 `thinking` |
| 低 | `low` | `low` | `low` | 预算 1024 |
| 中 | `medium` | `medium` | `high` | 4096 |
| 高 | `high` | `high` | `high` | 16384 |
| 无限制 | `max` | `high` | `max` | 32768 |

Claude 开思考时只接受 `temperature=1`，所以这时自动不发该字段；`max_tokens` 会自动抬到
「预算 + 1024」以上，否则 Claude 会报错。

没适配的服务商不认这个参数，界面右下角会写明「这家不认思考强度参数」，不会乱发字段把请求弄坏。

---

## 附件

- **相册 / 图片**：手机上直接进相册，也能拍照
- **文件**：.txt / .md / .json / .csv / 各类代码文件
- **Ctrl+V 粘图**、**拖放文件**（桌面端）

图片发送前自动缩到最长边 1280、转 JPEG；文本文件拼进正文成代码块。单个文本超过 100 KB 会二次确认，
一次最多 8 个附件。

> 网页读不了目录树，只能通过系统文件对话框让你选——这是浏览器规范，不是权限没申请。

---

## 配色

设置 → 偏好 → 配色：黄铜 / 青瓷 / 石墨 / 绛紫 / 赤陶 / 自定义。

自定义只挑**两个色**（强调色 + 底色），悬浮层、卡片、分割线、正文色、静音色、按钮文字色
全部按亮度自动推导。深浅色切换时预设会自动换对应的浅色版。

---

## 技能

「技能」是一段发给模型的指令文本。打开开关的技能，每次提问都会附在基础提示词后面：

```
[基础提示词]

【技能名】
技能正文
```

新增时可以点示例套用。提示词库随便找，把正文粘进去就行：

| 来源 | 地址 |
|---|---|
| Awesome ChatGPT Prompts | `github.com/f/awesome-chatgpt-prompts` |
| LangGPT | `github.com/langgptai/LangGPT` |
| Anthropic Prompt Library | `docs.anthropic.com` |
| OpenAI Cookbook | `cookbook.openai.com` |

> 另有一类叫 agent skill（`skills.sh`、`anthropics/skills`）——那是带 SKILL.md 和脚本的包，
> 装给 AI 助手客户端用的，不能直接塞进本 App。本 App 只认纯文本指令。

---

## 文件结构

```
F:\AI Tool\
├── index.html                  页面骨架
├── css/app.css                 全部样式
├── js/version.js               版本号（build.mjs 从 package.json 生成）
├── js/update.js                更新检查（GitHub Releases / 自定义 JSON）
├── js/i18n.js                  中英文文案表 ← 加语言或改文案只改这里
├── js/secure.js                原生能力封装（钥匙串加密 + 原生 HTTP）
├── js/providers.js             服务商预设表 ← 加新服务商只改这里
├── js/md.js                    零依赖 Markdown 渲染
├── js/store.js                 本机存储层
├── js/app.js                   界面逻辑、密钥、技能、强度、请求、流式解析
├── sw.js                       离线缓存（网页版用，App 里不注册）
├── manifest.webmanifest        PWA 清单
├── icon.svg                    网页图标
├── build.mjs                   把前端同步到 www/
├── capacitor.config.json       Capacitor 配置（CapacitorHttp 已开）
├── android/                    Android Studio 工程
│   └── app/src/main/java/com/keyapp/chat/
│       ├── MainActivity.java           注册本地插件
│       ├── SecureStorePlugin.java      Keystore 加密存储
│       └── NativeHttpPlugin.java       原生 HTTP（绕开跨域）
├── .github/workflows/build-apk.yml   云端编译 APK
└── www/                        同步产物，打包时生成（不用手改）
```

---

## 你的数据在哪

| 内容 | 存储键 |
|---|---|
| 数据结构版本 | `keyapp:schemaVersion` |
| 密钥条目 | `keyapp:profiles`（App 里另有加密副本 `keyapp:secureProfiles`） |
| 当前在用哪条 | `keyapp:activeProfile` |
| 技能库 | `keyapp:skills` |
| 提示词、温度、主题、配色、强度 | `keyapp:settings` |
| 对话列表索引 | `keyapp:index` |
| 每条对话 | `keyapp:conv:<id>` |

都在本机。**换浏览器、清数据、卸载重装都会丢**，重要对话用「导出全部」备份。

> 隐私：Key 以明文存在 localStorage 里，能在这台设备上打开开发者工具的人都能读到。
> 共用设备用完请删掉对应条目。打包成 App 后仍是明文（未接 Android Keystore），
> 这是已知的待改进项。

---

## 已知限制

- 网页版受跨域限制，智谱/混元/讯飞要打包成 App 才能用
- 临时对话不进任何存储，切走或刷新就没了（除非点「保存」）
- 原生请求兜底没有流式输出；正常服务商不受影响
- 导入备份不会恢复密钥条目（怕一份备份泄漏所有 Key）
- 单条对话太长时会自动裁掉最早的几轮（约 12 万字符上限）
- 图片随对话存进本机，多了占存储；存不下时会提示导出备份
- Markdown 不支持表格，代码块没有「复制」按钮
- 语音输入依赖浏览器识别（Chrome 可用，Safari/Firefox 有限）
- 函数调用、联网搜索还没做
