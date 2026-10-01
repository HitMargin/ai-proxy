# ai-proxy 项目上下文（代理每次请求都会读到，压缩不会丢失）

## 项目
Deno 本地反代（端口 8000，`restart.ps1 -Local`）+ cloudflared 隧道 + Cloudflare Worker 远端链。
为 dsh 提供免费模型入口。

## 当前状态（2026-09-30 核实，改动此节请更新日期）
- **cnb 匿名通道已死**：上游 401 `[NOT_LOGIN]`，需登录。已实现登录态支持：登录 Cookie 粘到
  `cnb-login.txt`（热加载，剔除 csrfkey，见 README 1.5 节）。用户暂无 cnb 账户，通道 dormant。
- **DeepSeek 网页端**：`/deepseek-web/v1` 已支持自动登录凭证、PoW WASM、THINK/RESPONSE SSE 解析、OpenAI SSE、工具调用、图片 data URL 上传到 `ref_file_ids`、Chat Completions、Responses API 和 `off/low/high/max` 思考档位；由于 DSH OpenAI 兼容列表不读取自定义 reasoning 元数据，额外暴露 `deepseek-reasoner-off/low/high/max` 模型变体；同一账号请求串行，随机间隔 2～4 秒，连续 15 次长休，429/403 会暂停自动重试。默认同一账号复用 chat_session 20 轮，`DEEPSEEK_SESSION_REUSE_TURNS=0` 可关闭复用。图片首次使用前需重新运行登录捕获脚本生成 `deepseek-headers.json`。
- **Zen 兼容层**：`src/zen.ts` 为 `/zen/v1` 补齐 OpenCode UA、DSH session 派生的 `x-opencode-*`、`bash/glob/grep/read` 工具 quartet、Muse Spark Responses/Anthropic Messages 转换和 FreeTier/Region 错误分类；可用 `ZEN_BASE_URL`/`ZEN_BEARER_TOKEN` 覆盖上游。实测非流式请求会触发 `FreeTierError`，`stream:true` 可正常出流，因此 DSH 路径必须保持流式；模型列表可返回 11 个 `-free` 模型。单会话免费额度有限，连续探针会触发 `FreeUsageLimitError`。
- **Zen 会话压缩**：`src/zen-compaction.ts` 移植 opencode 官方 `session/compaction.ts`（经 YuJunZhiXue/Cline-proxy `internal/app/compact.go` 中转）。超限时从尾部按 token 预算保留原文（超预算那条按 prefix/suffix 拆开而非整条丢弃），更早的历史交给模型生成锚定摘要，重组为 `[system] + [Conversation Summary] + 尾部原文`；同一 session 下次压缩走 `Update the anchored summary` 增量更新而非重写。token 估算沿用官方 `字符数/4` 近似。`ZEN_COMPACTION=off` 关闭；`ZEN_COMPACTION_KEEP_TOKENS`/`BUFFER`/`MAX_SUMMARY`/`SUMMARY_MODEL` 可调。**压缩必须发生在 `upstreamBodyForChat` 之前**，否则改写后的 messages 不会进入实际请求；摘要请求复用本代理的 Zen 路由以带上指纹。摘要生成失败降级为 `fallbackTruncate` 截断，不会把会话直接打失败。
- **Zen 出口代理池**：`src/zen-egress.ts` 处理 `ZEN_PROXIES`（逗号/空格分隔的 http/https/socks5/socks5h URL）+ `ZEN_PROXY_STRATEGY`（round_robin/random/fill）+ `ZEN_PROXY_COOLDOWN_MS`。Zen 按出口地址计量匿名额度，单 IP 会先耗尽；轮换出口可分摊。429/5xx 或传输失败会把该出口标记冷却并线性探测下一个。凭据在 `describe()` 里被 `***` 遮蔽，面板不会拿到密码。**TLS 指纹伪装（utls `HelloChrome_120`）未移植**：Deno 不暴露 ClientHello 定制 API，Go 的 utls 无法在 Deno 侧等价实现；Cline-proxy 用它绕过 CF 风控，我们只有 HTTP 层指纹。Zen 的 500 是否由 TLS 指纹导致尚未证实。
- **Cline 上游结论**：`api.cline.bot/api/v1` 列模型免认证（464 个，与 OpenRouter 清单 `shared=464` 完全重合，且缺 name/pricing/architecture），但推理一律 401——`Bearer public`、无头、OpenCode UA 三种形式都试过，含 Cline-proxy README 标为「不消耗额度」的 `deepseek/deepseek-v4-flash`、`poolside/laguna-s-2.1:free`、`stepfun/step-3.7-flash`。那个项目的「免费」实际来自 Zen，Cline 只是加了账号门槛的 OpenRouter 转发层。
- **CommandCode Go**：`/commandcode/v1` 已移植 `dsh-cmdgo-provider` 0.9.1 的模型筛选、CLI 私有网关协议、OpenAI Chat/Responses/Anthropic Messages 转换、显式会话头作用域内稳定的 `x-session-id`（无会话头时每请求随机隔离）、工具调用双射/自愈、损坏 tool arguments 的截断保护、多账号轮询冷却、单账号 in-flight/最小间隔限制、OAuth、额度和缓存统计；`COMMANDCODE_API_KEY` 可作单账号兜底，OAuth key 存入已忽略的 `commandcode-accounts.json`。公开模型目录实测 51 个 Go 模型（31 个图像模型）；尚未用真实 CommandCode 凭据验证推理，需有 key 后实测。
- **可用通道**：`/v1` 聚合入口的 kilo 系模型（含 `kilo/deepseek/deepseek-v4-flash-0731:free`，实测正常）。
- **不可用/受限**：Zen 的模型列表可读，但真实推理可能被上游按出口或客户端策略拒绝；ss2a 自营模型 502；ss2a 免费档间歇 403/502。
- **DSH 配置**：活动 Web profile 的模型注册文件是 `C:\Users\22282\.dsh\profiles\web\cordis.patch.yml`；其中 `deepseek-web` 已注册 1,048,576 context、16,384/32,768 maxTokens、text/image 输入和 off/low/high/max 思考档位。HTTP `/models` 不能替代这份 DSH 配置。
- **业务错误/冷却**：DeepSeek HTTP 200 `biz_code`、SSE `error/toast`、`content/msg` 错误正文、muted/mute_until、非 SSE completion 错误会被识别；限流期返回 429 + Retry-After，`deepseek-web-cooldown.json` 持久化冷却状态，进程重启不丢失；Responses 流错误转换为 `response.failed`。
- **请求指纹**：DeepSeek 的 PoW、建会话、删除会话、图片上传和 completion 共用 `deepseek-headers.json` 的浏览器头集合；不再发送重复版本头或 `X-Deepseek-Harness`。
- **健康状态**：`GET /health` 返回最近一次标准 Provider 探测汇总；`GET /commandcode/v1/panel` 返回 CommandCode 模型/账号/额度快照，供 DSH 设置页读取；`src/runtime/health.ts` 将 200/429/5xx/鉴权失败/网络失败区分为 available/degraded/unavailable/unknown，unknown 不会清空模型列表。
- **逐模型状态**：`/health` 除 provider 级计数外还带 `models[provider][未加前缀的 model id]` 的逐模型判定（`src/core.ts` 的 `getModelHealth`）。插件 `healthIndex()` 把样本拼回 `kilo/…` 完整 ID 后写到每个模型行，面板显示 可用/限流/不可用/未探测 + 延迟。**join 时必须无条件加 provider 前缀**：kilo 的 `kilo-auto/free` 自身含 `/`，用 `includes('/')` 判断「已加前缀」会漏拼。`/health` 在根路径，插件用 `requestAt('/', '/health')` 而非 `request('/health')`（后者会拼成 `/commandcode/v1/health`）。未探测的模型不带 `state` 字段，不计入 `modelHealth`，避免被当作故障。探测只在拉模型列表时触发（`?health=true` 强制重探），插件不自行发起推理探测。
- **真实 smoke**：`scripts/probes/commandcode-smoke.ts` 是显式 `--confirm-live` 才会发请求的手动探针；只走本地代理，不读取上游 key/OAuth/session 文件，输出元数据不输出正文。
- **DSH 桥接**：`dsh-plugin/` 是覆盖整个 ai-proxy 项目的可选 Node Host + 浏览器设置分区，支持自动启动/监控 `projectRoot` 中的原始 Deno 项目或连接已有本地/远程代理；注册 `ai-proxy` Provider，聚合 `/v1` 以及 DeepSeek 网页端、TokenHarbor 等可用渠道，通过同源 `/api/ai-proxy/*` 提供面板、设置和启停，不保存上游凭据；面板运行时长每秒刷新、快照每 10 秒拉取；`openrouter/*`、`anthropic/*`、`gemini/*` 缺 per-user key 故不进入模型列表且调用被拒；`node dsh-plugin/self-test.mjs` 使用 fake fetch 验证多渠道发现、元数据归一、生命周期路由和 SSE 转换。
- **模型元数据归一**：`/v1/models` 返回 OpenAI 蛇形（`context_window`/`max_output_tokens`/`input_modalities`），插件的 `normalizeModel()` 同时接受蛇形与驼峰；曾因只读驼峰导致 CommandCode 54 个模型中 33 个图像模型被降级成 text。reasoning effort 按上游实际发布档位生成，不再全模型硬编码四档。
- **用量统计**：`dsh-plugin/stats.mjs`（纯 JS + `node:test`，非 Deno）在插件侧记录每次调用，数据只在内存、进程重启归零。`GET /api/ai-proxy/usage` 返回 `{summary, models, heatmap, trend}`。速度口径沿用 `dsh-our-free-model` 的 `src/store.js`：解码窗口 <250ms 或速率 >250 tok/s 不计入（`MIN_DECODE_MS`/`MAX_CREDIBLE_TPS`），**推理 token 不计入解码窗口**，失败调用的耗时不算首帧延迟，速度按累计 token÷累计窗口而非各次速率均值。采样环 400 条，日桶保留 120 天。**该文件必须保持纯 JavaScript**——它是 Node 加载的 `.mjs`，写成 TS 语法会直接 `SyntaxError`。
- **max_output_tokens**：CommandCode 目前对所有模型返回同一个 `COMMANDCODE_MAX_TOKENS` 全局值（`src/commandcode/handler.ts` 的 `modelToOpenAi`），实测 54 个模型 distinct 值只有 64000；这是代理真实行为，插件不伪造，需要按模型真实上限须在代理侧另开一轮。
- **源码结构**：`main.ts` 为入口/路由；`src/core.ts` 为通用核心；`src/cnb.ts`、`src/deepseek-web.ts`、`src/commandcode/` 为上游适配模块；`src/runtime/stream-normalizer.ts` 提供响应体形状嗅探、流回放和 abort/截断分类；`src/runtime/health.ts` 提供健康状态聚合；`dsh-plugin/` 为可选 DSH 桥接；`third_party/dsh-deepseek-web-login` 与 `third_party/dsh-cmdgo-provider` 分别保留 Apache-2.0 / MIT 派生代码的许可与说明。
- git 已于今日 init（身份 HitMargin），`.gitignore` 已排除 cookies.txt / cnb-login.txt / deepseek-auth.txt / deepseek-cookies.txt / commandcode-accounts.json / *.bak 等。
- **未决事项**：session journal/启动补删仍未完成。CommandCode `pause_turn` 目前仅支持尚未产生客户端输出时的有限同会话续写，输出开始后仍明确拒绝重放。TLS 指纹伪装（utls）仍未移植，受 Deno 限制；若要追 Zen 的 500 根因需先确认是否真与 TLS 有关。

## 行为规则
1. **文件为准**：涉及文件内容/行号/结构时，以本次工具读取结果为准；不要依赖会话记忆或压缩摘要里的旧行号。
2. 会话被压缩或换模型后：先重读本文件定位任务，再继续；不要重新验证已确认的事实。
3. 用中文回复用户。
