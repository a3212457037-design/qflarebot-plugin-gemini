# QFlareBot Gemini 文本问答插件

为「上分难」提供中文文本问答、最近 6 轮会话上下文及默认关闭的 Tavily 联网搜索，适配 QFlareBot v0.6.1。固定使用 Google 原生 REST API 和模型 `gemini-3.5-flash-lite`，无第三方运行依赖。

## 使用

- QQ 私聊：直接发送 `你好` 即可聊天，不需要前缀。
- QQ 群聊：先 @上分难，再发送 `你好`。
- 原有 `/ai 你好` 用法继续有效。
- `/search 关键词` 强制搜索；开启 Tavily 后，新闻、最新消息、实时动态等问题会按简单规则自动搜索。群聊仍需 @机器人。
- `/reset` 清除当前用户当前会话的上下文，不调用 Gemini；群内使用时也需 @机器人。
- 未 @ 机器人的群消息不调用模型、不回复；频道不处理。

命令解析遵循 QFlareBot：默认前缀是 `/`，管理员修改前缀后跟随框架；私聊或 @机器人时，框架也允许省略前缀。

普通聊天使用 SDK 正则匹配器，仅接收 `c2c` / `group` 消息，群聊检查 `atMe`。正则优先级为 -100、`block: false`；默认优先级 0 且命中后阻断的现有命令先执行，`/ai` 不会再触发一次普通聊天。`/` 开头的消息始终跳过，保护 `/sid`、`/t2i` 及未知命令。普通聊天、`/ai` 与 `/search` 共用同一个忙碌状态、冷却表、长度限制和错误处理函数。

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

4. QFlareBot 面板 → 添加插件 → **仓库链接**，粘贴 `https://github.com/a3212457037-design/qflarebot-plugin-gemini`。预检应显示插件 `gemini`、命令 `ai` / `search` / `reset`、权限 `net` / `kv`。若已有其他插件占用 `/ai`、`/search` 或 `/reset`，先自行决定保留哪个，避免命令冲突。
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
| `enableTavilySearch` | `false` | 管理员主动开启；旧配置缺字段时关闭 |
| `tavilyApiKey` | 空 | 面板填写，`writeOnly: true`；与 Gemini Key 分开保存 |

旧 `enableGoogleSearch` 字段仅保留兼容，不再显示开关；即使旧值为 true，也不发送 Google `tools`。

每次只发送一条纯文本回复，最多 1500 UTF-8 字节；超长或模型达到 Token 上限时附截断提示。输入过长会拒绝，不会悄悄截掉问题。普通聊天忽略含附件的消息和非文本事件；`/ai` 仍只发送命令后的文字，不读取附件或引用内容。

同一 Worker isolate 同时只处理一个 Gemini 请求；全机器人两次模型请求间隔至少 6 秒，同一用户跨群间隔至少 10 秒。冷却只在内存中保存时间戳，**冷启动或扩容会重置，无法提供跨 isolate 的严格全局限流或费用封顶**。上下文使用现有插件 KV，不新增 D1、Durable Object 或定时任务。

API 超时、429、明确的每日额度不足/402、Key 或权限错误、模型不可用、服务繁忙、网络故障、内容拦截和异常响应都有简短中文提示。不自动重试，不自动更换模型。429 无足够信息区分短时限流和额度耗尽时会提示两种可能。

## 会话上下文与重置

普通聊天和 `/ai` 共用对话历史。每次请求携带最近 6 轮完整的 `user` / `model` 文本及当前问题；只有 Gemini 返回有效回答后才保存，并裁剪到最多 12 条消息。私聊按机器人 ID + 用户 ID 隔离；群聊按机器人 ID + 群 ID + 用户 ID 隔离，不共用群员的私人记录。

历史保存在 `ctx.kv` 自动隔离的 `p:gemini:` 命名空间。成功保存时设置 `{ ttl: 86400 }`（秒，即 24 小时），同时记录最后成功时间；加载时做 JSON、角色顺序、完整轮次、文本长度和过期校验，损坏数据安全忽略。API 失败不写入本轮问答、不刷新历史 TTL。每次成功问答会写一次 KV，使用机器人现有的 KV 额度。

