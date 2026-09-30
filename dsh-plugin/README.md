# ai-proxy DSH bridge（可选）

这是一个**可选的 DSH Host 插件**，把 DSH 的模型选择器接到本项目已经运行的本地代理：

```text
DSH → http://127.0.0.1:8000/commandcode/v1 → CommandCode
```

它不保存 CommandCode key、不读取 OAuth 文件，也不复制账号池逻辑。凭据、额度、冷却和多账号调度全部由 `ai-proxy` 负责。

## 安装前确认

- 本地代理正在运行；
- `GET http://127.0.0.1:8000/commandcode/v1/models` 可访问；
- DSH 能访问 `LOCAL_AGGREGATION_API_KEY` 环境变量；
- 不要把 `baseURL` 改成公网地址后就直接安装，插件只允许 HTTPS 或 loopback HTTP。

## 手动安装

将 `dsh-plugin` 目录复制到目标 DSH profile 的 `node_modules/ai-proxy-dsh-bridge/`，然后把下面一行加入该 profile 的 bundle 配置：

```yaml
- insert:
    - id: ai-proxy-commandcode
      name: 'ai-proxy-dsh-bridge'
      config:
        baseUrl: http://127.0.0.1:8000/commandcode/v1
        apiKeyEnv: LOCAL_AGGREGATION_API_KEY
```

插件不会自动安装，也不会修改 DSH 的默认模型。需要重启 DSH 或让插件管理器重新加载。

## 自检

不接真实上游的本地自检：

```bash
node dsh-plugin/self-test.mjs
```

自检只使用 fake `fetch`，验证模型发现、SSE 转换和 Host 注册接口。

## 当前边界

- 这是模型 Provider 适配器，不是完整的设置页；
- DSH 面板可以直接读取代理的 `GET /commandcode/v1/panel`；
- 工具调用的历史修复、截断保护、Anthropic Messages 转换仍由代理完成；
- 插件本身只使用 Node 内置 `fetch`，没有 npm 运行时依赖。
