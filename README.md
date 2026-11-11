# 钥匙 · 自带 API Key 的 AI 对话客户端

填自己的 API Key 就能用，请求直接发到服务商，对话记录只留在本机。
没有账号、没有中转服务器；除了你自己局域网内的电脑桥，不经过任何第三方。

三种形态：网页、安卓 App、Windows 桌面版。**电脑端与手机可以互相同步对话**（见下方 v1.3 一节）。

当前版本：**1.5.0**　模型名核对时间：**2026-11**

---

## 版本历史

### 1.5.0 — 安全与可靠性

- **静态服务收紧**：局域网桥以前会按项目根目录提供文件，`/package.json`、`/.git/config`
  这类东西同 WiFi 的人能直接下载；现在只放行前端产物（`www/`），并用真实路径围栏挡住各种穿越写法
- **密钥不再明文落盘**：安卓走 Android Keystore，电脑端新增 **Windows DPAPI**（`ctypes` 实现，不引第三方库）；
  同时删掉了历史上为了“同步读取”而额外缓存的那份明文副本（那等于加密白做）
- **配对码限速**：6 位数字只有一百万种，连错 5 次封 10 分钟（两套服务都有）
- **请求体上限**：JSON 2 MB / 文件 64 MB，超了直接 413，不再无限读进内存
- **同步写入加锁**：并发写不同对话以前会互相覆盖（实测 16 条丢 13 条），现在串行合并
- **应用内更新 + SHA-256 校验**：电脑端下载后自己替换 exe 并重启；手机端下载 APK 拉起安装器；
  两端都要求校验值，拿不到就拒装
- **自测不再碰真实数据**：`selftest.py` 以前会删你的对话和收到的文件，现在全跑在 `.selftest-tmp/`

### 1.3.x — 双端互通

- 电脑端从 `msedge --app` 改成 **pywebview + 内嵌 WebView2**，不再拉起浏览器进程
- 实时同步（SSE 长连接）：一端改动，另一端自动拉回，不用手点
- 电脑端自己的界面也参与同步（以前因为没令牌，电脑上的对话根本进不了同步）
- 自动发现照 LocalSend 的思路：组播 + 子网扫描 + fingerprint 排自我

### 1.2.x — 界面与账单

- 用量与账单面板、时段提示、余额查询
- 思考强度推拉条、技能库、临时对话

### 1.1.0 — 设置与密钥

- 设置分成密钥 / 外观 / 语言 / 关于四类；中英双语；主题可切
- 密钥条目化：每个 Key 一条，可命名、可切换
- 升级不丢数据：有 schema 版本 + 只补不删的迁移

---

## 手机与电脑互通（v1.3）

**前提**：这个 App 是纯静态前端，网页无法监听端口，所以必须有一端跑一个小程序。
方案是**在电脑上跑局域网桥**，手机连同一个 WiFi。不走任何云端，数据不经过第三方。

### 两种跑法

**A. 电脑端软件（推荐，有窗口）**

见 [desktop/README.md](desktop/README.md)。打包成 `钥匙.exe` 后双击即可，
窗口里能看配对码、地址、附近设备、日志，还能设开机自启。

**B. 命令行（改代码时用）**

```bash
cd "F:\AI Tool"
bun run lan
```

终端会打印：

```
  钥匙 · 局域网桥已启动

  配对码  890457

  手机访问  http://192.168.1.49:8787
  电脑访问  http://localhost:8787
```

### 手机连上（自动发现，照 LocalSend 的思路）

桥服务启动后会加入组播组 `224.0.0.167:53317`（LocalSend 的默认地址），
广播自己是谁、在哪个端口。这就是 LocalSend「不用填 IP 就能看到彼此」的原理。

移动端拿到邻居列表的方式：连上任意一台后，桥服务告诉你它还听见了谁。

```
手机 App →「设置 → 连接」→「附近的电脑」
  ├─ 桌面 PC      192.168.1.49:8787     [用这台]
  └─ 旧笔记本     192.168.1.60:8787     [用这台]
```

点「用这台」自动填地址，只需要再敲一次配对码。

三种连法，按省事程度排：

1. **附近设备列表点「用这台」** —— 地址自动填，只输配对码
2. **手机浏览器打开终端给的地址** —— 「自动填入」一步搞定（配对码和地址都从本机读）
3. **纯手动** —— 填地址 + 配对码，适合组播被路由器拦的情况

配对之后：打开 App 会自动静默同步一次，也能手动点「立即同步」。

### 和 LocalSend 的取舍

