# 钥匙 · 自带 API Key 的 AI 对话客户端

一个纯前端的对话界面：你填自己的 API Key，请求从浏览器（或打包后的 App）直接发到服务商，
对话记录只留在本机。没有后端、没有账号、没有中转服务器。

模型名核对时间：**2026-11**

---

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

### 打包带来的两个变化

- **不再受浏览器跨域限制**：`capacitor.config.json` 里开了 `CapacitorHttp`，
  WebView 的请求会走原生层，智谱 GLM、腾讯混元、讯飞星火这些不返回 CORS 头的服务商也能用了
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
├── .github/workflows/build-apk.yml   云端编译 APK
└── www/                        同步产物，打包时生成（不用手改）
```

---

## 你的数据在哪

| 内容 | 存储键 |
|---|---|
| 密钥条目 | `keyapp:profiles` |
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
- 临时对话不进任何存储，切走或刷新就没了（除非先点保存）
- 导入备份不会恢复密钥条目（怕一份备份泄漏所有 Key）
- 单条对话太长时会自动裁掉最早的几轮（约 12 万字符上限）
- 图片随对话存进本机，多了占存储；存不下时会提示导出备份
- Markdown 不支持表格，代码块没有「复制」按钮
- 语音输入依赖浏览器识别（Chrome 可用，Safari/Firefox 有限）
- 函数调用、联网搜索还没做
- APK 里的 Key 仍是明文存储
