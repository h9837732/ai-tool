/* 账单与帮助数据。
   balance: 官方余额接口的路径（相对用户的接口地址；null = 该服务商没有公开接口）
            dropV1 表示这个路径在根域名下而不是 /v1 下（DeepSeek 就是这种）
   recharge / console: 官方充值页、用量页
   offPeak: 是否区分高峰/空闲时段计费
   steps: 获取 API Key 的步骤，每项 [中文, English] */

const BILLING = {
  deepseek: {
    balance: { path: '/user/balance', dropV1: true, kind: 'deepseek' },
    recharge: 'https://platform.deepseek.com/top_up',
    console: 'https://platform.deepseek.com/usage',
    offPeak: true
  },
  moonshot: {
    balance: { path: '/users/me/balance', kind: 'kimi' },
    recharge: 'https://platform.moonshot.cn/console/pay',
    console: 'https://platform.moonshot.cn/console/info'
  },
  siliconflow: {
    balance: { path: '/user/info', kind: 'siliconflow' },
    recharge: 'https://cloud.siliconflow.cn/account/recharge',
    console: 'https://cloud.siliconflow.cn/account/ak'
  },
  openrouter: {
    balance: { path: '/credits', kind: 'openrouter' },
    recharge: 'https://openrouter.ai/settings/credits',
    console: 'https://openrouter.ai/activity'
  },
  dashscope: {
    balance: null,
    recharge: 'https://bailian.console.aliyun.com/',
    console: 'https://bailian.console.aliyun.com/'
  },
  ark: {
    balance: null,
    recharge: 'https://console.volcengine.com/finance/recharge',
    console: 'https://console.volcengine.com/ark'
  },
  zhipu: {
    balance: null,
    recharge: 'https://bigmodel.cn/finance/recharge',
    console: 'https://bigmodel.cn/usercenter/usagedetails'
  },
  openai: {
    balance: null,
    recharge: 'https://platform.openai.com/settings/organization/billing',
    console: 'https://platform.openai.com/usage'
  },
  anthropic: {
    balance: null,
    recharge: 'https://console.anthropic.com/settings/billing',
    console: 'https://console.anthropic.com/settings/usage'
  },
  gemini: {
    balance: null,
    recharge: 'https://aistudio.google.com/apikey',
    console: 'https://aistudio.google.com/usage'
  },
  groq: {
    balance: null,
    recharge: 'https://console.groq.com/settings/billing',
    console: 'https://console.groq.com/usage'
  },
  xai: {
    balance: null,
    recharge: 'https://console.x.ai/team/billing',
    console: 'https://console.x.ai/'
  },
  custom: { balance: null, recharge: '', console: '' }
};

