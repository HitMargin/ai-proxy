# WorkBuddy 反代集成方案（第 8 渠道：/workbuddy/v1）

> 目标：把腾讯 **WorkBuddy 中国版**（www.workbuddy.cn）的对话通道接进本仓库 ai-proxy，
> 作为继 kilo / zen / cnb / commandcode / deepseek-web / trae / tokenharbor 之后的**第 8 个渠道**，
> 并让它出现在 DSH 插件面板与模型选择器里。
>
> 参考实现：C:\Users\22282\AppData\Local\Temp\dsh-codearts-auth（MIT，CodeBuddy/WorkBuddy 同源实现）。
> 本方案只借鉴其**协议常量、登录时序、头族与错误判定**，**不搬运**它的 LlmAdapter 框架——
> 本仓库的接入面不同（main.ts 泛型代理 + customHandler），照搬框架会多出一层无用的抽象。
>
> 与 TRAE 移植的关键区别：WorkBuddy 说的是**标准 OpenAI SSE 与标准 OpenAI 请求体**，
> **不需要**协议转换器（trae.ts 那种 SOLO↔OpenAI 翻译器）。本方案的难点全部在
> **登录链路 / 续期 / 凭据落盘 / 归因头族**，不在流式解析。
>
> ⚠️ **版本改道记录**：本方案初稿按**国际版**（www.workbuddy.ai）设计。用户答复为**中国版**后，
> 第 1/2/3 章与附录 A 全部按中国版重写。改道的实证见 §2.7，**两条待验证项**见附录 B。

---

## 1. 协议关系：WorkBuddy 与现有渠道的对比

| 维度 | WorkBuddy（中国版） | TRAE SOLO | deepseek-web | CodeBuddy（参考项目） |
|------|--------------------|-----------|--------------|----------------------|
| 认证 | POST /v2/plugin/auth/state 拿 state → 浏览器登录 → GET auth/token 轮询拿 token；refresh_token 续期 | refreshToken → ExchangeToken（轮换制） | 抓 cookie/token/headers 三件套 | external-link 轮询式 |
| Host | **www.workbuddy.cn** | trae-api-cn.mchost.guru | chat.deepseek.com | copilot.tencent.com |
| platform | **workbuddy-ai** | — | — | ide |
| 对话端点 | POST /v2/chat/completions | POST /api/agent/v3/llm_utils_chat | POST /api/v0/chat/completion | POST /v2/chat/completions |
| 载荷转换 | **透传标准 OpenAI** | OpenAI → SOLO（function / config_name） | 自有 | 透传 |
| SSE 格式 | **标准 OpenAI SSE** | SOLO 自定事件 → 转换 | 自有 | 标准 OpenAI SSE |
| 模型列表 | GET /v3/config（**必须带 Bearer**） | POST /api/ide/v1/batch_get_detail_param | 自有 | GET /v3/config |
| 归因头 | X-Agent-Purpose / X-IDE-Name / X-IDE-Type / X-IDE-Version / X-Product 五件套 | Cloud-IDE-JWT + ~19 个身份头 | cookie 三件套 | 同 WorkBuddy |
| 签到 | **待实测**（路由存在，见 §2.6） | 有 /trae/api/v2/ug/checkin_credits/claim | 无 | 有 /v2/billing/meter/daily-checkin |
| 入口 | 需要**浏览器登录态**（会过期） | 同左 | 需要抓包 | 同左 |

**结论**：WorkBuddy 属「**标准协议 + 需要登录态**」脉系。本仓库已有两条同类先例
—— deepseek-web（抓包三件套）与 trae（登录脚本 + 每请求读 + 自动续期）。WorkBuddy
**最接近 trae**：token 会过期、需要 refresh、需要面板卡片，但**比 trae 简单**，
因为协议无需翻译。故按路径 B：customHandler 走 workbuddy + 新文件 src/workbuddy*.ts。

### 1.1 为什么 host 是 www.workbuddy.cn 而不是 copilot.tencent.com

参考实现里「中国版」那一侧的产品 id 是 **CodeBuddy / copilot.tencent.com**，而它只有一个
**国际版** WorkBuddy（www.workbuddy.ai）。**本机实测证明中国版 WorkBuddy 有独立域名**，
两者不是同一个产品：

| 判据 | 证据（§2.7 详录） |
|------|------------------|
| 独立站点 | https://www.workbuddy.cn 200，标题「WorkBuddy - AI Agent 办公新范式」，页面 script 带 `data-wb-injected`（CodeBuddy 站点是 `data-cb-injected`） |
| 明确判为国内 | 登录页内联 `window.IS_INTERNATIONAL_EDITION = 'false'`；其 JS:`/workbuddy\.ai|tencentcloud\.com/i.test(hostname)` 判国际化 |
| 平台路由表 | 登录 bundle 的 `Ji = ua ? 'www.workbuddy.cn' : (We||ze ? 'www.codebuddy.cn' : 'copilot.tencent.com')`（`ua` = host 含 workbuddy.cn） |
| 协议同形 | workbuddy.cn 与 workbuddy.ai 的 `/v3/config` 响应体**逐字段同形**（`data.models: null` 未登录亦然） |
| 有独立安装包 | `download.codebuddy.cn/workbuddy/saas/win32-x64-user/WorkBuddy-win32-x64-user-<ver>.exe` |

