# ai-proxy DSH 插件（全项目）

这个插件把**整个原始 `ai-proxy` Deno 项目**接入 DSH，不复制或改写原始代码：

```text
DSH 插件
  ├─ 自动启动/监控本地 Deno 项目（可选）
  ├─ 或连接已经运行的本地/远程代理
  ├─ 注册 ai-proxy 全项目 Provider
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
- `zen/*`：Zen 免费模型；
- `cnb/*`：CNB 通道；
- `commandcode/*`：CommandCode Go 通道；
- `deepseek-web/*`：DeepSeek 网页端；
- `tokenharbor/*`：TokenHarbor 通道（可用时）；
- `openrouter/*`：OpenRouter 通道（可用时）；
- `anthropic/*`、`gemini/*`：配置了凭据且端点可用时显示。

聚合入口本身是：

```text
/v1
```

插件会自动把带前缀的模型 ID 路由回正确的上游：

```text
kilo/...          → /v1
commandcode/...   → /v1
cnb/...           → /v1
zen/...           → /v1
deepseek-web/...  → /deepseek-web/v1
openrouter/...    → /openrouter/v1
```

插件不保存任何上游 key、OAuth 文件或 Cookie；凭据、额度、冷却、协议转换和多账号调度全部由原始 `ai-proxy` 负责。

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
- 自动注册 DSH 全项目 Provider；
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
DSH 设置 → ai-proxy 全项目
```

修改模式、项目目录、端口、外部地址，并执行启动、停止或重启。

## 面板 API

插件在 DSH 同源接口提供：

```text
GET  /api/ai-proxy/panel
GET  /api/ai-proxy/settings
GET  /api/ai-proxy/logs
POST /api/ai-proxy/settings
POST /api/ai-proxy/start
POST /api/ai-proxy/stop
POST /api/ai-proxy/restart
```

旧路径 `/api/ai-proxy-commandcode/*` 仍保留兼容。

面板会显示：

- 全项目模型数量；
- 各渠道模型数量；
- CommandCode 账号池摘要；
- 本地/远程运行状态；
- Deno 进程 PID；
- 最近日志。

## 安全边界

- 插件不接收或显示任何上游 key；
- 插件只向本地/远程代理转发请求；
- 本地模式只允许 loopback，公网地址必须 HTTPS；
- `/api/ai-proxy/*` 路由要求同源请求，拒绝跨站来源；
- 插件只停止自己启动的 Deno 子进程，不会误杀已有代理；
- `LOCAL_AGGREGATION_API_KEY` 是 DSH/插件访问代理的客户端 key，不是任何上游 key。

## 自检

```bash
node dsh-plugin/self-test.mjs
```

自检使用 fake `fetch`，验证：

- 全项目 Provider 注册；
- 聚合与多渠道模型发现；
- 模型前缀路由；
- SSE 转换；
- 面板和兼容回退；
- 设置读取；
- 启动/停止路由。

## 当前边界

- 原始 Deno 项目是唯一代码实现，插件不复制 `main.ts` 或 `src/`；
- 本地模式要求机器安装 Deno；已有代理模式不要求；
- 设置页是轻量全项目状态/生命周期面板，不是完整账号管理 UI；
- 工具历史修复、截断保护、Responses/Messages 转换仍由代理完成；
- 插件运行时只使用 Node 内置模块，没有 npm 运行时依赖；
- 浏览器半身使用 DSH 自带的 React 和 ModuleLoader，没有构建步骤。
