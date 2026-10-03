# ai-proxy

多上游 AI API 聚合代理：对外暴露**统一的 OpenAI 兼容接口**，对内把请求翻译/伪装成各个上游能接受的形态。

支持以下上游：

1. **标准 OpenAI 兼容上游**（透传）：kilo.ai、opencode.ai/zen、openrouter.ai、tokenharbor.ai
2. **网页端私有接口**：chat.deepseek.com（PoW + Cookie 会话）、api.trae.cn（协议翻译 + 签到）、cnb.cool（会话自举 + 提示词协议模拟），分别包装成标准 Chat Completions / Responses
3. **私有 CLI 网关**：CommandCode Go（移植 `dsh-cmdgo-provider` 的模型筛选、网关协议、多账号池与额度读取）与 WorkBuddy 中国版（文件凭据 + 自动续期 + 流内内容拦截）
4. **Anthropic Messages**：`/commandcode/v1/messages` 做 OpenAI ⇄ Messages 双向转换（原先的 `/anthropic/v1` 与 `/gemini/v1` 已下线，见下方说明）

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
      │  /cnb/v1/chat/completions  /v1/...  /commandcode/v1/messages  ...
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
src/deepseek-gate.ts       DeepSeek 网页端串行闸与安全阀（冷却、频率、并发）
src/deepseek-responses.ts  DeepSeek 网页端 Responses API 转换
src/deepseek-risk.ts       DeepSeek 网页端本地启发式风险打分
src/trae.ts                TRAE 协议翻译、工具调用、思考档位、签到
src/trae-account.ts        TRAE 凭据落盘、过期与续期、远端模型目录
src/workbuddy.ts           WorkBuddy 凭据解析、目录/倍率/促销、请求体、错误分类、流内拦截
src/workbuddy-account.ts   WorkBuddy 凭据落盘、过期与续期、目录并集、可调性探测
src/zen.ts                 Zen 请求头补齐、Responses/Messages 转换、错误分类
src/zen-catalog.ts         Zen 模型能力元数据（来自 models.dev）
src/zen-compaction.ts      Zen 会话压缩
src/zen-egress.ts          Zen 出口代理轮换
src/commandcode/           CommandCode Go 模型、协议、账号池、OAuth、额度、Messages 转换与路由
src/runtime/               响应体形状嗅探、流回放、abort/截断分类、目录健康登记
dsh-plugin/               可选 DSH Host Provider 桥接插件（按渠道分组注册）
third_party/              移植来源的代码与许可说明（CommandCode Go provider）
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

**渠道清单拉取失败不再静默。** `GET /v1/models` 的聚合过去在某个成员拉取失败时直接跳过它，于是整个渠道从选择器里消失——没有报错、没有日志、`/health` 里也什么都看不到，界面只表现为「渠道变少了」。实测出现过 kilo 的 17 个模型整条消失、面板只剩两个渠道却无人知道原因。

现在每种结果都会被记录（`src/runtime/health.ts` 的 `CatalogRegistry`）：请求抛错、上游返回不可用的列表、以及**上游正常返回但被 provider 过滤器清空**（第三种最隐蔽——kilo 的 `isFree` 字段若改名，渠道会静默变空而不是报错）。失败写日志，并出现在 `GET /health` 的 `catalog` 与 `catalogIssues` 里；插件把它们带到面板的渠道区，标为「列表拉取失败」。

**Zen 现在也接入了截断检测。** reader 报 `done` 并不等于回答写完了——Zen 在匿名额度中途耗尽、或传输失败时都会直接关连接，而这两者过去都会给客户端留下一个 `finish_reason: stop` 和半句没写完的话，和「模型自己决定停止」完全无法区分。agent loop 于是判定回合正常结束、标记目标完成、起下一个目标，故障在任何地方都不留痕迹。

