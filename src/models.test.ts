import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizePlugin } from '@qqbot/sdk'
import { createMemoryKV, createMockContext, createMockSession, type MockSessionOptions } from '@qqbot/sdk/testing'
import { configSchema, defaultConfig, MODEL, readConfig, type Config } from './config.js'
import { createGeminiPlugin } from './index.js'
import { askGemini, tips } from './gemini.js'
import { MODEL_IDS, modelEndpoint, modelSelectionKey, parseModelChoice, resolveModel } from './models.js'
import { conversationKey } from './history.js'
import { loadPending } from './delivery.js'
import { TAVILY_ENDPOINT, SEARCH_USAGE_KEY } from './tavily.js'

const config = { ...defaultConfig, apiKey: 'local-model-test-key', tavilyApiKey: 'local-search-test-key' }
const answer = (text = '回答') => Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] })
function harness(fetcher = vi.fn<typeof fetch>().mockImplementation(async () => answer())) {
  const plugin = createGeminiPlugin(fetcher)
  const ctx = { ...createMockContext(plugin, { config: { ...config } }), kv: createMemoryKV() }
  const session = (options: MockSessionOptions = {}) => createMockSession({ scene: 'c2c', event: 'qq.c2c.message',
    botId: 'bot', userId: 'user', targetId: 'user', atMe: true, ...options })
  async function invoke(command: string, argText = '', options: MockSessionOptions = {}) {
    const s = session(options)
    const handler = normalizePlugin(plugin).commands.find((c) => c.name === command)!.handler
    const value = await handler({ session: s, ctx, command, argText, args: argText.split(' ') })
    return { value, session: s }
  }
  async function text(content: string) {
    return normalizePlugin(plugin).regex[0]!.handler({ session: session({ content }), ctx, match: /\S/u.exec(content)! })
  }
  return { plugin, ctx, fetcher, session, invoke, text }
}
afterEach(() => vi.useRealTimers())

