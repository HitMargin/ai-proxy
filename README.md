# ai-proxy

多上游 AI API 聚合代理：对外暴露**统一的 OpenAI 兼容接口**，对内把请求翻译/伪装成各个上游能接受的形态。

支持以下上游：

1. **标准 OpenAI 兼容上游**（透传）：kilo.ai、opencode.ai/zen、openrouter.ai、tokenharbor.ai
2. **协议转换上游**：Anthropic、Gemini（OpenAI 格式 ⇄ 各自原生格式双向翻译）
3. **cnb.cool 网页聊天**：通过会话自举 + 提示词协议模拟，包装成标准 Chat Completions / Responses。
4. **CommandCode Go 私有网关**：移植 `dsh-cmdgo-provider` 的模型筛选、CLI 网关协议、多账号池与额度读取，提供 `/commandcode/v1`。

> 同一份 `main.ts` 可以跑在 **Deno Deploy**、**本地 Deno**、**Cloudflare Workers** 三种环境。

---

## ⚠️ 免责声明

- 本项目**仅供个人学习与技术研究**，用于验证「协议适配 / 逆向 / 边缘代理」等工程思路。
- 其中 cnb.cool 部分依赖对**网页端私有接口**的逆向（CSRF 握手、内部 chat 端点、提示词模拟工具调用）。**这并非官方 API**，随时可能失效，也可能违反上游服务条款。
- 请勿用于商业用途、大规模分发或转售免费额度。因使用本项目产生的任何后果由使用者自行承担。
- 上游的免费额度、模型清单、鉴权方式均由第三方控制，本项目不保证其可用性。

---

## 架构

```
客户端（任意 OpenAI SDK）
      │  /cnb/v1/chat/completions  /v1/...  /anthropic/v1/...
      ▼
Cloudflare Worker  https://<worker>.workers.dev          ← worker.ts
      │  ENV.BACKEND_URL 有值 → 纯字节转发（流式；仅幂等请求最多重试一次，非幂等 POST 不自动重放）
      ▼
cloudflared 快速隧道  https://xxx.trycloudflare.com      ← restart.ps1
      ▼
本机 Deno 服务  http://localhost:8000                    ← main.ts 的 Deno.serve
```

**为什么要这么绕？** Cloudflare Workers / Deno Deploy 都有 CPU 时间与配额限制，而 cnb 的协议解析（数百行正则 + 流式标记过滤）很吃 CPU。
用 `ENV.BACKEND_URL` 一个开关把计算挪回本机、边缘只做字节转发，就绕开了限制，同时保留一个稳定的公网域名。

`main.ts` 的 `handler` 会先完成入口鉴权，再根据 `BACKEND_URL` 选择纯转发或本地 Provider 处理：

```ts
if (ENV.BACKEND_URL) return await proxyToBackend(request);  // 反向代理模式
// 否则：本地解析 + 适配 + 调用上游
```

## 源码结构

项目已从单文件拆分为以下模块：

```text
main.ts                    入口、鉴权、Provider 路由、/v1 聚合、本地 Deno 启动
src/core.ts                环境变量、Provider 配置、协议适配器、通用 HTTP/流式工具
src/cnb.ts                 cnb.cool CSRF、登录态、工具调用、Responses 转换
src/deepseek-web.ts        DeepSeek 网页登录态、PoW WASM、SSE 解析、OpenAI 转换
src/commandcode/           CommandCode Go 模型、协议、账号池、OAuth、额度、Messages 转换与路由
src/runtime/               响应体形状嗅探、流回放与 abort/截断分类
deepseek-sha3.wasm         DeepSeek PoW 原生求解器
```

`worker.ts` 仍然从 `main.ts` 导入 `handler`，部署入口保持不变。

### 流式响应可靠性

`src/runtime/stream-normalizer.ts` 提供跨 Provider 的基础能力：

- 按响应体前 4 KiB 判断 `SSE/JSON/空/未知`，不完全依赖 `Content-Type`；
- 检查后把已读字节回放到新的 `ReadableStream`，不丢首帧；
- 等待首个响应体字节有 15 秒上限，避免上游只回 headers 后长期挂起；
- 区分 `aborted`、`timeout`、`stream_cut` 和 `transport`，客户端取消不会被当成可重试错误；
- 已经向客户端输出后发生截断时不会重放请求；
- CommandCode 收到无法解析的 tool arguments 时不会把损坏调用交给客户端，而是按 `length`/截断处理。

CommandCode 已接入 abort/timeout 分类；DeepSeek 网页端和 cnb 已接入响应体嗅探。

---

