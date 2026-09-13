# ai-proxy

多上游 AI API 聚合代理：对外暴露**统一的 OpenAI 兼容接口**，对内把请求翻译/伪装成各个上游能接受的形态。

支持两类上游：

1. **标准 OpenAI 兼容上游**（透传）：kilo.ai、opencode.ai/zen、openrouter.ai、tokenharbor.ai
2. **协议转换上游**：Anthropic、Gemini（OpenAI 格式 ⇄ 各自原生格式双向翻译）
3. **cnb.cool 网页聊天**（本项目核心）：cnb.cool 自带一个免费 AI 聊天但**没有开放 API**，本项目通过会话自举 + 提示词协议模拟，把它包装成标准的 `/v1/chat/completions` 与 `/v1/responses`。

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
      │  ENV.BACKEND_URL 有值 → 纯字节转发（流式、失败重试 1 次、零解析 CPU）
      ▼
cloudflared 快速隧道  https://xxx.trycloudflare.com      ← restart.ps1
      ▼
本机 Deno 服务  http://localhost:8000                    ← main.ts 的 Deno.serve
```

**为什么要这么绕？** Cloudflare Workers / Deno Deploy 都有 CPU 时间与配额限制，而 cnb 的协议解析（数百行正则 + 流式标记过滤）很吃 CPU。
用 `ENV.BACKEND_URL` 一个开关把计算挪回本机、边缘只做字节转发，就绕开了限制，同时保留一个稳定的公网域名。

`main.ts` 的入口逻辑只有一行（`main.ts:2186`）：

```ts
if (ENV.BACKEND_URL) return await proxyToBackend(request);  // 反向代理模式
// 否则：本地解析 + 适配 + 调用上游
```

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
> 服务日志：`%TEMP%ai-proxy.log`（stderr，`[cnb-gate]` 诊断流水在这里）与 `%TEMP%ai-proxy-out.log`（stdout）。

### 方式 D：纯本地模式（不碰隧道与 Worker）

```powershell
pwsh .estart.ps1 -Local
```

只做三件事：杀掉旧的 `deno main.ts` → 启动新服务（8000）→ 健康检查。**完全不触碰** cloudflared（不杀也不建）、
Cloudflare Worker（不跑 wrangler、不动 `BACKEND_URL`）、网络代理（连 Clash 探测都跳过）——全程唯一的网络流量是对
`127.0.0.1:8000` 的健康检查。客户端直连 `http://localhost:8000/cnb/v1`。

本地与完整模式共用同一个 8000 端口，可随时互相补位：本地模式跑着时再执行一次完整模式，隧道会接到重启后的新服务上；
反之，完整模式的隧道在跑时执行 `-Local` 只重启本地服务，远端链路自动恢复。

---

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `API_KEYS` | 否 | 访问本代理的白名单，逗号分隔。**留空 = 完全开放**，任何人都能用 |
| `BACKEND_URL` | 否 | 有值即进入**反向代理模式**，全部请求原样转发到该地址（如隧道 URL） |
| `DEFAULT_BEARER_TOKEN` | 否 | 透传类上游的兜底 Bearer token |
| `ANTHROPIC_API_KEY` | 否 | `/anthropic/v1` 使用 |
| `GEMINI_API_KEY` | 否 | `/gemini/v1` 使用 |
| `OPENROUTER_API_KEY` | 否 | `/openrouter/v1` 使用 |

鉴权逻辑见 `checkAuth`（`main.ts:2133`）：接受 `Authorization: Bearer <key>` 或 `x-api-key: <key>`；根路径 `/` 豁免（用于列出 provider）。

---

## 路由表

每个上游是一份配置（`main.ts:221` 的 `providers`），包含 `prefix` / `baseUrl` / `auth` / `pathRewrite` / `endpoints` / `adapter` / `filterModels`。

| 路径前缀 | 上游 | 适配方式 |
|---|---|---|
| `/v1` | **聚合入口** | kilo / zen / cnb 一个入口：模型加 `kilo/`、`zen/`、`cnb/` 前缀统一列出与分发（见下） |
| `/kilo/v1` | api.kilo.ai | 透传，仅保留 `isFree: true` 的模型（kilo 的直连前缀，聚合成员之一） |
| `/zen/v1` | opencode.ai/zen | 透传，默认 token `public`，仅保留 `-free` 模型 |
| `/anthropic/v1` | api.anthropic.com | `toAnthropic` 双向翻译 |
| `/gemini/v1` | generativelanguage.googleapis.com | `toGemini` 双向翻译 |
| `/openrouter/v1` | openrouter.ai | 透传 |
| `/openrouter/v1/responses` | openrouter.ai | 透传 Responses API |
| `/tokenharbor/v1` | tokenharbor.ai | 透传，仅保留 `:free` 模型 |
| `/cnb/v1` | cnb.cool | **自定义处理器**（见下节） |

`GET /` 会返回所有可用 provider 列表。

**聚合端点 `/v1`**：`GET /v1/models` 返回 kilo + zen + cnb 全部模型的并集（id 加 `kilo/`、`zen/`、`cnb/` 前缀防冲突）；
POST 时 model 写带前缀的 id（如 `cnb/deepseek-v4-pro`、`kilo/kilo-auto/free`）即自动分发到对应上游，完整复用该上游的
处理链（cnb 的串行闸/预检/重试、各成员自己的鉴权与透传）。不带前缀的裸 id 按 kilo→zen→cnb 顺序解析（保持旧行为），
冷启动后需先 GET 一次 `/v1/models` 暖缓存。分发时会剥掉客户端 token，让各成员用自家默认凭据（kilo 无鉴权、zen 的
`public`、cnb 的自建 CSRF）；仅当本代理设置 `API_KEYS` 时才透传客户端鉴权头。