---

## 2. 协议详解（依据：参考实现源码 + 本机活体实测 2026-10-03）

### 2.1 API 端点（host 全部为 https://www.workbuddy.cn）

| 用途 | 方法 | 路径 | 鉴权 | 实测（本机，未登录） |
|------|------|------|------|--------------------|
| 取登录 state | POST | /v2/plugin/auth/state?platform=workbuddy-ai | 无（四个 X-No-* 头） | **200** JSON，data.state + data.authUrl |
| 轮询 token | GET | /v2/plugin/auth/token?state= | 无（X-No-Authorization: true） | **200** {"code":11217,"msg":"11217:login ing..."} |
| 取账号 | GET | /v2/plugin/login/account?state= | Bearer token | 未登录时 **401 + openresty HTML**（非 JSON） |
| 刷新 token | POST | /v2/plugin/auth/token/refresh | Bearer access + X-Refresh-Token | 空体 **400** {"code":10001,"msg":"10001:refreshToken is empty"} |
| 账号列表 | GET | /v2/plugin/accounts | Bearer | 未登录 401 HTML |
| 模型目录 | GET | /v3/config | Bearer（**必须**） | 匿名/伪凭据 **200 但 data.models 为 null** |
| 企业模型 | GET | /console/enterprises/personal/models | Bearer | 未登录 **400 + login-pf HTML**（登录页壳） |
| 对话 | POST | /v2/chat/completions | Bearer + 归因头族 | 未登录 **401 openresty HTML** |
| 用量通知 | POST | /v2/billing/meter/get-dosage-notify | Bearer | 未登录 401 HTML |
| 签到状态 | POST | /v2/billing/meter/checkin-activity-status | Bearer | 未登录 **401** ⇒ 路由存在（见 §2.6） |
| 签到领取 | POST | /v2/billing/meter/daily-checkin | Bearer | 未登录 **401** ⇒ 路由存在（见 §2.6） |
| 积分余额 | GET | /v2/billing/meter/get-user-resource | Bearer | 未登录 401 HTML |

> ⚠️ 端点的 state / authUrl / domain **一律以服务端下发为准**，不得自己拼装。
>
> ⚠️ **「401 vs 404」是本机唯一可靠的路由存在性判据**（§2.7 已用 `/totally/unknown/route/xyz`
> 与 `/v2/billing/meter/claim-checkin` 做对照，两者都是 404 `{"error_msg":"404 Route Not Found"}`）。
> 上表的 401 全部代表**路由真实存在、只是缺鉴权**。

### 2.2 认证流程

    登录（一次性脚本 .tmp-workbuddy-login.ts）:
      POST /v2/plugin/auth/state?platform=workbuddy-ai
        → { state, authUrl }        authUrl = https://www.workbuddy.cn/login?platform=workbuddy-ai&state=<uuid>
      decorateLoginUrl(authUrl): 追加 version=<客户端版本> 与 loginSessionId=<uuid>
        ⚠️ 只追加参数、绝不重建 URL；URL 非法则原样返回
        ⚠️ platform 服务端**不校验**（任意字符串原样回显），值必须来自客户端配置，不能靠探测推
      openBrowser(decorated)                    ← 用户手动完成登录
      轮询 GET /v2/plugin/auth/token?state=<state>    间隔 1s，上限 5 分钟
        - code === 11217 (CODE_TOKEN_NOT_READY) → 继续等
        - 200 但 data 缺失 → 继续等
        - 网络错误 → 继续等
        - 其余非 200 → 抛 auth/token HTTP <status> code=<code>: <message>
      GET /v2/plugin/login/account?state=<state>
        → 头加 Authorization: Bearer <access_token>，X-Domain 用**服务端本次下发的 token.domain**（非空时）
        - code === 12151 (CODE_ACCOUNT_NOT_READY) → 继续等
      → buildCredential(token, account) → 落盘 workbuddy-auth.json

    续期:
      POST /v2/plugin/auth/token/refresh
        头 = credentialRequestHeaders(credential)
             + Authorization: Bearer <access_token>
             + X-Refresh-Token: <refresh_token>
             + X-Auth-Refresh-Source: ide-main
        ⚠️ X-Domain 与 User-Agent 必须**按产品覆盖**（否则 WorkBuddy 会以 CodeBuddy 身份续期）
      判定过期: HTTP 401/403 **或** code 401/403 → RefreshTokenExpiredError（要求重新登录）
                其余非 200 → 普通 Error（可重试）

