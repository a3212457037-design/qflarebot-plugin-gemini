import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryKV, createMockContext, createMockSession } from '@qqbot/sdk/testing'
import { normalizePlugin, extractManifest, type DBStatement, type PluginDB, type Session } from '@qqbot/sdk'
import { scopeSql } from '@qqbot/sdk/sqlScope'
import { defaultConfig, readConfig, type Config } from '../src/config.js'
import { createGeminiPlugin } from '../src/index.js'
import { ensureBackground, metaPut, processBackground, reserveBackground, cancelBackground, type Task } from '../src/background.js'
import { API_REVISION, createInteraction, getInteraction, interactionAnswer, interactionFailure, INTERACTIONS_URL, keyFingerprint, verifyCallback } from '../src/interactions.js'
import { conversationKey, loadHistory, message } from '../src/history.js'
import { loadPending } from '../src/delivery.js'
import { MODEL_IDS } from '../src/models.js'

const config: Config = { ...defaultConfig, apiKey: 'fake-background-key', tavilyApiKey: 'fake-search-key', executionMode: 'background' }
const result = (id = 'v1_test', text = '后台回答', status = 'completed') => ({ id, status, steps: [
  { type: 'thought', summary: [{ type: 'text', text: '秘密思考' }], signature: 'secret-signature' },
  { type: 'user_input', content: [{ type: 'text', text: '用户输入不能当答案' }] },
  { type: 'model_output', content: [{ type: 'text', text }] },
] })
function sqlite(): PluginDB {
  const sql = new DatabaseSync(':memory:')
  const prepared = (text: string) => sql.prepare(scopeSql(text, 'p_gemini_'))
  const db = {
    table: (name: string) => 'p_gemini_' + name,
    exec: async (text: string) => { sql.exec(scopeSql(text, 'p_gemini_')) },
    run: async (text: string, ...params: unknown[]) => ({ changes: Number(prepared(text).run(...params as never[]).changes) }),
    all: async (text: string, ...params: unknown[]) => prepared(text).all(...params as never[]),
    first: async (text: string, ...params: unknown[]) => prepared(text).get(...params as never[]) ?? null,
    batch: async (items: DBStatement[]) => {
      sql.exec('BEGIN')
      try { const out = []; for (const item of items) out.push({ ...await db.run(item.sql, ...(item.params ?? [])), results: [] }); sql.exec('COMMIT'); return out }
      catch (e) { sql.exec('ROLLBACK'); throw e }
    },
  }
  return db as PluginDB
}
async function harness(scene: 'c2c' | 'group' = 'c2c') {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => init?.method === 'POST' ? Response.json({ id: 'v1_test', status: 'in_progress' }) : Response.json(result()))
  let plugin = createGeminiPlugin(fetcher)
  const db = sqlite(); const kv = createMemoryKV()
  const ctx = { ...createMockContext(plugin, { config, botId: 'bot', db, publicUrl: 'https://bot.test' }), kv }
  ctx.logger.warn = vi.fn()
  ctx.api.sendMessage = vi.fn().mockResolvedValue({ ok: true, status: 200, raw: {} })
  const session = createMockSession({ scene, botId: 'bot', targetId: scene === 'group' ? 'group' : 'user', userId: 'user', messageId: 'm1', timestamp: Date.now(), atMe: true, event: scene === 'group' ? 'qq.group.at_message' : 'qq.c2c.message', content: '你好' })
  await ensureBackground(ctx)
  for (const model of MODEL_IDS) await metaPut(ctx, `model:${model}`, { fingerprint: await keyFingerprint(config.apiKey), retrieved: true, status: 'completed' })
  const invoke = async (name = 'ai', text = '你好', s: Session = session) => normalizePlugin(plugin).commands.find(c => c.name === name)!.handler({ ctx, session: s, argText: text, args: [text], command: name })
  const poll = () => processBackground(ctx, config, fetcher)
  const task = () => db.first<Task>('SELECT * FROM {async_tasks} ORDER BY created DESC LIMIT 1')
  return { ctx, fetcher, session, db, kv, invoke, poll, task, restart: () => { plugin = createGeminiPlugin(fetcher) }, plugin }
}
afterEach(() => vi.useRealTimers())

