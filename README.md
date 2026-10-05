# ai-proxy

多上游 AI API 聚合代理：对外暴露**统一的 OpenAI 兼容接口**，对内把请求翻译/伪装成各个上游能接受的形态。

支持以下上游：

1. **标准 OpenAI 兼容上游**（透传）：kilo.ai、opencode.ai/zen、openrouter.ai、tokenharbor.ai、zlkpro.tech
2. **网页端私有接口**：chat.deepseek.com（PoW + Cookie 会话）、api.trae.cn（协议翻译 + 签到）、cnb.cool（会话自举 + 提示词协议模拟），分别包装成标准 Chat Completions / Responses
3. **私有 CLI 网关**：CommandCode Go（移植 `dsh-cmdgo-provider` 的模型筛选、网关协议、多账号池与额度读取）与 WorkBuddy 中国版（文件凭据 + 自动续期 + 流内内容拦截）
4. **Anthropic Messages**：`/commandcode/v1/messages` 做 OpenAI ⇄ Messages 双向转换（原先的 `/anthropic/v1` 与 `/gemini/v1` 已下线，见下方说明）
5. **任意自填的 OpenAI 兼容上游**：面板里填名字 + 地址 + key 即可，**不用改代码、不用重启**

> 同一份 `main.ts` 可以跑在 **Deno Deploy**、**本地 Deno**、**Cloudflare Workers** 三种环境。

---

## 它解决什么问题

免费/低价模型额度散落在十几个上游，每家都要单独注册、单独填 key、单独适配协议，而且**接口形状各不相同**：

- 有的只发 `reasoning_content`，有的发 `reasoning`，有的发 `thinking`——**读错一个字段，思考内容就整个消失**（不报错，只是没了）；
- 有的把推理档位发布成裸字符串 `["low","high"]`，有的发布成对象 `[{id,name}]`，有的藏在 `opencode.variants` 里，有的干脆用私有布尔 `enable_reason`；
- 有的窗口上限叫 `context_window`，有的叫 `max_input_tokens`——**读错就是上游 400**；
- 网页端接口需要逆向 CSRF 握手、PoW 求解、SSE 标记过滤，而且**流被掐断和正常结束长得一模一样**。

本项目把这些差异全部收在一个 `/v1` 聚合入口后面：**一个地址、一个 key、一套 OpenAI 协议**。同时把那些「静默失败」变成**可见的失败**——渠道消失会记日志、流被截断会报错、字段读不到会显示「未知」而不是 0。

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
cloudflared 隧道
      ├─ 快速：https://xxx.trycloudflare.com   （免账号，地址每次变，有配额）
      └─ 命名：https://<你的域名>              （地址固定，无配额，需先 tunnel login）
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

**隧道有两条等效的启动路径**，二选一即可：

| 路径 | 怎么用 | 适合 |
|---|---|---|
| `restart.ps1`（完整模式） | 命令行一次跑完：起服务 → 起隧道 → 写 Worker | 纯命令行部署 |
| **DSH 面板开关** | 设置页点「开启隧道」，地址直接显示并可复制 | 已经装了 DSH 插件 |

两者做的事相同（都起 cloudflared 并回写 Worker 的 `BACKEND_URL`）。⚠️ **不要在隧道已经跑着的时候再执行不带 `-Local` 的 `restart.ps1`**：它会另起一个 cloudflared，并把 `BACKEND_URL` 改成新域名，而面板上显示的仍是旧域名——两个入口各自为政，谁后跑谁生效。

---

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
src/custom.ts              自定义供应商：来源合并、校验、出站头、路由解析
src/custom-handler.ts      /custom/v1 的列表聚合与推理转发
src/commandcode/           CommandCode Go 模型、协议、账号池、OAuth、额度、Messages 转换与路由
src/runtime/               响应体形状嗅探、流回放、abort/截断分类、目录健康登记
dsh-plugin/               可选 DSH Host Provider 桥接插件（按渠道分组注册 + 设置面板 + 隧道开关）
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

**用量面板的缓存命中率一度有个 50% 的天花板。** harness 把插件返回的 `TokenUsage.inputTokens` 当作 **`uncachedInputTokens`** 用（`app.asar` 里那行的 i18n 原文就是「未缓存输入」），命中率分母是 `uncachedInput + cacheRead + cacheWrite`。而 OpenAI 的 `prompt_tokens` **本身就含缓存部分**，插件原样传就等于把缓存算了两遍：

```
分母 ≈ cacheRead + (cacheRead + 未命中) ≈ 2 × cacheRead   →  命中率收敛到 50%
```

实测用户 14,891 次请求里，六个渠道的 `cacheRead/input` 中位数在 0.97～0.999（**真实命中率 93%～99.7%**），面板却一律显示 ~49%。现在 `inputTokens` 会扣掉缓存部分——**但只在缓存数确实来自 `prompt_tokens_details.cached_tokens` 时才扣**：Anthropic 的 `input_tokens` 本身不含缓存，减了会把未命中压成 0，而 harness 在 `missed === 0` 时直接显示 `100%`，那等于用一个假 100% 换一个假 49%。

---

## 快速开始

