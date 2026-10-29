# 本地验证记录

## 最高推理档增量验证（0.1.0，2026-10-29）

基线 main `cb21e530f3b4ec6f0b511c79ef3658b34bc6bf79`，开始时 Git 干净。三个候选模型统一显式发送 `generationConfig.thinkingConfig.thinkingLevel: "high"`，不发送 thinkingBudget/includeThoughts，不改变模型、端点、Key、超时、上下文或 Tavily。

- 完整测试 264/264 通过，包含三模型 high 请求、内部思考/签名不输出及原有回归。
- 类型检查、官方 CLI 构建、manifest 一致性检查通过；manifest 无需修改，版本保持 0.1.0。
- 本地实际 workerd 16 项通过，聊天切换及后台默认请求均断言 high。
- 外部 API 为本地替身，未使用真实 Key 进行推理。high 可能增加耗时及 Token 消耗，实际 QQ/Google 延迟仍需线上观察。发布状态另行核对。

## 模型选择增量验证（0.1.0，2026-10-29）

基线 main `fddf2a8c8ed4e11d6562cb7c163ace00b0a0ce4e`；开始时Git干净，outputs与基线文本一致。用户确认聊天切换只影响当前用户当前会话，后台配置提供默认模型。默认仍为gemini-3.5-flash-lite；新增gemini-3.6-flash、gemini-3.8-flash候选，不修改Key、主机或计费设置。

- 完整测试261/261、类型检查通过；包含旧217项回归、模型路径/校验、会话隔离、后台默认变化/default恢复、上下文与more保留、busy/cooldown、无效状态、KV失败、错误不回退、密钥不回显及真实dispatcher命令优先级。
- 官方CLI构建、manifest一致性通过；版本0.1.0、五个命令ai/search/model/more/reset、权限net/kv。
- 本地workerd实际16项场景通过，覆盖私聊/群聊模型选择和后台默认，Tavily、长回复、more与reset回归。
- 官方隔离安装构建通过：45935字节，无第三方运行依赖。
- Schema使用现有UI支持的enum下拉；旧快照缺少model默认补为原模型。模型偏好使用隔离KV键无TTL，/model default恢复跟随后台；reset不清模型偏好。

所有Google/Tavily响应为本地替身，未用真实Key调用新模型；各候选在当前Google项目的实际授权、额度、耗时仍需真实QQ验证。切换只保存偏好，不承诺该项目已获模型授权；失败不自动换模型重试。发布和线上升级状态另行核对。下文保留此前验证记录。

## 长回复增量验证（0.1.0，2026-10-29）

基线 main `96f8229b63848a903e98a33846fa45ac0506e556`。开始时 Git 干净，outputs 与基线文本一致。Gemini 模型未变；移除总回复字符/字节裁剪，Token 默认和上限 65536；旧配置兼容。24 秒搜索/生成共同预算，遵守当前 Worker 的 30 秒后台生命周期。

- 完整测试 217/217 通过：单元测试与真实 v0.6.1 标准化/dispatcher 联测。
- 类型检查、官方 CLI 构建、manifest 一致性检查通过；版本 0.1.0，ai/search/more/reset 四个命令、net/kv 权限。
- 实际本地 workerd 13 项通过，新增私聊/群聊长回复、Unicode 字节分段、KV 保存余文和新事件 more 领取，未二次调用 API。
- 官方无 node_modules 临时目录隔离安装构建通过，39906 字节，无第三方运行依赖。
- 覆盖：超过64KiB JSON和500字符/1500字节仍完整，中文/Emoji/换行逐字重组；私聊4/群聊5条预算，发送失败或长度拒绝、KV故障、进度恢复、隔离/过期/reset并发，历史长模型消息、旧字段兼容、24秒共同超时、Tavily/诊断/双Key回归。

QQ 现行单聊接口写每条最多4次，群聊5次，旧概述写单聊5次；SDK默认5次，本插件采用较严格口径。官方未列纯文本统一的精确长度值；每条2000 UTF-8字节是保守传输分段值，非总正文限制，并支持明确长度错误后缩小分段。来源链接尽量完整放在一条。

余文保留24小时、/more不调用模型、/reset清除当前历史与余文。KV最终一致，进度保存失败可能重发上一批，已明确提示；无法保证跨isolate严格一次投递。65536 Token不是保证能在约30秒内全部生成。测试均为虚构Key/本地响应，真实QQ长回复和大输出的时延/边缘CPU仍需上线后实测。下文保留此前阶段记录。

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