const KEY_TUTORIAL = {
  deepseek: {
    url: 'https://platform.deepseek.com/api_keys',
    steps: [
      ['打开 DeepSeek 开放平台，注册或用手机号登录', 'Open the DeepSeek platform and sign in'],
      ['左侧菜单点「API keys」，再点「创建 API key」', 'Click "API keys", then "Create API key"'],
      ['给这个 key 起个名字（比如「钥匙App」），确认创建', 'Name the key and confirm'],
      ['复制弹出的 sk- 开头的字符串（只显示一次）', 'Copy the sk-… string, shown only once'],
      ['回到本应用「设置 → 密钥」粘贴，然后保存', 'Paste it in Settings → Keys and save'],
      ['账户要先充值才能调用，余额可在「用量」页查看', 'Top up first; the balance is on the Usage tab']
    ]
  },
  moonshot: {
    url: 'https://platform.moonshot.cn/console/api-keys',
    steps: [
      ['打开 Kimi 开放平台，用手机号登录', 'Open the Kimi platform and sign in'],
      ['左侧「API Key 管理」→ 新建', 'API Key management → New'],
      ['复制 sk- 开头的 key', 'Copy the sk-… key'],
      ['粘贴到本应用「设置 → 密钥」', 'Paste it in Settings → Keys'],
      ['注意：platform.kimi.com 与 platform.kimi.ai 的 Key 不通用', 'Keys from platform.kimi.com and platform.kimi.ai are not interchangeable']
    ]
  },
  dashscope: {
    url: 'https://bailian.console.aliyun.com/',
    steps: [
      ['打开阿里云百炼控制台，需实名认证的阿里云账号', 'Open Alibaba Cloud Model Studio with a verified account'],
      ['右上角「API-KEY」→ 创建我的 API-KEY', 'Click "API-KEY" → create a key'],
      ['复制 key 并粘贴到本应用', 'Copy it into this app'],
      ['接口地址保持「通义千问（阿里云百炼）」预设即可', 'Keep the built-in DashScope preset'],
      ['要在百炼里开通对应模型才能调用', 'Enable the model in the console first']
    ]
  },
  ark: {
    url: 'https://console.volcengine.com/ark',
    steps: [
      ['打开火山方舟控制台，需火山引擎账号', 'Open the Volcengine Ark console'],
      ['左侧「API Key 管理」→ 创建 API Key', 'API Key management → create'],
      ['在「在线推理」里为模型创建推理接入点，拿到 ep- 开头的 ID', 'Create an inference endpoint and note the ep-… ID'],
      ['模型名一栏填这个 ep- ID，不是 doubao-seed-evolving 这种显示名', 'Put the ep-… ID in the model field, not the display name'],
      ['粘贴 API Key 到本应用', 'Paste the API key into this app']
    ]
  },
  zhipu: {
    url: 'https://bigmodel.cn/usercenter/apikeys',
    steps: [
      ['打开智谱开放平台，注册并登录', 'Open the Zhipu platform and sign in'],
      ['右上角头像 → API 密钥', 'Avatar menu → API keys'],
      ['复制 key，形如 xxxxx.xxxxx，中间有一个点', 'Copy the key, shaped like xxxxx.xxxxx'],
      ['粘贴到本应用「设置 → 密钥」', 'Paste it in Settings → Keys'],
      ['智谱不返回跨域允许头，网页版直连会被拦下，需要用 App', 'Zhipu sends no CORS header, so the web build cannot reach it — use the app']
    ]
  },
  siliconflow: {
    url: 'https://cloud.siliconflow.cn/account/ak',
    steps: [
      ['打开硅基流动控制台，手机号登录', 'Open the SiliconFlow console and sign in'],
      ['左侧「API 密钥」→ 新建 API 密钥', 'API keys → create new'],
      ['复制 sk- 开头的 key', 'Copy the sk-… key'],
      ['粘贴到本应用「设置 → 密钥」', 'Paste it in Settings → Keys'],
      ['一个 Key 可调平台上百个模型', 'One key covers hundreds of models there']
    ]
  },
  openrouter: {
    url: 'https://openrouter.ai/keys',
    steps: [
      ['打开 OpenRouter，用 Google 或 GitHub 登录', 'Open OpenRouter and sign in'],
      ['右上角头像 → Keys → Create Key', 'Avatar → Keys → Create Key'],
      ['复制 sk-or-v1- 开头的 key', 'Copy the sk-or-v1-… key'],
      ['粘贴到本应用「设置 → 密钥」', 'Paste it in Settings → Keys'],
      ['一个 Key 可调 OpenAI / Claude / Gemini / DeepSeek 等几百个模型', 'One key reaches hundreds of models'],
      ['大陆访问通常需要代理', 'Usually needs a proxy from mainland China']
    ]
  },
  openai: {
    url: 'https://platform.openai.com/api-keys',
    steps: [
      ['打开 OpenAI 平台，登录后绑定支付方式', 'Open the OpenAI platform and add a payment method'],
      ['右上角齿轮 → API keys → Create new secret key', 'Gear icon → API keys → Create new secret key'],
      ['复制 sk- 开头的 key，只显示一次', 'Copy the sk-… key, shown once'],
      ['粘贴到本应用「设置 → 密钥」', 'Paste it in Settings → Keys'],
      ['大陆访问通常需要代理，余额在 Billing 页充值', 'Needs a proxy from mainland China; top up under Billing']
    ]
  },
  anthropic: {
    url: 'https://console.anthropic.com/settings/keys',
    steps: [
      ['打开 Anthropic Console，登录并充值', 'Open the Anthropic Console, sign in and add credit'],
      ['API Keys → Create Key', 'API Keys → Create Key'],
      ['复制 sk-ant- 开头的 key', 'Copy the sk-ant-… key'],
      ['粘贴到本应用「设置 → 密钥」', 'Paste it in Settings → Keys'],
      ['大陆访问通常需要代理', 'Usually needs a proxy from mainland China']
    ]
  },
  gemini: {
    url: 'https://aistudio.google.com/apikey',
    steps: [
      ['打开 Google AI Studio，用 Google 账号登录', 'Open Google AI Studio and sign in'],
      ['左侧 Get API key → Create API key', 'Get API key → Create API key'],
      ['复制 AIza 开头的 key', 'Copy the AIza… key'],
      ['粘贴到本应用「设置 → 密钥」', 'Paste it in Settings → Keys'],
      ['免费额度有限，用超了要在 Cloud 项目里开结算', 'Free tier is limited; enable billing for more'],
      ['大陆访问通常需要代理', 'Usually needs a proxy from mainland China']
    ]
  },
  groq: {
    url: 'https://console.groq.com/keys',
    steps: [
      ['打开 Groq Console，用 Google 或 GitHub 登录', 'Open the Groq Console and sign in'],
      ['左侧 API Keys → Create API Key', 'API Keys → Create API Key'],
      ['复制 gsk_ 开头的 key', 'Copy the gsk_… key'],
      ['粘贴到本应用「设置 → 密钥」', 'Paste it in Settings → Keys'],
      ['有免费额度，出字速度极快', 'Has a free tier and is extremely fast'],
      ['大陆访问通常需要代理', 'Usually needs a proxy from mainland China']
    ]
  },
  xai: {
    url: 'https://console.x.ai/',
    steps: [
      ['打开 xAI Console，登录并充值', 'Open the xAI Console, sign in and add credit'],
      ['API Keys → 创建', 'API Keys → create'],
      ['复制 xai- 开头的 key', 'Copy the xai-… key'],
      ['粘贴到本应用「设置 → 密钥」', 'Paste it in Settings → Keys'],
      ['大陆访问通常需要代理', 'Usually needs a proxy from mainland China']
    ]
  },
  custom: {
    url: '',
    steps: [
      ['确认对方是 OpenAI 兼容接口', 'Confirm the endpoint speaks the OpenAI protocol'],
      ['拿到 Base URL，一般以 /v1 结尾', 'Get the base URL, usually ending in /v1'],
      ['拿到 API Key', 'Get the API key'],
      ['两样都填进「设置 → 密钥」，模型名可手填或点「拉取列表」', 'Fill both in Settings → Keys, then set the model'],
      ['本地 Ollama 地址类似 http://127.0.0.1:11434/v1，Key 随便填', 'For local Ollama use http://127.0.0.1:11434/v1 with any key']
    ]
  }
};

function getBilling(id) {
  return BILLING[id] || BILLING.custom;
}

function getTutorial(id) {
  return KEY_TUTORIAL[id] || KEY_TUTORIAL.custom;
}
