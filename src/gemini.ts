// Gemini 请求和文本 part 解析改编自 clown145/qflarebot-plugin-llm（MIT）。
// 来源、提交和完整许可见 THIRD_PARTY_NOTICES.md、licenses/。
import { ENDPOINT, type Config } from './config.js'

export type ErrorCode = 'timeout' | 'rate' | 'quota' | 'auth' | 'model' | 'request' | 'unavailable' | 'network' | 'response' | 'blocked'

export const tips: Record<ErrorCode, string> = {
  timeout: 'AI 响应超时，请稍后再试。',
  rate: '请求过于频繁或额度已用完，请稍后再试。',
  quota: 'AI 额度不足，请联系机器人管理员。',
  auth: 'AI 密钥或访问权限异常，请联系机器人管理员。',
  model: 'AI 模型暂不可用，请联系机器人管理员。',
  request: 'AI 请求配置异常，请联系机器人管理员。',
  unavailable: 'AI 服务暂时繁忙，请稍后再试。',
  network: '暂时无法连接 AI，请稍后再试。',
  response: 'AI 暂未返回有效回答，请稍后再试。',
  blocked: '这个问题暂时无法回答，请换个说法。',
}

export class GeminiError extends Error {
  constructor(readonly code: ErrorCode, readonly diagnostic?: { name: string; message: string }) {
    // message 保持用户提示；只允许携带脱敏后的诊断，不保留原始异常或 cause。
    super(tips[code])
    this.name = 'GeminiError'
  }
}

function safeDiagnostic(error: unknown, apiKey: string): { name: string; message: string } {
  // 不序列化异常对象，避免附带的 headers / body / response / stack / cause 进入日志。
  if (!(error instanceof Error)) return { name: 'UnknownError', message: 'Non-Error exception' }
  const clean = (value: string, limit: number): string => {
    let text = value
    // 必须先脱敏再截断，防止截断后的半截 Key 泄露；也覆盖 URL 编码形式。
    for (const secret of new Set([apiKey, encodeURIComponent(apiKey)])) {
      if (secret) text = text.split(secret).join('[REDACTED]')
    }
    text = text.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').replace(/\s+/gu, ' ').trim()
    return Array.from(text).slice(0, limit).join('')
  }
  return { name: clean(error.name, 64), message: clean(error.message, 200) }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function apiError(status: number, json: unknown): GeminiError {
  const error = record(record(json).error)
  // 仅用于分类，不输出或记录这些字段。QuotaFailure 可区分每日额度与每分钟限流。
  const detail = JSON.stringify([error.status, error.message, error.details]).toLowerCase()
  if (status === 401 || status === 403 || detail.includes('api_key_invalid') || detail.includes('api key not valid')) return new GeminiError('auth')
  if (status === 402) return new GeminiError('quota')
  if (status === 429) {
    return new GeminiError(/per.?day|daily|insufficient|billing|credit|quota_value[^0-9]*0\b/.test(detail) ? 'quota' : 'rate')
  }
  if (status === 408 || status === 504) return new GeminiError('timeout')
  if (status === 404) return new GeminiError('model')
  if (status >= 500) return new GeminiError('unavailable')
  return new GeminiError('request')
}

// 控制 JSON 解析的内存/CPU；这不是 SSE 流式输出，QQ 只收一条最终文本。
async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new GeminiError('response')
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 65536) {
        await reader.cancel()
        throw new GeminiError('response')
      }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
    return JSON.parse(text) as unknown
  } catch (error) {
    if (error instanceof GeminiError) throw error
    throw new GeminiError('response')
  } finally {
    reader.releaseLock()
  }
}

const INCOMPLETE = '\n（回答已截短）'

export function limitReply(text: string, maxChars: number, incomplete = false): string {
  const clean = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').trim()
  const chars = Array.from(clean)
  const encoder = new TextEncoder()
  if (!incomplete && chars.length <= maxChars && encoder.encode(clean).length <= 1500) return clean
  let result = ''
  let bytes = encoder.encode(INCOMPLETE).length
  for (const ch of chars.slice(0, maxChars - Array.from(INCOMPLETE).length)) {
    const size = encoder.encode(ch).length
    if (bytes + size > 1500) break
    result += ch
    bytes += size
  }
  return result.trimEnd() + INCOMPLETE
}

export async function askGemini(question: string, config: Config, fetcher: typeof fetch = fetch): Promise<string> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new GeminiError('timeout'))
    }, config.timeoutMs)
  })
  const request = async (): Promise<string> => {
    const response = await fetcher(ENDPOINT, {
      method: 'POST',
      redirect: 'manual', // Workers 支持 manual；Key 只发往固定的 Google HTTPS 地址。
      headers: { 'content-type': 'application/json', 'x-goog-api-key': config.apiKey },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: question }] }],
        systemInstruction: { parts: [{ text: `你是 QQ 机器人“上分难”的文字问答助手。用简短中文和纯文本回答，尽量不超过 ${config.maxReplyChars} 字符。` }] },
        generationConfig: { maxOutputTokens: config.maxOutputTokens },
      }),
    })
    if (response.status >= 300 && response.status < 400) {
      // 不读取 Location 或响应正文，也不重发请求，避免把 Key 带到重定向目标。
      void response.body?.cancel().catch(() => {})
      throw new GeminiError('request')
    }
    let json: unknown
    try {
      json = await readJson(response)
    } catch (error) {
      if (!response.ok) throw apiError(response.status, null)
      throw error
    }
    const root = record(json)
    if (!response.ok || root.error) throw apiError(response.ok ? Number(record(root.error).code) || 400 : response.status, json)
    if (record(root.promptFeedback).blockReason) throw new GeminiError('blocked')
    const candidate = record(Array.isArray(root.candidates) ? root.candidates[0] : undefined)
    const reason = candidate.finishReason
    if (['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY'].includes(String(reason))) throw new GeminiError('blocked')
    if (reason && reason !== 'STOP' && reason !== 'MAX_TOKENS') throw new GeminiError('response')
    const parts = record(candidate.content).parts
    const text = (Array.isArray(parts) ? parts : []).map((part: unknown) => {
      const p = record(part)
      return p.thought !== true && typeof p.text === 'string' ? p.text : ''
    }).join('')
    const safeText = text.split(config.apiKey).join('[密钥已隐藏]')
    if (!safeText.trim()) throw new GeminiError('response')
    const reply = limitReply(safeText, config.maxReplyChars, reason === 'MAX_TOKENS')
    if (!reply.trim()) throw new GeminiError('response')
    return reply
  }
  try {
    return await Promise.race([request(), timeout])
  } catch (error) {
    if (controller.signal.aborted) throw new GeminiError('timeout')
    if (error instanceof GeminiError) throw error
    throw new GeminiError('network', safeDiagnostic(error, config.apiKey))
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
