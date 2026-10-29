import { definePlugin, isMessageEvent } from '@qqbot/sdk'
import type { CommandInput } from '@qqbot/sdk'
import { configSchema, defaultConfig, readConfig, type Config } from './config.js'
import { askGemini, GeminiError, tips } from './gemini.js'

export function createGeminiPlugin(fetcher: typeof fetch = (...args) => fetch(...args)) {
  // 只保存冷却时间，不保存问答。Worker isolate 重建或扩容后会重置，非全局强限流。
  const users = new Map<string, number>()
  let busy = false
  let nextRequestAt = 0

  async function chat({ session, ctx, argText }: Pick<CommandInput<Config>, 'session' | 'ctx' | 'argText'>) {
    if (session.scene !== 'c2c' && session.scene !== 'group') return
    if (session.scene === 'group' && !session.atMe) return
    if (!session.canReply) return
    const question = argText.trim()
    if (!question) return '用法：/ai 你的问题（群聊请先 @机器人）。'
    const config = readConfig(ctx.config)
    if (!config) return 'AI 配置异常，请联系机器人管理员。'
    if (!config.apiKey || config.apiKey.startsWith('__qflare_secret__:')) return 'AI 尚未配置，请联系机器人管理员。'
    if (Array.from(question).length > config.maxInputChars) return `问题太长，请限制在 ${config.maxInputChars} 字符以内。`

    const now = Date.now()
    const user = JSON.stringify([session.botId, session.userId])
    if (busy) return 'AI 正在回答，请稍后再问。'
    if (now < nextRequestAt || now < (users.get(user) ?? 0)) return '提问太频繁，请稍后再试。'
    for (const [id, until] of users) if (until <= now) users.delete(id)
    if (users.size >= 1024) return 'AI 服务暂时繁忙，请稍后再试。'
    users.set(user, now + 10000)
    nextRequestAt = now + 6000
    busy = true
    try {
      return await askGemini(question, config, fetcher)
    } catch (error) {
      const code = error instanceof GeminiError ? error.code : 'unavailable'
      ctx.logger.warn('Gemini 请求未完成', {
        code,
        ...(error instanceof GeminiError && error.diagnostic ? { error: error.diagnostic } : {}),
      })
      return tips[code]
    } finally {
      busy = false
    }
  }

  return definePlugin<Config>({
    name: 'gemini',
    apiVersion: 4,
    displayName: 'Gemini 文本问答',
    description: '通过 Gemini 进行单轮中文文本问答',
    permissions: ['net'],
    configSchema,
    defaultConfig,
    commands: {
      ai: {
        description: '向 AI 提问',
        usage: '/ai <问题>',
        scenes: ['c2c', 'group'],
        handler: chat,
      },
    },
    regex: [{
      pattern: '\\S',
      scenes: ['c2c', 'group'],
      priority: -100,
      block: false,
      handler({ session, ctx }) {
        if (session.scene !== 'c2c' && session.scene !== 'group') return
        if (session.scene === 'group' && !session.atMe) return
        if (!isMessageEvent(session.event) || session.attachments.length) return
        const text = session.content.trim()
        if (!text || text.startsWith('/')) return
        const prefixes = ctx.config?.ignoredCommandPrefixes ?? defaultConfig.ignoredCommandPrefixes
        if (Array.isArray(prefixes) && prefixes.some((prefix) => typeof prefix === 'string' && prefix.length && text.startsWith(prefix))) return
        return chat({ session, ctx, argText: text })
      },
    }],
  })
}

export default createGeminiPlugin()