> **第一次用？** 直接跳到下面的[「5 分钟跑通」](#5-分钟跑通从零到第一条回复)。想先了解各部署方式的区别，看方式 A–D。

### 5 分钟跑通（从零到第一条回复）

**前提**：装了 [Deno](https://deno.com/) 2.x。没有的话：

```powershell
# Windows (winget)
winget install DenoLand.Deno
# 或官方脚本（PowerShell）
irm https://deno.land/install.ps1 | iex
```

验证：`deno --version` 能打印版本号即可。

#### 第 1 步：启动

```powershell
cd D:\Projects\ai-proxy
deno run -A main.ts
```

看到 `Listening on http://0.0.0.0:8000/` 就是起来了（**别关这个窗口**，它是前台进程）。

> 改端口用环境变量：`$env:PORT=9000; deno run -A main.ts`。
> 注意宿主插件的「端口」设置页字段与这个 `PORT` 是**同一件事**——插件就是用 `PORT` 把设置页里那个数字传给子进程的。

#### 第 2 步：确认它活着（**别跳过这步**）

另开一个窗口：

```powershell
# 列出可用渠道
curl.exe -s http://127.0.0.1:8000/
# 看模型清单（这就是客户端真正会读到的东西）
curl.exe -s http://127.0.0.1:8000/v1/models | Select-Object -First 1
```

`/` 返回一个 `providers` 数组。**它列出的是「代码里注册了哪些渠道」，不是「哪些渠道现在能用」**——没配 key 的渠道也会在这里出现。要区分这两者看下一步。

#### 第 3 步：看谁真的能用

```powershell
curl.exe -s http://127.0.0.1:8000/health
```

重点看三个字段：

| 字段 | 回答什么问题 |
|---|---|
| `providers` | 每个渠道**上一次探测**的结果（`available` / `degraded` / `unavailable` / `unknown`） |
| `catalogIssues` | 哪些渠道**没进模型列表**，以及原因 |
| `credentials` | 每个渠道**有没有凭据**——没 key 和挂了是两回事 |

**`unknown` 是正常的**（= 还没探测过），不等于坏。别把它当成故障。

**`catalogIssues` 里混着两种性质不同的原因，要分开看**：

```json
{
  "openrouter": { "reason": "openrouter needs an API key; set it in the ai-proxy panel" },
  "zlkpro":     { "reason": "zlkpro needs an API key; set it in the ai-proxy panel" }
}
```

- **`needs an API key` / `needs a login`** = **你没配**，是预期状态。对应 `credentials` 里的 `configured: false`。**不是故障**，配了就消失。
- **其它 reason**（HTTP 4xx/5xx、`fetch failed`、`listedModels` 有数但 `keptModels` 是 0 等）= **真的有问题**。最后一种最隐蔽：上游答得好好的，但模型全被过滤器扔了（比如免费档下架），表现为「渠道静默变空」。

#### 第 4 步：发第一条请求

**先挑一个现在存在的模型 id**（模型清单每周都在变，README 里写死的 id 一定会过期）：

```powershell
# 挑一个 free 模型，把它记下来
$model = ((curl.exe -s http://127.0.0.1:8000/v1/models | ConvertFrom-Json).data |
  Where-Object { $_.id -match ':free$' } | Select-Object -First 1).id
"用这个模型: $model"
```

然后发请求（把 `$model` 填进去）：

```powershell
$body = @{ model = $model; messages = @(@{ role = 'user'; content = '说一个字：好' }); stream = $false } |
  ConvertTo-Json -Depth 5 -Compress
curl.exe -s http://127.0.0.1:8000/v1/chat/completions -H "Content-Type: application/json" -d $body
```

看到 `"choices":[...]` 就是通了。**模型 id 必须带渠道前缀**（`渠道/模型`）——`/v1` 是聚合入口，靠第一段前缀决定发给谁。不带前缀的裸 id 会按固定顺序猜渠道（见[路由表](#路由表)），容易猜错，**建议永远带前缀**。

> 遇到 `model_not_found` 就是那个 id 过期了（免费档下架很常见），**换 `/v1/models` 里现在有的就行**，不是代理坏了。
> 遇到 `FreeUsageLimitError` / `ZEN_QUOTA` 是**该渠道额度用完了**，换别的渠道（同一条命令，换个前缀）。

#### 第 5 步：接进你的客户端

把 `baseURL` 指到 `http://127.0.0.1:8000/v1` 即可，见[客户端用法](#客户端用法)。

---

> ⚠️ **`API_KEYS` 留空 = 完全不鉴权。** 默认就是这样，本机自用没问题；一旦经隧道暴露到公网，**任何人拿到地址就能白嫖你的额度和凭据**。对外暴露前务必先设 `API_KEYS`。

---

### 方式 A：本地 Deno 直跑

```bash
deno run -A main.ts        # 监听 http://localhost:8000（PORT 环境变量可改端口）
```

最省事，适合本机自用。**不带任何上游凭据也能跑**：kilo / zlkpro 这类渠道不配 key 就能出模型。要接需要登录的渠道（deepseek-web / workbuddy / trae / cnb）见各自的章节。

用 DSH 的话装插件即可（见[插件章节](#可选-dsh-provider-桥接插件)），插件会自动帮你起停这个进程、并在设置页里管各渠道的 key。

### 方式 B：Deno Deploy

```bash
deno deploy --org <你的org> --app <你的app> --prod -y
```

⚠️ **`deno.jsonc` 里的 `org: hitmargin` / `app: ai-api` 是原作者的**。你要部署到自己的账号，必须先把这两项改成你自己的，否则会推到别人的应用上。

⚠️ **CLI 需要 `DENO_DEPLOY_TOKEN`，浏览器登录不算。** `dash.deno.com` 里登着不代表命令行有权限——`deno deploy` 只认 Access Token（[dash.deno.com/account#access-tokens](https://dash.deno.com/account#access-tokens)）或 `--token`。没有 token 时报的是 `This command requires interactive input`，那句话并不指向真正的原因。

⚠️ **cnb 渠道在云端必须先配 `CNB_LOGIN_COOKIES` 环境变量**，否则打 `cnb/*` 一律 `401 cnb requires login`。云端没有工作目录，读不到本机的 `cnb-login.txt`：

```powershell
deno deploy env add CNB_LOGIN_COOKIES "$(Get-Content cnb-login.txt -Raw)" --org <org> --app <app>
```

**为什么本地能用、云端不能用**：同一个 `main.ts`，本机跑能读到 `cnb-login.txt`，Deno Deploy 上读不到——所以「本地好好的」推不出「云端也能用」，两边的凭据来源不同。

### 方式 C：Cloudflare Workers + 隧道（规避边缘 CPU 配额）

```powershell
pwsh .\restart.ps1
```

`restart.ps1` 会依次：杀掉旧的 `deno main.ts` 与 `cloudflared` 进程 → 后台启动本地 8000 端口 → 启动 cloudflared 隧道 →
从日志里正则抓出 `https://xxx.trycloudflare.com` → 用 `wrangler secret put BACKEND_URL` 写回 Worker。

**前置条件**（缺一个都会失败，且报错不一定指向真正的原因）：

| 需要什么 | 怎么准备 |
|---|---|
| `cloudflared` | `winget install Cloudflare.cloudflared`，装完确认 `cloudflared --version` 能跑 |
| `wrangler` 登录态 | `npx wrangler login`——脚本用 `deno run npm:wrangler` 调它，**它自己认账号，本项目不存 Cloudflare 凭据** |
| Worker 已存在 | 脚本只写 secret，**不创建 Worker**。先在 Cloudflare 建好或用 `wrangler deploy` 部署 `worker.ts` |
| 能出网 | 脚本会自动探测本机 Clash 的 `127.0.0.1:7897` 并设 `HTTPS_PROXY`（wrangler 拉 npm 和调 API 都需要） |

> 停止全部：`Get-Process deno,cloudflared | Stop-Process`
> 服务日志：`%TEMP%\ai-proxy.log`（stderr，`[cnb-gate]` 诊断流水在这里）与 `%TEMP%\ai-proxy-out.log`（stdout）。
> 隧道日志：`%TEMP%\cloudflared-tunnel.log`（URL 就在这里，脚本是从它里面正则抓的）。

> ⚠️ **快速隧道有配额，用完就只能换命名隧道。** `restart.ps1` 只会起**快速隧道**（免账号、地址每次变）；一天内启停几次后上游会回 `429` + `error code: 1015`，cloudflared 随后什么都不打印。要固定地址、无限额，得先做一次账号侧的准备（各一次即可）：
>
> ```powershell
> cloudflared tunnel login                      # 浏览器授权
> cloudflared tunnel create ai-proxy            # 建命名隧道
> cloudflared tunnel route dns ai-proxy <你的域名>  # 绑一个固定 hostname
> ```
>
> 然后在**设置页**把「隧道模式」改成命名隧道、填隧道名字。`restart.ps1` **不支持命名隧道**（它只解析 `trycloudflare` 那行日志）。详见[「cloudflared 隧道」](#cloudflared-隧道面板里一键开关)。

> 💡 **装了 DSH 插件的话，同一件事可以在设置页点按钮完成**：切到 `ai-proxy` 设置分区，「Cloudflared 隧道」区点**开启隧道**，地址会直接显示出来（含复制按钮），填了 Worker 名字就自动回写。见[「cloudflared 隧道」](#cloudflared-隧道面板里一键开关)。**两条路径选一条，不要同时跑**——它们互不感知，谁后跑谁的 `BACKEND_URL` 生效。

### 方式 D：纯本地模式（不碰隧道与 Worker）

```powershell
pwsh .\restart.ps1 -Local
```

只做三件事：杀掉旧的 `deno main.ts` → 启动新服务（8000）→ 健康检查。**完全不触碰** cloudflared（不杀也不建）、
Cloudflare Worker（不跑 wrangler、不动 `BACKEND_URL`）、网络代理（连 Clash 探测都跳过）——全程唯一的网络流量是对
`127.0.0.1:8000` 的健康检查。客户端直连 `http://localhost:8000/v1`。

本地与完整模式共用同一个 8000 端口，可随时互相补位：本地模式跑着时再执行一次完整模式，隧道会接到重启后的新服务上；
反之，完整模式的隧道在跑时执行 `-Local` 只重启本地服务，远端链路自动恢复。

### 重启之后要做什么

| 你改了什么 | 要做什么 |
|---|---|
| `main.ts` / `src/**` | **重启 Deno 服务**（面板的「重启」按钮**不一定真的重启**，见[已知限制](#已知限制)；拿不准就手动 `Stop-Process` 再起） |
| `dsh-plugin/index.js` 的模块级函数（`listModels` / `normalizeModel` / `publishedEfforts`） | **重启 DSH Host**——热重载只换 `stream` / `resolveModel` |
| `dsh-plugin/client.js`（面板 UI） | 刷新页面即可 |
| 面板里的设置 | 点**保存**才落盘（输入框里改的只是草稿） |
| `custom-providers.json` | **不用重启**，按 mtime 热加载 |
| `cnb-login.txt` | **不用重启**，按 mtime 热加载 |

### 开发检查

```powershell
deno task check     # deno check main.ts worker.ts
deno task test      # deno test --allow-env src/
node dsh-plugin/self-test.mjs   # 插件的自检（不联网、不碰真实配置）
```

`deno task test` 使用 `--allow-env`，因为测试导入的运行时会读取 `API_KEYS` 等环境变量；不会读取或打印凭据文件。

> `self-test.mjs` 会把 `DSH_HOME` 指向临时目录，所以它**不会**动你真实的 `settings.json`。这是刻意的——早期版本直接读写用户真实配置，结果套件的结果取决于「你上次在面板里存了什么」。

---

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `PORT` | 否 | 本地监听端口，默认 `8000`。**只影响本地 Deno 运行**；DSH 插件用它把设置页的「端口」传给子进程 |
| `API_KEYS` | 否 | 访问本代理的白名单，逗号分隔。**留空 = 完全开放**，任何人都能用 |
| `MAX_REQUEST_BODY_BYTES` | 否 | 通用 `/v1` 与反向代理请求体上限，默认 `12582912`（12 MiB） |
| `BACKEND_URL` | 否 | 有值即进入**反向代理模式**，全部请求原样转发到该地址（如隧道 URL） |
| `DEFAULT_BEARER_TOKEN` | 否 | 透传类上游的兜底 Bearer token |
| `OPENROUTER_API_KEY` | 否 | `/openrouter/v1` 使用；未配置时该渠道不进模型列表 |
| `TOKENHARBOR_API_KEY` | 否 | `/tokenharbor/v1` 使用；未配置时该渠道不进模型列表 |
| `ZLKPRO_API_KEY` | 否 | `/zlkpro/v1` 使用；未配置时该渠道不进模型列表 |
| `AI_PROXY_CUSTOM_PROVIDERS` | 否 | 自定义供应商表（JSON 数组）。**含明文 apiKey**，由 DSH 插件注入，也可自己设 |
| `AI_PROXY_CUSTOM_FILE` | 否 | 自定义供应商配置文件的改道路径，默认工作目录下的 `custom-providers.json` |
| `CNB_LOGIN_COOKIES` | 否 | cnb 登录态，**并列于 `cnb-login.txt` 且优先于它**。云端部署（Deno Deploy）用它——那边没有工作目录、读不到文件，不配就一律 `401 cnb requires login` |
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

### 自定义供应商：面板里加任意 OpenAI 兼容上游

不想改代码就接一家新的免费上游时，在 DSH 面板的设置页填 **名字 + 地址 + key** 即可，**存下来就生效，不用重启**。

模型在选择器里以 `自定义供应商/<你的名字>/<上游模型 id>` 出现，例如 `custom/step/step-3.7-flash`。

**两个配置入口**（同一个能力，两条部署路径都要能用）：

| 入口 | 谁写它 | 适用 |
|---|---|---|
| DSH 面板 | 插件写进 `settings.json`，再经 `AI_PROXY_CUSTOM_PROVIDERS` 注入进程环境 | 装了插件 |
| 工作目录下的 `custom-providers.json` | 你手写 | 直接 `deno run -A main.ts`、隧道部署、自建客户端 |

同名冲突时**环境赢**，被盖掉的那条会记进 `shadowed` 并打日志——静默让其中一条失效会让人以为文件写错了。文件读到但解析不出东西时 `fileError` **单独上报**：「没配」和「配坏了」是两种状态，混为一谈会让写错格式的人看到「去配一个」（而他明明配了）。可提交的样例见 [`custom-providers.example.json`](custom-providers.example.json)；真实文件已 gitignore（含明文 key）。

**为什么所有自定义上游共用一个 `custom` 前缀**，而不是一家一个：代理的 provider 前缀表（`main.ts` 的 `channelPrefixes`、`V1_AGGREGATE_MEMBERS`、`src/core.ts`）是**进程启动时定格的**，插件的 `CHANNEL_GROUPS` 更只在 `apply()` 时注册。一家一个前缀就等于「每加一个供应商重启一次 DSH Host」，与「面板填一下就生效」直接冲突。代价是所有自定义供应商共享一个选择器分组——换来零重启。

名字取路由的**第一段**，所以上游模型 id 可以自带斜杠（`deepseek-ai/deepseek-v4.1-flash`、`z-ai/glm-5.3`）；按最后一段切会在一半模型上切错。

**凭据纪律**：key 只在代理进程里，面板只回 `keySet` 布尔值，**从不回传明文**（回传到会渲染的页面等于会进截图）。面板保存时只提交**这一轮重新输入的** key，服务端做**合并**而不是替换——否则给第二家填 key 会把第一家那把删掉。

### cloudflared 隧道：面板里一键开关

设置页可以直接**开启 / 关闭隧道**，起来的公网地址（带 `/v1` 的聚合地址）显示在按钮下方并可一键复制。填了 **Worker 名字**，就会自动把 `BACKEND_URL` 写过去，省掉手工跑 wrangler。

- **启动**：`POST /api/ai-proxy/tunnel/start`
- **关闭**：`POST /api/ai-proxy/tunnel/stop`
- **只重写 Worker 地址**：`POST /api/ai-proxy/tunnel/sync-worker`（隧道可能好着而 `BACKEND_URL` 是旧的，为了修后者去重起 cloudflared 会白白换掉域名）

四点实现说明：

- **等地址真的能路由才报成功**。cloudflared 一注册就打印 URL，但**早于边缘开始服务**——实测新域名第一次请求 `ECONNRESET`、几秒后正常。在打印处就报 `running` 会把一个 502 的地址交给用户，还紧接着拿它去写 Worker。
- **写 Worker 前先验证目标存在**。`wrangler secret put --name <打错的>` **不报错、退出码 0、还会在账号里创建一个新 Worker**——你真正的 Worker 仍指着旧地址，而面板显示成功。所以先 `wrangler secret list --name` 验存在，不存在就拒绝写入并说明原因。**凭据回写失败绝不抛异常**：隧道本身是好的，不能因为 wrangler 的问题把它一起打死，所以 `ok` / `error` / `skipped` 单独显示。
- **不持有 Cloudflare 凭据**。面板不存 API token，只是 spawn `wrangler`，由它用自己的登录态（`wrangler login` 留下的 `~/.config/.wrangler`）认账号。这样 key 不会进 `settings.json`，也就不会进截图。
- **失败原因取 cloudflared 自己的话**。它的 stderr 里写着真因（`429` / `error code: 1015` 是快速隧道配额耗尽），早先那句自造的 "never printed a url" 会把排查引向二进制路径。现在只要输出里出现 `failed` / `error` / `429` / `1015` / `refused` / `unauthorized`，那一行就被提成 `lastError`。

> ⚠️ **两种隧道，地址是否固定取决于模式。**
>
> | 模式 | 地址 | 需要什么 | 配额 |
> |---|---|---|---|
> | `quick`（默认） | `https://xxx.trycloudflare.com` | 无 | **有配额**：一天内启停几次后上游回 `429` + `error code: 1015`，随后 cloudflared 什么都不打印 |
> | `named` | 你自己绑定的固定域名 | `cloudflared tunnel login` + `tunnel create` + `tunnel route dns`（各一次） | 无 |
>
> 在设置页选「隧道模式」= 命名隧道并填「隧道名字」即可。**命名隧道必须有一个不被 Worker custom domain 占用的域名**：`BACKEND_URL` 会写成那个地址，若它恰好是 Worker 自己的域名，Worker 就会转发给自己（见下面那条约束）。

### 可选 DSH Provider 桥接插件

`dsh-plugin/` 现在是整个项目的 DSH 安装桥接：启用后可自动启动/监控原始项目目录中的 Deno 服务，也可以切换为连接已经运行的本地或远程代理。它动态发现 `/v1` 聚合模型并按模型前缀把请求路由回原始代理；浏览器侧是一个现代设置面板：每秒走动的运行时长、10 秒刷新的全渠道快照、可搜索的模型表、渠道统计、账号池状态、启停和日志；账号池、额度、协议转换仍由原始 `ai-proxy` 代码负责。安装和自检说明见 [`dsh-plugin/README.md`](dsh-plugin/README.md)。

**模型选择器按渠道分组。** 插件向 Host 注册**两个层面**：一个可配置的 `ai-proxy` Provider（地址在设置页里改），以及 9 个 `ai-proxy-<渠道>` 的只读 adapter（`ai-proxy-commandcode` / `-cnb` / `-deepseek-web` / `-kilo` / `-tokenharbor` / `-trae` / `-workbuddy` / `-zen` / `-zlkpro`，见 `dsh-plugin/index.js` 的 `CHANNEL_GROUPS`），每个 adapter 只列自己渠道的模型并带上中文标题。全部 adapter 共用同一个 `ProjectAdapter` 实例——Host 的 `registerAdapter` 一次接收一个列表，所以同一个对象按 provider id 各自收窄列表即可。

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
| `/v1` | **聚合入口** | kilo / zen / cnb / commandcode / openrouter / deepseek-web / workbuddy / trae / zlkpro：模型加渠道名前缀统一列出与分发 |
| `/kilo/v1` | api.kilo.ai | 透传，仅保留 `isFree: true` 的模型（kilo 的直连前缀，聚合成员之一） |
| `/zen/v1` | opencode.ai/zen | 透传，默认 token `public`，仅保留 `-free` 模型 |
| `/deepseek-web/v1` | chat.deepseek.com 网页聊天端 | 需要登录 Cookie，支持 Chat Completions 与 Responses |
| `/trae/v1` | trae-api-cn.mchost.guru（推理）/ api.trae.cn（签到与积分） | 入站/出站协议翻译、工具调用、思考档位、账号状态与每日签到 |
| `/workbuddy/v1` | www.workbuddy.cn | **自定义处理器**：文件凭据 + 401 自动续期重试 + 流内 11140 内容拦截；目录取自账号自身 |
| `/commandcode/v1` | CommandCode Go CLI 网关 | 模型发现、私有协议转换、多账号池、额度、Chat Completions 与 Responses |
| `/openrouter/v1` | openrouter.ai | 透传 |
| `/openrouter/v1/responses` | openrouter.ai | 透传 Responses API |
| `/tokenharbor/v1` | tokenharbor.ai | 透传，仅保留 `:free` 模型 |
| `/zlkpro/v1` | zlkpro.tech | 透传（标准 OpenAI 契约：流式、工具调用、带斜杠的模型 id 均原样可用） |
| `/custom/v1` | **用户自填的任意 OpenAI 兼容上游** | 按 `自定义供应商/<名字>/<模型>` 路由；凭据按供应商各自配置，只发我们自己的 key，**不转发入站 authorization** |
| `/cnb/v1` | cnb.cool | **自定义处理器**（见下节） |
| `/health` | 本地代理 | 返回最近一次模型健康探测汇总；不会在请求时自动发起探测 |

`GET /` 会返回所有可用 provider 列表。`GET /health` 返回各 provider 最近一次健康探测的状态（`available` / `degraded` / `unavailable` / `unknown`）；没有探测记录时显示 `unknown`，不会因为一次网络失败把模型清单清空。

**聚合端点 `/v1`**：`GET /v1/models` 返回 **9 个成员**（`kilo` / `zen` / `cnb` / `commandcode` / `openrouter` / `deepseek-web` / `workbuddy` / `trae` / `zlkpro`，见 `main.ts` 的 `V1_AGGREGATE_MEMBERS`）全部模型的并集，id 分别加渠道名前缀防冲突；
POST 时 model 写带前缀的 id（如 `cnb/deepseek-v4-pro`、`commandcode/deepseek/deepseek-v4-flash`）即自动分发到对应上游，完整复用该上游的
处理链。不带前缀的裸 id 按 kilo→zen→cnb→commandcode 顺序解析（保持旧行为），冷启动后需先 GET 一次 `/v1/models` 暖缓存。分发时会剥掉客户端 token，让各成员用自家默认凭据；仅当本代理设置 `API_KEYS` 时才透传客户端鉴权头。

⚠️ **`/workbuddy/v1/chat/completions` 的 `model` 必须写裸 id**（如 `deepseek-v4-flash`），不能带 `workbuddy/` 前缀——带前缀会被判成未知模型并回 400。`/v1` 聚合入口的分发只认带前缀的 id，这是两条不同的解析路径。

deepseek-web / workbuddy / trae / openrouter / zlkpro 这几个成员加入聚合**不是为了让它们能被分发**（`/v1` 早就能分发），而是 **harness 的模型目录读的是这个聚合**（`adapter.listModels()`），不是插件那份独立清单——漏掉任何一个，就会出现「面板里有该渠道、选择器里一个模型都没有」。`openrouter` 在没配 key 时主动隐身（未鉴权的目录请求会回 401，列出来再 401 比不列更糟）。

**模型列表**有 5 分钟内存缓存，并会在后台异步做健康探测（`testModel`，3 秒超时；200 可用，429/5xx 视为 degraded，401/403 才是 unavailable，网络失败保留为 unknown），在 Deno Deploy 上用 `EdgeRuntime.waitUntil` 挂起，不阻塞响应；加 `?health=true` 可强制同步探测。探测结果可通过 `GET /health` 查看。

---

## 客户端用法

任何 OpenAI 兼容客户端都可以直接指过来。**两个要点**：

1. **`baseURL` 用聚合入口 `/v1`**，不要用某个渠道的前缀（`/cnb/v1` 之类）——用渠道前缀会把所有请求都发给那一个渠道。
2. **模型 id 带渠道前缀**（`kilo/xxx`、`zen/xxx`、`custom/step/xxx`），或者先 `GET /v1/models` 看有哪些。

### 先看有什么模型

```powershell
curl.exe -s http://127.0.0.1:8000/v1/models > models.json
# 只看 id
(Get-Content models.json -Raw | ConvertFrom-Json).data.id
```

### curl

```bash
curl https://<your-host>/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <API_KEYS 中的一个>" \
  -d '{
    "model": "<渠道>/<模型>",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
```

> `<渠道>/<模型>` 从 `GET /v1/models` 里抄，例如 `kilo/stepfun/step-3.7-flash:free`。**别照抄文档里的 id**——免费档每周都在下架。
> `API_KEYS` 没设的话 **`Authorization` 头可以完全不发**。

### Python（openai SDK）

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8000/v1", api_key="<API_KEYS 中的一个，没设就随便填>")

# 先看现在有哪些模型，别写死 id
models = [m.id for m in client.models.list()]
free = [m for m in models if m.endswith(":free")]
print(free[:5])
model = free[0]

resp = client.chat.completions.create(
    model=model,
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)

# 流式
for chunk in client.chat.completions.create(
    model=model,
    messages=[{"role": "user", "content": "数到五"}],
    stream=True,
):
    print(chunk.choices[0].delta.content or "", end="")
```

### 思考档位（reasoning effort）

**只在模型自己发布了档位时才可调**，而且**档位字段的形状各渠道不同**——代理是**原样透传上游字段**的，归一化发生在 DSH 插件里。所以看原始 `/v1/models` 时会看到至少三种形状：

| 形状 | 谁发的 | 例子 |
|---|---|---|
| `reasoning: { efforts: [{id,name}], defaultEffort }` | trae、workbuddy | 已经是归一化后的 |
| `reasoning_efforts: ["off","high","max"]` | deepseek-web、commandcode、zen | 裸字符串数组 |
| `reasoning_effort_support_list: ["low","high","medium"]` | **自定义供应商**（上游原生字段，如 StepFun） | 私有拼法 |

**同一个模型在「面板/选择器」和「原始 /v1/models」里可能长得不一样**——前者经过插件归一化（认得出 `reasoning_effort_support_list` 这类旁名），后者是上游原样。**判断某个模型能不能调档位，以面板/选择器的 Effort 控件为准**，那才是你实际会用的那条路。

传的时候用**档位 id**（不是显示名）：

```python
resp = client.chat.completions.create(
    model="custom/step/step-3.7-flash",       # 该上游发布 low/high/medium
    messages=[{"role": "user", "content": "你好"}],
    extra_body={"reasoning_effort": "high"},
)
```

> ⚠️ 三条约束：
> 1. **档位不在发布列表里会被上游拒或静默忽略**，别照抄别的模型的档位；
> 2. **没发布档位的模型不要传这个字段**（本项目不会替你编一张表——给没有档位的模型造控件是死控件）；
> 3. **有的上游不校验**（实测 StepFun 对不认识的 `off`/`none` 也回 200），所以「发过去没报错」**不等于**这个档位有效。

### 图片输入

模型必须支持视觉（`input_modalities` 含 `image`），否则**整个回合 400**（不是丢一张图）：

```python
resp = client.chat.completions.create(
    model="custom/step/step-3.7-flash",
    messages=[{"role": "user", "content": [
        {"type": "text", "text": "这张图里是什么？"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,<...>"}},
    ]}],
)
```

### 常见错误对照

| 现象 | 原因 |
|---|---|
| `unknown custom provider` | 用了 `/custom/v1` 却带了 `custom/` 前缀。**渠道自己的口要裸 id**（`step/xxx`），聚合口才要带前缀（`custom/step/xxx`） |
| `401` | `API_KEYS` 设了但客户端没带对 key |
| 模型不见了 | 看 `/health` 的 `catalogIssues`——先分清是「没配 key」（正常）还是「拉取失败」（故障） |
| 选中就 400 | 模型不支持你传的 `reasoning_effort`，或窗口超了（见[已知限制](#已知限制)） |
| 回答到一半停住 | 上游流被掐断。现在会报 `stream_cut` 而不是假装正常结束 |
| 面板里改了设置但没生效 | **没点保存**（输入框里改的只是草稿）；或该字段需要**重启 DSH Host**（见[重启之后要做什么](#重启之后要做什么)） |

---

## cnb.cool 模块

`src/cnb.ts` 是 cnb 集成模块，也是全项目最复杂的部分。

### 1. 会话自举

cnb 的网页端接口需要 CSRF 双因子（token + cookie）：

- `cnbFetchCsrf` GET `https://cnb.cool/`，从 HTML 正则抓 `window.csrftoken`，从 `Set-Cookie` 抓 `csrfkey`；
- 缓存 25 分钟（`CNB_TTL`），并用 `cnbState.pending` 做**单飞（single-flight）**，防止并发请求重复握手；
- `cnbCall` 请求时带上 `Csrftoken` 头、`csrfkey` cookie、移动端 UA、`Origin` / `Referer`。

### 1.5 登录态（cnb-login.txt）

cnb.cool 已要求登录才能调用推理接口（**2026-10-05 实测**：匿名打 `POST /ai/chat/completions`
得到 **HTTP 403 + `errcode 7 "User has no permission."`**；早期是 `401 [NOT_LOGIN]`，
上游已改过行为，所以别照着记忆判断）。登录态通过项目根目录的
`cnb-login.txt` 提供（已在 .gitignore 排除）：

**一键脚本（推荐）**

```powershell
deno run -A .tmp-cnb-login.ts      # 拉起浏览器 → 你正常登录 → 自动抓 Cookie → 真实请求验证 → 写盘
deno run -A .tmp-cnb-login.ts -v   # 只想验证已有凭据，不拉浏览器
```

脚本做的事：打开 Edge/Chrome → 你在窗口里登录 cnb.cool（扫码或账号密码都行，**不用回终端按键**）
→ 检测到会话 cookie → **先发一次真实请求确认能出字** → 成功才写盘。
失败时**不写盘**，保留原有凭据并打印原因。

这样设计是因为「粘对了没有」本来没人回答：手工粘完只能等下一次推理撞 403 才发现。
判据只有一条——**带凭据的请求能不能拿到真的模型输出**，状态码和错误文案都不算数
（文案会漂：`401 [NOT_LOGIN]` → `403 errcode 7` 就是一次漂移）。

**手工方式（脚本不好使时的退路）**

1. 浏览器登录 cnb.cool；
2. F12 → Network → 刷新页面 → 点任一 cnb.cool 请求 → Request Headers 里复制完整 `Cookie:` 头的值；
3. 单行粘贴进 `cnb-login.txt` 保存（也支持 Netscape cookies.txt 导出格式）。

行为：按 mtime 热加载，刷新 Cookie 无需重启代理；`csrfkey` 会自动从登录串剔除
（CSRF token+cookie 对仍由代理匿名抓取配对）；文件不存在 = 退回匿名模式（当前上游会 403，
错误信息里带粘贴指引）。

**云端部署用环境变量 `CNB_LOGIN_COOKIES`（并列来源，优先于文件）**

Deno Deploy 这类环境**没有工作目录**，`cnb-login.txt` 既不存在也不可能被写进去，
所以凭据必须能走环境变量：

```powershell
# 值就是 cnb-login.txt 的整行内容（三种粘贴形状都认：单行 k=v、分号串、Netscape 导出）
deno deploy env add CNB_LOGIN_COOKIES "$(Get-Content cnb-login.txt -Raw)" --org <org> --app <app>
```

**env 优先于文件**，所以本机也可以用它临时覆盖文件做验证。两种来源共用同一个归一化函数
（剔除 `csrfkey`、同名后者覆盖、跳过没有 `=` 的片段），不会因为两处各写一遍而漂开。

> ⚠️ **写这类 secret 时不要跑 `env list`**——它会把值明文打印出来。
> 实测 `deno deploy env list` 就直接回显了 cookie 全文。写完用**功能验证**（打一次真实推理）
> 确认，而不是用 `list` 确认。
>
> ⚠️ **`cnb-login.txt` 是活的账号凭据**，等同于你的登录态。别贴进聊天窗口、issue、截图或提交。
> 万一泄露，去 cnb.cool 退出登录（或轮换会话）即可让旧值在服务端失效。
> 脚本自己在终端**只打印 cookie 的名字、不打印值**，就是为了不把它漏进日志和截图。

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
- **请求体大小不做本地预检，交给上游判**：cnb 对 >1 MiB 的请求体回 `413 [BODY_TOO_LARGE]`（实测：1.000 MiB 通过、1.050 MiB 起拒绝）。这里**曾有一道 `>1MiB 直接本地回 413` 的闸，已拆掉**——它比上游还严，会拦掉上游本来会接受的请求（实测一个 1060926 字节的请求被本地拒死，而那个尺寸上游很可能接受）。现在只写一行 `[cnb-gate] large body … sending anyway` 日志，由上游自己判，用户拿到的是上游原文而不是我们猜的线。

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
| `src/custom.ts` | 自定义供应商：两名来源合并（环境 + 文件）、名字/地址校验、出站头、路由解析 |
| `src/custom-handler.ts` | `/custom/v1` 的列表聚合与推理转发（`custom/<vendors>/<model>`） |
| `custom-providers.example.json` | 自定义供应商配置文件的可提交样例（真实文件已 gitignore） |
| `third_party/dsh-deepseek-web-login/` | Apache-2.0 工具协议派生代码及许可证 |
| `third_party/dsh-cmdgo-provider/` | dsh-cmdgo-provider 的 MIT 许可证与移植说明 |
| `worker.ts` | Cloudflare Workers 入口 shim（把 `vars`/secrets 注入 `main.ts` 的模块级 `ENV`） |
| `wrangler.jsonc` | Worker 配置（`name: ai-api`，`main: worker.ts`） |
| `deno.jsonc` | Deno Deploy 配置（`org: hitmargin`，`app: ai-api`） |
| `restart.ps1` | 一键：本地服务 + 隧道 + 更新 Worker 的 `BACKEND_URL` 密钥；`-Local` 只启动本地服务，不碰隧道/Worker/代理 || `deno.lock` | 依赖锁定 |

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
- **快速隧道的 URL 每次重启都会变，且有配额**（由 `restart.ps1` 或面板开关自动回写 `BACKEND_URL`），且可能有连接抖动；**命名隧道的地址固定、无配额**，但需要先做一次 `cloudflared tunnel login` / `create` / `route dns`。`proxyToBackend` 仅对幂等请求最多重试一次，非幂等 POST 不自动重放以避免重复计费；
- **命名隧道的地址绝不能是 Worker 自己的域名**。`BACKEND_URL` 就是从 ingress 取的，若取到 Worker 的 custom domain，Worker 会转发给自己。插件已从 `wrangler.jsonc` 的 routes 读出 Worker 拥有的域名并跳过它们（多份 ingress 时取第一条不属于 Worker 的），全被占用时报错而不是硬凑一个地址；
- **隧道有两条启动路径（`restart.ps1` 与面板开关），互不感知**。隧道已在运行时再执行不带 `-Local` 的 `restart.ps1`，会另起一个 cloudflared 并覆盖 `BACKEND_URL`，而面板显示的可能仍是旧域名。二选一即可。**`restart.ps1` 的清理也只认快速隧道**：它按 `CommandLine -match "tunnel --url"` 找进程，而命名隧道跑的是 `tunnel --config … run <name>`，所以命名隧道不会被它杀掉——两个进程可能同时连同一个 tunnel；
- **自定义供应商的推理档位依赖上游如实发布**。有的上游（如 StepFun）对不认识的 `reasoning_effort` **不报错而是照收**，所以阶梯无法靠探测推断，只能信它发布的字段；没发布就不给档位（不编造）；
- 自定义供应商的**非对话模型**（TTS、ASR、文生图）同样会出现在模型列表里，选中后调用会失败——上游没有可用的类别字段能可靠区分；
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
