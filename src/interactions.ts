import type { Config } from './config.js'
import { isModelId } from './models.js'
import type { ChatMessage } from './history.js'
import type { SearchResult } from './tavily.js'
import { hideKey } from './grounding.js'
import { apiError, formatAnswer, GEMINI_RESPONSE_BYTES, GeminiError, readJson, safeDiagnostic, systemInstruction } from './gemini.js'

// Google 官方 REST / OpenAPI，固定主机、版本；不接受任意 URL、agent 或工具。
export const INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions'
export const API_REVISION = '2026-05-20'
export const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export const validInteractionId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,1024}$/u.test(id)

export function interactionFailure(result: Record<string, unknown>): string {
  const error = object(result.error)
  const statuses: Record<string, number> = { UNAUTHENTICATED: 401, PERMISSION_DENIED: 403, NOT_FOUND: 404, RESOURCE_EXHAUSTED: 429, DEADLINE_EXCEEDED: 504, UNAVAILABLE: 503, INTERNAL: 500, INVALID_ARGUMENT: 400 }
  const reason = String(error.status ?? error.code ?? '').toUpperCase()
  const status = statuses[reason] ?? (typeof error.code === 'number' && error.code >= 400 && error.code < 600 ? error.code : 400)
  // 只返回既有固定错误分类，不回显模型/项目的 error.message/details。
  return apiError(status, { error }).code
}

export async function googleJson(url: string, method: 'GET' | 'POST', config: Config, fetcher: typeof fetch, body?: unknown): Promise<Record<string, unknown>> {
  if (!url.startsWith(INTERACTIONS_URL) && url !== 'https://generativelanguage.googleapis.com/v1/webhooks') throw new GeminiError('request')
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (async () => {
        const response = await fetcher(url, { method, redirect: 'manual', signal: controller.signal,
          headers: { 'content-type': 'application/json', 'x-goog-api-key': config.apiKey, 'Api-Revision': API_REVISION },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        if (response.status >= 300 && response.status < 400) {
          void response.body?.cancel().catch(() => {})
          throw new GeminiError('request')
        }
        let json: unknown
        try { json = await readJson(response, GEMINI_RESPONSE_BYTES) }
        catch (error) { if (!response.ok) throw apiError(response.status, null); throw error }
        if (!response.ok || (object(json).error && !object(json).id)) {
          const error = apiError(response.ok ? 400 : response.status, json)
          throw new GeminiError(error.code, undefined, error.api ?? { status: response.status, reason: 'HTTP_ERROR' })
        }
        return object(json)
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new GeminiError('timeout')) }, Math.min(config.timeoutMs, 8000)) }),
    ])
  } catch (error) {
    if (error instanceof GeminiError) throw error
    throw new GeminiError('network', safeDiagnostic(error, config.apiKey, config.tavilyApiKey))
  } finally { if (timer !== undefined) clearTimeout(timer) }
}

export function interactionBody(question: string, config: Config, history: ChatMessage[], search?: SearchResult[]) {
  if (!isModelId(config.model)) throw new GeminiError('model')
  const clean = (text: string) => hideKey(text, config.apiKey, config.tavilyApiKey)
  return {
    model: config.model, background: true, store: true,
    // 使用本地六轮文本历史显式重建 Step；不使用无限累加的 previous_interaction_id。
    input: [...history.slice(-12).map((m) => ({ type: m.role === 'user' ? 'user_input' : 'model_output', content: [{ type: 'text', text: clean(m.parts[0].text) }] })),
      { type: 'user_input', content: [{ type: 'text', text: clean(question) }, ...(search ? [{ type: 'text', text: clean(JSON.stringify({ untrustedSearchResults: search })) }] : [])] }],
    system_instruction: systemInstruction(!!search, config.enableTavilySearch && !!config.tavilyApiKey),
    generation_config: { max_output_tokens: config.maxOutputTokens, thinking_level: 'high', thinking_summaries: 'none' },
  }
}

export async function createInteraction(question: string, config: Config, fetcher: typeof fetch, history: ChatMessage[] = [], search?: SearchResult[]) {
  const result = await googleJson(INTERACTIONS_URL, 'POST', config, fetcher, interactionBody(question, config, history, search))
  if (!validInteractionId(result.id)) throw new GeminiError('response')
  return result as Record<string, unknown> & { id: string }
}

export async function getInteraction(id: string, config: Config, fetcher: typeof fetch) {
  if (!validInteractionId(id)) throw new GeminiError('response')
  const result = await googleJson(`${INTERACTIONS_URL}/${id}`, 'GET', config, fetcher)
  if (result.id !== id) throw new GeminiError('response')
  return result
}

export function interactionAnswer(result: Record<string, unknown>, config: Config, search?: SearchResult[]): string {
  if (!['completed', 'incomplete'].includes(String(result.status))) throw new GeminiError('response')
  // thought / user_input / tool steps、签名、错误原文一律不发送。
  const steps = Array.isArray(result.steps) ? result.steps : []
  // GET 会包含显式输入的历史 model_output/user_input。只取最后一次用户输入之后
  // 的新输出；只返回生成步骤的响应没有 user_input，此时保留全部生成输出。
  let lastInput = -1
  for (let i = steps.length - 1; i >= 0; i--) if (object(steps[i]).type === 'user_input') { lastInput = i; break }
  const text = steps.slice(lastInput + 1).flatMap((step) => {
    const s = object(step)
    return s.type === 'model_output' && Array.isArray(s.content) ? s.content.flatMap((part) => {
      const p = object(part)
      return p.type === 'text' && typeof p.text === 'string' ? [p.text] : []
    }) : []
  }).join('')
  return formatAnswer(text, config, search, result.status === 'incomplete')
}

export async function keyFingerprint(key: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))), (n) => n.toString(16).padStart(2, '0')).join('')
}

export async function verifyCallback(request: Request, secret: string, now = Date.now()): Promise<Record<string, unknown> | null> {
  const id = request.headers.get('webhook-id') ?? ''
  const timestamp = request.headers.get('webhook-timestamp') ?? ''
  const signatures = request.headers.get('webhook-signature') ?? ''
  if (!id || id.length > 256 || !/^\d{10}$/u.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300 || signatures.length > 2048) return null
  // 限制整个流，不能只信 Content-Length；复用受限 JSON 读取但保留签名原始字节。
  const reader = request.body?.getReader()
  if (!reader) return null
  let raw = ''; let bytes = 0
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  try {
    for (;;) {
      const item = await reader.read(); if (item.done) break
      bytes += item.value.byteLength
      if (bytes > 16384) { await reader.cancel(); return null }
      raw += decoder.decode(item.value, { stream: true })
    }
    raw += decoder.decode()
    const key = await crypto.subtle.importKey('raw', Uint8Array.from(atob(secret.replace(/^whsec_/u, '')), (c) => c.charCodeAt(0)), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
    for (const signature of signatures.split(/\s+/u)) {
      if (!signature.startsWith('v1,')) continue
      const sig = Uint8Array.from(atob(signature.slice(3)), (c) => c.charCodeAt(0))
      if (await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(`${id}.${timestamp}.${raw}`))) return object(JSON.parse(raw))
    }
  } catch { /* 固定错误响应，不输出 secret、签名或回调正文 */ }
  finally { reader.releaseLock() }
  return null
}