describe('Interactions 官方 REST', () => {
  it.each([['PERMISSION_DENIED','auth'],['RESOURCE_EXHAUSTED','rate'],['UNAVAILABLE','unavailable']])('异步资源失败%s只输出安全分类', (status, expected) => {
    const error=interactionFailure({error:{code:status,message:config.apiKey,details:{secret:config.tavilyApiKey}}})
    expect(error).toBe(expected);expect(error).not.toContain(config.apiKey)
  })
  it.each(MODEL_IDS)('%s 提交 background/store/high，带六轮文本，不泄露 Key', async (model) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: 'v1_id', status: 'in_progress' }))
    const history = [message('user', '上轮'), message('model', '回答')]
    await createInteraction('本轮', { ...config, model }, fetcher, history)
    expect(fetcher).toHaveBeenCalledWith(INTERACTIONS_URL, expect.objectContaining({ redirect: 'manual', headers: { 'content-type': 'application/json', 'x-goog-api-key': config.apiKey, 'Api-Revision': API_REVISION } }))
    const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string)
    expect(body).toMatchObject({ model, background: true, store: true, generation_config: { thinking_level: 'high', thinking_summaries: 'none', max_output_tokens: 65536 } })
    expect(body.input.map((s: { type: string }) => s.type)).toEqual(['user_input', 'model_output', 'user_input'])
    expect(body).not.toHaveProperty('tools'); expect(body).not.toHaveProperty('previous_interaction_id')
    expect(JSON.stringify(body)).not.toContain(config.apiKey)
  })
  it('只解析最终文本，双密钥脱敏，incomplete 明确说明', () => {
    const text = interactionAnswer(result('v1_id', `${config.apiKey} ${config.tavilyApiKey} 正文`, 'incomplete'), config)
    expect(text).toContain('正文'); expect(text).toContain('未完成')
    expect(text).not.toContain(config.apiKey); expect(text).not.toContain(config.tavilyApiKey); expect(text).not.toContain('秘密思考')
  })
  it.each([301, 302, 307, 308])('HTTP %s 不跟随不重发', async (status) => {
    const f = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status, headers: { location: 'https://evil.test' } }))
    await expect(createInteraction('问题', config, f)).rejects.toMatchObject({ code: 'request' }); expect(f).toHaveBeenCalledTimes(1)
  })
  it.each([401, 403, 429, 500])('错误 %s 保留安全提示', async (status) => {
    const f = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { message: config.apiKey } }, { status }))
    await expect(createInteraction('问题', config, f)).rejects.not.toHaveProperty('message', config.apiKey); expect(f).toHaveBeenCalledTimes(1)
  })
  it('禁止 ID 注入主机和取得错误任务', async () => {
    const f = vi.fn<typeof fetch>().mockResolvedValue(Response.json(result('other')))
    await expect(getInteraction('../evil?key=x', config, f)).rejects.toMatchObject({ code: 'response' }); expect(f).not.toHaveBeenCalled()
    await expect(getInteraction('v1_test', config, f)).rejects.toMatchObject({ code: 'response' })
  })
  it('提交超时会中止，未知异常安全诊断同时隐藏两把 Key', async () => {
    vi.useFakeTimers()
    const f = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}))
    const pending = createInteraction('问题', config, f).catch(e => e)
    await vi.advanceTimersByTimeAsync(8001)
    expect(await pending).toMatchObject({ code: 'timeout' }); expect(f.mock.calls[0]![1]!.signal!.aborted).toBe(true)
    const broken = vi.fn<typeof fetch>().mockRejectedValue(new TypeError(`${config.apiKey} ${config.tavilyApiKey}`))
    const error = await createInteraction('问题', config, broken).catch(e => e)
    expect(JSON.stringify(error)).not.toContain(config.apiKey); expect(JSON.stringify(error)).not.toContain(config.tavilyApiKey)
  })
})