describe('后台默认模型与固定 REST 主机', () => {
  it('Schema enum 生成后台下拉，旧配置缺少字段时仍用原模型', () => {
    expect(configSchema).toMatchObject({ properties: { model: { type: 'string', enum: [...MODEL_IDS], default: MODEL } } })
    const { model: _model, ...old } = config
    expect(readConfig(old as Config)!.model).toBe('gemini-3.5-flash-lite')
    for (const model of MODEL_IDS) expect(readConfig({ ...config, model })!.model).toBe(model)
  })
  it.each(['https://evil.test/', '../other', 'gemini-3.5-flash-lite?key=x', '', 123, null])('非法默认模型 %j 不进入 API', async (model) => {
    expect(readConfig({ ...config, model: model as never })).toBeNull()
    const bot = harness(); bot.ctx.config.model = model as never
    expect((await bot.invoke('ai', '问题')).value).toContain('配置异常')
    expect(bot.fetcher).not.toHaveBeenCalled()
  })
  it.each(MODEL_IDS)('选择 %s 时只更改模型路径，其余 API 保护不变', async (model) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(answer())
    expect(await askGemini('问题', { ...config, model }, fetcher)).toBe('回答')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledWith(modelEndpoint(model), expect.objectContaining({
      redirect: 'manual', headers: { 'content-type': 'application/json', 'x-goog-api-key': config.apiKey },
    }))
    const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string)
    expect(body.generationConfig).toEqual({ maxOutputTokens: 65536, thinkingConfig: { thinkingLevel: 'high' } })
    expect(body).not.toHaveProperty('tools')
    expect(JSON.stringify(body)).not.toContain(config.apiKey)
  })
  it.each(MODEL_IDS)('%s 高档推理只返回最终正文，不回显思考或签名', async (model) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [
      { thought: true, text: '内部思考', thoughtSignature: 'private-signature' }, { text: '最终答案' },
    ] } }] }))
    expect(await askGemini('问题', { ...config, model }, fetcher)).toBe('最终答案')
    const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string)
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'high' })
    expect(body.generationConfig.thinkingConfig).not.toHaveProperty('thinkingBudget')
    expect(body.generationConfig.thinkingConfig).not.toHaveProperty('includeThoughts')
  })
  it('直接调用请求层也拒绝非法模型，不能把 Key 送往任意主机', async () => {
    const fetcher = vi.fn<typeof fetch>()
    await expect(askGemini('问题', { ...config, model: 'https://evil.test' as never }, fetcher)).rejects.toMatchObject({ code: 'model' })
    expect(() => modelEndpoint('https://evil.test' as never)).toThrow('Unsupported model')
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('/model 当前会话选择', () => {
  it('查看列表不调用 Gemini/Tavily，也不更改配置或历史', async () => {
    const bot = harness()
    const result = (await bot.invoke('model')).value as string
    for (const model of MODEL_IDS) expect(result).toContain(model)
    expect(result).toContain('跟随后台默认')
    expect(result).toContain('/model default')
    expect(bot.ctx.kv.data.size).toBe(0)
    expect(bot.fetcher).not.toHaveBeenCalled()
  })
  it.each([['1', MODEL_IDS[0]], ['2', MODEL_IDS[1]], ['3', MODEL_IDS[2]], ['GEMINI-3.8-FLASH', MODEL_IDS[2]]])('以 %s 保存 %s，下次聊天实际使用它', async (choice, model) => {
    const bot = harness()
    expect((await bot.invoke('model', choice)).value).toContain(model)
    expect(bot.ctx.config.model).toBe(MODEL)
    expect(bot.fetcher).not.toHaveBeenCalled()
    expect(await bot.text('你好')).toBe('回答')
    expect(bot.fetcher.mock.calls[0]![0]).toBe(modelEndpoint(model as typeof MODEL_IDS[number]))
    expect((await bot.invoke('model', 'list')).value).toContain('本会话选择')
  })
  it('后台变更影响跟随者，已有会话选择保留；default 恢复跟随新的后台值', async () => {
    vi.useFakeTimers(); const bot = harness()
    await bot.invoke('model', '2')
    bot.ctx.config.model = MODEL_IDS[2]
    await bot.invoke('ai', '问题')
    expect(bot.fetcher.mock.calls[0]![0]).toBe(modelEndpoint(MODEL_IDS[1]))
    await bot.invoke('model', 'default')
    await vi.advanceTimersByTimeAsync(10001)
    await bot.invoke('ai', '问题2')
    expect(bot.fetcher.mock.calls[1]![0]).toBe(modelEndpoint(MODEL_IDS[2]))
    expect(await bot.ctx.kv.get(modelSelectionKey(bot.session())!)).toBeNull()
  })
  it('按用户、机器人、群隔离，持久化偏好不随历史24小时过期', async () => {
    vi.useFakeTimers(); const bot = harness(); await bot.invoke('model', '3')
    for (const scope of [{ userId: 'other' }, { botId: 'other' }, { scene: 'group' as const, targetId: 'group' }]) {
      expect(await resolveModel(bot.ctx, bot.session(scope), MODEL)).toEqual({ model: MODEL, overridden: false })
    }
    const group = { scene: 'group' as const, event: 'qq.group.at_message' as const, targetId: 'group-a' }
    await bot.invoke('model', '2', group)
    expect((await resolveModel(bot.ctx, bot.session({ ...group, targetId: 'group-b' }), MODEL)).model).toBe(MODEL)
    expect((await resolveModel(bot.ctx, bot.session({ ...group, userId: 'other' }), MODEL)).model).toBe(MODEL)
    await vi.advanceTimersByTimeAsync(86400001)
    expect((await resolveModel(bot.ctx, bot.session(), MODEL)).model).toBe(MODEL_IDS[2])
  })
  it('切换保留完整上下文，reset只清历史和余文，不清模型选择或API Key', async () => {
    vi.useFakeTimers(); const bot = harness()
    await bot.invoke('ai', '第一题')
    const key = conversationKey(bot.session())!
    const history = await bot.ctx.kv.get(key)
    await bot.invoke('model', '2')
    expect(await bot.ctx.kv.get(key)).toBe(history)
    await vi.advanceTimersByTimeAsync(10001)
    await bot.invoke('ai', '第二题')
    expect(JSON.parse(bot.fetcher.mock.calls[1]![1]!.body as string).contents).toHaveLength(3)
    await bot.invoke('reset')
    expect(await bot.ctx.kv.get(key)).toBeNull()
    expect((await resolveModel(bot.ctx, bot.session(), MODEL)).model).toBe(MODEL_IDS[1])
    expect(bot.ctx.config.apiKey).toBe(config.apiKey)
  })
  it('不会影响已生成的待领取正文；more不生成或搜索', async () => {
    vi.useFakeTimers()
    const bot = harness(vi.fn<typeof fetch>().mockImplementation(async () => answer('长'.repeat(5000))))
    await bot.invoke('ai', '详细解释')
    const pending = await loadPending(bot.ctx, bot.session())
    await bot.invoke('model', '3')
    expect(await loadPending(bot.ctx, bot.session())).toEqual(pending)
    await vi.advanceTimersByTimeAsync(10001); await bot.invoke('more')
    expect(bot.fetcher).toHaveBeenCalledTimes(1)
  })
  it('Tavily与 /search 使用所选模型，搜索配额规则不变', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => url === TAVILY_ENDPOINT
      ? Response.json({ results: [{ title: '资料', url: 'https://source.test/', content: '信息' }] }) : answer())
    const bot = harness(fetcher); bot.ctx.config.enableTavilySearch = true
    await bot.invoke('model', '2')
    expect((await bot.invoke('search', '关键词')).value).toContain('https://source.test/')
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([TAVILY_ENDPOINT, modelEndpoint(MODEL_IDS[1])])
    expect(JSON.parse((await bot.ctx.kv.get(SEARCH_USAGE_KEY))!).daily).toBe(1)
  })
  it.each([{ scene: 'group', atMe: false }, { scene: 'guild' }, { attachments: [{ url: 'https://attachment.test/' }] },
    { event: 'qq.friend.add' } ] as MockSessionOptions[])('忽略未@群、非支持场景、附件/事件：%j', async (scope) => {
    const bot = harness(); expect((await bot.invoke('model', '2', scope)).value).toBeUndefined()
    expect(bot.ctx.kv.data.size).toBe(0)
    expect(bot.fetcher).not.toHaveBeenCalled()
  })
  it('无用户身份不能写共享模型偏好', async () => {
    const bot = harness(); expect((await bot.invoke('model', '2', { userId: '' })).value).toContain('无法识别')
    expect(bot.ctx.kv.data.size).toBe(0)
  })
  it.each(['4', 'unknown', 'https://evil.test/', config.apiKey])('不接受任意模型或回显无效输入：%s', async (choice) => {
    const bot = harness(); const result = (await bot.invoke('model', choice)).value
    expect(result).toContain('不在可选列表')
    expect(result).not.toContain(config.apiKey)
    expect(bot.ctx.kv.data.size).toBe(0)
  })
  it('忙碌中可查看，但不能切换或恢复默认；原冷却不因切换而绕过', async () => {
    let finish!: (response: Response) => void
    const bot = harness(vi.fn<typeof fetch>().mockImplementation(() => new Promise((done) => { finish = done })))
    const pending = bot.invoke('ai', '问题')
    await vi.waitFor(() => expect(bot.fetcher).toHaveBeenCalledTimes(1))
    expect((await bot.invoke('model')).value).toContain('当前模型')
    expect((await bot.invoke('model', '2')).value).toContain('正在回答')
    expect((await bot.invoke('model', 'default')).value).toContain('正在回答')
    finish(answer()); await pending
    await bot.invoke('model', '2')
    expect((await bot.invoke('ai', '第二题')).value).toContain('太频繁')
  })
})

