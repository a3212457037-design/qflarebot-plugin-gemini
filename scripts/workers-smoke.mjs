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
          const session = { scene: url.pathname.slice(1), event: 'qq.c2c.message', attachments: [], content: '你好', atMe: url.searchParams.get('at') === '1', canReply: true, botId: 'test', userId: 'test' };
          const ctx = { config: { apiKey: 'local-test-credential', maxInputChars: 500, maxReplyChars: 400, maxOutputTokens: 512, timeoutMs: 15000 }, logger: { warn() {} } };
          const result = url.searchParams.get('mode') === 'text'
            ? await plugin.regex[0].handler({ session, ctx, match: ['你'] })
            : await plugin.commands.ai.handler({ session, ctx, argText: '你好' });
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
  for (const mode of ['command', 'text']) {
    for (const scene of ['c2c', 'group']) {
      const result = await (await mf.dispatchFetch(`https://smoke.test/${scene}?at=1&mode=${mode}`)).json()
      assert.deepEqual(result, { reply: 'Workers 回答成功', calls: 1 })
    }
    const skipped = await (await mf.dispatchFetch(`https://smoke.test/group?at=0&mode=${mode}`)).json()
    assert.deepEqual(skipped, { reply: null, calls: 0 })
  }
  console.log('本地 workerd：命令与普通文本的私聊、群 @、未 @ 忽略，6 项通过（未连接 Google / QQ）')
} finally {
  await mf.dispose()
}