**模型列表**有 5 分钟内存缓存，并会在后台异步做健康探测（`testModel`，3 秒超时，200/429 视为可用），
在 Deno Deploy 上用 `EdgeRuntime.waitUntil` 挂起，不阻塞响应；加 `?health=true` 可强制同步探测。

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

`main.ts:452` 起是 cnb 集成，也是全项目最复杂的部分。

### 1. 会话自举

cnb 的网页端接口需要 CSRF 双因子（token + cookie）：

- `cnbFetchCsrf`（`main.ts:468`）GET `https://cnb.cool/`，从 HTML 正则抓 `window.csrftoken`，从 `Set-Cookie` 抓 `csrfkey`；
- 缓存 25 分钟（`CNB_TTL`），并用 `cnbState.pending` 做**单飞（single-flight）**，防止并发请求重复握手；
- `cnbCall`（`main.ts:1435`）请求时带上 `Csrftoken` 头、`csrfkey` cookie、移动端 UA、`Origin` / `Referer`。

### 2. 工具调用的「文本协议」模拟

cnb 上游不支持原生 `tool_calls`，所以改用提示词协议：

- `cnbBuildToolPrompt`（`main.ts:743`）把所有工具定义拼成系统提示词，要求模型输出 `` 包裹的 JSON；
- 历史里的 assistant `tool_calls` 会转回同样的文本（`main.ts:1355`），工具结果转成 `[Tool Result id=...]` 的 user 消息（`main.ts:1378`）——让模型「看到自己的历史就是正确示范」；
- `cnbParseToolCalls`（`main.ts:995`）是**极其宽容**的反向解析器：兼容 `XYML` / `QNML` / DeepSeek 原生 `DSML` / `` 等多种变体，能修复被截断的 JSON、按 JSON Schema 强制类型、拆解嵌套 arguments、归一化形近字、检测「一字符一行的退化输出」、参数名反猜工具等；
- `createLiveFilter`（`main.ts:1254`）在**流式输出**时扣住「可能是标记开头」的前缀，保证协议标记不会泄漏到用户可见正文。

### 3. Responses API

`handleCnbResponses`（`main.ts:1693`）把新版 `/v1/responses` 请求降级成 chat 格式跑一遍，再重组为 Responses 的 output items（`reasoning` / `message` / `function_call`），流式与非流式均支持。

### 4. 可靠性

- `cnbCallUpstream`（`main.ts:1522`）按 `[0, 500, 1500, 3500, 8000, 20000]` ms 退避重试；
- 网络层失败会刷新 CSRF 会话再试；4xx（429 除外）视为确定性错误直接透传；
- `deepseek-v4-flash` 连续 5xx 时**自动降级到 `deepseek-v4-pro`**；
- `cnbCall`（`main.ts:1436`）带 **30 秒无响应头超时**——cnb 偶发无限挂起，中止后交给退避重试（只罩到响应头返回，不限流式生成总时长）；
- **串行闸**（`main.ts:1492`）：cnb 网页会话按 cookie 归属，多客户端并发共用一个 cookie 会互踩（曾观测到跨会话内容泄漏）。所有 cnb 上游调用同一时刻只放行一个，锁持有到**响应流真正消费完**（流结束/出错/消费方取消/2 分钟无数据/10 分钟硬安全阀任一条件释放），日志以 `[cnb-gate] fp=...` 记录排队与释放（fp 为会话指纹，重叠且 fp 不同即跨会话并发）；
- **1 MiB 请求体预检**：cnb 网关（nginx）硬性拒绝超过 1 MiB 的请求体，超过则毫秒级本地返回 413，不浪费隧道往返。

### 5. 其它

- **可用模型**：`deepseek-v4-flash`、`deepseek-v4-pro`；
- **视觉**：`user` / `system` 消息中的 `image_url` 块会被保留为多模态数组，而不是被折叠成纯文本（`main.ts:1317` 的注释记录了这次修复的原因）；
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
| `main.ts` | 全部逻辑：路由、适配器、cnb 模块、Responses 适配、鉴权、反向代理 |
| `worker.ts` | Cloudflare Workers 入口 shim（把 `vars`/secrets 注入 `main.ts` 的模块级 `ENV`） |
| `wrangler.jsonc` | Worker 配置（`name: ai-api`，`main: worker.ts`） |
| `deno.jsonc` | Deno Deploy 配置（`org: hitmargin`，`app: ai-api`） |
| `restart.ps1` | 一键：本地服务 + 隧道 + 更新 Worker 的 `BACKEND_URL` 密钥；`-Local` 只启动本地服务，不碰隧道/Worker/代理 |
| `deno.lock` | 依赖锁定 |

本地开发还会出现（已在 `.gitignore` 中排除）：`cookies.txt`（抓包得到的 cookie）、`.wrangler/`（Cloudflare 账号缓存）、
`cloudflared.exe`、`page.html`（页面快照）、`main.ts.bak-*`（历史备份）。

---

## 已知限制

- cnb 通道完全依赖网页端私有接口，**上游改版即失效**；
- 免费上游的模型清单随时变化，且常见限流（429）与容量窗口（5xx）；
- `trycloudflare` 快速隧道的 URL 每次重启都会变（由 `restart.ps1` 自动回写 `BACKEND_URL`），且约有 10% 的连接抖动（`proxyToBackend` 已做一次重试）；
- 内存缓存（模型列表 5 分钟、CSRF 25 分钟）在边缘多实例下不共享。

---

## 许可证

本项目采用 **GNU General Public License v3.0** 许可，全文见 [LICENSE](LICENSE)。

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
