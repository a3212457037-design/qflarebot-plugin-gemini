import type { JsonSchema } from '@qqbot/sdk'

export interface Config {
  apiKey: string
  maxInputChars: number
  maxReplyChars: number
  maxOutputTokens: number
  timeoutMs: number
  ignoredCommandPrefixes: string[]
  enableGoogleSearch: boolean
}

export const MODEL = 'gemini-3.5-flash-lite'
export const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`
export const defaultConfig: Config = {
  apiKey: '',
  maxInputChars: 500,
  maxReplyChars: 400,
  maxOutputTokens: 512,
  timeoutMs: 15000,
  ignoredCommandPrefixes: ['/'],
  enableGoogleSearch: false,
}

const ranges = {
  maxInputChars: [1, 1000],
  maxReplyChars: [50, 500],
  maxOutputTokens: [64, 1024],
  timeoutMs: [1000, 15000],
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
    maxReplyChars: integer('maxReplyChars', '回复字符上限'),
    maxOutputTokens: integer('maxOutputTokens', '生成 Token 上限'),
    timeoutMs: integer('timeoutMs', 'API 超时（毫秒，最多 15000）'),
    ignoredCommandPrefixes: {
      type: 'array', title: '跳过的命令前缀', default: ['/'], maxItems: 16,
      items: { type: 'string', minLength: 1, maxLength: 32 },
      description: '普通聊天不会处理这些前缀开头的消息。默认无需更改；若机器人使用自定义命令前缀，请同步填写。SDK 不提供全局前缀读取接口。/ 始终跳过。',
    },
    enableGoogleSearch: {
      type: 'boolean', title: '启用 Google Search 联网搜索', default: false,
      description: '默认关闭。启用后由 Gemini 决定是否搜索，最多附加 2 个来源。此模型的免费 API 层不提供搜索，可能需要项目权限并产生费用；插件不会修改计费设置。',
    },
  },
  required: ['apiKey', ...Object.keys(ranges)],
}

// 同时校验运行时配置，避免旧快照或绕过面板保存的异常值放宽上限。
export function readConfig(value: Config): Config | null {
  if (!value || typeof value !== 'object') return null
  const config = { ...defaultConfig, ...value }
  if (typeof config.enableGoogleSearch !== 'boolean') return null
  if (typeof config.apiKey !== 'string' || config.apiKey.length > 4096) return null
  config.apiKey = config.apiKey.trim()
  if (/[\u0000-\u0020\u007f-\u009f]/u.test(config.apiKey)) return null
  if (!Array.isArray(config.ignoredCommandPrefixes) || config.ignoredCommandPrefixes.length > 16
    || config.ignoredCommandPrefixes.some((prefix) => typeof prefix !== 'string' || !prefix.length || prefix.length > 32)) return null
  for (const key of Object.keys(ranges) as Array<keyof typeof ranges>) {
    const v = config[key]
    if (!Number.isSafeInteger(v) || v < ranges[key][0] || v > ranges[key][1]) return null
  }
  return config
}
