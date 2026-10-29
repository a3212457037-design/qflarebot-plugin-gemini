# QFlareBot Gemini 文本问答插件

为「上分难」提供单轮中文文本问答，适配 QFlareBot v0.6.1。固定使用 Google 原生 REST API 和模型 `gemini-3.5-flash-lite`，无第三方运行依赖。

## 使用

- QQ 私聊：`/ai 你好`
- QQ 群聊：先 @上分难，再发送 `/ai 你好`
- 未 @ 机器人的群消息不调用模型、不回复；频道不处理。

命令解析遵循 QFlareBot：默认前缀是 `/`，管理员修改前缀后跟随框架；私聊或 @机器人时，框架也允许省略前缀。

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

4. QFlareBot 面板 → 添加插件 → **仓库链接**，粘贴 `https://github.com/a3212457037-design/qflarebot-plugin-gemini`。预检应显示插件 `gemini`、命令 `ai`、权限 `net`。若已有其他插件占用 `/ai`，先自行决定保留哪个，避免命令冲突。
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

每次只发送一条纯文本回复，最多 1500 UTF-8 字节；超长或模型达到 Token 上限时附截断提示。输入过长会拒绝，不会悄悄截掉问题。附件和引用内容不发送给模型。

同一 Worker isolate 同时只处理一个 Gemini 请求；全机器人两次模型请求间隔至少 6 秒，同一用户跨群间隔至少 10 秒。冷却只在内存中保存时间戳，**冷启动或扩容会重置，无法提供跨 isolate 的严格全局限流或费用封顶**。不为此新增 KV 写入、D1、Durable Object 或定时任务。

API 超时、429、明确的每日额度不足/402、Key 或权限错误、模型不可用、服务繁忙、网络故障、内容拦截和异常响应都有简短中文提示。不自动重试，不自动更换模型。429 无足够信息区分短时限流和额度耗尽时会提示两种可能。

## Key 保存方式

使用 QFlareBot 原生插件设置：Key 存在其 KV 配置快照中，`writeOnly` 令管理状态和快照接口只返回占位符。这是框架的隐藏回显机制，**不是插件额外提供的加密存储或独立 Worker Secret**；拥有部署/KV 权限的管理员、同一运行时中的可信插件仍有相应访问能力。

本插件不读取环境中的 Key，不把 Key 放进模型提示词、URL、Git 或日志；只在固定 Google HTTPS 端点的 `x-goog-api-key` 请求头中发送，不跟随重定向。错误日志只有固定类别，不含原始响应或异常；异常回显的 Key 也会从回答中移除。不要在 QQ 中发送 Key。

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

已完成：类型检查、官方 CLI 构建、根 manifest 一致性检查、46 项单元/框架联测、官方隔离安装构建、本地 workerd 中的 3 项场景冒烟。内置 `sid`、T2I 能与插件共同注册，`/sid` 仍由原插件处理。核对过的框架仓库无受版本控制文件变更。

尚未完成：线上仓库链接预检/安装、真实 Google Key 和项目额度、Cloudflare 边缘到 Google 的连通性、QQ 实际投递及长时间运行。开发验证中的模型响应均为本地测试替身，未使用用户的 Key，未请求真实 Google 推理，未修改线上机器人配置。源码发布版本见本仓库提交历史。详细结果见 [VERIFICATION.md](VERIFICATION.md)。

真实 QQ 最小检查：私聊 `/ai 你好`；群内 `@上分难 /ai 你好`；未 @ 的群命令；空问题和超长输入；快速连续提问；确认回复为单条简短中文。不要为了测试错误而公开或发送真实 Key。

## 复用来源

检查了官方插件目录、官方模板、`sid`、T2I 及社区 `ai` / `llm` 插件。社区 `ai` 使用 OpenAI 兼容接口，包含聊天记录、D1 和管理页面；`llm` 已有原生 Gemini 协议，但作为模型服务不直接处理 QQ 问答。此插件复用官方模板，以及社区 `llm` 的 Gemini 请求结构与文本 part 解析，裁减为本次需要的单轮文本路径，不引入通用模型服务或历史管理。具体提交和 MIT 许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
