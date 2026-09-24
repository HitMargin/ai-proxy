# ai-proxy 项目上下文（代理每次请求都会读到，压缩不会丢失）

## 项目
Deno 本地反代（端口 8000，`restart.ps1 -Local`）+ cloudflared 隧道 + Cloudflare Worker 远端链。
为 dsh 提供免费模型入口。

## 当前状态（2026-09-24 核实，改动此节请更新日期）
- **cnb 匿名通道已死**：上游 401 `[NOT_LOGIN]`，需登录。已实现登录态支持：登录 Cookie 粘到
  `cnb-login.txt`（热加载，剔除 csrfkey，见 README 1.5 节）。用户暂无 cnb 账户，通道 dormant。
- **DeepSeek 网页端**：`/deepseek-web/v1` 已支持自动登录凭证、PoW WASM、THINK/RESPONSE SSE 解析、OpenAI SSE、工具调用、图片 data URL 上传到 `ref_file_ids`、Chat Completions、Responses API 和 `off/low/high/max` 思考档位；由于 DSH OpenAI 兼容列表不读取自定义 reasoning 元数据，额外暴露 `deepseek-reasoner-off/low/high/max` 模型变体；同一账号请求串行，随机间隔 2～4 秒，连续 15 次长休，429/403 会暂停自动重试。默认同一账号复用 chat_session 20 轮，`DEEPSEEK_SESSION_REUSE_TURNS=0` 可关闭复用。图片首次使用前需重新运行登录捕获脚本生成 `deepseek-headers.json`。
- **可用通道**：`/v1` 聚合入口的 kilo 系模型（含 `kilo/deepseek/deepseek-v4-flash-0731:free`，实测正常）。
- **不可用**：zen 全部（区域锁 / 仅限 OpenCode 客户端）；ss2a 自营模型 502；ss2a 免费档间歇 403/502。
- **DSH 配置**：活动 Web profile 的模型注册文件是 `C:\Users\22282\.dsh\profiles\web\cordis.patch.yml`；其中 `deepseek-web` 已注册 1,048,576 context、16,384/32,768 maxTokens、text/image 输入和 off/low/high/max 思考档位。HTTP `/models` 不能替代这份 DSH 配置。
- **业务错误/冷却**：DeepSeek HTTP 200 `biz_code`、SSE `error/toast`、`content/msg` 错误正文、muted/mute_until、非 SSE completion 错误会被识别；限流期返回 429 + Retry-After，`deepseek-web-cooldown.json` 持久化冷却状态，进程重启不丢失；Responses 流错误转换为 `response.failed`。
- **请求指纹**：DeepSeek 的 PoW、建会话、删除会话、图片上传和 completion 共用 `deepseek-headers.json` 的浏览器头集合；不再发送重复版本头或 `X-Deepseek-Harness`。
- **源码结构**：`main.ts` 为入口/路由；`src/core.ts` 为通用核心；`src/cnb.ts` 与 `src/deepseek-web.ts` 为上游适配模块；`third_party/dsh-deepseek-web-login` 为保留 Apache-2.0 许可的 DeepSeek 工具协议派生代码。
- git 已于今日 init（身份 HitMargin），`.gitignore` 已排除 cookies.txt / cnb-login.txt / deepseek-auth.txt / deepseek-cookies.txt / *.bak 等。
- **未决事项**：是否参考 https://github.com/jieapi/AiCode issue #23 在后续模块中实现「自动上下文压缩」——仅参考，未决定。

## 行为规则
1. **文件为准**：涉及文件内容/行号/结构时，以本次工具读取结果为准；不要依赖会话记忆或压缩摘要里的旧行号。
2. 会话被压缩或换模型后：先重读本文件定位任务，再继续；不要重新验证已确认的事实。
3. 用中文回复用户。
