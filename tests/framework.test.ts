// 开发期与相邻的真实 QFlareBot v0.6.1 源码联测；这些 import 不会进入插件产物。
import { describe, expect, it, vi } from 'vitest'
import { createMockContext } from '@qqbot/sdk/testing'
import { extractManifest } from '@qqbot/sdk'
import { buildSession } from '../../QFlareBot/packages/runtime/src/session.js'
import { dispatch } from '../../QFlareBot/packages/runtime/src/dispatcher.js'
import { PluginRegistry } from '../../QFlareBot/packages/runtime/src/registry.js'
import { maskSecrets, restoreSecrets } from '../../QFlareBot/packages/runtime/src/configSecrets.js'
import { validateConfig } from '../../QFlareBot/packages/runtime/src/configSchema.js'
import type { ContextFactory } from '../../QFlareBot/packages/runtime/src/context.js'
import type { OutgoingMessage } from '@qqbot/sdk'
import sid from '../../QFlareBot/plugins/sid/src/index.js'
import t2i from '../../QFlareBot/plugins/t2i/src/index.js'
import { createGeminiPlugin } from '../src/index.js'
import { configSchema, defaultConfig } from '../src/config.js'

const config = { ...defaultConfig, apiKey: 'local-test-credential' }

async function deliver(type: string, content: string, mentions: unknown[] = []) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '你好。' }] } }],
  }))
  const plugin = createGeminiPlugin(fetcher)
  const replies: OutgoingMessage[] = []
  const session = buildSession({ op: 0, t: type, id: 'test-event', d: {
    id: 'test-message', content, mentions, group_openid: type.startsWith('GROUP') ? 'test-group' : undefined,
    author: { user_openid: 'test-user', member_openid: 'test-member' },
  } } as Parameters<typeof buildSession>[0], {
    botId: 'test-bot', maxPassiveReplies: 5,
    sender: { async sendMessage(_target, message) {
      replies.push(message)
      return { ok: true, status: 200, raw: null }
    } },
  })
  const ctx = createMockContext(plugin, { config })
  const registry = new PluginRegistry([plugin, sid, t2i])
  const report = await dispatch(session, {
    registry,
    snapshot: { revision: 1, plugins: {} },
    contexts: { prepare: async () => ctx } as unknown as ContextFactory,
    commandPrefixes: ['/'], logger: ctx.logger,
  })
  return { replies, fetcher, report, registry, session }
}

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
    const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string)
    expect(body.contents[0].parts).toEqual([{ text: '你好' }])
  })

  it.each([
    ['GROUP_MESSAGE_CREATE', '/ai 你好'],
    ['GROUP_AT_MESSAGE_CREATE', '<@123456> 普通聊天'],
    ['C2C_MESSAGE_CREATE', '/aix 你好'],
  ])('忽略 %s 中的不符合条件消息：%s', async (type, content) => {
    const { replies, fetcher } = await deliver(type, content)
    expect(replies).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('与内置 sid、T2I 注册共存，/sid 仍交给原插件', async () => {
    const { registry, report, replies, fetcher } = await deliver('C2C_MESSAGE_CREATE', '/sid')
    expect(registry.all().map((p) => p.manifest.name)).toEqual(['gemini', 'sid', 't2i'])
    expect(registry.providerOf('t2i')).toBe('t2i')
    expect(report.matched).toEqual([{ plugin: 'sid', kind: 'command', name: 'sid' }])
    expect(report.errors).toEqual([])
    expect(replies).toHaveLength(1)
    expect(fetcher).not.toHaveBeenCalled()
    expect(extractManifest(t2i, { version: '0.6.1' }).services).toContain('t2i')
  })
})

describe('官方配置校验和 writeOnly 机制', () => {
  it('默认配置合法、超出边界被拒绝', () => {
    expect(validateConfig(configSchema, config)).toEqual([])
    expect(validateConfig(configSchema, { ...config, timeoutMs: 30000 })).not.toEqual([])
    expect(validateConfig(configSchema, { ...config, maxReplyChars: 501 })).not.toEqual([])
  })

  it('管理端只收到占位符，保存未改字段可以保留原 Key', () => {
    const masked = maskSecrets(configSchema, config)
    expect(JSON.stringify(masked)).not.toContain(config.apiKey)
    expect(masked).toMatchObject({ apiKey: '__qflare_secret__:apiKey' })
    expect(restoreSecrets(configSchema, masked, config)).toEqual(config)
    expect(restoreSecrets(configSchema, { ...config, apiKey: '' }, config)).toMatchObject({ apiKey: '' })
  })
})