describe('模型状态与错误安全', () => {
  it.each(['{bad', 'null', '[]', '{}', '{"model":"https://evil.test/"}', 'x'.repeat(257)])('损坏状态 %s 安全回到后台默认', async (raw) => {
    const bot = harness(); bot.ctx.kv.data.set(modelSelectionKey(bot.session())!, raw)
    expect(await resolveModel(bot.ctx, bot.session(), MODEL)).toEqual({ model: MODEL, overridden: false })
    await bot.invoke('ai', '问题')
    expect(bot.fetcher.mock.calls[0]![0]).toBe(modelEndpoint(MODEL))
  })
  it('KV读取失败不悄悄改用其他模型，写入失败不报告成功；日志不含密钥', async () => {
    const bot = harness(); await bot.invoke('model', '3')
    const get = bot.ctx.kv.get.bind(bot.ctx.kv)
    vi.spyOn(bot.ctx.kv, 'get').mockImplementation((key) => key.startsWith('model:') ? Promise.reject(new Error(config.apiKey)) : get(key))
    const warn = vi.spyOn(bot.ctx.logger, 'warn')
    expect((await bot.invoke('ai', '问题')).value).toContain('无法读取会话模型')
    expect(bot.fetcher).not.toHaveBeenCalled()
    vi.spyOn(bot.ctx.kv, 'put').mockRejectedValue(new Error(config.tavilyApiKey))
    expect((await bot.invoke('model', '2')).value).toContain('保存失败')
    for (const key of [config.apiKey, config.tavilyApiKey]) expect(JSON.stringify(warn.mock.calls)).not.toContain(key)
  })
  it.each([[403, tips.auth], [404, tips.model], [429, tips.rate]])('所选模型 HTTP %s 保留原错误提示、不自动回退重试', async (status, tip) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({}, { status: status as number }))
    const bot = harness(fetcher); await bot.invoke('model', '3')
    expect((await bot.invoke('ai', '问题')).value).toBe(tip)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]![0]).toBe(modelEndpoint(MODEL_IDS[2]))
  })
  it('选择只写当前会话，不附TTL、不更改框架全局配置', async () => {
    const bot = harness(); const put = vi.spyOn(bot.ctx.kv, 'put')
    await bot.invoke('model', '2')
    expect(put).toHaveBeenCalledWith(modelSelectionKey(bot.session()), { model: MODEL_IDS[1] })
    expect(bot.ctx.config).toEqual(config)
    expect(parseModelChoice('3')).toBe(MODEL_IDS[2])
  })
})