**插件侧同样如此。** `dsh-plugin/index.js` 的 `readSse` 是插件注入模型独有的手写 SSE 读取器（配置里手写的模型走 DSH 内置的 OpenAI 客户端，不经过它），过去同样不检查 `[DONE]` 是否到达：流提前断开时循环正常退出、`finish` 保持 `undefined`，而 `finishKind(undefined)` 返回 `'stop'`——被掐断的流和正常结束的流对 agent loop 完全一样，于是它判定这一轮说完、标记目标完成、起下一个。这就是「所有供应商的插件注入模型都有概率要干活却直接停止，而配置里手写的没有」的原因。现在缺终止帧即报失败，并区分两种情况：**已经输出过内容的**用非重试码 `stream_cut`（重放会重复执行并二次付费），**一个字都还没输出**的用 `TRANSPORT`（这是重试真正有意义的唯一情形）。已到达的部分照常收尾，文字不会随失败一起丢掉；统计记 `ok: false / truncated: true`，截断第一次在用量面板里变得可见。

Zen 侧**由各 wire 自己的终止帧判定是否完成**，而不是由 reader：`[DONE]`（chat）、`response.completed` / `failed` / `incomplete`（responses）、`message_stop`（messages）。没有终止帧就结束 = 截断，会先补一帧 `{"error":{"code":"stream_cut"…}}` 再收尾——插件会把这种帧变成可见的错误。客户端主动取消**不算故障**（走 `StreamAbort`，静默结束），否则用户点停止也会被报成上游问题。

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
| `OPENROUTER_API_KEY` | 否 | `/openrouter/v1` 使用；未配置时该渠道不进模型列表 |
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
| `ZEN_BASE_URL` | 否 | Zen 上游地址覆盖，默认 `https://opencode.ai/zen/v1` |
| `ZEN_BEARER_TOKEN` | 否 | Zen 上游 Bearer token 覆盖（默认走 `public`） |
| `ZEN_CATALOG` | 否 | 从 models.dev 读取 Zen 模型能力元数据；设为 `off` 跳过（该目录约 5 MB，见下） |
| `ZEN_MODEL_LIMITS` | 否 | 目录未收录模型的上下限，如 `{"jev-1.13-free":{"context":200000,"output":32000}}` |

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

### WorkBuddy 中国版（`/workbuddy/v1`）

WorkBuddy（中国版，主机 `www.workbuddy.cn`）的请求体和 SSE **本身就是标准 OpenAI 形态**，所以这一路不做任何协议翻译：`stream: true` 的 Chat Completions 请求原样转发，响应字节原样回传。代理只补三件上游必须看到的东西——凭据、归属头、以及藏在 200 里的内容拦截。

**配置凭据**：

```powershell
deno run -A .tmp-workbuddy-login.ts
```

脚本会打开浏览器完成登录（轮询式，客户端不起本地回调服务器），把令牌写入仓库根目录的 `workbuddy-auth.json`（已加入 `.gitignore`），并顺带打印 `credential.domain` 与三个主机各自的模型目录——中国版与国际版路径完全相同，只有主机不同，实测 `www.workbuddy.cn` / `www.workbuddy.ai` / `copilot.tencent.com` 路由集一模一样，所以靠「参考实现里 WorkBuddy 是国际版」推不出中国版主机。凭据文件被删或损坏时 `GET /workbuddy/v1/models` 直接报错，不回退到静态模型表：静态表刻意留空，因为猜一个 id 只会把用户送进「选得到、调不通」的模型。

三个必须照做的实现约束：

- **`prompt_cache_key` 必须回传**。用请求头 `x-session-id` / `x-conversation-id`（都没有才随机生成），否则上游缓存命中率归零——实测同一会话 `prompt_tokens=8027, prompt_cache_hit_tokens=0, credit=0.34`，带上之后命中 7808、`credit=0.02`，约 17 倍。
- **5 个归属头一个都不能少**（`X-Product` / `X-Product-Code` / `X-IDE-Name` / `X-IDE-Type` / `X-IDE-Version`），后台「使用端」一栏靠它们归因，缺任一头就显示 `-`。
- **流内 11140 要单独判**。内容审核拒绝会返回 HTTP 403，也可以包在 HTTP 200 的 SSE 里；且它和真认证失败共用 403，所以只认「无 `choices` 字段 + 正文命中 `"code": 11140`」这一条窄判据。它是**账号级**拦截（同一请求发 7 个账号：2 个 200、4 个 403、1 个 429），换号而不是让用户改内容。

