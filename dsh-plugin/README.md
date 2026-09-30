# ai-proxy DSH 插件（完整桥接）

这个插件把**原始 `ai-proxy` Deno 项目**接入 DSH，同时不复制或改写原始代码：

```text
DSH 插件
  ├─ 自动启动/监控本地 Deno 项目（可选）
  ├─ 或连接已经运行的本地/远程代理
  └─ 注册 CommandCode Provider + 轻量设置页

原始项目目录
  ├─ main.ts
  ├─ src/
  ├─ third_party/
  ├─ restart.ps1
  └─ deno.jsonc
```

插件不保存 CommandCode key、不读取 OAuth 文件，也不复制账号池逻辑。凭据、额度、冷却、协议转换和多账号调度全部由 `ai-proxy` 负责。

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
- 自动注册 DSH Provider；
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
  externalUrl: http://127.0.0.1:8000/commandcode/v1
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
    - id: ai-proxy-commandcode
      name: 'ai-proxy-dsh-bridge'
      config:
        mode: local
        projectRoot: D:/Projects/ai-proxy
        port: 8000
        apiKeyEnv: LOCAL_AGGREGATION_API_KEY
```

插件不会自动安装，也不会修改 DSH 默认模型。启用后可在：

```text
DSH 设置 → CommandCode 桥接
```

修改模式、项目目录、端口、外部地址，并执行启动、停止或重启。

## 安全边界

- 插件不接收或显示 CommandCode 上游 key；
- 插件只向本地/远程代理转发请求；
- 本地模式只允许绑定 loopback HTTP，公网地址必须 HTTPS；
- `/api/ai-proxy-commandcode/*` 路由要求同源请求，拒绝跨站来源；
- 插件只停止自己启动的 Deno 子进程，不会误杀已有的代理进程；
- `LOCAL_AGGREGATION_API_KEY` 是 DSH/插件访问代理的客户端 key，不是 CommandCode 上游 key。

## 自检

不接真实上游的本地自检：

```bash
node dsh-plugin/self-test.mjs
```

自检使用 fake `fetch`，验证：

- DSH Adapter 注册；
- 模型发现；
- SSE 转换；
- 面板 API；
- 设置读取；
- 启动/停止路由。

## 当前边界

- 原始 Deno 项目是唯一代码实现，插件不复制 `main.ts` 或 `src/`；
- 本地模式要求机器安装 Deno；已有代理模式不要求；
- 设置页是轻量状态/生命周期面板，不是完整账号管理 UI；
- 工具历史修复、截断保护、Responses/Messages 转换仍由代理完成；
- 插件运行时只使用 Node 内置模块，没有 npm 运行时依赖；
- 浏览器半身使用 DSH 自带的 React 和 ModuleLoader，没有构建步骤。
