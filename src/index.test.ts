import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockContext, createMockSession, runCommand } from '@qqbot/sdk/testing'
import { normalizePlugin } from '@qqbot/sdk'
import { createGeminiPlugin } from './index.js'
import { defaultConfig, ENDPOINT, MODEL } from './config.js'
import { tips } from './gemini.js'

// 此字符串只是本地测试替身，不是 API Key；测试不发网络请求。
const config = { ...defaultConfig, apiKey: 'local-test-credential' }
const answer = (text = '你好，我是上分难。', finishReason = 'STOP') => new Response(JSON.stringify({
  candidates: [{ content: { parts: [{ text }] }, finishReason }],
}))
const fake = () => vi.fn<typeof fetch>().mockImplementation(async () => answer())

afterEach(() => vi.useRealTimers())

describe('QQ 文本问答', () => {
  it.each(['c2c', 'group'] as const)('%s 通过 SDK 接收参数并被动回复一条文本', async (scene) => {
    const fetcher = fake()
    const session = await runCommand(createGeminiPlugin(fetcher), 'ai', ' 你好 ', {
      session: { scene, atMe: true }, ctx: { config },
    })
    expect(session.replies).toEqual(['你好，我是上分难。'])
    expect(session.sent).toEqual([])
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe(ENDPOINT)
    expect(String(url)).toContain(MODEL)
    expect(String(url)).not.toContain(config.apiKey)
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'x-goog-api-key': config.apiKey } })
    const body = JSON.parse(init!.body as string)
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: '你好' }] }])
    expect(body.generationConfig).toEqual({ maxOutputTokens: 512 })
    expect(body.tools).toBeUndefined()
    expect(body.cachedContent).toBeUndefined()
    expect(String(init!.body)).not.toContain(config.apiKey)
  })

  it.each([
    { scene: 'group', atMe: false },
    { scene: 'guild', atMe: true },
    { scene: 'guild_dm', atMe: true },
  ] as const)('忽略未 @ 的群消息或非 QQ 群/私聊场景：%j', async (sessionOptions) => {
    const fetcher = fake()
    const session = await runCommand(createGeminiPlugin(fetcher), 'ai', '你好', { session: sessionOptions, ctx: { config } })
    expect(session.replies).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('空问题、缺 Key、错误配置、超长问题均不调用 API', async () => {
    const fetcher = fake()
    const plugin = createGeminiPlugin(fetcher)
    expect((await runCommand(plugin, 'ai')).replies[0]).toContain('用法')
    expect((await runCommand(plugin, 'ai', '你好')).replies[0]).toContain('尚未配置')
    expect((await runCommand(plugin, 'ai', '你好', { ctx: { config: { ...config, timeoutMs: 30000 } } })).replies[0]).toContain('配置异常')
    expect((await runCommand(plugin, 'ai', '长'.repeat(501), { ctx: { config } })).replies[0]).toContain('500')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('拒绝带控制字符或未还原的面板占位符 Key', async () => {
    const fetcher = fake()
    for (const apiKey of ['test\ncredential', '__qflare_secret__:apiKey']) {
      await runCommand(createGeminiPlugin(fetcher), 'ai', '你好', { ctx: { config: { ...config, apiKey } } })
    }
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('Unicode 输入边界按完整码点计数', async () => {
    const fetcher = fake()
    const plugin = createGeminiPlugin(fetcher)
    const session = await runCommand(plugin, 'ai', '😀'.repeat(500), { ctx: { config } })
    expect(session.replies).toEqual(['你好，我是上分难。'])
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('不保存或携带上一轮问答', async () => {
    vi.useFakeTimers()
    const fetcher = fake()
    const plugin = createGeminiPlugin(fetcher)
    await runCommand(plugin, 'ai', '第一题', { ctx: { config } })
    await vi.advanceTimersByTimeAsync(10001)
    await runCommand(plugin, 'ai', '第二题', { ctx: { config } })
    const body = JSON.parse(fetcher.mock.calls[1]![1]!.body as string)
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: '第二题' }] }])
  })

  it('并发忙碌保护、全机器人冷却和跨群用户冷却', async () => {
    vi.useFakeTimers()
    let finish!: (response: Response) => void
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
      .mockImplementation(async () => answer())
    const plugin = createGeminiPlugin(fetcher)
    const first = runCommand(plugin, 'ai', '第一题', { ctx: { config } })
    const busy = await runCommand(plugin, 'ai', '第二题', { session: { userId: 'other' }, ctx: { config } })
    expect(busy.replies[0]).toContain('正在回答')
    finish(answer())
    await first
    expect((await runCommand(plugin, 'ai', '第三题', { session: { userId: 'other' }, ctx: { config } })).replies[0]).toContain('太频繁')
    await vi.advanceTimersByTimeAsync(6001)
    expect((await runCommand(plugin, 'ai', '第四题', { session: { targetId: 'another-group' }, ctx: { config } })).replies[0]).toContain('太频繁')
    await vi.advanceTimersByTimeAsync(4000)
    await runCommand(plugin, 'ai', '第五题', { ctx: { config } })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('超时覆盖请求及响应体读取；会中止且释放忙碌状态', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => new Response(new ReadableStream()))
      .mockImplementation(async () => answer())
    const plugin = createGeminiPlugin(fetcher)
    const request = runCommand(plugin, 'ai', '你好', { ctx: { config } })
    await vi.advanceTimersByTimeAsync(15000)
    expect((await request).replies).toEqual([tips.timeout])
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true)
    expect((await runCommand(plugin, 'ai', '再试', { ctx: { config } })).replies).toEqual(['你好，我是上分难。'])
  })

  it('网络异常只记录固定错误码，不泄露异常文本或凭据', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error(`upstream ${config.apiKey}`))
    const plugin = createGeminiPlugin(fetcher)
    const command = normalizePlugin(plugin).commands[0]!
    const ctx = createMockContext(plugin, { config })
    const warn = vi.spyOn(ctx.logger, 'warn')
    const result = await command.handler({ session: createMockSession(), ctx, command: 'ai', args: ['你好'], argText: '你好' })
    expect(result).toBe(tips.network)
    expect(warn).toHaveBeenCalledWith('Gemini 请求未完成', { code: 'network' })
    expect(JSON.stringify(warn.mock.calls)).not.toContain(config.apiKey)
  })
})

