import { definePlugin } from '@qqbot/sdk'
import { configSchema, defaultConfig, readConfig, type Config } from './config.js'
import { askGemini, GeminiError, tips } from './gemini.js'

export function createGeminiPlugin(fetcher: typeof fetch = (...args) => fetch(...args)) {
  // 只保存冷却时间，不保存问答。Worker isolate 重建或扩容后会重置，非全局强限流。
  const users = new Map<string, number>()
  let busy = false
  let nextRequestAt = 0

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
        async handler({ session, ctx, argText }) {
          // SDK 测试助手直接调用 handler，线上还有 dispatcher 的 scenes 筛选。
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
          // 正常 QQ 事件都有 userId；内存也有固定上限。
          if (users.size >= 1024) return 'AI 服务暂时繁忙，请稍后再试。'
          users.set(user, now + 10000)
          nextRequestAt = now + 6000
          busy = true
          try {
            return await askGemini(question, config, fetcher)
          } catch (error) {
            const code = error instanceof GeminiError ? error.code : 'unavailable'
            ctx.logger.warn('Gemini 请求未完成', { code })
            return tips[code]
          } finally {
            busy = false
          }
        },
      },
    },
  })
}

export default createGeminiPlugin()
