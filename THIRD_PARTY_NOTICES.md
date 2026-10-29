# 第三方来源与许可

本插件按 MIT 发布。使用者需要保留本仓库 LICENSE 和以下许可文件。

- **QFlareBot 官方模板与 SDK 契约**：检查和采用 Fork 中的 v0.6.1，提交 [`d143732abd6312e21f55edc2d3e6220563f06be8`](https://github.com/a3212457037-design/QFlareBot/tree/d143732abd6312e21f55edc2d3e6220563f06be8)。官方上游为 [QFlareBot/QFlareBot](https://github.com/QFlareBot/QFlareBot)。模板和 SDK 为 MIT；许可保存在 `licenses/QFlareBot-template-MIT.txt`。仓库其余 GPL 运行时代码只参与本地测试，没有复制到插件源码或插件产物中。
- **社区原生 Gemini 协议实现**：[`clown145/qflarebot-plugin-llm/src/protocols/gemini.ts`](https://github.com/clown145/qflarebot-plugin-llm/blob/94f0f1f444b5980eb738d77492760ab412855682/src/protocols/gemini.ts)，提交 `94f0f1f444b5980eb738d77492760ab412855682`，Copyright (c) 2026 clown145，MIT。`src/gemini.ts` 的请求头、`contents` / `systemInstruction` / `generationConfig` 组装和排除 `thought` 的文本解析由此裁减改编；不含其流式、工具、多模态或服务管理代码。完整许可保存在 `licenses/qflarebot-plugin-llm-MIT.txt`。
- **对照检查，未复制代码**：[lktsuarpok1qwq/qflarebot-plugin-ai](https://github.com/lktsuarpok1qwq/qflarebot-plugin-ai/tree/5a95b177555dbe1eab49822084e1cdac446e251f)，提交 `5a95b177555dbe1eab49822084e1cdac446e251f`。
- **社区目录**：[QFlareBot/plugins](https://github.com/QFlareBot/plugins/tree/50c6cf576be3381265b50f0c91e38b6193a59a37)，检查其登记条目，同时搜索 GitHub 公开 QFlareBot 仓库；未发现可以直接安装并同时满足本次全部最小范围约束的插件。这不代表穷尽了所有未登记或私有插件。

开发工具（TypeScript、Vitest、esbuild、Wrangler/Miniflare）只用于构建和验证，各自遵循上游许可；没有作为第三方运行时库打进 `dist/plugin.js`。