describe('API 错误提示', () => {
  it.each([
    [400, { message: 'bad input' }, tips.request],
    [400, { details: [{ reason: 'API_KEY_INVALID' }] }, tips.auth],
    [401, {}, tips.auth],
    [403, {}, tips.auth],
    [402, {}, tips.quota],
    [404, {}, tips.model],
    [408, {}, tips.timeout],
    [429, { status: 'RESOURCE_EXHAUSTED' }, tips.rate],
    [429, { details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] }, tips.quota],
    [500, {}, tips.unavailable],
    [503, {}, tips.unavailable],
    [504, {}, tips.timeout],
  ])('HTTP %s 返回简短中文且不自动重试', async (status, error, expected) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ error: { ...error, private: config.apiKey } }), { status }))
    const session = await runCommand(createGeminiPlugin(fetcher), 'ai', '你好', { ctx: { config } })
    expect(session.replies).toEqual([expected])
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('非 JSON 的 429 仍按 HTTP 状态处理', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>Too many</html>', { status: 429 }))
    expect((await runCommand(createGeminiPlugin(fetcher), 'ai', '你好', { ctx: { config } })).replies).toEqual([tips.rate])
  })

  it.each([
    {},
    { candidates: [] },
    { candidates: [{ content: { parts: [{ thought: true, text: '内部思考' }] } }] },
    { candidates: [{ content: { parts: [{ functionCall: { name: 'x' } }] } }] },
  ])('空或非文本回答不会发送原始结构：%j', async (payload) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(payload)))
    expect((await runCommand(createGeminiPlugin(fetcher), 'ai', '你好', { ctx: { config } })).replies).toEqual([tips.response])
  })

  it.each([
    { promptFeedback: { blockReason: 'SAFETY' } },
    { candidates: [{ finishReason: 'SAFETY', content: { parts: [{ text: '不可发送的部分回答' }] } }] },
    { candidates: [{ finishReason: 'RECITATION' }] },
  ])('被拦截时给中文提示：%j', async (payload) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(payload)))
    expect((await runCommand(createGeminiPlugin(fetcher), 'ai', '你好', { ctx: { config } })).replies).toEqual([tips.blocked])
  })

  it('拒绝超大响应和损坏 JSON', async () => {
    for (const body of ['x'.repeat(65537), '{bad json']) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body))
      expect((await runCommand(createGeminiPlugin(fetcher), 'ai', '你好', { ctx: { config } })).replies).toEqual([tips.response])
    }
  })

  it('排除思考内容，拼接文本 parts，并过滤异常回显的 Key', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ finishReason: 'STOP', content: { parts: [
        { thought: true, text: '内部思考' }, { text: '答案：' }, { text: config.apiKey },
      ] } }],
    })))
    expect((await runCommand(createGeminiPlugin(fetcher), 'ai', '你好', { ctx: { config } })).replies).toEqual(['答案：[密钥已隐藏]'])
  })

  it.each([['长'.repeat(2000), 'STOP'], ['😀'.repeat(600), 'STOP'], ['短回答', 'MAX_TOKENS']])('限制字符和 UTF-8 字节，截断不拆 Unicode', async (text, reason) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(answer(text, reason))
    const session = await runCommand(createGeminiPlugin(fetcher), 'ai', '你好', { ctx: { config: { ...config, maxReplyChars: 500 } } })
    const reply = session.replies[0] as string
    expect(Array.from(reply).length).toBeLessThanOrEqual(500)
    expect(new TextEncoder().encode(reply).byteLength).toBeLessThanOrEqual(1500)
    expect(reply).toContain('回答已截短')
    expect(reply).not.toContain('\ufffd')
  })
})