## 快速开始

### 方式 A：本地 Deno 直跑

```bash
deno run -A main.ts        # 监听 http://localhost:8000（PORT 环境变量可改端口）
```

### 方式 B：Deno Deploy

```bash
deno deploy                # 配置见 deno.jsonc（org: hitmargin, app: ai-api）
```

### 方式 C：Cloudflare Workers + 隧道（规避边缘 CPU 配额）

```powershell
pwsh .\restart.ps1
```

`restart.ps1` 会依次：杀掉旧的 `deno main.ts` 与 `cloudflared` 进程 → 后台启动本地 8000 端口 → 启动 cloudflared 隧道 →
从日志里正则抓出 `https://xxx.trycloudflare.com` → 用 `wrangler secret put BACKEND_URL` 写回 Worker。

> 脚本会自动探测本机 Clash 的 `127.0.0.1:7897` 并设置 `HTTPS_PROXY`（wrangler 访问 npm/API 需要）。
> 停止全部：`Get-Process deno,cloudflared | Stop-Process`
> 服务日志：`%TEMP%\ai-proxy.log`（stderr，`[cnb-gate]` 诊断流水在这里）与 `%TEMP%\ai-proxy-out.log`（stdout）。

### 方式 D：纯本地模式（不碰隧道与 Worker）

```powershell
pwsh .\restart.ps1 -Local
```

只做三件事：杀掉旧的 `deno main.ts` → 启动新服务（8000）→ 健康检查。**完全不触碰** cloudflared（不杀也不建）、
Cloudflare Worker（不跑 wrangler、不动 `BACKEND_URL`）、网络代理（连 Clash 探测都跳过）——全程唯一的网络流量是对
`127.0.0.1:8000` 的健康检查。客户端直连 `http://localhost:8000/cnb/v1`。

本地与完整模式共用同一个 8000 端口，可随时互相补位：本地模式跑着时再执行一次完整模式，隧道会接到重启后的新服务上；
反之，完整模式的隧道在跑时执行 `-Local` 只重启本地服务，远端链路自动恢复。

### 开发检查

```powershell
deno task check
deno task test
```

`deno task test` 使用 `--allow-env`，因为测试导入的运行时会读取 `API_KEYS` 等环境变量；不会读取或打印凭据文件。

---

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `API_KEYS` | 否 | 访问本代理的白名单，逗号分隔。**留空 = 完全开放**，任何人都能用 |
| `MAX_REQUEST_BODY_BYTES` | 否 | 通用 `/v1` 与反向代理请求体上限，默认 `12582912`（12 MiB） |
| `BACKEND_URL` | 否 | 有值即进入**反向代理模式**，全部请求原样转发到该地址（如隧道 URL） |
| `DEFAULT_BEARER_TOKEN` | 否 | 透传类上游的兜底 Bearer token |
| `ANTHROPIC_API_KEY` | 否 | `/anthropic/v1` 使用 |
| `GEMINI_API_KEY` | 否 | `/gemini/v1` 使用 |
| `OPENROUTER_API_KEY` | 否 | `/openrouter/v1` 使用 |
| `COMMANDCODE_ADMIN_KEY` | 否 | CommandCode 管理接口独立密钥；设置后需通过 `X-CommandCode-Admin-Key` 发送 |
| `COMMANDCODE_API_KEY` | 否 | CommandCode Go 账号 key；账号池为空时作为单账号兜底 |
| `COMMANDCODE_BASE_URL` | 否 | CommandCode 网关地址，默认 `https://api.commandcode.ai`；非 loopback 必须 HTTPS |
| `COMMANDCODE_VERSION` | 否 | CLI 兼容版本头，默认 `1.31.0`；真实网关升级后需按协议调整 |
| `COMMANDCODE_MODELS_URL` | 否 | 模型目录覆盖地址；默认 `${COMMANDCODE_BASE_URL}/provider/v1/models`；自定义地址要求 HTTPS/loopback |
| `COMMANDCODE_CATALOG_URL` | 否 | CLI `models.md` effort/档位目录覆盖地址；自定义地址要求 HTTPS/loopback |
| `COMMANDCODE_REGISTRY_URL` | 否 | CLI bundle 模态注册表覆盖地址（仅本地 Deno 默认下载；自定义 URL 同样要求 HTTPS/loopback） |
| `COMMANDCODE_ACCOUNTS_FILE` | 否 | OAuth 多账号清单，默认 `./commandcode-accounts.json` |
| `COMMANDCODE_MAX_TOKENS` | 否 | `/models` 声明和实际上游请求的输出 token 上限，默认 `64000` |
| `COMMANDCODE_MAX_BODY_BYTES` | 否 | 直接 CommandCode Chat/Responses 请求体上限，默认 `12582912`（12 MiB）；聚合/反代请用 `MAX_REQUEST_BODY_BYTES` |
| `COMMANDCODE_MAX_PAUSE_TURNS` | 否 | `pause_turn` 在尚未产生输出时的同会话安全续写次数，默认 `2`；输出开始后仍会拒绝重放 |
| `COMMANDCODE_MAX_INFLIGHT` | 否 | 每个 CommandCode 账号允许的同时在途请求数；`0` 表示不限制，默认 `0` |
| `COMMANDCODE_MIN_INTERVAL_MS` | 否 | 同一账号两次请求启动的最小间隔毫秒数，默认 `0` |
| `COMMANDCODE_TIMEOUT_MS` | 否 | 单次 CommandCode 请求总超时，默认 `600000` |
| `COMMANDCODE_SESSION_SALT` | 否 | 显式会话头哈希的服务端盐；不设时每进程随机，重启后亲和性改变 |
| `COMMANDCODE_ALLOW_REMOTE_IMAGES` | 否 | 设为 `1/true/yes` 才允许代理下载 HTTP(S) 图片；默认关闭以避免 SSRF |

