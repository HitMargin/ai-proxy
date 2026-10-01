# ai-proxy DSH 插件（全项目）

这个插件把**整个原始 `ai-proxy` Deno 项目**接入 DSH，不复制或改写原始代码：

```text
DSH 插件
  ├─ 自动启动/监控本地 Deno 项目（可选）
  ├─ 或连接已经运行的本地/远程代理
  ├─ 注册 ai-proxy Provider
  └─ 提供全渠道模型、运行状态和生命周期面板

原始项目目录
  ├─ main.ts
  ├─ src/
  ├─ third_party/
  ├─ restart.ps1
  └─ deno.jsonc
```

## Provider 覆盖范围

DSH 中的 `ai-proxy` Provider 会从本地代理读取完整模型目录：

- `kilo/*`：Kilo 免费模型；
- `zen/*`：Zen 免费模型（代理会补 OpenCode 指纹和 session；上游拒绝时返回明确错误）；
- `commandcode/*`：CommandCode Go 通道；
- `tokenharbor/*`：TokenHarbor 通道（可用时）。

以下渠道不进入模型列表，即使旧会话仍缓存着这些 ID，调用也会立刻以 `CONFIG_DISABLED` 拒绝，不会消耗一轮请求：

| 渠道 | 原因 |
| --- | --- |
| `openrouter/*` | 依赖 per-user key，本代理从不持有 |
| `anthropic/*` | 同上 |
| `gemini/*` | 同上 |
| `deepseek-web/*` | 按使用者要求关闭。**它本身是可用的**（实测 HTTP 200 并返回真实文本），所以这不是能力问题，只是不再出现在选择器里 |
| `cnb/*` | 上游要求登录，实测 `401 [NOT_LOGIN]`。把 Cookie 粘进 `cnb-login.txt` 后可恢复 |

屏蔽按**首个路径段**（即本代理用来路由的渠道名）判断，不是子串匹配。所以 `tokenharbor/openrouter/…` 同样被拦下，而 `kilo/openrouter/free`（Kilo 自己托管的免费路由模型）不受影响。

聚合入口本身是：

```text
/v1
```

插件会自动把带前缀的模型 ID 路由回正确的上游：

```text
kilo/...          → /v1
commandcode/...   → /v1
zen/...           → /v1
tokenharbor/...   → /tokenharbor/v1
```

被屏蔽的渠道仍保留路由（`cnb/... → /v1`、`deepseek-web/... → /deepseek-web/v1`），但请求在发出前就会被 `CONFIG_DISABLED` 拦下，所以这两条不会真正被用到；留着是为了将来在设置里恢复某个渠道时不必改路由表。

插件不保存任何上游 key、OAuth 文件或 Cookie；凭据、额度、冷却、协议转换和多账号调度全部由原始 `ai-proxy` 负责。对 `zen/*` 请求，插件会把 DSH 的 `options.sessionId` 作为 `x-session-id` 传给代理，由代理生成稳定的 OpenCode canonical session。

## 两种运行模式

### 本地 Deno 模式（默认）

插件启用后会自动尝试启动：

```text
deno run -A main.ts
```

它会：

- 从 `projectRoot` 找 `main.ts` 和 `deno.jsonc`；
- 启动 Deno 子进程；
- 等待 `http://127.0.0.1:<port>/health`；
- 自动注册 DSH `ai-proxy` Provider；
- 在插件卸载时停止自己启动的进程；
- 读取最近日志并显示状态。

插件不会把源码复制到 `node_modules`。原始项目仍然放在原来的目录。

推荐配置：

```yaml
config:
  mode: local
  projectRoot: D:/Projects/ai-proxy
  port: 8000
  denoPath: deno
  apiKeyEnv: LOCAL_AGGREGATION_API_KEY
```

也可以通过环境变量指定项目目录：

```powershell
$env:AI_PROXY_HOME='D:\Projects\ai-proxy'
```

### 已有代理模式

如果代理已经由 `restart.ps1`、Windows 服务、Deno Deploy、Worker 或隧道启动，插件不启动子进程，只连接已有地址：