`/reset` 只删除当前用户当前会话的历史，空历史也正常提示，不清除 Key、配置或冷却。当前 isolate 内重置进行中的请求时，已发送的模型调用仍可能返回，但不会重新保存已重置的历史。KV 本身是最终一致存储，多个 isolate 间不提供强一致的会话锁；本插件不为此新增付费服务。存储故障时尽量保留有效回答，并仅记录 `history_read` / `history_write` / `history_reset` 等固定错误类别，历史可能未能保存。

## Tavily 联网搜索

管理员以后应用本地改动的插件版本后，在「Gemini 文本问答」设置填写 **Tavily API Key**，打开 **启用 Tavily 联网搜索** 并保存。不要把 Key 发到 QQ；原 Gemini Key 不变。保持 Tavily 的 Pay as you go 关闭；插件不会修改任何计费设置或开通服务。源码发布与线上更新是两个步骤；推送仓库后仍需在面板应用插件更新，不能仅凭仓库提交判断已上线。

- 普通聊天默认不搜索；启用后，以当前问题中的“新闻、最新、今天、实时、动态”等简单规则判断，无额外模型判定。规则可能漏判或误判，需要时用 `/search 关键词` 强制搜索。
- 使用官方 `POST https://api.tavily.com/search`，固定 `search_depth: basic`、`max_results: 3`、`auto_parameters: false`，关闭 Tavily answer/raw content/images。不使用 Advanced、Research、Extract、自建爬虫或 Google Search Grounding。
- 成功检索后，只把经过校验的最多 3 条标题、URL 和每条最多 1000 字符的摘要作为不可信外部资料传给 Gemini。系统指令禁止执行资料中的命令、角色声明或密钥索取；Key 不进入提示词。提示隔离不能保证模型永远正确，应核对重要事实。
- 程序移除检索回答中模型自写的 URL，末尾只从实际 Tavily 结果追加最多 2 个去重 HTTP/HTTPS 来源。过滤无效地址、URL 凭据和含两种 Key 的链接。正文优先，来源与正文共同遵守字符和 1500 UTF-8 字节上限，空间不足会省略来源，不截断链接。未额外访问来源网页验证可用性。
- 搜索关闭时 `/search` 明确提示；搜索缺 Key、失败、超时、429、432/433 额度不足、无有效资料时返回中文提示，不调用 Gemini 编造搜索答案，也不写入本轮历史。Tavily 成功但 Gemini 失败时保留原 Gemini 提示，不存未完成问答。
- Tavily 请求和响应读取共用最多 8 秒超时（不超过 `timeoutMs`），之后 Gemini 保留原超时。两者仅调用各自固定 HTTPS 端点，`redirect: manual`，不自动重试。

所有聊天入口共用原有忙碌和冷却保护。搜索额外限制当前 isolate 每 30 秒最多一次尝试；插件 KV 的 `tavily:usage` 在发送前预留计数，每个 UTC 自然日最多 30 次、自然月最多 900 次，失败也保守计一次，跨机器人共用此插件命名空间的计数。读取、写入失败或计数损坏时拒绝搜索；`/reset` 不清除用量记录。计数保存 32 天，日/月窗口按时间刷新。

