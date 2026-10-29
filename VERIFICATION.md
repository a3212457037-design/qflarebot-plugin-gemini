# 本地验证记录

## Tavily 本地增量验证（0.1.0，2026-10-29）

基线：main `ce8153e9fc6440472fe3a6df6725e396dfc8f243`；开始时 Git 干净，outputs 与基线的文本内容一致（部分文件行尾不同）。本记录对应本地验证阶段，当时尚未提交、推送或部署；实际发布与上线状态需另行核实。

- `npm run typecheck`：通过。
- `npm test`：193/193 通过（index 54、history 17、grounding 21、Tavily 59、真实框架联测 42）。
- `npm run sync`：官方 CLI 构建并同步 manifest 成功，版本 0.1.0、ai/search/reset 三个命令、net/kv 权限，无新运行依赖。
- `npm run check:manifest`：通过。
- `npm run test:workers`：11 个实际本地 workerd 场景通过，包括私聊/群 @、未 @ 忽略、上下文 TTL、Tavily 搜索成功/额度失败、Google 原生工具停用和 reset。
- 覆盖：basic/3条/禁止自动升级，规则/强制搜索，关闭/无 Key/失败/超时/无效及超大响应/429/432/433，30秒间隔与日/月尝试预算、KV 故障时拒绝，最多两条真实来源及字符/字节预算，提示隔离与双 Key 脱敏、writeOnly 往返，原有聊天/限流/历史隔离/重置回归。
- Gemini auth 增加固定 HTTP 状态和原因分类；不记录 Google 原始报错或项目标识。现有线上日志仅有 code=auth，仍不足以确定真实 Key/项目权限根因。

使用现有测试依赖目录完成验证，再将相同源码和构建产物同步至 outputs；未使用真实 Gemini/Tavily Key，未请求真实外部 API 或 QQ。真实账户授权、Tavily 搜索质量、QQ 投递与多 isolate 下计数表现仍需管理员日后更新插件后实测。KV 辅助用量保护不等于账户费用封顶。下文保留初版历史记录，不代表此次测试结果。

日期：2026-10-29；Windows / Node.js v24.20.0。框架及官方 SDK/CLI：QFlareBot v0.6.1，Fork 提交 `d143732abd6312e21f55edc2d3e6220563f06be8`。

| 检查 | 实际结果 |
| --- | --- |
| 官方 SDK 与 plugin-cli 构建 | 通过，使用仓库实际源码 |
| `npm run typecheck` | 通过，TypeScript 严格检查 |
| `npm test` | 46 项通过：37 项插件测试、9 项真实框架联测 |
| `npm run sync` | 官方 CLI 成功生成自包含 ESM 和根 manifest |
| `npm run check:manifest` | 源码提取的 manifest 与根声明完全一致 |
| `npm run test:install` | 官方安装构建脚本在无 node_modules 的临时源码目录成功构建，11069 字节，无第三方运行依赖；声明核对通过 |
| `npm run test:workers` | 本地 workerd 3 项通过：私聊、群 @、未 @ 忽略；compatibility date 为 2026-09-01，与现有部署模板相同 |
| 核心、sid、T2I | 真实 PluginRegistry 可共同注册；真实 dispatcher 中 `/sid` 正常；没有修改受版本控制的框架文件 |

覆盖的关键行为：固定模型与 Google 原生请求体、Key 只进请求头、无历史/工具字段、场景与 @ 过滤、Unicode 输入边界、字符/UTF-8/Token 输出边界、15 秒全程超时与中止、忙碌与冷却、429 和每日额度/402、400/401/403/404/408/5xx、坏 JSON/超大响应/空回答、内容拦截、思考 part 排除、固定错误日志、writeOnly 占位和还原、官方 Schema 配置边界。

环境说明：本机默认 pnpm 为 11，而仓库声明 10.34.5；默认 pnpm 的脚本策略阻止过一次安装流程。最终用已安装的依赖与 `npm run build --prefix packages/sdk`、`npm run build --prefix packages/plugin-cli` 成功构建官方工具。pnpm 自动写入的 allowBuilds 片段已撤回。插件自身通过 npm 安装并使用锁文件。Workers 冒烟使用 Wrangler 附带的 Miniflare 5 转换接口，实际启动了 workerd。

## 尚需真实环境验证

- 用户在独立公开 GitHub 仓库发布后，面板「仓库链接」的远端读取、安装预检、Workers Builds 和线上健康检查。
- 用户自行保存 Key 后，项目对 `gemini-3.5-flash-lite` 的真实授权、地区可用性、免费额度，以及 Cloudflare 边缘到 Google 的连通性。
- QQ 私聊和群 @ 的实际被动回复投递、平台审核/长度规则及延迟。
- 长时间运行、多个 Worker isolate 下的实际触发频率；内存冷却不保证全局强限流。
- T2I 的外部渲染服务及现有线上配置未做实测；本插件不调用或修改它们。

所有 API 成功/错误响应都由本地替身提供。没有读取或使用用户的 Gemini API Key，没有进行真实 Google 推理，没有登录或改动线上 QQ/Cloudflare 配置。此记录保留初版开发阶段的测试结果，发布时未重复运行整套测试；当前源码发布版本见本仓库提交历史。线上插件安装仍由部署管理员执行。
