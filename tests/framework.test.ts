// 开发期与相邻的真实 QFlareBot v0.6.1 源码联测；这些 import 不会进入插件产物。
import { describe, expect, it, vi } from 'vitest'
import { createMockContext } from '@qqbot/sdk/testing'
import { definePlugin, extractManifest } from '@qqbot/sdk'
import { buildSession } from '../../QFlareBot/packages/runtime/src/session.js'
import { dispatch } from '../../QFlareBot/packages/runtime/src/dispatcher.js'
import { PluginRegistry } from '../../QFlareBot/packages/runtime/src/registry.js'
import { maskSecrets, restoreSecrets } from '../../QFlareBot/packages/runtime/src/configSecrets.js'
import { validateConfig, withConfigDefaults } from '../../QFlareBot/packages/runtime/src/configSchema.js'
import type { ContextFactory } from '../../QFlareBot/packages/runtime/src/context.js'
import type { OutgoingMessage } from '@qqbot/sdk'
import sid from '../../QFlareBot/plugins/sid/src/index.js'
import t2i from '../../QFlareBot/plugins/t2i/src/index.js'
import { createGeminiPlugin } from '../src/index.js'
import { configSchema, defaultConfig, readConfig } from '../src/config.js'

const config = { ...defaultConfig, apiKey: 'local-test-credential' }

function harness(fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '你好。' }] } }],
  })), commandPrefixes = ['/'], pluginConfig = config) {
  const plugin = createGeminiPlugin(fetcher)
  const ctx = createMockContext(plugin, { config: pluginConfig })
  const other = definePlugin({ name: 'other', commands: {
    other: () => '其他插件回复',
    quiet: () => undefined,
  } })
  const registry = new PluginRegistry([plugin, sid, t2i, other])
  async function deliver(type: string, content: string, mentions: unknown[] = [], extra: Record<string, unknown> = {}) {
    const replies: OutgoingMessage[] = []
    const session = buildSession({ op: 0, t: type, id: 'test-event', d: {
      id: 'test-message', content, mentions, group_openid: type.startsWith('GROUP') ? 'test-group' : undefined,
      author: { user_openid: 'test-user', member_openid: 'test-member' }, ...extra,
    } } as Parameters<typeof buildSession>[0], {
      botId: 'test-bot', maxPassiveReplies: 5,
      sender: { async sendMessage(_target, message) {
        replies.push(message)
        return { ok: true, status: 200, raw: null }
      } },
    })
    const report = await dispatch(session, {
      registry,
      snapshot: { revision: 1, plugins: {} },
      contexts: { prepare: async () => ctx } as unknown as ContextFactory,
      commandPrefixes, logger: ctx.logger,
    })
    return { replies, fetcher, report, registry, session }
  }
  return { deliver, fetcher }
}

const deliver = (type: string, content: string, mentions: unknown[] = [], extra: Record<string, unknown> = {}) =>
  harness().deliver(type, content, mentions, extra)

