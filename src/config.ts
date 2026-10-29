import type { JsonSchema } from '@qqbot/sdk'

export interface Config {
  apiKey: string
  maxInputChars: number
  /** 兼容旧快照，已停用，不再裁剪回复。 */
  maxReplyChars?: number
  maxOutputTokens: number
  timeoutMs: number
  ignoredCommandPrefixes: string[]
  enableGoogleSearch: boolean
  enableTavilySearch: boolean
  tavilyApiKey: string
}

export const MODEL = 'gemini-3.5-flash-lite'
export const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`
export const defaultConfig: Config = {
  apiKey: '',
  maxInputChars: 500,
  maxOutputTokens: 65536,
  timeoutMs: 24000,
  ignoredCommandPrefixes: ['/'],
  enableGoogleSearch: false,
  enableTavilySearch: false,
  tavilyApiKey: '',
}

const ranges = {
  maxInputChars: [1, 1000],
  maxOutputTokens: [64, 65536],
  timeoutMs: [1000, 24000],
} as const

const integer = (key: keyof typeof ranges, title: string) => ({
  type: 'integer', title, default: defaultConfig[key],
  minimum: ranges[key][0], maximum: ranges[key][1],
})

export const configSchema: JsonSchema = {
  type: 'object',
  properties: {
    apiKey: {
      type: 'string', title: 'Gemini API Key', writeOnly: true, maxLength: 4096,
      description: '在 [Google AI Studio](https://aistudio.google.com/api-keys) 创建。仅在此设置，不要发送到 QQ。保存后不回显。',
      default: '',
    },
    maxInputChars: integer('maxInputChars', '问题字符上限'),
    maxOutputTokens: {
      ...integer('maxOutputTokens', '生成 Token 上限'),
      description: '默认使用模型官方上限 65536，只是允许的最大输出量；闲聊仍简洁，详细问题再展开。',
    },
    timeoutMs: {
      ...integer('timeoutMs', 'API 超时（毫秒，最多 24000）'),
      description: '搜索与模型调用合计最多 24 秒，为现有 Worker 的 30 秒后台执行窗口保留发送时间；不能靠提高 Token 上限延长平台执行时间。',
    },
    ignoredCommandPrefixes: {
      type: 'array', title: '跳过的命令前缀', default: ['/'], maxItems: 16,
      items: { type: 'string', minLength: 1, maxLength: 32 },
      description: '普通聊天不会处理这些前缀开头的消息。默认无需更改；若机器人使用自定义命令前缀，请同步填写。SDK 不提供全局前缀读取接口。/ 始终跳过。',
    },
    enableTavilySearch: {
      type: 'boolean', title: '启用 Tavily 联网搜索', default: false,
      description: '默认关闭。开启后时效性问题自动搜索，也可用 /search；仅 basic、最多 3 条结果。Google 原生搜索已停用。',
    },
    tavilyApiKey: {
      type: 'string', title: 'Tavily API Key', writeOnly: true, maxLength: 4096, default: '',
      description: '仅在面板填写，保存后不回显。不会开通付费服务；请在 Tavily 保持 Pay as you go 关闭。',
    },
  },
  required: ['apiKey', ...Object.keys(ranges)],
}

// 同时校验运行时配置，避免旧快照或绕过面板保存的异常值放宽上限。
export function readConfig(value: Config): Config | null {
  if (!value || typeof value !== 'object') return null
  const config = { ...defaultConfig, ...value }
  delete config.maxReplyChars
  // 保留旧字段的兼容性，但旧配置即使为 true 也不再发送 Google tools。
  config.enableGoogleSearch = false
  if (typeof config.enableTavilySearch !== 'boolean') return null
  for (const key of ['apiKey', 'tavilyApiKey'] as const) {
    if (typeof config[key] !== 'string' || config[key].length > 4096) return null
    config[key] = config[key].trim()
    if (/[\u0000-\u0020\u007f-\u009f]/u.test(config[key])) return null
  }
  if (!Array.isArray(config.ignoredCommandPrefixes) || config.ignoredCommandPrefixes.length > 16
    || config.ignoredCommandPrefixes.some((prefix) => typeof prefix !== 'string' || !prefix.length || prefix.length > 32)) return null
  for (const key of Object.keys(ranges) as Array<keyof typeof ranges>) {
    const v = config[key]
    if (!Number.isSafeInteger(v) || v < ranges[key][0] || v > ranges[key][1]) return null
  }
  return config
}
