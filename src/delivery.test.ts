import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizePlugin } from '@qqbot/sdk'
import { createMemoryKV, createMockContext, createMockSession, runCommand, type MockSessionOptions } from '@qqbot/sdk/testing'
import { defaultConfig, readConfig, configSchema, type Config } from './config.js'
import { askGemini, cleanReply, GEMINI_RESPONSE_BYTES, tips } from './gemini.js'
import { createGeminiPlugin } from './index.js'
import { splitText, loadPending, pendingKeys, deliverAnswer, MORE_TIP } from './delivery.js'
import { parseHistory, message, conversationKey } from './history.js'
import { TAVILY_ENDPOINT } from './tavily.js'

const config = { ...defaultConfig, apiKey: 'local-long-answer-credential', tavilyApiKey: 'local-search-credential' }
const answer = (text = '回答', finishReason = 'STOP') => Response.json({ candidates: [{ content: { parts: [{ text }] }, finishReason }] })
function harness(text: string, scene: 'c2c' | 'group' = 'c2c') {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => answer(text))
  const plugin = createGeminiPlugin(fetcher)
  const ctx = { ...createMockContext(plugin, { config }), kv: createMemoryKV() }
  const session = (options: MockSessionOptions = {}) => createMockSession({ scene, event: scene === 'c2c' ? 'qq.c2c.message' : 'qq.group.at_message',
    atMe: true, userId: 'user', botId: 'bot', targetId: scene === 'group' ? 'group' : 'user', ...options })
  const invoke = async (command: string, options: MockSessionOptions = {}) => {
    const s = session(options)
    const spec = normalizePlugin(plugin).commands.find((c) => c.name === command)!
    const value = await spec.handler({ ctx, session: s, command, argText: command === 'ai' ? '详细解释' : '', args: [] })
    if (typeof value === 'string') await s.reply(value)
    return s
  }
  return { fetcher, plugin, ctx, session, invoke }
}
afterEach(() => vi.useRealTimers())

describe('无总字符上限与模型参数', () => {
  it('默认/上限 65536，旧小值继续合法，旧字符裁剪字段忽略', () => {
    expect(defaultConfig.maxOutputTokens).toBe(65536)
    expect(configSchema).toMatchObject({ properties: { maxOutputTokens: { maximum: 65536, default: 65536 } } })
    expect(configSchema.properties).not.toHaveProperty('maxReplyChars')
    expect(readConfig({ ...config, maxOutputTokens: 65537 })).toBeNull()
    expect(readConfig({ ...config, maxOutputTokens: 600, timeoutMs: 15000, maxReplyChars: 400 })).toMatchObject({ maxOutputTokens: 600, timeoutMs: 15000 })
    expect(readConfig({ ...config, maxReplyChars: 1 })!.maxReplyChars).toBeUndefined()
    expect(readConfig({ apiKey: config.apiKey, maxInputChars: 500, maxOutputTokens: 600, timeoutMs: 15000 } as Config)).not.toBeNull()
  })
  it('超过原64KiB响应、500字符和1500字节仍完整解析，不要求每次写满Token', async () => {
    const text = '中文😀\n'.repeat(15000)
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(answer(text))
    const reply = await askGemini('详细解释', config, fetcher)
    expect(reply).toBe(text.trim())
    const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string)
    expect(body.generationConfig.maxOutputTokens).toBe(65536)
    expect(body.systemInstruction.parts[0].text).toContain('普通闲聊简洁自然')
    expect(body.systemInstruction.parts[0].text).toContain('不是必须生成的长度')
    expect(body.systemInstruction.parts[0].text).not.toContain('400 字符')
  })
  it('模型 Token 用尽时保留全部已有正文并明确提示', () => {
    const text = '长'.repeat(10000)
    expect(cleanReply(text, true).startsWith(text)).toBe(true)
    expect(cleanReply(text, true)).toContain('Token 上限')
  })
  it('异常超大响应仍受内存保护，不记录响应或密钥', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(GEMINI_RESPONSE_BYTES + 1)))
    await expect(askGemini('问题', config, fetcher)).rejects.toMatchObject({ code: 'response' })
  })
  it('长模型回复进入6轮历史，第二轮不会因500字符校验丢失上下文', async () => {
    const text = '答案'.repeat(26000)
    const history = [message('user', '上轮问题'), message('model', text)]
    expect(parseHistory(JSON.stringify({ updatedAt: Date.now(), messages: history }))).toEqual(history)
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(answer())
    await askGemini('新问题', config, fetcher, history)
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string).contents[1].parts[0].text).toBe(text)
  })
})