### DeepSeek 网页端反代（`/deepseek-web/v1`）
1. 运行自动登录与凭证捕获脚本：
   ```powershell
   deno run -A .tmp-extract-deepseek-cookies.ts
   ```
2. 脚本会打开系统 Edge 的 DeepSeek 登录页；在页面中完成扫码/登录后，无需按回车，脚本会自动捕获 Cookie、Bearer Token 和网页请求指纹头，分别保存到 `deepseek-cookies.txt`、`deepseek-auth.txt` 和 `deepseek-headers.json`。图片上传依赖这些真实请求头。
3. 三个凭证文件均已加入 `.gitignore`，不要上传或分享。
4. 会话默认按账号复用 20 轮；设置 `DEEPSEEK_SESSION_REUSE_TURNS=0` 可恢复每轮创建/删除临时会话。达到复用上限后旧会话延迟清理。
5. 调用：
   ```bash
   curl http://localhost:8000/deepseek-web/v1/chat/completions \
     -H "Content-Type: application/json" \
     -d '{
       "model": "deepseek-chat",
       "messages": [{"role": "user", "content": "你好"}]
     }'
   ```

> **注意**：DeepSeek 网页端接口为私有接口，随时可能改版；当前实现已包含网页端 `DeepSeekHashV1` PoW（使用本地 `deepseek-sha3.wasm` 自动求解）。同一账号默认复用一个 `chat_session` 最多 20 轮，达到上限后创建新会话并延迟清理旧会话；设置 `DEEPSEEK_SESSION_REUSE_TURNS=0` 可恢复每轮创建/删除。每轮仍完整序列化 OpenAI `messages`（上限 20 万字符）。响应会按上游 SSE 实时转发：`THINK` 片段输出为 `delta.reasoning_content`，`RESPONSE` 片段输出为 `delta.content`，工具调用输出为 `delta.tool_calls`；请求支持 `reasoning_effort`（`off` / `low` / `high` / `max`）。网页端本身只有 `thinking_enabled` 开关，`low/high/max` 都只表示开启思考，等级会作为模型指令注入。工具协议源码及许可证见 [`third_party/dsh-deepseek-web-login`](third_party/dsh-deepseek-web-login)。
>
> **业务错误与冷却**：代理会解析 HTTP 200 中的 `biz_code/biz_msg`、SSE `error/toast` 事件、`content/msg` 错误正文和 `mute_until`；completion 会区分 SSE 与非 SSE 响应；限流/封禁期间返回 HTTP 429、`Retry-After` 和 `type: rate_limit_exceeded`，冷却状态持久化在 `deepseek-web-cooldown.json`，进程重启不会丢失。401/403/账号受限后不会自动重试或切换账号。Responses 流会把上游错误转换为 `response.failed`。
>
> **安全阀**：同一账号请求严格串行，两次请求结束之间随机等待 2～4 秒；连续 15 次后随机长休 1～3 分钟；单 prompt 上限 20 万字符；收到 429 后至少冷却 30 分钟，收到 401/403 后至少冷却 2 小时。暂停期间不会自动重试或切换账号。这些措施只能降低风险，不能保证不触发平台限制。
>
> **Responses API**：`/deepseek-web/v1/responses` 现已支持非流式和 SSE 流式 Responses；输入会转换为网页端 prompt，工具调用会输出为 `function_call` / `response.function_call_arguments.delta`。
>
> **DSH 思考档位**：由于 DSH 的 OpenAI 兼容模型列表不会读取自定义 `reasoning_efforts` 字段，HTTP 代理同时暴露了 `deepseek-reasoner-off/low/high/max` 等模型变体；在 DSH 中选择这些模型即可切换档位。若要显示原生下拉控件，需要把 `dsh-deepseek-web-login` 作为 DSH 插件安装，让它通过 `ctx.llm` 注册模型元数据。
>
> **请求指纹**：DeepSeek 网页请求统一使用 `deepseek-headers.json` 中捕获的浏览器请求头，避免 Deno 默认 UA、重复版本头和非官方 Harness 标记；未捕获时使用单一 fallback，不会把同名头拼成 `a, b`。
>
> **风险提示**：`GET /deepseek-web/v1/risk` 返回本地启发式风险分数，`GET /deepseek-web/v1/risk.txt` 适合命令行查看；聊天响应也会带 `X-DeepSeek-Risk-Level` 和 `X-DeepSeek-Risk-Score`。分数只反映本地请求频率、连续请求、prompt 大小和 429/403 冷却，不是 DeepSeek 官方封号概率。

