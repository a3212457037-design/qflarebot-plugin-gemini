// 仅本地 workerd 冒烟；使用相邻 QFlareBot 的 Wrangler 开发依赖，不请求外网。
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../../QFlareBot/package.json', import.meta.url))
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'))
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare')
const { build } = wranglerRequire('esbuild')
const { outputFiles } = await build({
  stdin: {
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    contents: `
      import { createGeminiPlugin } from './dist/plugin.js';
      export default {
        async fetch(request) {
          const url = new URL(request.url);
          let calls = 0;
          let sent;
          const plugin = createGeminiPlugin(async (_url, init) => {
            calls++;
            sent = JSON.parse(init.body);
            return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Workers 回答成功' }] }, groundingMetadata: { groundingChunks: [{web: {uri: 'https://source.test/', title: '来源'}}] } }] });
          });
          const scene = url.pathname.slice(1);
          const atMe = url.searchParams.get('at') === '1';
          const session = { scene, event: scene === 'c2c' ? 'qq.c2c.message' : atMe ? 'qq.group.at_message' : 'qq.group.message', targetId: scene === 'group' ? 'test-group' : 'test', attachments: [], content: '你好', atMe, canReply: true, botId: 'test', userId: 'test' };
          const data = new Map();
          const writes = [];
          const ctx = { config: { apiKey: 'local-test-credential', maxInputChars: 500, maxReplyChars: 400, maxOutputTokens: 512, timeoutMs: 15000, enableGoogleSearch: url.searchParams.get('search') === '1' }, logger: { warn() {} }, kv: {
            async get(key) { return data.get(key) ?? null; },
            async put(key, value, options) { data.set(key, JSON.stringify(value)); writes.push({ value, options }); },
            async delete(key) { data.delete(key); }
          } };
          if (url.searchParams.get('mode') === 'reset') {
            const result = await plugin.commands.reset.handler({ session, ctx, argText: '' });
            return Response.json({ reply: result ?? null, calls, entries: data.size });
          }
          const result = url.searchParams.get('mode') === 'text'
            ? await plugin.regex[0].handler({ session, ctx, match: ['你'] })
            : await plugin.commands.ai.handler({ session, ctx, argText: '你好' });
          return Response.json({ reply: result ?? null, calls, writes, tools: sent?.tools ?? null });
        }
      };
    `,
  },
  write: false, bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
})
const options = {
  modules: true, script: outputFiles[0].text,
  compatibilityDate: '2026-09-01',
}
const mf = new Miniflare(typeof convertV4MiniflareOptions === 'function' ? convertV4MiniflareOptions(options) : options)
try {
  for (const mode of ['command', 'text']) {
    for (const scene of ['c2c', 'group']) {
      const result = await (await mf.dispatchFetch(`https://smoke.test/${scene}?at=1&mode=${mode}`)).json()
      assert.equal(result.reply, 'Workers 回答成功')
      assert.equal(result.calls, 1)
      assert.equal(result.tools, null)
      assert.deepEqual(result.writes[0].options, { ttl: 86400 })
      assert.equal(result.writes[0].value.messages.length, 2)
    }
    const skipped = await (await mf.dispatchFetch(`https://smoke.test/group?at=0&mode=${mode}`)).json()
    assert.deepEqual(skipped, { reply: null, calls: 0, writes: [], tools: null })
  }
  const search = await (await mf.dispatchFetch('https://smoke.test/c2c?at=1&search=1')).json()
  assert.deepEqual(search.tools, [{ google_search: {} }])
  assert.equal(search.reply, 'Workers 回答成功\n来源：\n来源 https://source.test/')
  const reset = await (await mf.dispatchFetch('https://smoke.test/c2c?at=1&mode=reset')).json()
  assert.deepEqual(reset, { reply: '当前会话的对话历史已清除。', calls: 0, entries: 0 })
  console.log('本地 workerd：8 项通过，覆盖普通文本、命令、KV/TTL、Search 与 reset（未连接 Google / QQ）')
} finally {
  await mf.dispose()
}