describe('QFlareBot v0.6.1 真实标准化与 dispatcher', () => {
  it.each([
    ['C2C_MESSAGE_CREATE', '/ai 你好', []],
    ['GROUP_AT_MESSAGE_CREATE', '<@123456> /ai 你好', []],
    ['GROUP_MESSAGE_CREATE', '<@123456> /ai 你好', [{ id: '123456', is_you: true }]],
  ])('%s 实际事件正文进入 Gemini 并走被动回复', async (type, content, mentions) => {
    const { replies, fetcher, report } = await deliver(type as string, content as string, mentions as unknown[])
    expect(replies).toEqual(['你好。'])
    expect(report.errors).toEqual([])
    expect(report.matched).toEqual([{ plugin: 'gemini', kind: 'command', name: 'ai' }])
    expect(fetcher).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string)
    expect(body.contents[0].parts).toEqual([{ text: '你好' }])
  })

  it.each([
    ['GROUP_MESSAGE_CREATE', '/ai 你好'],
    ['GROUP_MESSAGE_CREATE', '普通聊天'],
    ['C2C_MESSAGE_CREATE', '/aix 你好'],
  ])('忽略 %s 中的不符合条件消息：%s', async (type, content) => {
    const { replies, fetcher } = await deliver(type, content)
    expect(replies).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('与内置 sid、T2I 注册共存，/sid 仍交给原插件', async () => {
    const { registry, report, replies, fetcher } = await deliver('C2C_MESSAGE_CREATE', '/sid')
    expect(registry.all().map((p) => p.manifest.name)).toEqual(['gemini', 'sid', 't2i', 'other'])
    expect(registry.providerOf('t2i')).toBe('t2i')
    expect(report.matched).toEqual([{ plugin: 'sid', kind: 'command', name: 'sid' }])
    expect(report.errors).toEqual([])
    expect(replies).toHaveLength(1)
    expect(fetcher).not.toHaveBeenCalled()
    expect(extractManifest(t2i, { version: '0.6.1' }).services).toContain('t2i')
  })

  it.each([
    ['C2C_MESSAGE_CREATE', '你好'],
    ['GROUP_AT_MESSAGE_CREATE', '<@123456> 你好'],
  ])('%s 普通文本只调用一次 Gemini 并回复一次', async (type, content) => {
    const { replies, fetcher, report } = await deliver(type, content)
    expect(replies).toEqual(['你好。'])
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(report.errors).toEqual([])
    expect(report.matched).toEqual([{ plugin: 'gemini', kind: 'regex', name: '\\S' }])
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string).contents[0].parts).toEqual([{ text: '你好' }])
  })

  it.each(['/unknown 你好', '/t2i 内容', '/ai', '/reset', '', '  \n\t', '/SID', 'sid', 'other', '/other', 'quiet'])('普通文本规则不会截获命令或空消息：%j', async (text) => {
    const { replies, fetcher, report } = await deliver('C2C_MESSAGE_CREATE', text)
    expect(fetcher).not.toHaveBeenCalled()
    expect(replies.length).toBeLessThanOrEqual(1)
    expect(report.errors).toEqual([])
    if (text.toLowerCase().includes('sid')) expect(report.matched[0]?.plugin).toBe('sid')
    if (text.includes('other')) expect(replies).toEqual(['其他插件回复'])
  })

  it.each([
    ['C2C_MESSAGE_CREATE', '你好', { attachments: [{ url: 'https://example.invalid/image.png', content_type: 'image/png' }] }],
    ['C2C_MESSAGE_CREATE', '', { attachments: [{ url: 'https://example.invalid/image.png' }] }],
    ['GROUP_ADD_ROBOT', '你好', {}],
    ['FRIEND_ADD', '你好', {}],
    ['AT_MESSAGE_CREATE', '你好', { channel_id: 'channel' }],
    ['DIRECT_MESSAGE_CREATE', '你好', { guild_id: 'guild' }],
  ])('忽略附件、非消息事件和频道：%s', async (type, content, extra) => {
    const { replies, fetcher } = await deliver(type as string, content as string, [], extra as Record<string, unknown>)
    expect(replies).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([['你好', '/ai 再问'], ['/ai 你好', '再问']])('普通文本与 /ai 共享忙碌和冷却保护：%s → %s', async (firstText, secondText) => {
    vi.useFakeTimers()
    try {
      let finish!: (response: Response) => void
      const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise((resolve) => { finish = resolve }))
      const bot = harness(fetcher)
      const first = bot.deliver('C2C_MESSAGE_CREATE', firstText)
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
      const busy = await bot.deliver('C2C_MESSAGE_CREATE', secondText)
      expect(busy.replies).toEqual(['AI 正在回答，请稍后再问。'])
      expect(fetcher).toHaveBeenCalledTimes(1)
      finish(Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '完成' }] } }] }))
      expect((await first).replies).toEqual(['完成'])
      expect((await bot.deliver('C2C_MESSAGE_CREATE', secondText)).replies).toEqual(['提问太频繁，请稍后再试。'])
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it.each([['第一题', '/ai 第二题'], ['/ai 第一题', '第二题']])('普通文本与 /ai 共享历史：%s → %s', async (first, second) => {
    vi.useFakeTimers()
    try {
      const bot = harness()
      expect((await bot.deliver('C2C_MESSAGE_CREATE', first)).replies).toEqual(['你好。'])
      await vi.advanceTimersByTimeAsync(10001)
      expect((await bot.deliver('C2C_MESSAGE_CREATE', second)).replies).toEqual(['你好。'])
      expect(JSON.parse(bot.fetcher.mock.calls[1]![1]!.body as string).contents).toEqual([
        { role: 'user', parts: [{ text: '第一题' }] },
        { role: 'model', parts: [{ text: '你好。' }] },
        { role: 'user', parts: [{ text: '第二题' }] },
      ])
    } finally { vi.useRealTimers() }
  })

  it.each(['!unknown 你好', 'cmd:unknown 你好', '/unknown 你好', '!sid', '!other'])('同步自定义命令前缀后跳过 %s', async (text) => {
    const bot = harness(undefined, ['!', 'cmd:'], { ...config, ignoredCommandPrefixes: ['!', 'cmd:'] })
    const { replies, fetcher, report } = await bot.deliver('C2C_MESSAGE_CREATE', text)
    expect(fetcher).not.toHaveBeenCalled()
    expect(replies.length).toBeLessThanOrEqual(1)
    expect(report.errors).toEqual([])
  })

  it('自定义前缀下普通聊天和原有 AI 命令均有效，命令不重复回复', async () => {
    for (const text of ['你好', '!ai 你好']) {
      const bot = harness(undefined, ['!'], { ...config, ignoredCommandPrefixes: ['!'] })
      const { replies, fetcher, report } = await bot.deliver('C2C_MESSAGE_CREATE', text)
      expect(replies).toEqual(['你好。'])
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(report.errors).toEqual([])
    }
  })
})