### 2.3 对话流程

    POST /workbuddy/v1/chat/completions  (OpenAI 形状)
      → 读凭据（过期先 refresh，refresh 失败 → 409 要求重新登录）
      → 缺凭据 → 409 { error: "no WorkBuddy credential. run: deno run -A .tmp-workbuddy-login.ts" }
      → GET /v3/config 取模型元数据（缓存 300s；失败回退静态兜底表）
      → 组装上游请求体（标准 OpenAI，几处白名单化，见 3.5）
      → POST https://www.workbuddy.cn/v2/chat/completions
          头：Authorization / Accept: text/event-stream / Content-Type
              X-Domain: www.workbuddy.cn          ← 产品配置优先
              X-Product-Code: workbuddy
              X-Agent-Purpose: conversation
              X-IDE-Name / X-IDE-Type: WorkBuddy
              X-IDE-Version: <客户端版本>
              X-Product: WorkBuddy                ← 归属名，不是部署类型
              User-Agent: WorkBuddy/<ver> WorkBuddy/<ver> CLI/<ver>   ← 国内形态
      → 401/403（含流外 code 11140）→ refresh 一次 → 重试一次；仍失败则报错
      → HTTP 200 → **直接透传 SSE**（标准 OpenAI 帧）
          唯一例外：若某帧 data.choices 为 undefined 且 body 命中 /"code"\s*:\s*11140/
          → 判为安全策略拦截，转成 error 帧（判定必须窄，见 3.5）

### 2.4 模型列表

- 来源：GET /v3/config → data.models[]（每项 id / name / maxInputTokens / maxOutputTokens / supportsImages / reasoning.supportedEfforts / reasoning.defaultEffort）
  + data.agents[]（cli / craft 白名单，**顺序即展示顺序**）
  + data.productFeaturesConfig.ModelTrialBanner.banners[].targetModelId（试用模型）
  + data.modelPromotions[]（促销倍率，展示成 x0.17→x0.50）
- 解析顺序（照抄参考实现，每条都有实测依据）：
  1. 首选 agent 白名单（cli 优先于 craft，取先出现的那个）
  2. data.models 里其余**可对话**模型
  3. 试用横幅模型
- 过滤：跳过 auto / default（字面量，**不做前缀匹配**——会误伤 default-model）；
  id 以 nes- / completion- / codewise- 开头跳过；supportsExtra === true 跳过；
  maxOutputTokens 为正且 ≤256 跳过（补全用途）；tags 含 text-to-image 跳过。
- 三层回退（照抄参考实现 buddy-oauth.ts:361-421）：
  1. GET /console/enterprises/personal/models（**scoped，元数据最全**，可能返回空/500）
  2. GET /v3/config
  3. 静态兜底表
  ⚠️ 第 1、2 层**必须取并集**（同 id 以 scoped 为准，scoped 没有的 id 追加在后）：
  实测两端的 id 集合不同，促销 `modelIds` 可能只挂在其中一端才有的 id 上（参考项目
  的 `hy4-preview-f` 免费促销 bug 就是这么来的）。
- ⚠️ 匿名或伪 Bearer 请求 /v3/config 会拿到 **200 + models: null**，
  所以**不能把 200 当作「目录可用」**，必须校验数组非空。
- ⚠️ **中国版的实际模型池以真凭据实测为准**。中国版文档（workbuddy.cn/docs/workbuddy/
  From-Beginner-to-Expert-Guide/Function-Description/Model）列出的内置模型**全是国内系**，
  与参考实现那份国际版表**只重合 5 条**（见附录 A）。

### 2.5 错误码

| 码 | 含义 | 处理 |
|----|------|------|
| 0 | OK | 正常 |
| 11217 | CODE_TOKEN_NOT_READY | 登录轮询时**继续等** |
| 12151 | CODE_ACCOUNT_NOT_READY | 取账号时**继续等** |
| 10001 | 参数/幂等类通用错误（实测：refresh 空体、签到今日已领） | 按语义处理：refresh 缺 token ⇒ 要求重新登录；签到 ⇒ 视为已完成 |
| 12153 | refresh 失败（如 token format error） | HTTP 401 已足够判定过期；code 仅用于日志 |
| 11140 | 安全策略拦截（request illegal） | **按账号生效、与内容无关**；流内判定必须窄 |

### 2.6 签到 / 积分（**由「不实现」改判为「待实测」**）

- 初稿按参考实现的结论写成「不实现」。**本机实测推翻了这条结论的适用范围**：
  参考项目说的是**国际版内核里没有该字面量**（客户端静态串），不是**服务端没有该路由**。
  - `POST /v2/billing/meter/daily-checkin` → **401**（路由存在）
  - `POST /v2/billing/meter/checkin-activity-status` → **401**（路由存在）
  - 对照：`POST /v2/billing/meter/claim-checkin` → **404**；`POST /v2/billing/meter/totally-bogus-xyz` → **404**
  ⇒ 三个 host（workbuddy.cn / workbuddy.ai / copilot.tencent.com）**都**有签到路由。
