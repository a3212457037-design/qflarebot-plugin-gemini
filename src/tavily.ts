import type { ScopedKV } from '@qqbot/sdk'
import type { Config } from './config.js'
import { readJson } from './gemini.js'
import { hideKey, sourceUrl } from './grounding.js'

export const TAVILY_ENDPOINT = 'https://api.tavily.com/search'
export const SEARCH_INTERVAL_MS = 30000
export const SEARCH_DAILY_LIMIT = 30
export const SEARCH_MONTHLY_LIMIT = 900
export const SEARCH_USAGE_KEY = 'tavily:usage'
export interface SearchResult { title: string; url: string; content: string }

export const searchTips = {
  disabled: '联网搜索未开启，请联系机器人管理员。',
  key: '联网搜索尚未配置，请联系机器人管理员。',
  rate: '搜索太频繁，请稍后再试。',
  budget: '搜索用量保护已触发，请稍后或下个周期再试。',
  storage: '搜索用量暂时无法确认，请稍后再试。',
  auth: '搜索密钥或访问权限异常，请联系机器人管理员。',
  quota: '搜索额度不足，请联系机器人管理员。',
  timeout: '联网搜索超时，请稍后再试。',
  network: '暂时无法连接搜索服务，请稍后再试。',
  response: '联网搜索未返回有效资料，请换个关键词再试。',
  service: '联网搜索暂时不可用，请稍后再试。',
}
export class TavilyError extends Error {
  constructor(readonly code: keyof typeof searchTips) {
    super(searchTips[code])
    this.name = 'TavilyError'
  }
}

// 无第二次模型判定。规则只看当前问题，可能漏判；/search 可强制检索。
export function needsSearch(question: string): boolean {
  if (/(?:不要|无需|不必|不用|禁止|不)(?:联网|上网|搜索|检索)/u.test(question)) return false
  return /新闻|最新|实时|时事|近况|动态|刚刚|今天|今日|昨天|昨日|这几天|本周|这周|最近.{0,16}(?:消息|情况|发生|进展|怎么样)|(?:现在|目前|当前).{0,16}(?:价格|股价|汇率|天气|比分|排名|消息|情况)|(?:查一下|查查|查询|查找|检索|搜索|搜一下|搜搜|搜一搜|(?:帮我|给我|替我)搜|联网|上网|网上查)|\b(?:latest|news|today|current|real[ -]?time|search|look\s+up)\b/iu.test(question)
}

// 尝试发送前预留一次，失败也计数；KV 最终一致，不能声称是账户费用的绝对上限。
export async function reserveSearch(kv: ScopedKV, now = Date.now()): Promise<void> {
  const day = new Date(now).toISOString().slice(0, 10)
  const month = day.slice(0, 7)
  let monthly = 0
  let daily = 0
  try {
    const raw = await kv.get(SEARCH_USAGE_KEY)
    if (raw !== null) {
      if (raw.length > 1024) throw new Error()
      const value = JSON.parse(raw)
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || !/^\d{4}-\d{2}$/.test(value.month) || !/^\d{4}-\d{2}-\d{2}$/.test(value.day)
        || !Number.isSafeInteger(value.monthly) || value.monthly < 0
        || !Number.isSafeInteger(value.daily) || value.daily < 0 || value.daily > value.monthly
        || value.day.slice(0, 7) !== value.month || value.month > month || value.day > day) throw new Error()
      monthly = value.month === month ? value.monthly : 0
      daily = value.day === day ? value.daily : 0
    }
    if (daily >= SEARCH_DAILY_LIMIT || monthly >= SEARCH_MONTHLY_LIMIT) throw new TavilyError('budget')
    await kv.put(SEARCH_USAGE_KEY, { month, day, monthly: monthly + 1, daily: daily + 1 }, { ttl: 32 * 86400 })
  } catch (error) {
    if (error instanceof TavilyError) throw error
    // 不记录 KV 原文或异常，不在无法确认计数时放行请求。
    throw new TavilyError('storage')
  }
}

export async function searchTavily(question: string, config: Config, fetcher: typeof fetch = fetch): Promise<SearchResult[]> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new TavilyError('timeout')) }, Math.min(config.timeoutMs, 8000))
  })
  const request = async (): Promise<SearchResult[]> => {
    const response = await fetcher(TAVILY_ENDPOINT, {
      method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.tavilyApiKey}` },
      body: JSON.stringify({ query: hideKey(question, config.apiKey, config.tavilyApiKey), search_depth: 'basic', max_results: 3,
        topic: 'general', auto_parameters: false, include_answer: false, include_raw_content: false, include_images: false }),
    })
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      if (response.status === 401 || response.status === 403) throw new TavilyError('auth')
      if ([402, 432, 433].includes(response.status)) throw new TavilyError('quota')
      if (response.status === 429) throw new TavilyError('rate')
      if ([408, 504].includes(response.status)) throw new TavilyError('timeout')
      throw new TavilyError('service')
    }
    let value: unknown
    try { value = await readJson(response) } catch { throw new TavilyError('response') }
    const items = value && typeof value === 'object' && 'results' in value ? value.results : null
    if (!Array.isArray(items)) throw new TavilyError('response')
    const results: SearchResult[] = []
    const seen = new Set<string>()
    const clean = (text: string, size: number) => Array.from(hideKey(text, config.apiKey, config.tavilyApiKey)
      .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').replace(/\s+/gu, ' ').trim()).slice(0, size).join('')
    for (const item of items.slice(0, 3)) {
      if (!item || typeof item !== 'object') continue
      const url = sourceUrl(item.url, [config.apiKey, config.tavilyApiKey])
      if (!url || url.length > 500 || seen.has(url) || typeof item.content !== 'string') continue
      const content = clean(item.content, 1000)
      if (!content) continue
      results.push({ url, title: clean(typeof item.title === 'string' ? item.title : new URL(url).hostname, 120), content })
      seen.add(url)
    }
    if (!results.length) throw new TavilyError('response')
    return results
  }
  try {
    return await Promise.race([request(), timeout])
  } catch (error) {
    if (controller.signal.aborted) throw new TavilyError('timeout')
    if (error instanceof TavilyError) throw error
    // 网络异常仅返回固定分类，禁止把可能含 Authorization 的 message 写入日志。
    throw new TavilyError('network')
  } finally { if (timer !== undefined) clearTimeout(timer) }
}