| LocalSend 的做法 | 本项目的做法 | 原因 |
|---|---|---|
| UDP 组播发现 | ✅ 照做（同一组播组、同端口） | 免手抄 IP，体验关键 |
| fingerprint 识别设备 | ✅ 照做（MAC + 主机名哈希） | 避免自己发现自己的回声 |
| `POST /api/register` 应答 | ✅ 照做 | 双向认识 |
| **HTTPS 自签证书** | ❌ 不做 | 手机浏览器会拦自签证书，而我们网页 + APK 双端都要能连；改用配对码 + Bearer 令牌 |
| 无鉴权（内网互信） | ❌ 不做 | 同一 WiFi 可能有陌生人，配对码是必须的 |
| 专门的传输 UI | 不做 | 我们只服务「钥匙」自己的对话与文件 |

> 关于 TLS：LocalSend 用「连接时生成的证书指纹」来做信任，
> 但浏览器不认这个模型（会直接报证书错误）。所以这里换成更实际的
> 「配对码一次性确认 + 长期令牌」，安全等级在同一量级，兼容性好得多。

### 同步什么、不同步什么

| 同步 | 不同步（刻意） |
|---|---|
| 对话（含消息、推理过程） | **API Key** |
| 技能库 | 模型选择 |
| | 主题 / 语言 / 强度等设备偏好 |

**Key 绝对不同步。** 它是每台设备自己的秘密，复制到另一台设备只会扩大泄露面。
所以换设备后仍然要各自填一次 Key。

### 冲突怎么解决

按 `updatedAt` 取新的：

- 同一条对话两边都改过 → 保留 `updatedAt` 更新的那个
- 一边删了 → 用「墓碑」记录删除时间，另一边的旧副本同步时会被删掉，不会被复活
- 墓碑 7 天后自动清理，避免无限增长

### 文件传输

「设置 → 连接 → 文件」：

- **发送文件**：手机选一个文件 → 存到电脑 `server/data/files/`
- **下载**：列表里点「下载」→ 存到手机
- 文件名里的路径会被剥掉（`../../evil.txt` 存成 `evil.txt`），不会写到目录外

### 安全边界

| 措施 | 说明 |
|---|---|
| 静态资源 | 只提供前端文件（`www/`）；`package.json`、源码、`.git` 一律 404 |
| 配对码 | 6 位数字，**每次启动服务随机换**，只给电脑本机看 |
| 配对码读取 | `/api/code` 只允许**电脑本机**访问，局域网其他设备拿到 403 |
| 配对码限速 | 同一 IP 连错 5 次封 10 分钟（429） |
| 令牌 | 配对后发 24 字节随机令牌，之后所有接口都要 Bearer |
| 本机豁免 | `127.0.0.1` 访问 `/api` 不要令牌（电脑端自己的界面靠它上报数据） |
| 请求体上限 | JSON 2 MB / 文件 64 MB，超了 413 |
| 密钥落盘 | 安卓 Keystore / Windows DPAPI 加密，磁盘上不存明文 |
| 自动更新 | 必须带 SHA-256 校验值，对不上就拒装 |
| 数据落盘 | 全在本机，不经过任何云 |

> 也就是说：同一 WiFi 下的陌生人即使知道你的 IP 和端口，没有配对码也读不到对话；
> 想暴力试 6 位配对码，会被限速拦住。

### 已知限制

- 电脑上的桥服务**必须先启动**，手机才能同步；关掉服务就停
- 手机端只有 App 与电脑配对后才实时；没配对时是纯本地
- 只支持同一个局域网，不能跨网络
- 桥服务没有开机自启，也没做后台常驻
- 两人同时改**同一条**对话时，仍可能丢掉一方最后几百毫秒的改动（按时间戳取新）；
  不同对话并发已经安全（有串行合并）
- 纯浏览器（没装 App、不是桌面版）没有系统安全区，密钥只能明文存 localStorage —— 界面会明确提示

## 用量与账单

设置里第五个页签「用量」，四块内容。

### ① 当前计费时段（DeepSeek）

按 DeepSeek 官方规则实时判断：

> 北京时间 **周一至周五 9:00–12:00、14:00–18:00 为高峰**，其余时段（含周末）为**空闲**，
> 空闲价 = 高峰价的一半。

界面显示「高峰 / 空闲」、当前北京时间、还有多久切换，空闲时段会提示「现在调用更便宜」。

> ⚠️ **不识别法定节假日**。官方规则里节假日全天算空闲，但本应用没有节假日日历，
> 节假日期间可能误报为高峰。界面底部有这句说明。

