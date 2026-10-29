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
          const plugin = createGeminiPlugin(async () => {
            calls++;
            return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Workers 回答成功' }] } }] });
          });
          const result = await plugin.commands.ai.handler({
            session: { scene: url.pathname.slice(1), atMe: url.searchParams.get('at') === '1', canReply: true, botId: 'test', userId: 'test' },
            ctx: { config: { apiKey: 'local-test-credential', maxInputChars: 500, maxReplyChars: 400, maxOutputTokens: 512, timeoutMs: 15000 }, logger: { warn() {} } },
            argText: '你好'
          });
          return Response.json({ reply: result ?? null, calls });
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
  for (const scene of ['c2c', 'group']) {
    const result = await (await mf.dispatchFetch(`https://smoke.test/${scene}?at=1`)).json()
    assert.deepEqual(result, { reply: 'Workers 回答成功', calls: 1 })
  }
  const skipped = await (await mf.dispatchFetch('https://smoke.test/group?at=0')).json()
  assert.deepEqual(skipped, { reply: null, calls: 0 })
  console.log('本地 workerd：私聊、群 @、未 @ 忽略，3 项通过（未连接 Google / QQ）')
} finally {
  await mf.dispose()
}
