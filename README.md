# QFlareBot Gemini 文本问答插件

为「上分难」提供中文文本问答、最近 6 轮会话上下文及默认关闭的 Google Search，适配 QFlareBot v0.6.1。固定使用 Google 原生 REST API 和模型 `gemini-3.5-flash-lite`，无第三方运行依赖。

## 使用

- QQ 私聊：直接发送 `你好` 即可聊天，不需要前缀。
- QQ 群聊：先 @上分难，再发送 `你好`。
- 原有 `/ai 你好` 用法继续有效。
- `/reset` 清除当前用户当前会话的上下文，不调用 Gemini；群内使用时也需 @机器人。
- 未 @ 机器人的群消息不调用模型、不回复；频道不处理。

命令解析遵循 QFlareBot：默认前缀是 `/`，管理员修改前缀后跟随框架；私聊或 @机器人时，框架也允许省略前缀。

普通聊天使用 SDK 正则匹配器，仅接收 `c2c` / `group` 消息，群聊检查 `atMe`。正则优先级为 -100、`block: false`；默认优先级 0 且命中后阻断的现有命令先执行，`/ai` 不会再触发一次普通聊天。`/` 开头的消息始终跳过，保护 `/sid`、`/t2i` 及未知命令。两个聊天入口共用同一个忙碌状态、冷却表、长度限制和错误处理函数。

默认命令前缀 `/` 无需额外配置。QFlareBot v0.6.1 SDK 不提供读取全局命令前缀的接口；若你使用 `!` 等自定义前缀，请在本插件「跳过的命令前缀」里同步填写，以免未知命令被当作普通聊天。此设置只决定哪些消息跳过，不改变机器人命令前缀。

## 发布独立公开仓库，再从仓库链接安装

1. 在 GitHub 创建空的 **Public** 仓库 `a3212457037-design/qflarebot-plugin-gemini`。无需修改现有 QFlareBot Fork，也无需发布 npm 包。
2. 把本插件目录的内容放到新仓库根目录。至少提交 `src/`、`package.json`、`package-lock.json`、**根目录 `manifest.json`**，以及本项目其余开发文件和许可。不要多套一层目录；`node_modules/`、`dist/` 和本地密钥文件由 `.gitignore` 排除。
3. 本交付已经生成了与源码一致的根 manifest，直接提交即可。以后改代码先执行 `npm run sync`，再提交新的源码和根 manifest。

   首次从本地发布时可在插件目录使用以下命令；仓库已经存在并有提交时，请先克隆现有仓库再更新文件：

   ```powershell
   git init -b main
   git add .
   git commit -m "feat: add minimal Gemini text chat plugin"
   git remote add origin https://github.com/a3212457037-design/qflarebot-plugin-gemini.git
   git push -u origin main
   ```

4. QFlareBot 面板 → 添加插件 → **仓库链接**，粘贴 `https://github.com/a3212457037-design/qflarebot-plugin-gemini`。预检应显示插件 `gemini`、命令 `ai` / `reset`、权限 `net` / `kv`。若已有其他插件占用 `/ai` 或 `/reset`，先自行决定保留哪个，避免命令冲突。
5. 确认安装并等待 Workers Builds 构建、健康检查和上线。源码由框架自己的 SDK 编译，不需要上传 `dist/`，也不需要更改 Worker 绑定。
6. 在「Gemini 文本问答」的插件设置中填入 API Key 并保存；保存后只显示「已设置」。再用 QQ 私聊和群 @ 分别测试。

