import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockContext, createMockSession } from '@qqbot/sdk/testing'
import { normalizePlugin } from '@qqbot/sdk'
import { defaultConfig, ENDPOINT, readConfig, type Config } from './config.js'
import { askGemini, limitReply, tips } from './gemini.js'
import { message } from './history.js'
import { createGeminiPlugin } from './index.js'

const config = { ...defaultConfig, apiKey: 'local-search-test-credential' }
const source = (uri: unknown, title: unknown = '来源标题') => ({ web: { uri, title } })
function response(chunks?: unknown, text = '最新消息已确认。', extra = {}) {
  return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] },
    groundingMetadata: { groundingChunks: chunks, webSearchQueries: ['不应输出的查询'], searchEntryPoint: { renderedContent: '<html>内部内容</html>' }, ...extra },
  }] })
}
afterEach(() => vi.useRealTimers())

describe('Google Search 原生工具与来源', () => {
  it('默认关闭且旧配置缺字段时正常调用，不发送 tools，不改变普通回复', async () => {
    const { enableGoogleSearch: _enabled, ...oldConfig } = config
    const normalized = readConfig(oldConfig as Config)!
    expect(normalized.enableGoogleSearch).toBe(false)
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response([source('https://a.test/')]))
    expect(await askGemini('问题', normalized, fetcher)).toBe('最新消息已确认。')
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).not.toHaveProperty('tools')
  })

  it('开启后仅增加 google_search 工具，保留历史、固定端点、manual 和生成设置', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response())
    const history = [message('user', '上轮问题'), message('model', '上轮回答')]
    await askGemini('新问题', { ...config, enableGoogleSearch: true }, fetcher, history)
    expect(fetcher).toHaveBeenCalledWith(ENDPOINT, expect.objectContaining({ redirect: 'manual', headers: {
      'content-type': 'application/json', 'x-goog-api-key': config.apiKey,
    } }))
    const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string)
    expect(body.tools).toEqual([{ google_search: {} }])
    expect(body.contents).toEqual([...history, message('user', '新问题')])
    expect(body.generationConfig).toEqual({ maxOutputTokens: config.maxOutputTokens })
    expect(body.systemInstruction.parts[0].text).toContain('上分难')
    expect(JSON.stringify(body)).not.toContain(config.apiKey)
  })

  it('解析真实来源，去重后最多展示两项，不发送内部元数据', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response([
      source('https://a.test/page#one', '来源一'), source('https://a.test/page#two', '重复'),
      source('http://b.test/', '来源二'), source('https://c.test/', '第三条'),
    ]))
    const reply = await askGemini('问题', { ...config, enableGoogleSearch: true }, fetcher)
    expect(reply).toBe('最新消息已确认。\n来源：\n来源一 https://a.test/page\n来源二 http://b.test/')
    for (const privateText of ['第三条', '不应输出的查询', '内部内容', 'groundingMetadata']) expect(reply).not.toContain(privateText)
  })

  it.each([undefined, [], null, {}, 1, 'invalid'])('没有有效来源 %j 时不编造引用', async (chunks) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(chunks))
    expect(await askGemini('问题', { ...config, enableGoogleSearch: true }, fetcher)).toBe('最新消息已确认。')
  })

  it('过滤非 HTTP(S)、相对地址、坏 URL、凭据和缺失链接', async () => {
    const chunks = [undefined, 1, '/relative', 'not-url', 'javascript:alert(1)', 'ftp://a.test/', 'file:///a',
      'https://user:password@a.test/', 'https://a.test/\nprivate'].map((uri) => source(uri))
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response([...chunks, { retrievedContext: { uri: 'https://a.test/' } }]))
    expect(await askGemini('问题', { ...config, enableGoogleSearch: true }, fetcher)).toBe('最新消息已确认。')
  })

  it('标题包含 Key 时脱敏，链接包含明文或编码 Key 时丢弃', async () => {
    const key = 'local/test+search-key?'
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response([
      source(`https://a.test/?key=${key}`), source(`https://b.test/?key=${encodeURIComponent(key)}`),
      source('https://c.test/', `来源 ${key}`),
    ], `回答 ${key} ${encodeURIComponent(key)}`))
    const reply = await askGemini('问题', { ...config, apiKey: key, enableGoogleSearch: true }, fetcher)
    expect(reply).not.toContain(key)
    expect(reply).not.toContain(encodeURIComponent(key))
    expect(reply).not.toContain('https://a.test')
    expect(reply).not.toContain('https://b.test')
    expect(reply).toContain('https://c.test/')
    expect(reply).toContain('[密钥已隐藏]')
  })

  it.each(['短回答', '中'.repeat(490), '😀'.repeat(500)])('来源与正文共用字符/字节上限且正文优先：%s', async (text) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response([
      source('https://a.test/', '😀'.repeat(100)), source('https://b.test/', '标题很长'.repeat(100)),
      source('https://long.test/' + 'x'.repeat(600)),
    ], text))
    const reply = await askGemini('问题', { ...config, enableGoogleSearch: true, maxReplyChars: 500 }, fetcher)
    expect(reply.startsWith(limitReply(text, 500))).toBe(true)
    expect(Array.from(reply).length).toBeLessThanOrEqual(500)
    expect(new TextEncoder().encode(reply).length).toBeLessThanOrEqual(1500)
    expect(reply).not.toContain('\ufffd')
    expect(reply).not.toContain('https://long.test/')
  })

  it('空间不足时省略来源，绝不输出截断 URL 或仅有来源标签', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response([source('https://a.test/long-path')], 'x'.repeat(49)))
    expect(await askGemini('问题', { ...config, enableGoogleSearch: true, maxReplyChars: 50 }, fetcher)).toBe('x'.repeat(49))
  })

  it.each([[400, tips.request], [403, tips.auth], [429, tips.rate], [503, tips.unavailable]] as const)('搜索开启时 HTTP %s 保持原中文提示', async (status, tip) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { message: config.apiKey } }, { status }))
    await expect(askGemini('问题', { ...config, enableGoogleSearch: true }, fetcher)).rejects.toMatchObject({ message: tip })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('搜索开启时错误和诊断依然只给固定中文提示与脱敏日志', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError(`fetch failed ${config.apiKey}`))
    const plugin = createGeminiPlugin(fetcher)
    const ctx = createMockContext(plugin, { config: { ...config, enableGoogleSearch: true } })
    const warn = vi.spyOn(ctx.logger, 'warn')
    expect(await normalizePlugin(plugin).commands[0]!.handler({ session: createMockSession(), ctx, command: 'ai', args: ['问题'], argText: '问题' })).toBe(tips.network)
    expect(JSON.stringify(warn.mock.calls)).not.toContain(config.apiKey)
    expect(warn).toHaveBeenCalledWith('Gemini 请求未完成', { code: 'network', error: { name: 'TypeError', message: 'fetch failed [REDACTED]' } })
  })

  it('搜索开启时超时和坏 JSON 仍按原错误路径处理', async () => {
    const broken = vi.fn<typeof fetch>().mockResolvedValue(new Response('{bad-json'))
    await expect(askGemini('问题', { ...config, enableGoogleSearch: true }, broken)).rejects.toMatchObject({ code: 'response' })
    vi.useFakeTimers()
    const pending = askGemini('问题', { ...config, enableGoogleSearch: true }, vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {})))
    const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(config.timeoutMs)
    await assertion
  })
})