```yaml
config:
  mode: external
  externalUrl: http://127.0.0.1:8000
  apiKeyEnv: LOCAL_AGGREGATION_API_KEY
```

也支持 HTTPS 的 Worker/隧道地址。

## 安装

将 `dsh-plugin` 复制到目标 DSH profile：

```text
<DSH profile>\node_modules\ai-proxy-dsh-bridge\
```

然后在 bundle 配置中加入：

```yaml
- insert:
    - id: ai-proxy
      name: 'ai-proxy-dsh-bridge'
      config:
        mode: local
        projectRoot: D:/Projects/ai-proxy
        port: 8000
        denoPath: deno
        apiKeyEnv: LOCAL_AGGREGATION_API_KEY
```

启用后可在：

```text
DSH 设置 → ai-proxy
```

修改模式、项目目录、端口、外部地址，并执行启动、停止或重启。面板按「总览 / 模型 / 渠道 / 运行 / 设置」五个标签组织：运行时长每秒刷新，快照每 10 秒拉取一次，模型表支持搜索。

## 面板 API

插件在 DSH 同源接口提供：

```text
GET  /api/ai-proxy/panel
GET  /api/ai-proxy/usage
GET  /api/ai-proxy/settings
GET  /api/ai-proxy/logs
POST /api/ai-proxy/settings
POST /api/ai-proxy/probe
POST /api/ai-proxy/start
POST /api/ai-proxy/stop
POST /api/ai-proxy/restart
```

`GET /api/ai-proxy/usage` 返回 `{ summary, models, heatmap, trend }`：`summary` 是面板顶部的
指标，`models` 是按模型聚合的行，`heatmap` 是 119 天的日 token，`trend` 是累计曲线采样点。
插件重启后统计归零——数据只在内存里。

旧路径 `/api/ai-proxy-commandcode/*` 仍保留兼容。

`/api/ai-proxy/panel` 的响应里，每个模型行可能带 `state`（`available` / `degraded` / `unavailable`）、
`latencyMs` 和 `reason`；顶层还有 `modelHealth` 计数和完整的 `health` 快照。没有探测记录的模型
不会带 `state` 字段，前端按「未探测」显示。

面板会显示：

- 全项目模型数量；
- 各渠道模型数量；
- 模型搜索表（ID、名称、**可用状态**、上下文、最长输出、输入模态）；
- 用量看板（见下节）；
- CommandCode 账号池摘要；
- 本地/远程运行状态与 Deno 进程 PID；
- 最近日志。

## 用量看板

`用量` 标签页统计本插件经手过的每一次对话调用。数据只写在本机，不上传。

统计持久化在 `~/.dsh/ai-proxy-dsh-bridge/stats.json`（`$DSH_HOME` 优先），**重启 DSH 不会清零**：

- 写入经 800 ms 合并，多次修改只落盘一次；
- 落盘走「临时文件 + 重命名」，中途崩溃不会留下截断文件；
- 文件损坏时保留一份 `.corrupt-<时间戳>` 副本再重置，避免历史被下一次写入静默覆盖；
- 插件卸载前会 flush 掉尚未到期的写入。

存成文件而不是用 harness 的存储服务，有三个原因：设置缝隙在两条 kernel 线上形状不同、存储域在裸 profile 上可能没挂载、而且用量是高基数遥测，不该塞进配置文档里。

| 指标 | 口径 |
| --- | --- |
| Token | 输入 + 输出总和，保留在最近 400 次采样内 |
| 输出 Token | 上游 usage 帧的 `completion_tokens` |
| 推理 Token | `completion_tokens_details.reasoning_tokens` |
| 调用 / 失败 | 成功与失败次数；流中途断开记为失败 |
| 输出速度 | 等待的输出 token ÷ 解码窗口，**只统计可信窗口** |
| 首帧延迟 | 从发出请求到收到第一个可见 token 的毫秒数 |
| 平均输出 | 单次成功回答的平均输出 token |
| 今日 | 当天（本地时区）的 token 总量 |

另外还有：

- **Token 热力图** — 最近 119 天，格深按非零天的四分位分档；
- **总量曲线** — 累计 token 的面积图；
- **模型用量表** — 每个模型的调用数、速度、首帧延迟、输出量与失败数。