- 但**中国版积分文档没有提到签到活动**（`/docs/workbuddy/Credits` 只讲积分定价、扣减、
  有效期、按月发放），所以「有路由」不等于「账号有这个活动」。
- **决策**：v1 **不渲染**「一键领取积分」按钮；登录脚本落地后先手工探一次
  `checkin-activity-status`，`active === true` 才考虑加按钮。避免点出 404。

### 2.7 改道实证记录（本机 2026-10-03）

1. **中国版 host 存在**：`https://www.workbuddy.cn` 200；`GET /v3/config` 匿名返回与
   workbuddy.ai **逐字段同形**的 body（`{"code":0,...,"data":{"agent":{"agents":null},"models":null,...}}`）。
2. **登录页明确判为国内**：`window.IS_INTERNATIONAL_EDITION = 'false'`、
   `window.APP_EDITION='standard'`、`window.RUN_ENV='prod'`；
   营销站 bundle `const-CKVNN4vL.js`：`IS_INTERNATIONAL_EDITION = /workbuddy\.ai|tencentcloud\.com/i.test(hostname)`。
3. **platform 取值 = workbuddy-ai**：登录站点 bundle `index-CjpuEu3x.js` 的平台枚举里
   `Z.WORKBUDDY='workbuddy'` 与 `Z.WORKBUDDYAI='workbuddy-ai'` **并列**；
   三个「客户端形态」白名单数组（`pa`/本文的 `ps`/`ds`）都含 `Z.WORKBUDDYAI`。
4. **platform 是纯回显**：`POST /v2/plugin/auth/state?platform=totally-bogus-xyz` → 200 且
   authUrl 原样带回该字符串 ⇒ 值只能从客户端配置取证。
5. **state 是全局态、host 无绑定**：拿 workbuddy.cn 的 state 去 copilot.tencent.com 查 token
   同样回 11217。
6. **品牌路由表**（登录 bundle）：`ca=host.includes('.workbuddy.')`、`We=host.includes('codebuddy.cn')`、
   `ua=host.includes('workbuddy.cn')`、`ze=host.includes('tencentbuddy.com')`、
   `Ji = ua ? 'www.workbuddy.cn' : (We||ze ? 'www.codebuddy.cn' : 'copilot.tencent.com')`；
   `$t = We||ze ? '.sso.codebuddy.cn' : '.sso.copilot.tencent.com'`。
7. **中国版模型池是另一套**（官方文档口径）：Hy4 preview / Hy3 / GLM-5.3 / GLM-5.3-Flash /
   GLM-5.2 / GLM-5.1 / GLM-5v-Turbo / MiniMax-M3 / MiniMax-m2.7 / Kimi-K3 / Kimi-K2.7-Code /
   Kimi-K2.6 / Deepseek-V4-Flash / Deepseek-V4-Pro，共 **14 条**；模式三档为
   快速 / 均衡 / 极致；企业版可禁用（含 auto）。
8. **中国版客户端版本**：官方更新日志最新 **5.6.2（2026-09-21）**；历史版本页有
   `WorkBuddy-win32-x64-user-<ver>.<build>-<hash>.exe` 形式的安装包（4.x–5.x）。
   参考实现里的 `5.5.2` 是**国际版**桌面版本号。

---

## 3. 实现方案

### 3.1 新增文件

| 文件 | 职责 | 参考源 |
|------|------|--------|
| src/workbuddy.ts | 产品常量、端点常量、凭据/账号/模型类型、纯函数（解析 token/account/config、促销、UA、归因头、isContentRejection、静态兜底表） | buddy.ts + product.ts |
| src/workbuddy-account.ts | 凭据落盘读写（workbuddy-auth.json）、过期/续期判定、refreshWorkBuddyCredential（终态判定 + 轮换保留）、requestWorkBuddy（先 text 再 try-parse） | src/trae-account.ts 形态 + buddy-oauth.ts:292-342 |
| src/workbuddy.test.ts | 纯函数单测（解析、过期判定、UA、归因头、拦截判定、HTML 错误体、null models、并集合并） | src/trae.test.ts |
| src/workbuddy-account.test.ts | 凭据层单测（读写、续期、终态判定、轮换保留、提前量上限） | src/trae-account.ts 形态 |
| .tmp-workbuddy-login.ts | 一次性登录脚本（含 openBrowser），落盘凭据；**同时执行 §4 步骤 0 的三 host 目录比对** | .tmp-trae-login.ts + login.ts:116-140 |
| docs/workbuddy-integration-plan.md | 本文档 | docs/trae-integration-plan.md |

