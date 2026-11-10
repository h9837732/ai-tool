/* 服务商预设。
   模型名核对时间：2026-11
   protocol: 'openai' 走 /chat/completions（绝大多数服务商）
             'anthropic' 走 /messages（Claude 自有格式）
   reasoning: 'deepseek' | 'openai' | 'anthropic' | 'zhipu' | 省略 = 不认强度参数
   vision: 是否支持图片输入
   browserBlocked: 服务商不返回 CORS 头，纯网页直连会被浏览器拦下，
                   打包成 App（原生 HTTP）后才能用。 */

const PROVIDERS = [
  {
    id: 'deepseek', name: 'DeepSeek', protocol: 'openai', reasoning: 'deepseek', vision: true,
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    keyUrl: 'https://platform.deepseek.com/api_keys',
    note: '国内直连。deepseek-flash 已是 V4.1-Flash-1017，原生支持看图。'
  },
  {
    id: 'moonshot', name: 'Kimi 月之暗面', protocol: 'openai', vision: true,
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed', 'kimi-k3'],
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    note: '国内直连。K3.1 Pro 是 3 万亿参数旗舰，1M 上下文，原生支持视觉。'
  },
  {
    id: 'dashscope', name: '通义千问（阿里云百炼）', protocol: 'openai', vision: true,
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen3.8-max', 'qwen3.7-plus', 'qwen3.8-flash'],
    keyUrl: 'https://bailian.console.aliyun.com/',
    note: '国内直连。百炼的 Key 通用，同一平台也能调 deepseek、kimi、GLM。'
  },
  {
    id: 'ark', name: '豆包（火山方舟）', protocol: 'openai', vision: true,
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: ['doubao-seed-evolving'],
    keyUrl: 'https://console.volcengine.com/ark',
    note: '国内直连。方舟统一用 doubao-seed-evolving 这个 ID 自动跟进最新版本，不用自己追版本号。'
  },
  {
    id: 'zhipu', name: '智谱 GLM', protocol: 'openai', reasoning: 'zhipu',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-5.3', 'glm-5.3-flash', 'glm-5v-turbo'],
    keyUrl: 'https://bigmodel.cn/usercenter/apikeys',
    note: '国内直连。GLM-5.3 始终开思考，强度只能选低/高/无限制，关不掉。',
    browserBlocked: true
  },
  {
    id: 'siliconflow', name: '硅基流动', protocol: 'openai', vision: true,
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['deepseek-ai/DeepSeek-V4.1-Flash', 'zai-org/GLM-5.3-Flash', 'Qwen/Qwen3.8-Max'],
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    note: '国内直连，聚合上百个模型，一个 Key 通用。'
  },
  {
    id: 'openrouter', name: 'OpenRouter', protocol: 'openai', reasoning: 'openai', vision: true,
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['deepseek/deepseek-v4-pro', 'anthropic/claude-opus-5-5', 'openai/gpt-6.1-sol'],
    keyUrl: 'https://openrouter.ai/keys',
    note: '聚合平台，一个 Key 调几百个模型。点「拉取列表」能拿到全部真实 slug。大陆通常需要代理。'
  },
  {
    id: 'openai', name: 'OpenAI', protocol: 'openai', reasoning: 'openai', vision: true,
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-6-astra'],
    keyUrl: 'https://platform.openai.com/api-keys',
    note: 'astra 最强最贵，sol 接近顶配但便宜，terra 快，luna 最省。大陆通常需要代理。'
  },
  {
    id: 'anthropic', name: 'Claude（Anthropic）', protocol: 'anthropic', reasoning: 'anthropic', vision: true,
    baseUrl: 'https://api.anthropic.com/v1',
    models: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'],
    keyUrl: 'https://console.anthropic.com/settings/keys',
    note: '自有协议，已单独适配。fable 用于最难的长程推理，opus 日常最强，haiku 最便宜。'
  },
  {
    id: 'gemini', name: 'Gemini（Google）', protocol: 'openai', reasoning: 'openai', vision: true,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'],
    keyUrl: 'https://aistudio.google.com/apikey',
    note: '走 Google 的 OpenAI 兼容端点。argon 是旗舰，1M 上下文。大陆通常需要代理。'
  },
  {
    id: 'groq', name: 'Groq', protocol: 'openai', reasoning: 'openai', vision: true,
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.3-70b-versatile'],
    keyUrl: 'https://console.groq.com/keys',
    note: '出字极快。主力是开源的 gpt-oss 系列。大陆通常需要代理。'
  },
  {
    id: 'xai', name: 'Grok（xAI）', protocol: 'openai', reasoning: 'openai', vision: true,
    baseUrl: 'https://api.x.ai/v1',
    models: ['grok-4.7', 'grok-4.7-latest'],
    keyUrl: 'https://console.x.ai/',
    note: 'grok-4.7 是当前旗舰，500K 上下文。大陆通常需要代理。'
  },
  {
    id: 'custom', name: '自定义（任意 OpenAI 兼容）', protocol: 'openai',
    baseUrl: '',
    models: [],
    keyUrl: '',
    note: '填入完整的 Base URL，例如 http://192.168.1.10:11434/v1（本地 Ollama）。'
  }
];

function getProvider(id) {
  return PROVIDERS.find(p => p.id === id) || PROVIDERS[0];
}
