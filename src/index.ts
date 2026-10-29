import { definePlugin, isMessageEvent } from '@qqbot/sdk'
import type { CommandInput } from '@qqbot/sdk'
import { configSchema, defaultConfig, readConfig, type Config } from './config.js'
import { askGemini, GeminiError, tips } from './gemini.js'
import { conversationKey, loadHistory, saveHistory, type ChatMessage } from './history.js'
import { needsSearch, reserveSearch, searchTavily, TavilyError, SEARCH_INTERVAL_MS } from './tavily.js'
import { hideKey } from './grounding.js'

export function createGeminiPlugin(fetcher: typeof fetch = (...args) => fetch(...args)) {
  // 只保存冷却时间，不保存问答。Worker isolate 重建或扩容后会重置，非全局强限流。
  const users = new Map<string, number>()
  let busy = false
  let nextRequestAt = 0
  let activeHistoryKey: string | null = null
  let resetDuringRequest = false
  let nextSearchAt = 0

  async function chat({ session, ctx, argText }: Pick<CommandInput<Config>, 'session' | 'ctx' | 'argText'>, forceSearch = false) {
    if (session.scene !== 'c2c' && session.scene !== 'group') return
    if (session.scene === 'group' && !session.atMe) return
    if (!session.canReply) return
    if (forceSearch && (!isMessageEvent(session.event) || session.attachments.length)) return
    let question = argText.trim()
    if (!question) return forceSearch ? '用法：/search 搜索关键词（群聊请先 @机器人）。' : '用法：/ai 你的问题（群聊请先 @机器人）。'
    const config = readConfig(ctx.config)
    if (!config) return 'AI 配置异常，请联系机器人管理员。'
    if (!config.apiKey || config.apiKey.startsWith('__qflare_secret__:')) return 'AI 尚未配置，请联系机器人管理员。'
    if (Array.from(question).length > config.maxInputChars) return `问题太长，请限制在 ${config.maxInputChars} 字符以内。`
    question = hideKey(question, config.apiKey, config.tavilyApiKey)
    const search = forceSearch || (config.enableTavilySearch && needsSearch(question))
    if (search && !config.enableTavilySearch) return '联网搜索未开启，请联系机器人管理员。'
    if (search && (!config.tavilyApiKey || config.tavilyApiKey.startsWith('__qflare_secret__:'))) return '联网搜索尚未配置，请联系机器人管理员。'

    const now = Date.now()
    const user = JSON.stringify([session.botId, session.userId])
    if (busy) return 'AI 正在回答，请稍后再问。'
    if (now < nextRequestAt || now < (users.get(user) ?? 0)) return '提问太频繁，请稍后再试。'
    for (const [id, until] of users) if (until <= now) users.delete(id)
    if (users.size >= 1024) return 'AI 服务暂时繁忙，请稍后再试。'
    users.set(user, now + 10000)
    nextRequestAt = now + 6000
    busy = true
    const key = conversationKey(session)
    activeHistoryKey = key
    resetDuringRequest = false
    try {
      let results
      if (search) {
        if (now < nextSearchAt) throw new TavilyError('rate')
        nextSearchAt = now + SEARCH_INTERVAL_MS
        await reserveSearch(ctx.kv, now)
        results = await searchTavily(question, config, fetcher)
      }
      let history: ChatMessage[] = []
      if (key) {
        try { history = await loadHistory(ctx.kv, key) }
        catch { ctx.logger.warn('Gemini 历史读取失败', { code: 'history_read' }) }
      }
      if (resetDuringRequest) history = []
      const reply = await askGemini(question, config, fetcher, history, results)
      if (key && !resetDuringRequest) {
        try {
          await saveHistory(ctx.kv, key, history, question, reply)
          // /reset 若发生在 KV 写入期间，写入完成后再次删除，避免恢复已重置的历史。
          if (resetDuringRequest) await ctx.kv.delete(key)
        } catch { ctx.logger.warn('Gemini 历史保存失败', { code: 'history_write' }) }
      }
      return reply
    } catch (error) {
      if (error instanceof TavilyError) {
        ctx.logger.warn('Tavily 搜索未完成', { code: error.code })
        return error.message
      }
      const code = error instanceof GeminiError ? error.code : 'unavailable'
      ctx.logger.warn('Gemini 请求未完成', {
        code,
        ...(error instanceof GeminiError && error.diagnostic ? { error: error.diagnostic } : {}),
        ...(error instanceof GeminiError && error.api ? { api: error.api } : {}),
      })
      return tips[code]
    } finally {
      activeHistoryKey = null
      busy = false
    }
  }

  return definePlugin<Config>({
    name: 'gemini',
    apiVersion: 4,
    displayName: 'Gemini 文本问答',
    description: '通过 Gemini 进行中文文本问答，支持会话上下文与可选联网搜索',
    permissions: ['net', 'kv'],
    configSchema,
    defaultConfig,
    commands: {
      ai: {
        description: '向 AI 提问',
        usage: '/ai <问题>',
        scenes: ['c2c', 'group'],
        handler: chat,
      },
      search: {
        description: '联网搜索并由 AI 整理回答',
        usage: '/search <关键词>',
        scenes: ['c2c', 'group'],
        handler: (input) => chat(input, true),
      },
      reset: {
        description: '清除当前对话历史',
        usage: '/reset',
        scenes: ['c2c', 'group'],
        async handler({ session, ctx }) {
          if (session.scene !== 'c2c' && session.scene !== 'group') return
          if (session.scene === 'group' && !session.atMe) return
          if (!session.canReply) return
          const key = conversationKey(session)
          if (!key) return '无法识别当前会话，请稍后再试。'
          if (activeHistoryKey === key) resetDuringRequest = true
          try {
            await ctx.kv.delete(key)
            return '当前会话的对话历史已清除。'
          } catch {
            ctx.logger.warn('Gemini 历史重置失败', { code: 'history_reset' })
            return '暂时无法清除对话历史，请稍后再试。'
          }
        },
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