> .tmp-* 脚本是本仓库的既有惯例（.tmp-trae-login.ts、.tmp-extract-deepseek-cookies.ts 均已提交），
> 故新脚本同样**放仓库根并提交**，不进 gitignore。

### 3.2 修改的文件

| 文件 | 改动 |
|------|------|
| src/core.ts | providers 表加 workbuddy 条目：prefix=/workbuddy/v1、占位 baseUrl/endpoints、auth:{type:'none'}、customHandler:'workbuddy'（照 trae 条目的「占位只为让 prefix 可辨识」注释） |
| main.ts | import workbuddy 模块；WORKBUDDY_ROOT（同 TRAE_ROOT 的解析方式）；V1_AGGREGATE_MEMBERS 加 'workbuddy'；hasChannelCredential 增加凭据文件分支；v1FetchMemberModels 加 workbuddy 分支；handleWorkBuddy(path, request)；自定义分发加 workbuddy；/health/probe 的 channelPrefixes 加 workbuddy |
| dsh-plugin/index.js | KNOWN_CHANNELS 加 'workbuddy'；CHANNEL_GROUPS 加 'ai-proxy-workbuddy': { channel: 'workbuddy', label: 'WorkBuddy' }；BLOCK_REASON.workbuddy；workbuddyStatus(settings)；面板 GET /workbuddy/status 与 POST /workbuddy/login；panelSnapshot 加 workbuddy |
| dsh-plugin/client.js | DICT 增中英词条；WorkBuddy 卡片（状态 / 登录按钮 / 打开登录页 / 刷新） |
| dsh-plugin/self-test.mjs | 断言新渠道进注册路由、分组只列自己的模型、状态字段形状 |
| README.md / dsh-plugin/README.md | 新渠道章节与路由表行 |
| .gitignore | 加 workbuddy-auth.json |
| AGENTS.md | 记录本轮新学到的判据（见 §4 末） |

### 3.3 凭据结构

    /** 落盘于 workbuddy-auth.json（与源码同目录，gitignored）。 */
    export interface WorkBuddyCredential {
      access_token: string;          // Bearer
      refresh_token: string;         // 续期用；缺失即不可续期
      expires_at?: number | string;  // 毫秒（> 1e12）否则秒；也可为 ISO 串
      refresh_expires_at?: number | string;
      token_type?: string;           // 缺省 'Bearer'
      scope?: string;
      domain?: string;               // 登录站点快照，仅作 X-Domain 兜底（实测确认步骤见 4.1）
      user_id?: string;
      nickname?: string;
      enterprise_id?: string;
      account_type?: string;         // 缺省 'personal'
    }

    export interface WorkBuddyModel {  // 归一化后的目录行
      id: string;
      name: string;
      contextWindow?: number;        // ← maxInputTokens
      maxOutputTokens?: number;      // ← 缺失即 undefined，不猜
      supportsImages?: boolean;
      reasoningEfforts?: string[];   // ← reasoning.supportedEfforts（非空才留）
      defaultReasoningEffort?: string;
      creditsRate?: string;          // 'x0.03'
      discountedCreditsRate?: string;// 促销价 'x0.17→x0.50' 里的后段
    }

### 3.4 登录流程（两步式）与修订记录

实现与 TRAE 同形：**一次性脚本 → 落盘 → 每请求读 → 到期自动续期 → 面板卡片**。
脚本流程见 §2.2；openBrowser 直接照抄参考实现 login.ts:116-140
（Windows 下 cmd /c start '""' "<url>" + windowsVerbatimArguments，
否则 URL 里的 & 会被当成命令分隔符，浏览器只收到 ?platform=…）。

**修订记录（本机实测推翻的假设）**