安装会钉住具体 commit；今后推送新代码后，还需在面板检查并应用插件更新。安装和更新流程见[官方开发指南](https://qflarebot.github.io/plugin-guide)。直接用仓库链接安装不要求登记插件市场。

## 设置与限制

| 字段 | 默认值 | 允许范围 |
| --- | --- | --- |
| `apiKey` | 空，未配置时不调用 API | 仅在面板设置，`writeOnly: true` |
| `maxInputChars` | 500 | 1–1000 个 Unicode 码点 |
| `maxReplyChars` | 400 | 50–500 个 Unicode 码点，包含截断提示 |
| `maxOutputTokens` | 512 | 64–1024 Token |
| `timeoutMs` | 15000 | 1000–15000 毫秒，覆盖请求和响应体读取 |
| `ignoredCommandPrefixes` | `["/"]` | 额外跳过的命令前缀；最多 16 项，每项 1–32 字符；`/` 始终跳过 |
| `enableGoogleSearch` | `false` | 管理员主动打开后允许 Gemini 原生搜索；旧配置缺字段时默认关闭 |

每次只发送一条纯文本回复，最多 1500 UTF-8 字节；超长或模型达到 Token 上限时附截断提示。输入过长会拒绝，不会悄悄截掉问题。普通聊天忽略含附件的消息和非文本事件；`/ai` 仍只发送命令后的文字，不读取附件或引用内容。

同一 Worker isolate 同时只处理一个 Gemini 请求；全机器人两次模型请求间隔至少 6 秒，同一用户跨群间隔至少 10 秒。冷却只在内存中保存时间戳，**冷启动或扩容会重置，无法提供跨 isolate 的严格全局限流或费用封顶**。上下文使用现有插件 KV，不新增 D1、Durable Object 或定时任务。

API 超时、429、明确的每日额度不足/402、Key 或权限错误、模型不可用、服务繁忙、网络故障、内容拦截和异常响应都有简短中文提示。不自动重试，不自动更换模型。429 无足够信息区分短时限流和额度耗尽时会提示两种可能。

## 会话上下文与重置

普通聊天和 `/ai` 共用对话历史。每次请求携带最近 6 轮完整的 `user` / `model` 文本及当前问题；只有 Gemini 返回有效回答后才保存，并裁剪到最多 12 条消息。私聊按机器人 ID + 用户 ID 隔离；群聊按机器人 ID + 群 ID + 用户 ID 隔离，不共用群员的私人记录。

历史保存在 `ctx.kv` 自动隔离的 `p:gemini:` 命名空间。成功保存时设置 `{ ttl: 86400 }`（秒，即 24 小时），同时记录最后成功时间；加载时做 JSON、角色顺序、完整轮次、文本长度和过期校验，损坏数据安全忽略。API 失败不写入本轮问答、不刷新历史 TTL。每次成功问答会写一次 KV，使用机器人现有的 KV 额度。

`/reset` 只删除当前用户当前会话的历史，空历史也正常提示，不清除 Key、配置或冷却。当前 isolate 内重置进行中的请求时，已发送的模型调用仍可能返回，但不会重新保存已重置的历史。KV 本身是最终一致存储，多个 isolate 间不提供强一致的会话锁；本插件不为此新增付费服务。存储故障时尽量保留有效回答，并仅记录 `history_read` / `history_write` / `history_reset` 等固定错误类别，历史可能未能保存。

## 启用 Google Search

在 QFlareBot 面板更新本插件并等待构建上线后，打开「Gemini 文本问答」设置 →「启用 Google Search 联网搜索」→ 保存。默认关闭，旧配置无需迁移或更换 Key / 模型。关闭时请求不发送 `tools`；开启时仅增加官方 `tools: [{ google_search: {} }]`，由 Gemini 判断是否需要搜索，不另行抓网页或调用第三方搜索 API。

模型返回有效 `groundingMetadata.groundingChunks[].web` 时，回答末尾最多附上 2 个去重的 HTTP/HTTPS 标题和链接；不输出查询词、内部 JSON 或 HTML。过滤坏链接、含凭据/Key 的链接，标题也做 Key 脱敏。来源与正文共用字符和 1500 字节上限，优先保留正文；空间不足时缩短标题或省略来源，绝不截断 URL。没有有效来源就不编造引用，也不会为了验证链接再发网络请求。

按 [Google 原生搜索说明](https://ai.google.dev/gemini-api/docs/generate-content/google-search) 和[当前价格页](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.5-flash-lite)（2026-10-29），该模型支持搜索，但免费 API 层未提供此工具。启用后是否可用、是否收费取决于项目权限和额度；本插件不会开通计费、自动重试或切换模型，开启前请自行确认 Google 项目情况。

## Key 保存方式

使用 QFlareBot 原生插件设置：Key 存在其 KV 配置快照中，`writeOnly` 令管理状态和快照接口只返回占位符。这是框架的隐藏回显机制，**不是插件额外提供的加密存储或独立 Worker Secret**；拥有部署/KV 权限的管理员、同一运行时中的可信插件仍有相应访问能力。

本插件不读取环境中的 Key，不把 Key 放进模型提示词、URL、Git 或日志；只在固定 Google HTTPS 端点的 `x-goog-api-key` 请求头中发送，不跟随重定向。网络错误日志包含固定类别，以及经过 Key 脱敏、控制字符清理和限长的异常名称（64 字符）与消息（200 字符），字段为 `data.error.name` 和 `data.error.message`；不记录请求头、请求体、响应正文、stack 或 cause。异常回显的 Key 也会从回答中移除。不要在 QQ 中发送 Key。

模型 ID 及免费层已按 [Google 模型页](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite) 和[价格页](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.5-flash-lite) 核对（2026-10-29）。实际可用性、地区和额度以你的 Google 项目为准；插件不会修改计费设置，也无法把已有付费项目强制变为免费项目。

## 开发与复现

目录布局遵循官方模板：

```text
dev/
  QFlareBot/                   # 机器人 Fork，v0.6.1
  qflarebot-plugin-gemini/      # 本插件
```

Node.js 22 或以上。在 `dev/` 下准备 SDK（不会部署）：

```powershell
git clone https://github.com/a3212457037-design/QFlareBot.git QFlareBot
git -C QFlareBot checkout d143732abd6312e21f55edc2d3e6220563f06be8
npx.cmd --yes pnpm@10.34.5 --dir QFlareBot install --filter "@qqbot/plugin-cli..." --frozen-lockfile
npm.cmd --prefix QFlareBot/packages/sdk run build
npm.cmd --prefix QFlareBot/packages/plugin-cli run build
```

在插件目录运行：

```powershell
npm.cmd ci
npm.cmd run typecheck
npm.cmd test
npm.cmd run sync
npm.cmd run check:manifest
npm.cmd run test:install
npm.cmd run test:workers
```

SDK/CLI 未发布到 npm，`devDependencies` 的 `file:../QFlareBot/...` 是官方模板的开发方式。线上构建由机器人注入 SDK，跳过插件的开发依赖。本插件没有 `dependencies`；不导入框架运行时，也不用 Node 内置模块、`eval` 或 `new Function`。

`npm test` 包含 SDK 模拟会话和真实框架源码联测；`test:install` 使用官方隔离构建脚本；`test:workers` 使用相邻 QFlareBot 中 Wrangler 自带的 Miniflare/workerd。Node 内置模块和框架源码导入仅用于开发脚本/测试，不进入插件产物。

## 验证边界

已完成：类型检查、官方 CLI 构建、根 manifest 一致性检查、131 项单元/框架联测、官方隔离安装构建、本地 workerd 中的 8 项场景冒烟。覆盖普通聊天、命令、共用历史/冷却、6 轮裁剪、KV TTL、会话隔离、损坏数据、重置并发、Google Search 开关、来源校验/去重/预算和密钥保护。内置 `sid`、T2I 共存；框架仓库无受版本控制文件变更。

尚未完成：线上仓库链接预检/安装、真实 Google Key 和项目额度、Cloudflare 边缘到 Google 的连通性、QQ 实际投递及长时间运行。开发验证中的模型响应均为本地测试替身，未使用用户的 Key，未请求真实 Google 推理，未修改线上机器人配置。源码发布版本见本仓库提交历史。详细结果见 [VERIFICATION.md](VERIFICATION.md)。

真实 QQ 最小检查：私聊和群 @ 各聊两轮，确认会话隔离；保留 `/ai` 用法；用 `/reset` 后再问；群内未 @ 时不回复；检查 `/sid` 和其他命令；搜索先保持关闭，有项目权限且确认费用后再主动打开，检查真实来源。不要为了测试错误而公开或发送真实 Key。

## 复用来源

检查了官方插件目录、官方模板、`sid`、T2I 及社区 `ai` / `llm` 插件。此插件复用官方模板，以及社区 `llm` 的 Gemini 请求结构与文本 part 解析，在原有文本路径上增加有界 KV 上下文和可选原生搜索，不引入通用模型服务或历史管理页面。具体提交和 MIT 许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