只有 DeepSeek 目前是分时计价，其他服务商显示「不区分时段」。

### ② 余额

接入各家的**官方余额接口**，点「查询」现取：

| 服务商 | 接口 | 能查到 |
|---|---|---|
| DeepSeek | `GET /user/balance` | 总余额、充值余额、赠送余额 |
| Kimi | `GET /v1/users/me/balance` | 可用余额、现金余额、代金券 |
| 硅基流动 | `GET /v1/user/info` | 总余额、充值余额 |
| OpenRouter | `GET /api/v1/credits` | 累计充值、累计使用、剩余 |

其余 9 家（OpenAI、Claude、Gemini、通义、豆包、智谱、Groq、Grok、自定义）**没有公开的余额接口**，
界面会直接写明并给出控制台入口，不会假装能查。

**余额地址跟着你的接口地址走**，所以走中转站也能查。

### ③ 本机用量

请求会带 `stream_options: { include_usage: true }`，服务商在最后一个 chunk 里回 token 数，
本机累计：请求次数、输入 tokens、输出 tokens、合计。

> 只统计**这台设备发出、且服务商真的返回了用量**的请求。换设备不累计，
> 服务商那边的账单也不受影响——这只是本地账本。

### ④ 氪金入口

「去充值」「用量与账单」两个按钮，分别跳服务商官方的充值页和账单页。
**支付全程在服务商自己的网站上完成，本应用不接触任何支付信息。**

### ⑤ 获取 API Key 教程

13 家服务商各有一份分步说明（中英双语），点「查看」打开，最后一步都是「粘贴到本应用」。
里面写了几条容易踩的坑，比如：

- 豆包的模型名要填 `ep-` 开头的推理接入点 ID，不是 `doubao-seed-evolving` 这种显示名
- 智谱的 key 形如 `xxxxx.xxxxx`，中间有一个点
- Kimi 国内站 `platform.kimi.com` 与海外站 `platform.kimi.ai` 的 key **不通用**
- 智谱不返回跨域允许头，网页版直连会被拦下，必须用 App

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

## 更新提示与安装

启动 3.5 秒后查一次版本（6 小时内不重复查），发现新版就在顶栏下方出一条提示：
「发现新版本 1.5.0　[立即更新]　×」。

点「立即更新」后：

| 平台 | 行为 |
|---|---|
| Windows 桌面版 | 下载 → 校验 SHA-256 → 启一个独立 cmd 等本进程退出 → 换掉 exe → 重启 |
| 安卓 App | 下载 APK → 校验 SHA-256 → FileProvider 发 `content://` → 拉起系统安装器 |
| 纯浏览器 | 只能打开下载页（浏览器没有替换自己的能力） |

**校验值从哪来**：优先用 GitHub Release 里 asset 自带的 `digest`；没有就去拉同名
`<文件名>.sha256` 旁文件；两样都拿不到就**拒绝安装**（宁可让用户手动下，也不能把不明来源的 exe 换上去）。

版本号来源只有一个：`package.json` 的 `version`。`build.mjs` 会把它写成 `js/version.js`，
`embed_assets.py` 又把它写进 Python 侧的 `APP_VERSION`，`android/app/build.gradle` 的
`versionName` / `versionCode` 也从它派生 —— 不会出现两处不一致。
打标签前改了 `package.json` 但忘了重跑 `bun run build`，打包脚本会直接拒绝。

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
├── js/billing.js               余额接口 / 充值入口 / API Key 教程数据
├── js/bill.js                  计费时段判断、余额解析、本机用量统计
├── js/sync.js                  局域网同步客户端（配对、同步、文件传输）
├── server/lan.mjs              局域网桥服务（Bun 版，命令行跑）
├── desktop/keyapp_desktop.py   电脑端软件（Python + tkinter，可打包 exe）
├── desktop/embed_assets.py     把前端压进单文件，给 PyInstaller 用
├── desktop/selftest.py         25 项接口自测，不需要界面
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

> 隐私：
> - **安卓 App**：密钥用 Android Keystore（AES-GCM）加密，localStorage 里不再保留明文
> - **Windows 桌面版**：密钥用 **Windows DPAPI** 加密，存在 `keyapp-data/secrets.dat`，磁盘上是密文
> - **纯浏览器**：没有系统安全区，只能明文存在 localStorage。共用设备用完请删掉对应条目

密钥在内存里确实会解密，这是“要给服务商发请求”的必然代价；要做到的是**不落盘明文**。

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