按 [Tavily 官方额度说明](https://docs.tavily.com/documentation/api-credits)，Researcher 免费计划每月 1000 credits，basic 每次 1 credit。上述辅助计数受 KV 最终一致性、多个 isolate 竞争、其他项目使用同一 Key 等因素影响，**不是账户费用的绝对上限**；以 Tavily 后台实际用量与账户限制为准。没有新增数据库、Durable Object 或其他付费服务。

## Key 保存方式

使用 QFlareBot 原生插件设置：Key 存在其 KV 配置快照中，`writeOnly` 令管理状态和快照接口只返回占位符。这是框架的隐藏回显机制，**不是插件额外提供的加密存储或独立 Worker Secret**；拥有部署/KV 权限的管理员、同一运行时中的可信插件仍有相应访问能力。

本插件不读取环境中的 Key，不把 Key 放进模型提示词、URL、Git 或日志；Gemini Key 只在固定 Google HTTPS 端点的 `x-goog-api-key` 请求头中发送，Tavily Key 只在固定 Tavily HTTPS 端点的 `Authorization` 请求头中发送，不跟随重定向。网络错误日志包含固定类别，以及经过 Key 脱敏、控制字符清理和限长的异常名称（64 字符）与消息（200 字符），同时脱敏 Gemini 和 Tavily Key，字段为 `data.error.name` 和 `data.error.message`；不记录请求头、请求体、响应正文、stack 或 cause。异常回显的 Key 也会从回答中移除。不要在 QQ 中发送 Key。Tavily 失败只记录固定 `data.code`，不记录网络异常原文或响应。

模型 ID 及免费层已按 [Google 模型页](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite) 和[价格页](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.5-flash-lite) 核对（2026-10-29）。实际可用性、地区和额度以你的 Google 项目为准；插件不会修改计费设置，也无法把已有付费项目强制变为免费项目。

## “密钥或访问权限异常”排查

QQ 的这条提示对应 Gemini `auth` 分类：HTTP 401/403 或明确无效 Key 错误。仅有旧日志 `data.code=auth` 不能确定是哪一种；它不表示 Tavily 故障，也不是网络连接失败。接入 Tavily 仍需要 Gemini 能正常生成回答。

本地新版为此分支增加 `data.api.status` 和固定白名单 `data.api.reason`，如 `API_KEY_INVALID`、`API_KEY_SERVICE_BLOCKED`、`API_KEY_LEAKED`、`PERMISSION_DENIED` 或 `UNKNOWN`。不记录 Google 的原始 message/details、项目标识或响应；QQ 提示保持不变。需要管理员日后应用新版后再观察此分类。

可在 Google AI Studio 人工核对 Key 是否可用、Key 类型/服务限制和对应项目的访问资格，见 [Google Key 说明](https://ai.google.dev/gemini-api/docs/api-key) 与[官方错误排查](https://ai.google.dev/gemini-api/docs/troubleshooting)。这次没有读取或验证真实 Key，不能宣称已修复线上授权问题；不应为了排查而开启付费或公开 Key。

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

已完成：类型检查、官方 CLI 构建、根 manifest 一致性检查、193 项单元/框架联测、本地 workerd 中的 11 项场景冒烟。覆盖普通聊天、命令、共用历史/冷却、6 轮裁剪、KV TTL、会话隔离、损坏数据、重置并发、Tavily 规则与强制搜索、失败/超时/额度保护、双密钥隐藏、Google 停用、来源校验/去重/预算和诊断保护。内置 `sid`、T2I 共存；框架仓库无受版本控制文件变更。

尚未完成：此版线上更新、真实 Tavily/Gemini Key 和项目额度、Cloudflare 边缘到 Google 的连通性、QQ 实际投递及长时间运行。开发验证中的模型响应均为本地测试替身，未使用用户的 Key，未请求真实 Tavily 搜索或 Google 推理，未修改线上机器人配置。源码发布版本见本仓库提交历史。详细结果见 [VERIFICATION.md](VERIFICATION.md)。

真实 QQ 最小检查：私聊和群 @ 各聊两轮，确认会话隔离；保留 `/ai` 用法；用 `/reset` 后再问；群内未 @ 时不回复；检查 `/sid` 和其他命令；Tavily 搜索先保持关闭，确认 Gemini 正常、填写 Tavily Key 并主动开启后，再测“最新新闻”和 `/search`，检查真实来源。不要为了测试错误而公开或发送真实 Key。

## 复用来源

检查了官方插件目录、官方模板、`sid`、T2I 及社区 `ai` / `llm` 插件。此插件复用官方模板，以及社区 `llm` 的 Gemini 请求结构与文本 part 解析，在原有文本路径上增加有界 KV 上下文和可选 Tavily 搜索，不引入通用模型服务或历史管理页面。具体提交和 MIT 许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