### 速度为什么经常显示「—」

判定规则沿用参考插件 `dsh-our-free-model` 的 `src/store.js`：

```text
解码窗口 < 250ms   → 不计入
速率 > 250 tok/s   → 不计入
```

只回十几个 token 的短回答，解码窗口往往不到 250ms，速度没有统计意义。宁可显示「—」，也不把一次性回答算成几千 tok/s。**推理 token 不计入解码窗口**——用户并没有等待那些 token。

首帧延迟同理：失败调用的整段耗时不是首帧延迟，不会进入平均值。速度由「累计 token ÷ 累计窗口」得出，不是各次速率的平均，否则一次长回答会和一百次短回答等权。

### 刷新时机

用量随面板快照一起拉取（每 10 秒一次）；每秒走的只有「已运行」时钟。

## 模型可用状态

代理在拉取模型列表时会顺带探测每个模型，面板据此给每行标注状态：

| 状态 | 含义 | 判定依据 |
| --- | --- | --- |
| 可用 `available` | 该模型能正常出结果 | HTTP 2xx |
| 限流 `degraded` | 上游过载或限流，稍后可能恢复 | 408 / 425 / 429 / 5xx |
| 不可用 `unavailable` | 凭据被拒或该模型已下线 | 401 / 403 / 407 / 其他 4xx |
| 未探测 | 该渠道尚未跑过探测 | 没有探测记录 |

逐模型判定来自代理 `GET /health` 的 `models` 字段，由 `src/runtime/health.ts` 的 `classifyProbeStatus` 统一分类。插件只负责把样本按 `provider + 未加前缀的 model id` 拼回 `kilo/…` 这样的完整 ID。

要点：

- **未探测不等于不可用。** 没有探测记录的模型照常显示，不会因为没测过就被判定为故障。
- **插件不自行发起推理探测**，只复用代理已经付出的探测结果，不额外消耗上游额度。
- 想立刻刷新状态，对对应渠道的模型列表加 `?health=true` 强制重探一次。

## 安全边界

- 插件不接收或显示任何上游 key；
- 插件只向本地/远程代理转发请求；
- 本地模式只允许 loopback，公网地址必须 HTTPS；
- `/api/ai-proxy/*` 路由要求同源请求，拒绝跨站来源；
- 插件只停止自己启动的 Deno 子进程，不会误杀已有代理；
- `LOCAL_AGGREGATION_API_KEY` 是 DSH/插件访问代理的客户端 key，不是任何上游 key。

## 自检

```bash
node dsh-plugin/self-test.mjs      # 桥接接线
node --test dsh-plugin/stats.test.mjs   # 用量统计口径
```

桥接自检使用 fake `fetch`，验证：

- Provider 注册；
- 聚合与多渠道模型发现；
- 蛇形/驼峰元数据归一（`input_modalities` 不再被降级成 text）；
- 屏蔽渠道不进入列表且调用被拒；
- 模型前缀路由；
- SSE 转换；
- 面板和兼容回退；
- 逐模型状态 join（含带斜杠的 kilo id 与两种拼写）；
- 主动状态检查不扩散到全量探测；
- 设置读取；
- 启动/停止路由。

统计自检验证：解码窗口的可信性门槛、失败调用不计入延迟、速度按累计窗口而非速率均值、
推理 token 不计入速度、空状态诚实返回 `null`、热力图跨度、趋势的累计基数、采样环有界、旧日桶裁剪。

## 当前边界

- 原始 Deno 项目是唯一代码实现，插件不复制 `main.ts` 或 `src/`；
- 本地模式要求机器安装 Deno；已有代理模式不要求；
- 设置页是状态/生命周期面板，不是完整账号管理 UI；
- `max_output_tokens` 目前对所有 CommandCode 模型取同一个全局配置值，这是代理侧的真实行为，插件不做粉饰；
- 工具历史修复、截断保护、Responses/Messages 转换仍由代理完成；
- 插件运行时只使用 Node 内置模块，没有 npm 运行时依赖；
- 浏览器半身使用 DSH 自带的 React 和 ModuleLoader，没有构建步骤。