| 项 | 早期假设 | 实测结论 | 影响 |
|---|---|---|---|
| 中国版 host | 沿用参考实现：中国版 = copilot.tencent.com | **中国版 WorkBuddy 有独立域名 www.workbuddy.cn** | 第 1/2 章整体改道（§1.1、§2.7） |
| platform | 中国版可能不同 | 中国版就是 **workbuddy-ai**（与国际版同名） | 常量可复用；但仍须按站点下发值使用 |
| 未登录的 login/account | 返回 JSON 错误体 | **401 + openresty HTML**（APISIX 网关） | 解析器必须容忍非 JSON，不能直接 response.json() |
| refresh 失败判定 | message 含 expired/invalid | 空体返回 400 + code 10001；伪凭据 401 + code 12153 | 过期判定要**以 HTTP 401/403 为主**，message 匹配只能当补充 |
| auth/state 耗时 | 国际版实测 5.8–7.5s，5s 超时必失败 | 中国版本机 **2883 / 232 / 215 ms** | 仍保留 **10s** 超时（对慢网更稳），不必按 5.8s 设计 |
| /v3/config 的 200 | 200 = 目录可用 | 匿名与伪 Bearer 都 200，但 data.models 为 null | **必须校验数组非空**，否则渠道会以「0 个模型」上线 |
| 企业模型端点 | 主要来源 | 未登录 **400 + login-pf HTML** | 仅作可选增强，失败静默回退，不作主路径 |
| 模型目录来源 | 以为匿名可达 | 未登录时是 models: null | 目录**必须带 Bearer**；无凭据时渠道整体不可用 |
| 签到 | 参考项目结论「没有该接口」 | 服务端**路由存在**（401≠404），但中国版积分文档无签到活动 | 由「不实现」改判为「待实测」，v1 仍不出按钮（§2.6） |
| X-Product 头 | 发部署类型 SaaS | 它是**归属名** WorkBuddy | 发错则后台「使用端」列归因不到产品（显示 -） |
| 凭据的 domain | 优先用它作 X-Domain | 它是**登录时站点快照**，产品迁移后会过期 | X-Domain 以 www.workbuddy.cn 为准，凭据值仅兜底；但改道首轮要先核对（4 步 0） |
| 路由存在性 | 用状态码判断 | 只有 **401 vs 404** 可判（404 是 `{"error_msg":"404 Route Not Found"}`） | 探测脚本必须以对照路径为基准 |

### 3.5 关键决策

| 决策项 | 处理方案 | 依据 |
|--------|---------|------|
| 接入路径 | customHandler 走 workbuddy（**不走**泛型透传） | 需要 401→refresh→重试、流内 11140 检测、凭据来自文件而非环境变量、模型目录不是 OpenAI 形状 |
| SSE 转换 | **不做**，直接透传 upstreamResponse.body | 参考实现与实测均确认是标准 OpenAI SSE：delta.content / delta.reasoning_content / delta.tool_calls |
| 工具调用 id | 若自己组装帧，必须**按 index 缓存 id**（首个分片带真实 id，后续只有 index） | 否则同一工具的后续分片 id 为空，工具结果无法匹配 |
| 归因头族 | 五件套全发：X-Agent-Purpose: conversation / X-IDE-Name / X-IDE-Type / X-IDE-Version / X-Product | 后台「使用端」列按这组头归因，缺一显示 - |
| X-Domain | 'www.workbuddy.cn' 优先，然后 credential.domain，最后空串；用 `||` 不用 `??` | 凭据字段缺失时读出来是**空串**，`??` 不生效会发出空域名 |
| User-Agent | 中国版只有一条产品线 ⇒ **单一 UA**：`WorkBuddy/<ver> WorkBuddy/<ver> CLI/<ver>` | 参考实现里 `userAgentByModelFamily` 是给**国际版**用的（按模型族分档）；中国版未配置分档表（`[]`），且中国版池内全是国内系模型 |
| 客户端版本 `<ver>` | 取中国版最新发布版 **5.6.2**（2026-09-21） | 官方更新日志；参考实现里的 5.5.2 是**国际版**桌面版本号 |
| 登录 URL 装饰 | 追加 `version` 与 `loginSessionId`（照参考实现的 appendSessionParams） | ⚠️ 这是从国际版**带过来**的行为，中国版未验证；只追加参数、失败原样返回，风险可控（附录 B-1） |
| 模型目录缓存 | 模块级 {models, at, loading}，TTL 300s，loading 共享 Promise，空结果**保留上一份** | 与 traeCatalog 同形；一次坏读不能让渠道消失 |
| 目录失败语义 | data.models 非数组或为空 → 回退**静态兜底表**，并 catalog.failed(reason) | 面板要能看到原因，而不是「0 个模型」 |
| maxOutputTokens | 只在远端下发正数时才发 max_tokens；否则用兜底表的实测值；两者都没有就**不发该字段** | 参考实现明写「远端未下发不臆造」；臆造会被上游拒 |
| reasoning | supportedEfforts 非空才下发 reasoning: {efforts, defaultEffort}；为空则**整个字段省略** | harness 唯一拒绝的形状是空 efforts 数组（INVALID_MODEL_REASONING） |
| reasoning_effort | 只发模型声明过的档位；调用方没给则补 defaultEffort（其次 high，再其次首档） | 无档位的模型收到任意档位会 400 |
| prompt_cache_key | 不额外处理：插件已在请求头带 prompt_cache_key / session_id，上游若不需要则忽略 | 插件 index.js:1863-1868 已发；此处不重复 |
| 流内 11140 | 仅当 data.choices 为 undefined **且** body 命中正则 `"code"\s*:\s*11140` 才判拦截 | 正文里出现「安全审核」「request illegal」乃至字面 11140 都是常态，判宽会误杀正常回答 |
| 拦截后的重试 | 首版**不做账号池换号**（本仓库无账号池），只把错误如实上报 | 换号需要多凭据仓储，超出本次范围；先保证「能说清失败原因」 |
| 签到 / 积分 | v1 不实现按钮；先探状态再决定（§2.6） | 路由存在 ≠ 账号有活动；点出 404 比没有按钮更糟 |
| 凭据落盘 | workbuddy-auth.json 与源码同目录，每请求解析一次；加进 .gitignore | 与 trae-auth.json 同一先例（重启后无需重跑脚本） |