describe('QQ UTF-8 分段与持续领取', () => {
  it.each(['中'.repeat(5000), '😀'.repeat(5000), ('a\n中😀 é\n').repeat(1000)])('按字节安全分段，拼回去逐字一致：%#', (text) => {
    const chunks = splitText(text)
    expect(chunks.join('')).toBe(text)
    for (const chunk of chunks) {
      expect(new TextEncoder().encode(chunk).byteLength).toBeLessThanOrEqual(2000)
      expect(chunk).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u)
    }
  })
  it('优先在换行处切分，能装入单条的来源 URL 不从中间拆开', () => {
    const link = 'https://source.test/article?q=abc'
    const text = '中'.repeat(660) + '\n来源：\n' + link
    expect(splitText(text).join('')).toBe(text)
    expect(splitText(text).some((part) => part.includes(link))).toBe(true)
  })
  it.each(['c2c', 'group'] as const)('%s 按平台条数分批，/more 最终完整领完且不调用API', async (scene) => {
    vi.useFakeTimers()
    const text = '中文😀与空格 \n'.repeat(2500).trim()
    const bot = harness(text, scene)
    let s = await bot.invoke('ai')
    expect(s.replies).toHaveLength(scene === 'c2c' ? 4 : 5)
    expect(s.replies.at(-1)).toBe(MORE_TIP)
    const all = (s.replies as string[]).filter((r) => r !== MORE_TIP)
    for (let n = 0; n < 50 && await loadPending(bot.ctx, bot.session()); n++) {
      await vi.advanceTimersByTimeAsync(10001)
      s = await bot.invoke('more')
      expect(s.replies.length).toBeLessThanOrEqual(scene === 'c2c' ? 4 : 5)
      all.push(...(s.replies as string[]).filter((r) => r !== MORE_TIP))
    }
    expect(all.join('')).toBe(text)
    expect(await loadPending(bot.ctx, bot.session())).toBeNull()
    expect(bot.fetcher).toHaveBeenCalledTimes(1)
    const saved = JSON.parse((await bot.ctx.kv.get(conversationKey(bot.session())!))!)
    expect(saved.messages[1]).toEqual(message('model', text))
  })
  it('小回答仍只返回一次；长回答每条受真实 SDK 被动回复计数保护', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(answer('长'.repeat(10000)))
    const s = await runCommand(createGeminiPlugin(fetcher), 'ai', '详细解释', { ctx: { config }, session: { maxPassiveReplies: 5 } })
    expect(s.replies).toHaveLength(5)
    expect(s.sent).toEqual([])
    expect(s.replies.at(-1)).toBe(MORE_TIP)
  })
  it('发送失败保留准确剩余位置，返回明确提示，日志不写正文', async () => {
    const bot = harness('长'.repeat(3000)); const session = bot.session()
    const original = session.reply.bind(session)
    vi.spyOn(session, 'reply').mockImplementationOnce(original).mockResolvedValueOnce({ ok: false, status: 500, raw: config.apiKey })
      .mockImplementation(original)
    const warn = vi.spyOn(bot.ctx.logger, 'warn')
    await deliverAnswer(session, bot.ctx, '长'.repeat(3000), Date.now() + 27000)
    expect(session.replies.at(-1)).toContain('发送失败')
    expect((await loadPending(bot.ctx, session))!.offset).toBe((session.replies[0] as string).length)
    expect(JSON.stringify(warn.mock.calls)).not.toContain(config.apiKey)
  })
  it('QQ 明确提示长度超限时缩小分段，正文不丢', async () => {
    const bot = harness('中'.repeat(1500)); const session = bot.session()
    const original = session.reply.bind(session)
    vi.spyOn(session, 'reply').mockResolvedValueOnce({ ok: false, status: 400, code: 40054007, raw: null }).mockImplementation(original)
    await deliverAnswer(session, bot.ctx, '中'.repeat(1500), Date.now() + 27000)
    expect(new TextEncoder().encode(session.replies[0] as string).byteLength).toBeLessThanOrEqual(1000)
    expect(await loadPending(bot.ctx, session)).not.toBeNull()
    expect(session.replies.at(-1)).toBe(MORE_TIP)
  })
  it('发送时间不足时保留全部未发正文，明确提示继续领取', async () => {
    const bot = harness('中'.repeat(3000)); const session = bot.session()
    await deliverAnswer(session, bot.ctx, '中'.repeat(3000), Date.now() - 1)
    expect(session.replies).toEqual([MORE_TIP])
    expect((await loadPending(bot.ctx, session))!.offset).toBe(0)
  })
  it('分段发送中仍保持忙碌，reset 后停止发送且不恢复待发正文', async () => {
    const bot = harness('中'.repeat(5000)); const session = bot.session()
    let finish!: () => void
    vi.spyOn(session, 'reply').mockImplementationOnce(() => new Promise((resolve) => {
      finish = () => resolve({ ok: true, status: 200, raw: null })
    }))
    const command = normalizePlugin(bot.plugin).commands.find((c) => c.name === 'ai')!
    const pending = command.handler({ ctx: bot.ctx, session, command: 'ai', argText: '问题', args: [] })
    await vi.waitFor(() => expect(session.reply).toHaveBeenCalledTimes(1))
    expect((await bot.invoke('more')).replies[0]).toContain('正在回答')
    await bot.invoke('reset')
    finish(); await pending
    expect(await loadPending(bot.ctx, session)).toBeNull()
    expect(await bot.ctx.kv.get(conversationKey(session)!)).toBeNull()
    expect(session.reply).toHaveBeenCalledTimes(1)
  })
  it('正文写失败不假装发送，进度失败保留原文并明确可能重复', async () => {
    const bot = harness('长'.repeat(3000)); const s = bot.session()
    const spy = vi.spyOn(bot.ctx.kv, 'put').mockRejectedValueOnce(new Error(config.apiKey))
    expect(await deliverAnswer(s, bot.ctx, '长'.repeat(3000), Date.now() + 27000)).toContain('无法保存')
    expect(s.replies).toEqual([])
    spy.mockRestore()
    const put = bot.ctx.kv.put.bind(bot.ctx.kv)
    vi.spyOn(bot.ctx.kv, 'put').mockImplementationOnce(put).mockRejectedValueOnce(new Error(config.apiKey))
    await deliverAnswer(s, bot.ctx, '长'.repeat(3000), Date.now() + 27000)
    expect(s.replies.at(-1)).toContain('可能重复')
  })
  it('剩余正文按机器人/用户/群隔离，24小时过期，reset只清当前会话', async () => {
    vi.useFakeTimers(); const bot = harness('长'.repeat(5000)); await bot.invoke('ai')
    for (const options of [{ userId: 'other' }, { botId: 'other' }, { scene: 'group' as const, targetId: 'other' }]) {
      expect(await loadPending(bot.ctx, bot.session(options))).toBeNull()
    }
    await bot.invoke('reset')
    const keys = pendingKeys(bot.session())!
    expect(await bot.ctx.kv.get(keys[0])).toBeNull()
    await vi.advanceTimersByTimeAsync(10001); await bot.invoke('ai')
    await vi.advanceTimersByTimeAsync(86400000)
    expect(await loadPending(bot.ctx, bot.session())).toBeNull()
  })
  it('more群未@不触发，领取共用忙碌/冷却，未领完不覆盖旧正文', async () => {
    vi.useFakeTimers(); const bot = harness('长'.repeat(5000)); await bot.invoke('ai')
    expect((await bot.invoke('more')).replies[0]).toContain('太频繁')
    expect((await bot.invoke('more', { scene: 'group', atMe: false })).replies).toEqual([])
    await vi.advanceTimersByTimeAsync(10001)
    expect((await bot.invoke('ai')).replies[0]).toContain('尚未发完')
    expect(bot.fetcher).toHaveBeenCalledTimes(1)
  })
  it('损坏/过期记录安全报错，损坏进度不会跳过正文', async () => {
    const bot = harness('长'.repeat(5000)); const keys = pendingKeys(bot.session())!
    bot.ctx.kv.data.set(keys[0], '{bad')
    expect((await bot.invoke('more')).replies[0]).toContain('无法读取')
    bot.ctx.kv.data.set(keys[0], JSON.stringify({ id: 'test', text: '完整原文', updatedAt: Date.now() }))
    bot.ctx.kv.data.set(keys[1], '{bad')
    expect((await loadPending(bot.ctx, bot.session()))!.offset).toBe(0)
  })
})