describe('官方配置校验和 writeOnly 机制', () => {
  it('默认配置合法、超出边界被拒绝', () => {
    expect(validateConfig(configSchema, config)).toEqual([])
    expect(validateConfig(configSchema, { ...config, timeoutMs: 30000 })).not.toEqual([])
    expect(validateConfig(configSchema, { ...config, maxOutputTokens: 65537 })).not.toEqual([])
    expect(readConfig({ ...config, maxReplyChars: 501 })!.maxReplyChars).toBeUndefined()
    expect(validateConfig(configSchema, { ...config, ignoredCommandPrefixes: [123] })).not.toEqual([])
    expect(readConfig({ ...config, ignoredCommandPrefixes: [''] })).toBeNull()
  })

  it('旧配置自动补齐前缀默认值，保留原 Key，不要求迁移', () => {
    const { ignoredCommandPrefixes: _prefixes, enableGoogleSearch: _search,
      enableTavilySearch: _tavily, tavilyApiKey: _key, ...oldConfig } = config
    expect(validateConfig(configSchema, oldConfig)).toEqual([])
    expect(withConfigDefaults(oldConfig, defaultConfig, configSchema)).toEqual(config)
  })

  it('管理端只收到占位符，保存未改字段可以保留原 Key', () => {
    const both = { ...config, tavilyApiKey: 'local-tavily-test-credential' }
    const masked = maskSecrets(configSchema, both)
    for (const key of [both.apiKey, both.tavilyApiKey]) expect(JSON.stringify(masked)).not.toContain(key)
    expect(masked).toMatchObject({ apiKey: '__qflare_secret__:apiKey', tavilyApiKey: '__qflare_secret__:tavilyApiKey' })
    expect(restoreSecrets(configSchema, masked, both)).toEqual(both)
    expect(restoreSecrets(configSchema, { ...config, apiKey: '' }, config)).toMatchObject({ apiKey: '' })
  })
})

describe('Tavily 命令与真实 dispatcher', () => {
  it.each(['C2C_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE'])('%s 的长回答按真实Session分段，不发主动消息或触发双回复', async (type) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ candidates: [{ content: { parts: [{ text: '长'.repeat(6000) }] } }] }))
    const bot = harness(fetcher)
    const { replies, report } = await bot.deliver(type, type.startsWith('GROUP') ? '<@123456> /ai 详细解释' : '/ai 详细解释')
    expect(replies).toHaveLength(type.startsWith('GROUP') ? 5 : 4)
    expect(replies.at(-1)).toContain('/more')
    for (const reply of replies) expect(new TextEncoder().encode(reply as string).byteLength).toBeLessThanOrEqual(2000)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(report.errors).toEqual([])
    expect(report.matched).toEqual([{ plugin: 'gemini', kind: 'command', name: 'ai' }])
  })
  it.each(['C2C_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE'])('%s 的 /search 只搜索/回复一次', async (type) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).includes('tavily')
      ? Response.json({ results: [{ title: '来源', url: 'https://source.test/', content: '资料' }] })
      : Response.json({ candidates: [{ content: { parts: [{ text: '整理回答' }] } }] }))
    const bot = harness(fetcher, ['/'], { ...config, enableTavilySearch: true, tavilyApiKey: 'local-tavily-test-credential' })
    const { replies, report } = await bot.deliver(type, type.startsWith('GROUP') ? '<@123456> /search 关键词' : '/search 关键词')
    expect(replies).toEqual(['整理回答\n来源：\n来源 https://source.test/'])
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(report.matched).toEqual([{ plugin: 'gemini', kind: 'command', name: 'search' }])
    expect(report.errors).toEqual([])
  })
  it('未 @ 群的 /search 不回复、不请求', async () => {
    const { replies, fetcher } = await harness(undefined, ['/'], { ...config, enableTavilySearch: true, tavilyApiKey: 'local-test-key' })
      .deliver('GROUP_MESSAGE_CREATE', '/search 新闻')
    expect(replies).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
  })
})