---

## 4. 实现步骤

按**先探端点、再协议、再接入、后 UI**的顺序，每步都可独立验证：

0. **端点确认（改道后的第一件事，成本极低、收益极高）**
   先只做登录脚本的最小闭环：拿到真凭据后，用**同一个 token** 分别打
   `https://www.workbuddy.cn/v3/config` 与 `https://copilot.tencent.com/v3/config`，
   看哪边返回非空 `data.models`；并打印 `credential.domain`。
   - 若 workbuddy.cn 返回模型 ⇒ 常量按下表定稿；
   - 若只有 copilot.tencent.com 返回，或 `domain` 不是 www.workbuddy.cn
     ⇒ **先纠正 §3.5 的 host/X-Domain 再继续**，本方案其余部分不受影响。
   **验收**：把两次请求的状态码、模型条数、`credential.domain` 记进本文档。

1. **src/workbuddy.ts（纯函数层）**
   常量（host / 路径 / UA / 码值）、类型、parseTokenData、parseAccountData、
   buildCredential、credentialExpiresAtMs、jwtExpiresAtMs、isExpired、isRefreshable、
   parseModelsFromConfig、parsePromotions、resolveUserAgent、attributionHeaders、
   isContentRejection、静态兜底表。
   **验收**：src/workbuddy.test.ts 全绿，且每条断言都做过变异验证（变异后必须变红）。

2. **.tmp-workbuddy-login.ts（登录脚本）**
   fetchAuthState → decorateLoginUrl → openBrowser → loopGetToken → getAccount → 落盘。
   **验收**：本机跑通到「浏览器登录完成后写出 workbuddy-auth.json」；
   期间断网/关窗要给出明确文案，而不是静默挂死。

3. **src/workbuddy-account.ts（凭据与续期）**
   readWorkBuddyCredential（读不到 → undefined，不抛）、writeWorkBuddyCredential、
   needsWorkBuddyRefresh（到期前 24h）、refreshWorkBuddyToken、refreshWorkBuddyIfNeeded、
   fetchWorkBuddyModels（三层回退 + 并集合并）。
   **验收**：拿**真凭据**拉到真实目录；再用失效凭据验证「401 → refresh → 失败 → 明确报错」这条链；
   并集合并要用「只在其中一层出现的 id」做变异验证。

4. **src/core.ts + main.ts（接入）**
   provider 条目、WORKBUDDY_ROOT、handleWorkBuddy（GET /workbuddy/v1/models、
   POST /workbuddy/v1/chat/completions、GET /workbuddy/v1/account）、自定义分发、
   V1_AGGREGATE_MEMBERS、hasChannelCredential 的凭据文件分支、
   v1FetchMemberModels 分支、/health/probe 的 channelPrefixes。
   **验收（必须真实上游，不接受 fixture）**：
   - GET /v1/models 渠道数 6 → 7，byOwner.workbuddy = 真实条数；
   - POST /workbuddy/v1/chat/completions 流式往返，带**工具调用**的一轮也要跑通；
   - 面板 /health/probe?provider=workbuddy 返回真状态。

5. **dsh-plugin/index.js（插件）**
   KNOWN_CHANNELS / CHANNEL_GROUPS / BLOCK_REASON / workbuddyStatus /
   面板 GET /workbuddy/status + POST /workbuddy/login / panelSnapshot.workbuddy。
   **验收**：node --check、node dsh-plugin/self-test.mjs、
   node --test dsh-plugin/stats.test.mjs 全绿；分组断言覆盖新渠道。

6. **dsh-plugin/client.js（面板 UI）**
   词条 + WorkBuddy 卡片（未登录时给「登录」按钮，点击后开登录页并轮询；
   已登录显示昵称/到期时间；失败显示可操作的原因）。
   **验收**：面板真机点一遍，登录 → 列表出现 → 发一轮 → 刷新状态。

7. **文档与提交**
   README.md 路由表 + 渠道章节、dsh-plugin/README.md 的 Provider 覆盖范围、
   .gitignore 加 workbuddy-auth.json、AGENTS.md 追加判据、
   跑齐 CI（deno task check / deno task test / deno fmt --check 受影响文件 / 插件三连），
   然后 commit + push，并**同步桌面 profile 副本**（物理复制 index.js / client.js / self-test.mjs，
   在副本目录再跑一次 self-test）。

**AGENTS.md 要记的新判据（本轮实测得来）**