### CommandCode Go（`/commandcode/v1`）

此模块把 CommandCode Go 套餐使用的 CLI 私有网关 `POST /alpha/generate` 转换成 OpenAI Chat Completions 与 Responses API。核心实现移植自 MIT 许可的 [`Ajwyunsx/dsh-cmdgo-provider`](https://github.com/Ajwyunsx/dsh-cmdgo-provider)，许可证与修改说明见 [`third_party/dsh-cmdgo-provider/NOTICE.md`](third_party/dsh-cmdgo-provider/NOTICE.md)。

**配置凭据（二选一）**：

> 当前仓库测试使用 fake gateway 验证协议和转换；没有在真实 CommandCode 账号上执行推理。上线前请用专用测试 key 验证 Chat/Responses、工具调用、usage、429 冷却和 OAuth，再用于生产会话。

1. 环境变量单账号模式：
   ```powershell
   $env:COMMANDCODE_API_KEY='user_xxx'
   pwsh .\restart.ps1 -Local
   ```
2. 本机 OAuth 多账号模式：
   ```powershell
   $login = Invoke-RestMethod -Method Post http://localhost:8000/commandcode/v1/login
   Start-Process $login.authUrl
   Invoke-RestMethod http://localhost:8000/commandcode/v1/status | ConvertTo-Json -Depth 8
   ```
   浏览器授权后，key 自动写入 `commandcode-accounts.json`。该文件已加入 `.gitignore`，并尽可能设置为仅当前用户可读写；它仍包含明文 key，请勿上传或分享。每次 OAuth 登录新增一个账号，请求按 round-robin 调度。401/403/429/5xx 或传输错误会令该账号指数冷却，并在首字节前切换下一个账号。`COMMANDCODE_MAX_INFLIGHT` 和 `COMMANDCODE_MIN_INTERVAL_MS` 可进一步限制单账号并发与请求启动间隔。`COMMANDCODE_API_KEY` 只在账号池为空时作为兜底。

**模型目录**：`GET /commandcode/v1/models` 从公开目录拉取模型，先用静态 Go 档位规则快速发布，再用官方 CLI `models.md` 的 `Min plan` 列双向覆盖，同时合并 reasoning effort 与图像模态。目录缓存 15 分钟；`?refresh=true` 可强制刷新。

DSH 的 OpenAI 兼容 provider 不会自动把 HTTP `/models` 的自定义元数据写入模型选择器，因此需要在活动 profile 的 `llm-pi-ai.providers` 中静态注册所需模型，例如：

```yaml
commandcode:
  apiKeyEnv: AI_PROXY_API_KEY
  api: openai-completions
  baseURL: http://localhost:8000/commandcode/v1/
  models:
    - id: deepseek/deepseek-v4-flash
      name: DeepSeek V4 Flash (CommandCode Go)
      contextWindow: 1000000
      maxTokens: 64000
      input: [text]
      reasoningEfforts:
        low: low
        medium: medium
        high: high
        xhigh: xhigh
        max: max
        off: null
  reasoning: high
```

若使用远端 Worker/tunnel，只需把 `baseURL` 改为对应 Worker 地址。示例中的 `AI_PROXY_API_KEY` 是 **DSH 客户端访问本代理**所用的 key，其值应已列入代理的 `API_KEYS` 白名单；它与代理进程读取的 CommandCode 上游 `COMMANDCODE_API_KEY` 是两个不同用途。若 `API_KEYS` 留空，DSH 仍可配置一个占位 key，但请求不会鉴权。

### 手动真实上游 smoke

仓库的自动测试使用 fake gateway，不会消耗上游额度。需要验证真实 CommandCode 账号时，显式运行：

```powershell
deno run --allow-env --allow-net .\scripts\probes\commandcode-smoke.ts `
  --base-url http://127.0.0.1:8000 `
  --model deepseek/deepseek-v4-flash `
  --confirm-live
```

如果本机代理配置了 `API_KEYS`，可临时设置 `AI_PROXY_API_KEY`；脚本不会读取 `COMMANDCODE_API_KEY`、OAuth 账号文件或 `session.json`，也只输出状态、模型、usage 和长度，不打印模型正文或凭据。`--stream` 可额外检查 SSE 帧和 `[DONE]`。

---

### 同步 DSH 模型配置

不要手工维护几十个模型。运行：

```powershell
pwsh -File .\scripts\sync-commandcode-models.ps1 -Mode Output
```

脚本会从本地 `/commandcode/v1/models` 生成：

```text
.\commandcode-models.generated.yml
```

默认只生成文件，不修改 DSH profile。确认内容后，可以显式应用：

```powershell
pwsh -File .\scripts\sync-commandcode-models.ps1 `
  -Mode Apply `
  -ProfilePath "C:\Users\22282\.dsh\profiles\web\cordis.patch.yml"
```

只检查是否同步：

```powershell
pwsh -File .\scripts\sync-commandcode-models.ps1 `
  -Mode Check `
  -ProfilePath "C:\Users\22282\.dsh\profiles\web\cordis.patch.yml"
```

脚本只使用 `AI_PROXY_API_KEY` 或 `API_KEYS` 中的代理客户端 key，不读取 `COMMANDCODE_API_KEY`、OAuth 文件或 ChatGPT 会话文件。默认输出文件已加入 `.gitignore`。

**调用**：

```bash
curl http://localhost:8000/commandcode/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek/deepseek-v4-flash",
    "messages": [{"role":"user","content":"你好"}],
    "reasoning_effort": "high",
    "stream": true
  }'
```

- `/commandcode/v1/responses` 支持非流式和 SSE 流式 Responses；输入会转换为同一套 CLI 网关请求。`previous_response_id`、`conversation`、后台/存储模式等无法在无状态代理中兑现的字段会明确返回 400，不会静默丢弃。
- `/commandcode/v1/messages` 支持 Anthropic Messages 的 JSON 与 SSE 转换，覆盖 system、文本、base64 图片、tool_use/tool_result 和 `auto/none` 工具选择；`stop_sequences`、`thinking`、`top_k` 以及需要指定工具的 `tool_choice` 会明确返回 400。
- 网关 NDJSON 的文本、思考、工具调用、usage、finish/error 事件会分别转换成 OpenAI `content`、`reasoning_content`、`tool_calls` 和 `usage`。`pause_turn` 在尚未产生客户端输出时会使用同一 session 做有限次数续写；一旦已经输出内容则返回 `unsupported_pause_turn`，避免重复生成。
- 客户端显式发送 `x-session-id` / `x-conversation-id` 时，代理会按“客户端鉴权凭据 + 服务端盐 + 会话头”派生稳定的 `sess_<16 hex>`；未发送时每个 one-shot 请求使用独立随机 ID，避免不同用户共用上游会话。隧道与 `/v1` 聚合入口会透传这两个头。
- 图片默认支持 data URL；只有显式设置 `COMMANDCODE_ALLOW_REMOTE_IMAGES=1` 才会下载 HTTP(S) 图片并转为 data URL（远程下载有 SSRF 风险，默认关闭）。工具调用会在发出前保证 call/result 严格配对，网关点名缺结果时最多自愈重试 4 次。

**账号与额度接口**：

| 方法与路径 | 说明 |
|---|---|
| `GET /commandcode/v1/status` | 账号池、冷却、登录、额度与缓存统计；不会返回 key |
| `GET /commandcode/v1/panel` | 面向设置页的模型、账号和健康状态快照；不会返回 key |
| `GET /commandcode/v1/usage` | `status` 的额度兼容别名 |
| `POST /commandcode/v1/usage/refresh` | 强制刷新全部账号，或正文 `{ "id": "账号 id" }` |
| `POST /commandcode/v1/login` | 启动本机 OAuth 回调并返回授权地址 |
| `POST /commandcode/v1/login/cancel` | 取消 OAuth |
| `POST /commandcode/v1/account/toggle` | 正文 `{ "id": "账号 id", "enabled": false }` |
| `POST /commandcode/v1/account/remove` | 删除文件账号及其 key |
| `POST /commandcode/v1/logout` | 清空文件账号池；环境变量 key 无法由 HTTP 修改 |

> **管理面安全**：`/status`、`/panel`、`/usage/refresh`、`/login`、`/account/*`、`/logout` 以及 `GET /models?refresh=true` 在未配置 `API_KEYS` 时只接受 loopback 请求；公网 Worker/隧道应同时设置 `API_KEYS` 与 `COMMANDCODE_ADMIN_KEY`，并通过 `X-CommandCode-Admin-Key` 发送管理密钥。`COMMANDCODE_BASE_URL` 仅允许 HTTPS（HTTP 只允许 loopback 测试），并禁止带凭据的重定向。
>
> CommandCode `/alpha/*` 是私有接口，上游改版、套餐策略和风控均可能使它失效。本项目仅供个人学习研究，请遵守上游服务条款。

鉴权逻辑见 `checkAuth`：接受 `Authorization: Bearer <key>` 或 `x-api-key: <key>`；根路径 `/` 豁免（用于列出 provider）。

---

## 路由表

每个上游是一份配置（见 `src/core.ts` 的 `providers`），包含 `prefix` / `baseUrl` / `auth` / `pathRewrite` / `endpoints` / `adapter` / `filterModels`。

| 路径前缀 | 上游 | 适配方式 |
|---|---|---|
| `/v1` | **聚合入口** | kilo / zen / cnb / commandcode：模型加 `kilo/`、`zen/`、`cnb/`、`commandcode/` 前缀统一列出与分发 |
| `/kilo/v1` | api.kilo.ai | 透传，仅保留 `isFree: true` 的模型（kilo 的直连前缀，聚合成员之一） |
| `/zen/v1` | opencode.ai/zen | 透传，默认 token `public`，仅保留 `-free` 模型 |
| `/deepseek-web/v1` | chat.deepseek.com 网页聊天端 | 需要登录 Cookie，支持 Chat Completions 与 Responses |
| `/commandcode/v1` | CommandCode Go CLI 网关 | 模型发现、私有协议转换、多账号池、额度、Chat Completions 与 Responses |
| `/anthropic/v1` | api.anthropic.com | `toAnthropic` 双向翻译 |
| `/gemini/v1` | generativelanguage.googleapis.com | `toGemini` 双向翻译 |
| `/openrouter/v1` | openrouter.ai | 透传 |
| `/openrouter/v1/responses` | openrouter.ai | 透传 Responses API |
| `/tokenharbor/v1` | tokenharbor.ai | 透传，仅保留 `:free` 模型 |
| `/cnb/v1` | cnb.cool | **自定义处理器**（见下节） |
| `/health` | 本地代理 | 返回最近一次模型健康探测汇总；不会在请求时自动发起探测 |

`GET /` 会返回所有可用 provider 列表。`GET /health` 返回各 provider 最近一次健康探测的状态（`available` / `degraded` / `unavailable` / `unknown`）；没有探测记录时显示 `unknown`，不会因为一次网络失败把模型清单清空。

**聚合端点 `/v1`**：`GET /v1/models` 返回 kilo + zen + cnb + commandcode 全部模型的并集（id 分别加 `kilo/`、`zen/`、`cnb/`、`commandcode/` 前缀防冲突）；
POST 时 model 写带前缀的 id（如 `cnb/deepseek-v4-pro`、`commandcode/deepseek/deepseek-v4-flash`）即自动分发到对应上游，完整复用该上游的
处理链。不带前缀的裸 id 按 kilo→zen→cnb→commandcode 顺序解析（保持旧行为），冷启动后需先 GET 一次 `/v1/models` 暖缓存。分发时会剥掉客户端 token，让各成员用自家默认凭据；仅当本代理设置 `API_KEYS` 时才透传客户端鉴权头。

**模型列表**有 5 分钟内存缓存，并会在后台异步做健康探测（`testModel`，3 秒超时；200 可用，429/5xx 视为 degraded，401/403 才是 unavailable，网络失败保留为 unknown），在 Deno Deploy 上用 `EdgeRuntime.waitUntil` 挂起，不阻塞响应；加 `?health=true` 可强制同步探测。探测结果可通过 `GET /health` 查看。

---

## 客户端用法

任何 OpenAI 兼容客户端都可以直接指过来：

```bash
curl https://<your-host>/cnb/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <API_KEYS 中的一个>" \
  -d '{
    "model": "deepseek-v4-pro",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
```

```python
from openai import OpenAI

client = OpenAI(base_url="https://<your-host>/cnb/v1", api_key="<API_KEYS 中的一个>")
resp = client.chat.completions.create(
    model="deepseek-v4-flash",
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)
```

---

## cnb.cool 模块

`src/cnb.ts` 是 cnb 集成模块，也是全项目最复杂的部分。

### 1. 会话自举

cnb 的网页端接口需要 CSRF 双因子（token + cookie）：

- `cnbFetchCsrf` GET `https://cnb.cool/`，从 HTML 正则抓 `window.csrftoken`，从 `Set-Cookie` 抓 `csrfkey`；
- 缓存 25 分钟（`CNB_TTL`），并用 `cnbState.pending` 做**单飞（single-flight）**，防止并发请求重复握手；
- `cnbCall` 请求时带上 `Csrftoken` 头、`csrfkey` cookie、移动端 UA、`Origin` / `Referer`。

### 1.5 登录态（cnb-login.txt）

cnb.cool 已要求登录才能调用推理接口（匿名会话 401 [NOT_LOGIN]）。登录态通过项目根目录的
`cnb-login.txt` 提供（已在 .gitignore 排除）：

1. 浏览器登录 cnb.cool；
2. F12 → Network → 刷新页面 → 点任一 cnb.cool 请求 → Request Headers 里复制完整 `Cookie:` 头的值；
3. 单行粘贴进 `cnb-login.txt` 保存（也支持 Netscape cookies.txt 导出格式）。

行为：按 mtime 热加载，刷新 Cookie 无需重启代理；`csrfkey` 会自动从登录串剔除
（CSRF token+cookie 对仍由代理匿名抓取配对）；文件不存在 = 退回匿名模式（当前上游会 401，
错误信息里带粘贴指引）。

### 2. 工具调用的「文本协议」模拟

cnb 上游不支持原生 `tool_calls`，所以改用提示词协议：

- `cnbBuildToolPrompt` 把所有工具定义拼成系统提示词，要求模型输出 `` 包裹的 JSON；
- 历史里的 assistant `tool_calls` 会转回同样的文本，工具结果转成 `[Tool Result id=...]` 的 user 消息——让模型「看到自己的历史就是正确示范」；
- `cnbParseToolCalls` 是**极其宽容**的反向解析器：兼容 `XYML` / `QNML` / DeepSeek 原生 `DSML` / `` 等多种变体，能修复被截断的 JSON、按 JSON Schema 强制类型、拆解嵌套 arguments、归一化形近字、检测「一字符一行的退化输出」、参数名反猜工具等；
- `createLiveFilter` 在**流式输出**时扣住「可能是标记开头」的前缀，保证协议标记不会泄漏到用户可见正文。

### 3. Responses API

`handleCnbResponses` 把新版 `/v1/responses` 请求降级成 chat 格式跑一遍，再重组为 Responses 的 output items（`reasoning` / `message` / `function_call`），流式与非流式均支持。

### 4. 可靠性

- `cnbCallUpstream` 按 `[0, 500, 1500, 3500, 8000, 20000]` ms 退避重试；
- 网络层失败会刷新 CSRF 会话再试；4xx（429 除外）视为确定性错误直接透传；
- `deepseek-v4-flash` 连续 5xx 时**自动降级到 `deepseek-v4-pro`**；
- `cnbCall` 带 **30 秒无响应头超时**——cnb 偶发无限挂起，中止后交给退避重试（只罩到响应头返回，不限流式生成总时长）；
- **串行闸**：cnb 网页会话按 cookie 归属，多客户端并发共用一个 cookie 会互踩（曾观测到跨会话内容泄漏）。所有 cnb 上游调用同一时刻只放行一个，锁持有到**响应流真正消费完**（流结束/出错/消费方取消/2 分钟无数据/10 分钟硬安全阀任一条件释放），日志以 `[cnb-gate] fp=...` 记录排队与释放（fp 为会话指纹，重叠且 fp 不同即跨会话并发）；
- **1 MiB 请求体预检**：cnb 网关（nginx）硬性拒绝超过 1 MiB 的请求体，超过则毫秒级本地返回 413，不浪费隧道往返。

### 5. 其它

- **可用模型**：`deepseek-v4-flash`、`deepseek-v4-pro`；
- **视觉**：`user` / `system` 消息中的 `image_url` 块会被保留为多模态数组，而不是被折叠成纯文本（`src/cnb.ts` 中保留了这次修复的注释）；
- **思考强度**：`enable_thinking` 恒为 `true`，`reasoning_effort` 取客户端值（`low` / `medium` / `high` / `max`），默认 `high`；
- **输出上限**：cnb 通道 `max_tokens` 默认 `flash: 120000` / `pro: 60000`（预算含思考 token；实测 flash 思考最多吃掉约一半，故单独调大）；

### 6. 实测能力与上限（2026-09，直连本地服务实测）

| 指标 | 实测值 |
|---|---|
| 输入上下文 | ≥ 271,000 token 无截断（首尾暗号均可召回，服务端 `prompt_tokens` 实读） |
| 硬上限 | **请求体 ≤ 1 MiB**（cnb 网关 nginx 限制，超限 413 `BODY_TOO_LARGE`；英文 ≈ 26.2 万 token，UTF-8 中文 ≈ 35 万字） |
| 输出 | flash 单次 59,884 token 全量吐完（其中思考 30,883）；pro 同任务 31,590（思考仅 2,589） |
| 吞吐 | ≈ 400–440 token/s |
| Prompt cache | 跨请求生效（相同前缀命中，`usage.prompt_cache_hit_tokens` 可见），连续对话 prefill 显著加速 |

> **排障口诀**：客户端看到 5xx/502 先看本地日志与请求体大小——中转层（共享订阅网关等）常把上游的 413/5xx
> 统一包装成「Upstream service temporarily unavailable」，报错文案不能按字面理解。

---

## 项目结构

| 文件 | 作用 |
|---|---|
| `main.ts` | 入口、鉴权、Provider 路由、/v1 聚合、本地 Deno 启动 |
| `src/core.ts` | 环境变量、Provider 配置、协议适配器、通用 HTTP/流式工具 |
| `src/cnb.ts` | cnb.cool CSRF、登录态、工具调用、Responses API |
| `src/deepseek-web.ts` | DeepSeek 登录态、PoW、完整上下文、SSE、思考和工具调用 |
| `src/commandcode/` | CommandCode Go 模型发现、私有协议、多账号池、OAuth、额度与 OpenAI 转换 |
| `third_party/dsh-deepseek-web-login/` | Apache-2.0 工具协议派生代码及许可证 |
| `third_party/dsh-cmdgo-provider/` | dsh-cmdgo-provider 的 MIT 许可证与移植说明 |
| `worker.ts` | Cloudflare Workers 入口 shim（把 `vars`/secrets 注入 `main.ts` 的模块级 `ENV`） |
| `wrangler.jsonc` | Worker 配置（`name: ai-api`，`main: worker.ts`） |
| `deno.jsonc` | Deno Deploy 配置（`org: hitmargin`，`app: ai-api`） |
| `restart.ps1` | 一键：本地服务 + 隧道 + 更新 Worker 的 `BACKEND_URL` 密钥；`-Local` 只启动本地服务，不碰隧道/Worker/代理 |
| `deno.lock` | 依赖锁定 |

本地开发还会出现（已在 `.gitignore` 中排除）：`cookies.txt`（抓包得到的 cookie）、`commandcode-accounts.json`（CommandCode OAuth 多账号 key）、`.wrangler/`（Cloudflare 账号缓存）、
`cloudflared.exe`、`page.html`（页面快照）、`main.ts.bak-*`（历史备份）。

---

## 已知限制

- cnb 通道完全依赖网页端私有接口，**上游改版即失效**；
- CommandCode Go 同样依赖 `/alpha/*` 私有 CLI 网关，模型档位、指纹要求或 OAuth 回调发生变化时需要更新；
- 免费上游的模型清单随时变化，且常见限流（429）与容量窗口（5xx）；
- `trycloudflare` 快速隧道的 URL 每次重启都会变（由 `restart.ps1` 自动回写 `BACKEND_URL`），且可能有连接抖动；`proxyToBackend` 仅对幂等请求最多重试一次，非幂等 POST 不自动重放以避免重复计费；
- 内存缓存（模型列表 5 分钟、CSRF 25 分钟）在边缘多实例下不共享。

---

## 许可证

本项目采用 **GNU General Public License v3.0** 许可，全文见 [LICENSE](LICENSE)。

本项目包含来自 `dsh-cmdgo-provider` 的派生代码；该部分按 MIT 许可使用，原始版权与许可证见
[`third_party/dsh-cmdgo-provider/LICENSE`](third_party/dsh-cmdgo-provider/LICENSE) 和 [`NOTICE.md`](third_party/dsh-cmdgo-provider/NOTICE.md)。

```
Copyright (C) 2026 adofaiex

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.
```