**401** 会先静默用 `refresh_token` 续期并重试一次；**403 要先看 body 再决定**——403 同时承载账号级内容拦截（11140），若不分类就一律续期重发，每次确定性拦截都会白烧一次 refresh 额度**外加**一发全额计费的请求，结果还是同样的 403。目录取 `/console/enterprises/personal/models` 与 `/v3/config` 的**并集**（两个端点的 id 集合不同，促销只挂一侧，先到先得会让整批限时免费模型消失而服务端照常计费），缓存 5 分钟，`?refresh=true` 强制刷新。倍率显示用 `原价→促销价` 箭头形态。**不含签到**：路由 `/v2/billing/meter/daily-checkin` 确实存在（401 而非 404），但中国版文档从未提及该活动，路由存在不等于账号有资格。

### TRAE（`/trae/v1`）

TRAE 只有网页端私有接口，没有公开的 OpenAI 端点，所以这一路必须自己做协议翻译：请求侧的 `reasoning` 块、工具声明、工具选择映射到 TRAE 的私有形状，响应侧的思考增量、文本增量、工具调用分片再拼回标准 SSE/JSON。

**配置凭据**：

```powershell
deno run -A .tmp-trae-login.ts
```

凭据写入仓库根目录的 `trae-auth.json`（已加入 `.gitignore`），过期后自动续期。

三处必须照做的实现约束：

- **模型 id 必须携带所属通道**。TRAE 的目录来自远端（`TraeModel.function`），同一个模型只在列出它的那个通道里可调用——把 `glm-5.1` 发到 `solo_work_lite` 会得到流内 `4001 param is invalid`。所以目录里必须有通道信息，前缀式路由表达不了这件事，**推不到通道宁可 502，也不猜默认值**。
- **多通道目录要带通道信息合并**。目录来自 `/api/ide/v1/batch_get_detail_param`，一次返回多个通道的条目（`TraeModel.function` 标明每个模型属于哪个通道），解析时合并成一份。同一 id 在不同通道给的能力字段可能不一致，能力字段逐字段并集、计费字段留 primary；整块取一个来源会让真实的档位阶梯整个消失。
- **签到是独立的一条链路**：`/trae/api/v2/ug/checkin_credits/status` 与 `/claim` 走 `api.trae.cn`，推理走 `trae-api-cn.mchost.guru` 的 `/api/agent/v3/llm_utils_chat`，两条链路**主机不同**，请求头也不一样（签到不带 SOLO 专属头）。业务码 `9074`「当前参与用户太多」是**按 device_id 的全网高峰限流**，不是账号出问题，所以只能退避重试，不能混进「账号异常」分支；claim 之后要补查 status 才下结论。

### Zen（`/zen/v1`）

`/zen/v1` 现在由 `src/zen.ts` 处理：它补齐 OpenCode 客户端 User-Agent、DSH session 派生的 `x-opencode-session`/`x-opencode-request`、canonical session、工具 quartet、Muse Spark 的 Responses 转换和 FreeTier/Region 错误分类。实测非流式请求会触发 `FreeTierError`，DSH 路径必须保持 `stream: true`。可用 `ZEN_BASE_URL` 和 `ZEN_BEARER_TOKEN` 覆盖默认上游；原始项目代码仍是唯一实现。

### Zen 模型能力元数据（`src/zen-catalog.ts`）