describe('30秒后台生命周期内的超时预算', () => {
  it('默认及上限为27000，旧24000配置继续有效', () => {
    expect(defaultConfig.timeoutMs).toBe(27000)
    expect(readConfig({ ...config, timeoutMs: 24000 })!.timeoutMs).toBe(24000)
    expect(readConfig({ ...config, timeoutMs: 27000 })!.timeoutMs).toBe(27000)
    expect(readConfig({ ...config, timeoutMs: 27001 })).toBeNull()
  })
  it('26秒首字延迟仍可成功，高档推理不在24秒被中止', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(answer()), 26000)))
    const pending = runCommand(createGeminiPlugin(fetcher), 'ai', '问题', { ctx: { config } })
    await vi.advanceTimersByTimeAsync(26001)
    expect((await pending).replies).toEqual(['回答'])
  })
  it('搜索耗时计入27秒共同预算，不叠加成35秒', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn<typeof fetch>().mockImplementation((url) => url === TAVILY_ENDPOINT
      ? new Promise((resolve) => setTimeout(() => resolve(Response.json({ results: [{ title: '资料', url: 'https://a.test/', content: '信息' }] })), 7000))
      : new Promise(() => {}))
    const pending = runCommand(createGeminiPlugin(fetcher), 'search', '新闻', { ctx: { config: { ...config, enableTavilySearch: true } } })
    await vi.advanceTimersByTimeAsync(27001)
    expect((await pending).replies).toEqual([tips.timeout])
    expect(fetcher.mock.calls[1]![1]!.signal!.aborted).toBe(true)
  })
})