describe('持久化、自动投递及隔离', () => {
  it.each(['c2c', 'group'] as const)('%s 超过30秒、isolate重建后Cron自动回复一次并写上下文', async (scene) => {
    vi.useFakeTimers(); const b = await harness(scene)
    const value = await normalizePlugin(b.plugin).regex[0]!.handler({ session: b.session, ctx: b.ctx, match: ['你'] })
    expect(value).toBeUndefined(); expect(b.session.replies).toEqual([])
    const t = (await b.task())!; expect(t).toMatchObject({ interaction: 'v1_test', state: 'pending', bot: 'bot', user: 'user', message: 'm1', scene })
    b.restart(); await vi.advanceTimersByTimeAsync(61000); await b.poll(); await b.poll()
    expect(b.ctx.api.sendMessage).toHaveBeenCalledTimes(1)
    expect(b.ctx.api.sendMessage).toHaveBeenCalledWith({ scene, id: b.session.targetId }, '后台回答', { messageId: 'm1', msgSeq: 1 })
    expect((await b.task())!.state).toBe('delivered')
    expect(await loadHistory(b.kv, conversationKey(b.session)!)).toEqual([message('user', '你好'), message('model', '后台回答')])
  })
  it('同会话未完成任务阻止下一轮，SQL原子唯一索引防跨isolate重复提交', async () => {
    const b = await harness()
    const reserved = await Promise.allSettled([reserveBackground(b.ctx, b.session, config), reserveBackground(b.ctx, b.session, config)])
    expect(reserved.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    b.restart(); expect(await b.invoke()).toContain('已有后台任务'); expect(b.fetcher).not.toHaveBeenCalled()
  })
  it('不同用户、群和机器人按会话隔离；其他bot的Cron不投递', async () => {
    const b = await harness('group'); await b.invoke()
    for (const patch of [{ userId: 'other' }, { targetId: 'other-group' }, { botId: 'other-bot' }]) {
      const s = createMockSession({ ...b.session, ...patch, messageId: crypto.randomUUID() })
      const ctx = { ...b.ctx, botId: s.botId }
      expect((await reserveBackground(ctx, s, config)).conversation).not.toBe(conversationKey(b.session))
    }
    await processBackground({ ...b.ctx, botId: 'wrong-bot' }, config, b.fetcher)
    expect(b.ctx.api.sendMessage).not.toHaveBeenCalled()
  })
  it('Cron与回调重复执行原子认领，只读一次并发送一次', async () => {
    const b = await harness(); await b.invoke()
    await Promise.all([b.poll(), b.poll(), b.poll()])
    expect(b.fetcher.mock.calls.filter(([, init]) => init?.method === 'GET')).toHaveLength(1)
    expect(b.ctx.api.sendMessage).toHaveBeenCalledTimes(1)
  })
  it('/reset取消后旧任务不再回复或恢复历史，不影响其他用户和模型偏好', async () => {
    const b = await harness(); await b.invoke(); await b.ctx.kv.put('keep', '配置')
    await b.invoke('reset', ''); await b.poll()
    expect((await b.task())!.state).toBe('cancelled'); expect(b.ctx.api.sendMessage).not.toHaveBeenCalled()
    expect(await loadHistory(b.kv, conversationKey(b.session)!)).toEqual([]); expect(await b.ctx.kv.get('keep')).toBe('配置')
  })
  it('轮询等待期间reset会阻断完成结果', async () => {
    const b = await harness(); await b.invoke()
    b.fetcher.mockImplementation(async () => { await cancelBackground(b.ctx, b.session); return Response.json(result()) })
    await b.poll(); expect(b.ctx.api.sendMessage).not.toHaveBeenCalled(); expect(await loadHistory(b.kv, conversationKey(b.session)!)).toEqual([])
  })
  it('未知发送结果不盲目重发，uncertain继续保护会话顺序', async () => {
    const b = await harness(); await b.invoke(); b.ctx.api.sendMessage = vi.fn().mockRejectedValue(new Error('network'))
    await b.poll(); await b.poll()
    expect(b.ctx.api.sendMessage).toHaveBeenCalledTimes(1); expect((await b.task())!.state).toBe('uncertain')
  })
  it('发送后崩溃保留sending，恢复时不重复投递', async () => {
    vi.useFakeTimers(); const b = await harness(); await b.invoke()
    await b.db.run("UPDATE {async_tasks} SET state='sending' WHERE id=?", (await b.task())!.id)
    await vi.advanceTimersByTimeAsync(91000); await b.poll()
    expect((await b.task())!.state).toBe('uncertain'); expect(b.ctx.api.sendMessage).not.toHaveBeenCalled()
  })
  it('失败任务只发固定中文提示，不写未完成上下文', async () => {
    const b = await harness(); await b.invoke(); b.fetcher.mockResolvedValue(Response.json({ id: 'v1_test', status: 'failed', error: { message: config.apiKey } }))
    await b.poll(); expect(b.ctx.api.sendMessage).toHaveBeenCalledWith(expect.anything(), 'AI 后台任务未能完成，请稍后重新提问。', expect.anything())
    expect(await loadHistory(b.kv, conversationKey(b.session)!)).toEqual([])
  })
  it('POST结果未知不重新提交，数据库与日志不保留Key', async () => {
    const b = await harness(); b.fetcher.mockRejectedValue(new TypeError(`${config.apiKey} ${config.tavilyApiKey}`))
    expect(await b.invoke()).toContain('提交结果暂时无法确认'); await b.poll()
    expect(b.fetcher).toHaveBeenCalledTimes(1); expect((await b.task())!.state).toBe('submit_unknown')
    expect(JSON.stringify(await b.task())).not.toContain(config.apiKey)
    expect(JSON.stringify((b.ctx.logger.warn as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(config.apiKey)
  })
  it.each(['c2c', 'group'] as const)('%s被动回复窗口过期不发送主动消息', async (scene) => {
    vi.useFakeTimers(); const b = await harness(scene); await b.invoke()
    await vi.advanceTimersByTimeAsync(scene === 'c2c' ? 3600001 : 300001); await b.poll()
    expect(b.ctx.api.sendMessage).not.toHaveBeenCalled(); expect((await b.task())!.state).toBe('expired')
  })
  it('未完成轮询可恢复租约，GET失败只在下次Cron重查', async () => {
    vi.useFakeTimers(); const b = await harness(); await b.invoke()
    b.fetcher.mockResolvedValueOnce(Response.json({ id: 'v1_test', status: 'in_progress' }))
    await b.poll(); expect((await b.task())!.state).toBe('pending')
    await b.poll(); expect(b.fetcher).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(61000); await b.poll(); expect((await b.task())!.state).toBe('delivered')
  })
  it('中文长回复安全分段，递增seq，剩余正文可用原有more读取', async () => {
    const b = await harness(); await b.invoke(); const text = '中文😀'.repeat(2000)
    b.fetcher.mockResolvedValue(Response.json(result('v1_test', text))); await b.poll()
    const calls = (b.ctx.api.sendMessage as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(4); expect(calls.map(c => c[2].msgSeq)).toEqual([1, 2, 3, 4])
    expect(calls.at(-1)![1]).toContain('/more')
    for (const c of calls) expect(new TextEncoder().encode(c[1]).byteLength).toBeLessThanOrEqual(2000)
    const pending = (await loadPending(b.ctx, b.session))!
    expect(calls.slice(0, 3).map(c => c[1]).join('') + pending.text.slice(pending.offset)).toBe(text)
  })
  it('旧配置仍默认普通模式；清单包含Cron、D1和受保护管理入口', () => {
    const { executionMode: _, ...old } = config
    expect(readConfig(old as Config)!.executionMode).toBe('generateContent')
    const manifest = extractManifest(createGeminiPlugin(), { version: '0.1.0' })
    expect(manifest.permissions).toContain('db'); expect(manifest.cron).toMatchObject([{ cron: '* * * * *' }])
    expect(createGeminiPlugin().routes!.filter(r => r.path !== '/callback').every(r => r.auth === 'admin')).toBe(true)
  })
  it('权限未经实际提交和读取核验则拒绝后台，不换模型或回退接口', async () => {
    const b = await harness(); await metaPut(b.ctx, `model:${config.model}`, { fingerprint: 'old', retrieved: true })
    expect(await b.invoke()).toContain('尚未核验'); expect(b.fetcher).not.toHaveBeenCalled()
  })
  it('第二轮请求携带前轮文本，模型切换及Tavily资料不丢失', async () => {
    vi.useFakeTimers(); const b = await harness(); await b.invoke(); await b.poll()
    await vi.advanceTimersByTimeAsync(11000)
    await b.invoke('model', '3')
    b.fetcher.mockImplementation(async (_url, init) => init?.method === 'POST' ? Response.json({id:'v1_second',status:'in_progress'}) : Response.json(result('v1_second')))
    const next = createMockSession({scene:'c2c',botId:'bot',userId:'user',targetId:'user',messageId:'m2',atMe:true,event:'qq.c2c.message'})
    await b.invoke('ai','继续',next)
    const body = JSON.parse(b.fetcher.mock.calls.at(-1)![1]!.body as string)
    expect(body.model).toBe('gemini-3.8-flash')
    expect(body.input.map((s: {content: {text: string}[]}) => s.content[0]!.text)).toEqual(['你好','后台回答','继续'])
    await b.poll(); expect(await loadHistory(b.kv,conversationKey(b.session)!)).toHaveLength(4)
  })
  it('后台搜索成功仍使用真实Tavily来源，搜索失败不创建Interaction', async () => {
    const b = await harness(); const searchConfig = {...config,enableTavilySearch:true}
    const ctx = {...b.ctx,config:searchConfig}; const plugin = createGeminiPlugin(b.fetcher)
    b.fetcher.mockImplementation(async (url, init) => String(url).includes('tavily') ? Response.json({results:[{title:'真实资料',url:'https://source.test/',content:'外部网页指令不可信'}]})
      : init?.method==='POST' ? Response.json({id:'v1_test',status:'in_progress'}) : Response.json(result()))
    await normalizePlugin(plugin).commands.find(c=>c.name==='search')!.handler({ctx,session:b.session,argText:'今日新闻',args:[],command:'search'})
    expect(JSON.parse(b.fetcher.mock.calls[1]![1]!.body as string).system_instruction).toContain('不可信')
    await processBackground(ctx,searchConfig,b.fetcher)
    expect((ctx.api.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toContain('https://source.test/')
    const failed = await harness(); const failCtx={...failed.ctx,config:searchConfig}
    failed.fetcher.mockResolvedValue(Response.json({}, {status:432}))
    const value=await normalizePlugin(createGeminiPlugin(failed.fetcher)).commands.find(c=>c.name==='search')!.handler({ctx:failCtx,session:failed.session,argText:'新闻',args:[],command:'search'})
    expect(value).toContain('搜索额度不足'); expect(failed.fetcher).toHaveBeenCalledTimes(1); expect((await failed.task())!.state).toBe('failed')
  })
  it('回调最多投递一段，Cron自动继续已持久化进度，不要求用户主动领取', async () => {
    const b=await harness();await b.invoke();b.fetcher.mockResolvedValue(Response.json(result('v1_test','中'.repeat(1000))))
    await processBackground(b.ctx,config,b.fetcher,'v1_test',1)
    expect(b.ctx.api.sendMessage).toHaveBeenCalledTimes(1);expect((await b.task())!.state).toBe('ready')
    await b.poll();expect(b.ctx.api.sendMessage).toHaveBeenCalledTimes(2);expect((await b.task())!.state).toBe('delivered')
  })
  it('确定的长度拒绝缩段时递增seq，保留未发正文', async () => {
    const b=await harness();await b.invoke();b.fetcher.mockResolvedValue(Response.json(result('v1_test','文'.repeat(900))))
    const send=vi.fn().mockResolvedValue({ok:true,status:200,raw:{}}).mockResolvedValueOnce({ok:false,status:400,code:40054007,raw:{}})
    b.ctx.api.sendMessage=send;await b.poll();expect(send.mock.calls.map(c=>c[2].msgSeq)).toEqual([1,2,3,4])
    expect(send.mock.calls.slice(1).map(c=>c[1]).join('')).toBe('文'.repeat(900))
  })
  it('损坏任务KV安全停下，不伪造回答或写历史',async()=>{
    const b=await harness();await b.invoke();await b.kv.put('async:payload:'+(await b.task())!.id,'{bad')
    await b.poll();expect(b.ctx.api.sendMessage).not.toHaveBeenCalled();expect(await loadHistory(b.kv,conversationKey(b.session)!)).toEqual([])
  })
})

async function signed(body: string, secret = btoa('fake-signing-secret'), seconds = Math.floor(Date.now() / 1000)) {
  const id = 'event-1'; const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('fake-signing-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${seconds}.${body}`))
  return { secret: 'whsec_' + secret, request: new Request('https://bot.test/p/gemini/callback', { method: 'POST', body, headers: {
    'webhook-id': id, 'webhook-timestamp': String(seconds), 'webhook-signature': 'v1,' + btoa(String.fromCharCode(...new Uint8Array(sig))),
  } }) }
}
describe('Webhook验签及回调', () => {
  it('HMAC原文验签，拒绝伪造/过期/大正文，不泄露签名密钥', async () => {
    const body = JSON.stringify({ type: 'interaction.completed', data: { id: 'v1_test' } })
    const a = await signed(body); expect(await verifyCallback(a.request, a.secret)).toEqual(JSON.parse(body))
    const b = await signed(body); expect(await verifyCallback(b.request, btoa('wrong'))).toBeNull()
    const c = await signed(body, undefined, Math.floor(Date.now() / 1000) - 301); expect(await verifyCallback(c.request, c.secret)).toBeNull()
    const d = await signed('x'.repeat(16385)); expect(await verifyCallback(d.request, d.secret)).toBeNull()
  })
  it('重复签名通知与Cron共享认领；未知任务不触发Google；无签名拒绝', async () => {
    const b = await harness(); await b.invoke(); const secret = 'whsec_' + btoa('fake-signing-secret')
    await metaPut(b.ctx, 'webhook', { id: 'hook', secret, uri: 'https://bot.test/p/gemini/callback' })
    const jobs: Promise<unknown>[] = []; b.ctx.waitUntil = p => jobs.push(p)
    const handler = b.plugin.routes!.find(r => r.path === '/callback')!.handler
    const event = JSON.stringify({ type: 'interaction.completed', data: { id: 'v1_test' } })
    const request = async (text: string) => handler({ ctx: b.ctx, request: (await signed(text)).request, params: {}, authenticated: false })
    expect((await request(event)).status).toBe(200); expect((await request(event)).status).toBe(200)
    await Promise.all(jobs); await b.poll(); expect(b.ctx.api.sendMessage).toHaveBeenCalledTimes(1)
    const count = b.fetcher.mock.calls.length
    await request(JSON.stringify({ type: 'interaction.completed', data: { id: 'unknown' } })); expect(b.fetcher).toHaveBeenCalledTimes(count)
    const bad = await handler({ ctx: b.ctx, request: new Request('https://bot.test', { method: 'POST', body: event }), params: {}, authenticated: false })
    expect(bad.status).toBe(401)
  })
  it('Webhook注册仅订阅两种事件，签名密钥留在服务端不回显，重复操作不注册两次',async()=>{
    const b=await harness();b.fetcher.mockResolvedValue(Response.json({id:'hook',new_signing_secret:'whsec_fake-signing-secret'}))
    const handler=b.plugin.routes!.find(r=>r.path==='/api/webhook')!.handler
    const input={ctx:b.ctx,request:new Request('https://bot.test'),params:{},authenticated:true}
    const response=await handler(input);expect(await response.text()).not.toContain('whsec_fake-signing-secret')
    const body=JSON.parse(b.fetcher.mock.calls[0]![1]!.body as string)
    expect(body).toEqual({name:'QFlareBot Gemini',uri:'https://bot.test/p/gemini/callback',subscribed_events:['interaction.completed','interaction.failed']})
    await handler(input);expect(b.fetcher).toHaveBeenCalledTimes(1)
  })
  it('当前项目拒绝Webhook不会升级付费或影响Cron',async()=>{
    const b=await harness();b.fetcher.mockResolvedValue(Response.json({error:{message:config.apiKey}},{status:403}))
    const handler=b.plugin.routes!.find(r=>r.path==='/api/webhook')!.handler
    const response=await handler({ctx:b.ctx,request:new Request('https://bot.test'),params:{},authenticated:true})
    const body=await response.text();expect(body).toContain('Cron');expect(body).not.toContain(config.apiKey)
    expect(b.fetcher).toHaveBeenCalledTimes(1)
  })
})