- 网关 401 的响应体可以是 **openresty HTML**，任何 await response.json() 都要先看 content-type 或 try/catch；
- 业务「OK」不等于「有数据」：/v3/config 用伪 Bearer 也是 200 + models: null，
  目录可用性判据必须是**数组非空**，不是状态码；
- **判断网关路由是否存在，唯一的可靠信号是 401 与 404 的对照**（404 形如
  `{"error_msg":"404 Route Not Found"}`）；401 代表路由存在仅缺鉴权 —— 这条推翻了
  「国际版没有签到接口」的旧结论（那是客户端内核串，不是服务端路由）；
- 过期判定的主依据是 **HTTP 401/403**，不是 message 文本（实测 message 是 token format error，不含 expired/invalid）；
- 归因头 X-Product 是**产品归属名**，发部署类型 SaaS 会让后台把用量记到 -；
- **同名产品可以分区域各有一个 host**：WorkBuddy 中国版 www.workbuddy.cn 与国际版
  www.workbuddy.ai 路径与响应同形、platform 同名（workbuddy-ai），差异只在 host 与模型池；
  「参考实现里 WorkBuddy = 国际版」不能推出「中国版 = copilot.tencent.com」；
- 客户端 bundle 里的**服务端不校验字段**（auth/state 的 platform 是纯回显）不能作为常量取值依据，
  取值只能来自客户端配置或官方产物。

---

## 附录 A：静态兜底模型表（**待真凭据实测重建**）

初稿这张表是国际版的 23 条，**中国版不适用**。中国版模型池以官方文档为据（§2.7 第 7 条），
但**文档只给展示名、不给 id**，因此 v1 的兜底表**必须在步骤 0 拿到真凭据后**由
`/v3/config` + `/console/enterprises/personal/models` 的实测结果生成，**不得照抄国际版表**。

文档可证的中国版内置模型（顺序按文档表格，**仅作字段形状示意，id 一栏留空待实测**）：

| 展示名（文档） | 文档标注能力 | id（待实测） | contextWindow | maxOutputTokens |
|---|---|---|---|---|
| Hy4 preview | 图片输入 / 思考模式 | 待实测 | 待实测 | 待实测 |
| Hy3 | 图片输入 / 思考模式 | 待实测 | 待实测 | 待实测 |
| GLM-5.3 | 图片输入 / 思考模式 | 待实测 | 待实测 | 待实测 |
| GLM-5.3-Flash | 思考模式 | 待实测 | 待实测 | 待实测 |
| GLM-5.2 | 图片输入 / 思考模式 | 待实测 | 待实测 | 待实测 |
| GLM-5.1 | 推理模型 | 待实测 | 待实测 | 待实测 |
| GLM-5v-Turbo | 图片输入 / 推理模型 | 待实测 | 待实测 | 待实测 |
| MiniMax-M3 | 图片输入 / 推理模型 | 待实测 | 待实测 | 待实测 |
| MiniMax-m2.7 | 图片输入 / 推理模型 | 待实测 | 待实测 | 待实测 |
| Kimi-K3 | 图片输入 / 推理模型 | 待实测 | 待实测 | 待实测 |
| Kimi-K2.7-Code | 图片输入 / 推理模型 | 待实测 | 待实测 | 待实测 |
| Kimi-K2.6 | 图片输入 / 推理模型 | 待实测 | 待实测 | 待实测 |
| Deepseek-V4-Flash | 思考模式 | 待实测 | 待实测 | 待实测 |
| Deepseek-V4-Pro | 思考模式 | 待实测 | 待实测 | 待实测 |

- 模式别名（快捷/均衡/极致三档）与 auto 的 **id 未定**，同样待实测；
  切换模型族时**不得**拿国际版的 `default-model`/`fast-model`/`balanced-model`/
  `primary-model`/`deep-model` 当中国版的别名。
- **远端未下发的字段保持 undefined，不臆造**（这条纪律不因改道而变）。

---

## 附录 B：待确认事项

1. **中国版登录 URL 是否要追加 `version` + `loginSessionId`**
   （`appendSessionParams = true`）——这是从国际版带过来的行为，中国版没有实证。
   处理：照做，但参数只追加不重建，且 `version` 取中国版版本号；失败原样返回。
   若步骤 0 发现登录页拒收该参数，去掉即可（一行开关）。
2. **中国版的实际 host**：本方案定为 www.workbuddy.cn（依据见 §1.1），但「中国版桌面客户端的
   product.json endpoint」未直接取证。步骤 0 用真凭据在两个 host 上各打一次 /v3/config 即可判定，
   这是**唯一的阻塞性未知**，且成本极低。
3. **签到活动是否对中国版账号开放**：路由存在但文档未提，待真凭据探
   `checkin-activity-status` 的 `active` 字段（§2.6）。
4. **用户是否已有 WorkBuddy 账号**：用户已答「我有workbuddy账号」（中国版），
   步骤 0 起需要本人在浏览器里完成一次登录。
