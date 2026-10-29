import type { PluginContext, Route } from '@qqbot/sdk'
import { readConfig, type Config } from './config.js'
import { ACTIVE, ensureBackground, metaGet, metaPut, processBackground } from './background.js'
import { createInteraction, getInteraction, googleJson, keyFingerprint, object, validInteractionId, verifyCallback } from './interactions.js'
import { MODEL_IDS } from './models.js'
import { GeminiError } from './gemini.js'

const PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/tokens.css">
<style>body{font:16px system-ui;padding:20px;line-height:1.6}button{margin:8px;padding:10px}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>
<h2>Gemini 后台任务</h2><p>保留普通模式。先核验当前 Gemini Key 的真实后台权限，再在插件设置把推理执行模式选为 background。</p>
<p>权限检查每个模型只提交一次简短的后台问题，会使用少量 Token；不会开启计费。检查与读取均在 Worker 内使用已保存密钥。</p>
<button id="probe">核验三个模型后台权限</button><button id="refresh">刷新权限及任务状态</button>
<p>Cron 每分钟自动轮询。可选注册 Google 签名回调加快完成通知；若项目拒绝，继续使用 Cron，不升级套餐。</p>
<button id="webhook">注册完成/失败 Webhook</button><pre id="result">正在读取…</pre>
<p>单聊原消息最多 60 分钟、群聊 5 分钟内被动回复；普通答案自动发送，过长剩余正文用 /more。/reset 会取消旧任务。发送结果不确定时不自动重发。</p>
<script type="module">import {createBridge} from '/bridge.js';
const bridge=await createBridge(); const result=document.getElementById('result');
async function run(path,method='GET'){for(const b of document.querySelectorAll('button'))b.disabled=true;
try{const r=await bridge.fetch(path,{method});result.textContent=JSON.stringify(await r.json(),null,2)}catch{result.textContent='请求未完成，请刷新状态；不要连续重复注册或提交。'}
finally{for(const b of document.querySelectorAll('button'))b.disabled=false;bridge.resize()}}
document.getElementById('probe').onclick=()=>run('/api/probe','POST');document.getElementById('refresh').onclick=()=>run('/api/status');
document.getElementById('webhook').onclick=()=>run('/api/webhook','POST');await run('/api/status');</script></html>`

interface Probe { id?: string; fingerprint: string; retrieved: boolean; status: string; code?: string }
interface Webhook { id: string; secret: string; uri: string }
const code = (error: unknown) => error instanceof GeminiError ? error.code : 'state'
function configOf(ctx: PluginContext<Config>): Config {
  const config = readConfig(ctx.config)
  if (!config?.apiKey || config.apiKey.startsWith('__qflare_secret__:')) throw new GeminiError('auth')
  return config
}
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })

export function backgroundRoutes(fetcher: typeof fetch): Route<Config>[] {
  return [
    { method: 'GET', path: '/ui/', auth: 'admin', handler: () => new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } }) },
    { method: 'POST', path: '/api/probe', auth: 'admin', async handler({ ctx }) {
      try {
        const config = configOf(ctx); await ensureBackground(ctx)
        const fingerprint = await keyFingerprint(config.apiKey)
        // 原子领取一次核验，重复点击不反复生成；30分钟后可重查失败权限。
        const now = Date.now()
        const lock = await ctx.db.run(`INSERT INTO {async_meta}(name,value) VALUES ('probe_lock',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value WHERE CAST(value AS INTEGER)<?`, String(now + 1800000), String(now))
        if (!lock.changes) return json({ message: '已执行过核验，请点击刷新读取结果；失败权限可30分钟后重新检查。' })
        for (const model of MODEL_IDS) {
          const previous = await metaGet<Probe>(ctx, `model:${model}`)
          if (previous?.fingerprint === fingerprint && previous.id && (previous.retrieved || previous.status === 'in_progress')) continue
          try {
            const result = await createInteraction('只回复“权限检查通过”。', { ...config, model, maxOutputTokens: 64 }, fetcher)
            await metaPut(ctx, `model:${model}`, { id: result.id, fingerprint, retrieved: false, status: String(result.status) })
          } catch (error) { await metaPut(ctx, `model:${model}`, { fingerprint, retrieved: false, status: 'failed', code: code(error) }) }
        }
        return json({ message: '已提交权限检查，请点击刷新。未开启任何付费服务。' })
      } catch (error) { return json({ error: code(error) }, 503) }
    } },
    { method: 'GET', path: '/api/status', auth: 'admin', async handler({ ctx }) {
      try {
        const config = configOf(ctx); await ensureBackground(ctx)
        const fingerprint = await keyFingerprint(config.apiKey)
        const models = []
        for (const model of MODEL_IDS) {
          const probe = await metaGet<Probe>(ctx, `model:${model}`)
          if (probe?.id && probe.fingerprint === fingerprint && !probe.retrieved) {
            try {
              const result = await getInteraction(probe.id, config, fetcher)
              probe.status = String(result.status)
              probe.retrieved = ['completed', 'incomplete'].includes(probe.status)
              await metaPut(ctx, `model:${model}`, probe)
            } catch (error) { probe.code = code(error); await metaPut(ctx, `model:${model}`, probe) }
          }
          models.push({ model, verified: !!probe?.retrieved && probe.fingerprint === fingerprint, status: probe?.fingerprint === fingerprint ? probe.status : 'unchecked', ...(probe?.code ? { error: probe.code } : {}) })
        }
        const tasks = await ctx.db.all('SELECT state,model,created,updated,model_ms,error FROM {async_tasks} WHERE bot=? ORDER BY created DESC LIMIT 8', ctx.botId)
        return json({ executionMode: config.executionMode, models, webhook: !!await metaGet<Webhook>(ctx, 'webhook'), lastPollAt: await metaGet(ctx, 'last_cron_or_callback'), tasks })
      } catch (error) { return json({ error: code(error) }, 503) }
    } },
    { method: 'POST', path: '/api/webhook', auth: 'admin', async handler({ ctx }) {
      try {
        const config = configOf(ctx); await ensureBackground(ctx)
        if (!ctx.publicUrl || !ctx.publicUrl.startsWith('https://')) return json({ error: '需要在框架设置中填写 HTTPS 公开地址' }, 400)
        const uri = `${ctx.publicUrl}/p/gemini/callback`
        const existing = await metaGet<Webhook>(ctx, 'webhook')
        if (existing) return json({ message: existing.uri === uri ? '已注册，无需重复创建。' : '公开地址已变化，请管理员处理原注册；未重复创建。' })
        const claimed = await ctx.db.run("INSERT OR IGNORE INTO {async_meta}(name,value) VALUES ('webhook_registration','pending')")
        if (!claimed.changes) return json({ message: '注册已尝试，请刷新状态；结果不确定时不会重复注册。Cron仍可使用。' })
        try {
          const result = await googleJson('https://generativelanguage.googleapis.com/v1/webhooks', 'POST', config, fetcher,
            { name: 'QFlareBot Gemini', uri, subscribed_events: ['interaction.completed', 'interaction.failed'] })
          if (typeof result.new_signing_secret !== 'string' || typeof result.id !== 'string') throw new GeminiError('response')
          // Google只返回一次的签名密钥保存在插件专属D1内，不送浏览器或日志。
          await metaPut(ctx, 'webhook', { id: result.id, secret: result.new_signing_secret, uri })
          return json({ message: '签名 Webhook 已注册并安全保存，Cron继续兜底。' })
        } catch (error) { return json({ error: code(error), message: '当前项目未成功注册回调；继续使用每分钟Cron，不开启计费。' }, 400) }
      } catch (error) { return json({ error: code(error) }, 503) }
    } },
    { method: 'POST', path: '/callback', auth: 'public', async handler({ ctx, request }) {
      try {
        const config = configOf(ctx); await ensureBackground(ctx)
        const hook = await metaGet<Webhook>(ctx, 'webhook')
        if (!hook) return json({ error: '未启用回调' }, 403)
        const event = await verifyCallback(request, hook.secret)
        if (!event) return json({ error: '签名无效或已过期' }, 401)
        if (!['interaction.completed', 'interaction.failed'].includes(String(event.type))) return json({ ok: true })
        const id = object(event.data).id
        if (!validInteractionId(id)) return json({ error: '无效任务标识' }, 400)
        const task = await ctx.db.first(`SELECT id FROM {async_tasks} WHERE interaction=? AND bot=? AND state IN ${ACTIVE}`, id, ctx.botId)
        if (task) {
          // 只把通知当唤醒信号，答案和状态必须重新向Google拉取；不信任事件中的正文。
          await ctx.db.run("UPDATE {async_tasks} SET next_poll=0 WHERE interaction=? AND bot=? AND state='pending'", id, ctx.botId)
          ctx.waitUntil(processBackground(ctx, config, fetcher, id, 1).catch(() => ctx.logger.warn('Gemini 回调处理未完成', { code: 'callback' })))
        }
        return json({ ok: true })
      } catch { return json({ error: '回调暂时不可用' }, 503) }
    } },
  ]
}