Zen 的 `GET /models` 只返回 `{ id, object, created, owned_by }`，没有上下文窗口、输出上限、模态，也没有推理档位。代理因此改从 [models.dev](https://models.dev) 读取——它的 `opencode` 条目把 `https://opencode.ai/zen/v1` 列为 api，描述的正是同一个网关：

| 模型 | 档位 | ctx | output |
|---|---|---|---|
| `space-bunny-free` | low/medium/high/xhigh/max | 1,048,576 | 524,288 |
| `muse-spark-1.3-contributor-free` | minimal/low/medium/high/xhigh | 1,048,576 | 131,072 |
| `deepseek-v4-flash-free` | low/high/max | 200,000 | 128,000 |
| `longcat-2.5-preview-free` | 仅开关 | 1,000,000 | 131,072 |
| `mimo-v2.6-flash-free` | 不可调 | 200,000 | 32,000 |

阶梯**逐模型不同**，所以不能自己编一套统一的；也没有任何一条阶梯包含 `off`，因此不会凭空补一个「关闭」档。

三点实现约束：

- **目录约 5 MB，不进请求路径**。首次访问只排一次后台刷新并返回当前快照，冷缓存的代价是一次「裸列表」而不是把 5 MB 拉进用户回合。TTL 12 小时，失败降级为上一份快照，`ZEN_CATALOG=off` 可完全关闭。
- **目录没覆盖的模型原样返回**，不补猜测值（目前 `jev-1.13-free` 属于这类，可用 `ZEN_MODEL_LIMITS` 显式指定）。
- **只在目录确认该模型发布了这个档位时才转发 effort**。透传未知档位要么是编造能力，要么给本来能通的请求换来一个 400；不认识的档位改为记日志——这是旧路径从来不做的事。

在此之前，代理对全部 11 个模型使用同一个 `{ context: 1,000,000, output: 64,000 }` 兜底值，而压缩正是在拿这个数字做分母。真实输出上限从 32,000 到 524,288 不等，旧值对目录覆盖的 10 个模型**全都错**：mimo 高估 2 倍，`space-bunny-free` 低估 8.2 倍。

### 可选 DSH Provider 桥接插件

`dsh-plugin/` 现在是整个项目的 DSH 安装桥接：启用后可自动启动/监控原始项目目录中的 Deno 服务，也可以切换为连接已经运行的本地或远程代理。它动态发现 `/v1` 聚合模型并按模型前缀把请求路由回原始代理；浏览器侧是一个现代设置面板：每秒走动的运行时长、10 秒刷新的全渠道快照、可搜索的模型表、渠道统计、账号池状态、启停和日志；账号池、额度、协议转换仍由原始 `ai-proxy` 代码负责。安装和自检说明见 [`dsh-plugin/README.md`](dsh-plugin/README.md)。

**模型选择器按渠道分组。** 插件向 Host 注册**两个层面**：一个可配置的 `ai-proxy` Provider（地址在设置页里改），以及 8 个 `ai-proxy-<渠道>` 的只读 adapter（`ai-proxy-commandcode` / `-cnb` / `-deepseek-web` / `-kilo` / `-tokenharbor` / `-trae` / `-workbuddy` / `-zen`，见 `dsh-plugin/index.js` 的 `CHANNEL_GROUPS`），每个 adapter 只列自己渠道的模型并带上中文标题。全部 adapter 共用同一个 `ProjectAdapter` 实例——Host 的 `registerAdapter` 一次接收一个列表，所以同一个对象按 provider id 各自收窄列表即可。

三处必须照做的约束：

- **id 必须带 `ai-proxy-` 前缀**。用户的 `cordis.patch.yml` 里已经注册过 `commandcode` / `deepseek-web` 同名 provider，宿主的 `prepareRoutes` 遇重名抛 `DUPLICATE_ADAPTER`，**整个插件条目都不激活**（炸过两次桌面端）。选择器里显示的名字来自 `providerInfo().name`，与 id 无关。
- **渠道分组的代码不在热重载范围**。热重载只换 `stream` / `resolveModel`，模块级 `listModels` / `normalizeModel` / `publishedEfforts` 以及 `apply()` 里的闭包换不掉，所以插件改动要**重启 DSH Host** 才生效。
- **目录是冷启动抢跑**。Host 每次生成只建一次模型目录，且插件加载时代理往往还没监听上；冷启动实测两次相隔三秒。`registerModelDiscovery` 里重试 4 次（间隔 2s×attempt）是唯一能救回来的地方，Host 自己不重试。

```powershell
node dsh-plugin/self-test.mjs
```

插件不会自动安装，也不会修改当前 DSH profile；需要手动复制到目标 profile 后再启用。

---

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
| `/v1` | **聚合入口** | kilo / zen / cnb / commandcode / openrouter / deepseek-web / workbuddy / trae：模型加渠道名前缀统一列出与分发 |
| `/kilo/v1` | api.kilo.ai | 透传，仅保留 `isFree: true` 的模型（kilo 的直连前缀，聚合成员之一） |
| `/zen/v1` | opencode.ai/zen | 透传，默认 token `public`，仅保留 `-free` 模型 |
| `/deepseek-web/v1` | chat.deepseek.com 网页聊天端 | 需要登录 Cookie，支持 Chat Completions 与 Responses |
| `/trae/v1` | trae-api-cn.mchost.guru（推理）/ api.trae.cn（签到与积分） | 入站/出站协议翻译、工具调用、思考档位、账号状态与每日签到 |
| `/workbuddy/v1` | www.workbuddy.cn | **自定义处理器**：文件凭据 + 401 自动续期重试 + 流内 11140 内容拦截；目录取自账号自身 |
| `/commandcode/v1` | CommandCode Go CLI 网关 | 模型发现、私有协议转换、多账号池、额度、Chat Completions 与 Responses |
| `/openrouter/v1` | openrouter.ai | 透传 |
| `/openrouter/v1/responses` | openrouter.ai | 透传 Responses API |
| `/tokenharbor/v1` | tokenharbor.ai | 透传，仅保留 `:free` 模型 |
| `/cnb/v1` | cnb.cool | **自定义处理器**（见下节） |
| `/health` | 本地代理 | 返回最近一次模型健康探测汇总；不会在请求时自动发起探测 |

`GET /` 会返回所有可用 provider 列表。`GET /health` 返回各 provider 最近一次健康探测的状态（`available` / `degraded` / `unavailable` / `unknown`）；没有探测记录时显示 `unknown`，不会因为一次网络失败把模型清单清空。

**聚合端点 `/v1`**：`GET /v1/models` 返回 **8 个成员**（`kilo` / `zen` / `cnb` / `commandcode` / `openrouter` / `deepseek-web` / `workbuddy` / `trae`，见 `main.ts` 的 `V1_AGGREGATE_MEMBERS`）全部模型的并集，id 分别加渠道名前缀防冲突；
POST 时 model 写带前缀的 id（如 `cnb/deepseek-v4-pro`、`commandcode/deepseek/deepseek-v4-flash`）即自动分发到对应上游，完整复用该上游的
处理链。不带前缀的裸 id 按 kilo→zen→cnb→commandcode 顺序解析（保持旧行为），冷启动后需先 GET 一次 `/v1/models` 暖缓存。分发时会剥掉客户端 token，让各成员用自家默认凭据；仅当本代理设置 `API_KEYS` 时才透传客户端鉴权头。

⚠️ **`/workbuddy/v1/chat/completions` 的 `model` 必须写裸 id**（如 `deepseek-v4-flash`），不能带 `workbuddy/` 前缀——带前缀会被判成未知模型并回 400。`/v1` 聚合入口的分发只认带前缀的 id，这是两条不同的解析路径。

后四个成员（deepseek-web / workbuddy / trae / openrouter）加入聚合**不是为了分发**，而是 **harness 的模型目录读的是这个聚合**（`adapter.listModels()`），不是插件那份独立清单——漏掉任何一个，就会出现「面板里有该渠道、选择器里一个模型都没有」。`openrouter` 在没配 key 时主动隐身（未鉴权的目录请求会回 401，列出来再 401 比不列更糟）。

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
| `src/deepseek-gate.ts` | DeepSeek 网页端串行闸与安全阀（并发、频率、冷却） |
| `src/deepseek-responses.ts` | DeepSeek 网页端 Responses API 转换 |
| `src/deepseek-risk.ts` | DeepSeek 网页端本地启发式风险打分 |
| `src/trae.ts` | TRAE 协议翻译、工具调用、思考档位、每日签到 |
| `src/trae-account.ts` | TRAE 凭据落盘、过期与续期、远端模型目录 |
| `src/workbuddy.ts` | WorkBuddy 常量、凭据解析、目录/倍率/促销解析、请求头、请求体、错误分类、SSE 拦截 |
| `src/workbuddy-account.ts` | WorkBuddy 凭据落盘、过期与续期、目录并集、模型可调性探测 |
| `src/commandcode/` | CommandCode Go 模型发现、私有协议、多账号池、OAuth、额度与 OpenAI 转换 |
| `src/zen.ts` | Zen 请求头补齐、Responses/Messages 转换、FreeTier/Region 错误分类 |
| `src/zen-catalog.ts` | Zen 模型能力元数据（来自 models.dev），Zen 网关自己不返回 |
| `src/zen-compaction.ts` | Zen 会话压缩 |
| `src/zen-egress.ts` | Zen 出口代理轮换（匿名额度按地址计费） |
| `third_party/dsh-deepseek-web-login/` | Apache-2.0 工具协议派生代码及许可证 |
| `third_party/dsh-cmdgo-provider/` | dsh-cmdgo-provider 的 MIT 许可证与移植说明 |
| `worker.ts` | Cloudflare Workers 入口 shim（把 `vars`/secrets 注入 `main.ts` 的模块级 `ENV`） |
| `wrangler.jsonc` | Worker 配置（`name: ai-api`，`main: worker.ts`） |
| `deno.jsonc` | Deno Deploy 配置（`org: hitmargin`，`app: ai-api`） |
| `restart.ps1` | 一键：本地服务 + 隧道 + 更新 Worker 的 `BACKEND_URL` 密钥；`-Local` 只启动本地服务，不碰隧道/Worker/代理 |
| `deno.lock` | 依赖锁定 |

本地开发还会出现（已在 `.gitignore` 中排除）：`cookies.txt`（抓包得到的 cookie）、`commandcode-accounts.json`（CommandCode OAuth 多账号 key）、`trae-auth.json` 与 `workbuddy-auth.json`（登录脚本抓取的令牌）、`.wrangler/`（Cloudflare 账号缓存）、
`cloudflared.exe`、`page.html`（页面快照）、`main.ts.bak-*`（历史备份）。

---

## 已知限制

- cnb 通道完全依赖网页端私有接口，**上游改版即失效**；
- DeepSeek 网页端、TRAE、WorkBuddy 三个渠道同样依赖网页端私有接口：TRAE 的推理走 `trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat`、签到走 `api.trae.cn`（两套主机，且客户端版号不匹配时新模型直接报流内 4001），WorkBuddy 的目录靠逐模型实发探测剔除调不通的 id（上游改版后探测结论要重跑），两者都与上游页面强绑定；
- 原先的 `/anthropic/v1`（api.anthropic.com）与 `/gemini/v1`（generativelanguage.googleapis.com）两条路由**已下线**，`ANTHROPIC_API_KEY` / `GEMINI_API_KEY` 也随之失效。Anthropic Messages 的转换能力保留在 `/commandcode/v1/messages`；
- 模型选择器里的**按渠道分组依赖重启 DSH Host** 才生效：插件的渠道分组是模块级代码，热重载只换 `stream` / `resolveModel`。不重启的话模型仍然是全挤在 `ai-proxy` 一个 provider 下（功能可用，只是没分组）。
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
