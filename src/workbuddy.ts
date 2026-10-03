/**
 * WorkBuddy（中国版）协议常量与**纯函数**层：端点、产品身份、凭据结构、
 * 目录解析、促销解析、请求头、请求体组装。
 *
 * 本文件**不碰网络也不碰文件** —— 网络流程在 src/workbuddy-account.ts。
 * 判据：能直接写单测的那种纯度。
 *
 * 协议与实测结论取自 dsh-codearts-auth（MIT）的 src/buddy.ts / product.ts /
 * buddy-adapter.ts，按其注释里的实测证据实现。凡与那份实现不一致处都在
 * 注释里标明理由 ——「与参考实现不同」本身就是需要解释的结论。
 *
 * ## 一、为什么是中国版而不是国际版
 *
 * 参考实现里 WorkBuddy 只有国际版（www.workbuddy.ai，platform workbuddy-ai，
 * 模型池是 claude/gpt/gemini 系）。中国版是**另一个站点** www.workbuddy.cn：
 * 路径与响应解析逐字段同形，差异在域名、模型池与 UA 归因。判据五条见
 * docs/workbuddy-integration-plan.md §1.1。
 *
 * 由此有三条**不能照抄**的地方：
 *
 * 1. 国际版按模型族分档的 UA（gpt-/gemini-/claude- 用国际形态、glm-/hy/kimi-/
 *    minimax- 用中国形态）**只服务国际版**。中国版客户端产物里那张表是空的，
 *    池内全是国内系 —— 套过来只会把后台归因打歪。所以只有单一 UA。
 * 2. 版本号取中国版文档站 Changelog 的最新发布版 **5.6.2（2026-09-21）**，
 *    不是参考实现里的 5.5.2（那是国际版桌面端）。
 * 3. 静态兜底模型表**刻意留空**（见 STATIC_FALLBACK_MODELS）：参考实现那 23 条
 *    是国际版的，中国版官方文档只给展示名不给 id。拿国际版别名、或按展示名猜
 *    id 顶替，等于把用户送进「选得到、调不通」的模型。
 *
 * ## 二、为什么不翻译 SSE
 *
 * 与 TRAE 相反：WorkBuddy 的请求体是标准 OpenAI，SSE 也是标准
 * chat.completion.chunk。所以本模块**一个字节的帧转换都不做**，只做三件事：
 * 凭据（含 401 后静默续期）、目录解析、以及流内 11140 的窄判定。
 */

// ---------- 产品身份 ----------

/** 中国版站点（含协议，用于拼请求 URL）。 */
export const WORKBUDDY_ENDPOINT = "https://www.workbuddy.cn";

/**
 * X-Domain 用的**裸域名**（不含协议）。
 *
 * 与 WORKBUDDY_ENDPOINT 刻意分开：endpoint 含协议、X-Domain 不含，混用会把
 * 「https://https://…」发出去。这是参考实现 product.ts 把 endpoint 与 apiDomain
 * 拆成两个字段的原因，不是冗余。
 */
export const WORKBUDDY_API_DOMAIN = "www.workbuddy.cn";

/**
 * platform 查询参数。
 *
 * ⚠️ 服务端**不校验**它：实测传一个编造的字符串也返回 200，并把该串原样回显
 * 在 authUrl 里。所以它不能靠探测得到，只能取自客户端产物 —— 中国版登录站点
 * bundle 的平台枚举里 workbuddy-ai 是白名单成员。这类「服务端原样回显」的字段
 * 一律不能拿探测结果当常量来源。
 */
export const WORKBUDDY_PLATFORM = "workbuddy-ai";

/** X-Product-Code（随产品变化：WorkBuddy 与 CodeBuddy 不同）。 */
export const WORKBUDDY_PRODUCT_CODE = "workbuddy";

/**
 * 部署类型。
 *
 * ⚠️ 参考实现里 X-Product 在**两处含义不同**：目录请求（buddy-oauth.ts）发这个
 * 部署类型值，聊天请求（buddy-adapter.ts）发归属名。后者才是被实测证明能归因
 * 到的那个 —— 早期发成 SaaS 时后台「使用端」一列全是「-」。两处都照抄，但
 * 必须分开命名，否则「X-Product 是啥」在这份代码里就没有唯一答案。
 */
export const WORKBUDDY_DEPLOYMENT_TYPE = "SaaS";

/**
 * 用量归属名：X-IDE-Name / X-IDE-Type / X-Product **三头共用同一个值**。
 *
 * 缺任一个头，后台按这组头归因的「使用端」列就显示成「-」（参考实现的实测记录）。
 */
export const WORKBUDDY_ATTRIBUTION_NAME = "WorkBuddy";

/** 客户端版本号（X-IDE-Version 与 UA 里的版本段）。 */
export const WORKBUDDY_CLIENT_VERSION = "5.6.2";
/** CLI 版本号（UA 的第三段）。 */
export const WORKBUDDY_CLI_VERSION = "5.6.2";

/**
 * User-Agent。
 *
 * 品牌词决定后台「使用端」归因，必须含 WorkBuddy。形态取参考实现的**国内版**
 * 形态（WorkBuddy/x WorkBuddy/x CLI/x）—— 注意没有国际版中间那个 AI 段。
 */
export const WORKBUDDY_USER_AGENT = "WorkBuddy/" + WORKBUDDY_CLIENT_VERSION +
  " WorkBuddy/" + WORKBUDDY_CLIENT_VERSION +
  " CLI/" + WORKBUDDY_CLI_VERSION;

// ---------- 端点 ----------

/** 取登录态：POST /v2/plugin/auth/state?platform=workbuddy-ai。 */
export const AUTH_STATE_PATH = "/v2/plugin/auth/state";
/** 轮换取令牌：GET /v2/plugin/auth/token?state=…。 */
export const AUTH_TOKEN_PATH = "/v2/plugin/auth/token";
/** 取账号信息：GET /v2/plugin/login/account?state=…。 */
export const LOGIN_ACCOUNT_PATH = "/v2/plugin/login/account";
/** 静默续期：POST /v2/plugin/auth/token/refresh。 */
export const AUTH_REFRESH_PATH = "/v2/plugin/auth/token/refresh";
/** 账号列表：GET /v2/plugin/accounts。 */
export const ACCOUNTS_PATH = "/v2/plugin/accounts";
/** 云端配置（模型目录 + 促销）：GET /v3/config。 */
export const CONFIG_PATH = "/v3/config";
/** 聊天：POST /v2/chat/completions。 */
export const CHAT_COMPLETIONS_PATH = "/v2/chat/completions";
/** 个人（企业）模型端点的 scope 段：个人账号用**字面量** personal。 */
export const ENTERPRISE_MODELS_SCOPE = "personal";
/** 个人模型端点。 */
export const SCOPED_MODELS_PATH = "/console/enterprises/" +
  ENTERPRISE_MODELS_SCOPE + "/models";

// ---------- 时序 ----------

/** 登录轮询总时限。 */
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
/** 轮询间隔。 */
export const POLL_INTERVAL_MS = 1000;
/**
 * auth/state 的超时。
 *
 * ⚠️ **不能**用通用的 5s：参考实现实测 www.workbuddy.* 建连稳定耗 5860–7525ms，
 * 5s 必然超时，症状是「无法获取登录地址」。放宽到 10s 只影响失败时多等几秒。
 */
export const STATE_REQUEST_TIMEOUT_MS = 10_000;
/** 其余控制面请求（token/account/refresh/config/chat）的超时。 */
export const REQUEST_TIMEOUT_MS = 60_000;
/** X-Auth-Refresh-Source 的取值。 */
export const AUTH_REFRESH_SOURCE = "ide-main";

// ---------- 业务码 ----------

export const CODE_OK = 0;
/** 令牌尚未就绪 → 继续轮询。 */
export const CODE_TOKEN_NOT_READY = 11217;
/** 账号信息尚未就绪 → 继续轮询。 */
export const CODE_ACCOUNT_NOT_READY = 12151;
/** 参数错误 / 幂等（如 refresh 空体、当日签到已领）。 */
export const CODE_ALREADY_CLAIMED = 10001;
/** 续期失败。 */
export const CODE_REFRESH_FAILED = 12153;
/** 安全策略拦截（可能以 HTTP 403，也可能以 HTTP 200 的流内帧出现）。 */
export const CODE_CONTENT_REJECTED = 11140;

// ---------- 请求头名 ----------

export const HTTP_HEADER_DOMAIN = "X-Domain";
export const HTTP_HEADER_ENTERPRISE_ID = "X-Enterprise-Id";
export const HTTP_HEADER_TENANT_ID = "X-Tenant-Id";
export const HTTP_HEADER_NO_AUTHORIZATION = "X-No-Authorization";
export const HTTP_HEADER_NO_USER_ID = "X-No-User-Id";
export const HTTP_HEADER_NO_ENTERPRISE_ID = "X-No-Enterprise-Id";
export const HTTP_HEADER_NO_DEPARTMENT_INFO = "X-No-Department-Info";
export const HTTP_HEADER_REFRESH_TOKEN = "X-Refresh-Token";
export const HTTP_HEADER_AUTH_REFRESH_SOURCE = "X-Auth-Refresh-Source";
export const HTTP_HEADER_PRODUCT = "X-Product";
export const HTTP_HEADER_PRODUCT_CODE = "X-Product-Code";
/** 用量归因用途。 */
export const HTTP_HEADER_AGENT_PURPOSE = "X-Agent-Purpose";
export const HTTP_HEADER_IDE_NAME = "X-IDE-Name";
export const HTTP_HEADER_IDE_TYPE = "X-IDE-Type";
export const HTTP_HEADER_IDE_VERSION = "X-IDE-Version";

// ---------- 类型 ----------

/** 落盘的凭据。字段名与 TRAE 那份同形，便于面板与 .gitignore 统一处理。 */
export interface WorkBuddyCredential {
  access_token: string;
  refresh_token: string;
  /**
   * 过期时刻。**归一化成毫秒时间戳字符串**；解析不了就退到 access_token 的
   * JWT exp。历史文件里可能是 ISO 字符串或秒级数字，读的时候都认。
   */
  expires_at: string;
  refresh_expires_at?: string;
  token_type?: string;
  /**
   * 授权范围。**实测是多行文本**（如 profile / offline_access / email 各占一
   * 行），读写都必须清洗控制字符 —— 见 stripControlChars。
   */
  scope?: string;
  /** 登录时服务端下发的域名快照。**字段缺失时是空串**（不是 undefined）。 */
  domain?: string;
  user_id?: string;
  nickname?: string;
  enterprise_id?: string;
  account_type?: string;
}

/** auth/token 的解析结果。 */
export interface WorkBuddyToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  refreshExpiresAt: string;
  tokenType: string;
  scope: string;
  domain: string;
}

/** login/account 的解析结果。 */
export interface WorkBuddyAccount {
  uid: string;
  nickname: string;
  enterpriseId: string;
  accountType: string;
}

/**
 * 一个可用对话模型。
 *
 * ⚠️ maxOutputTokens 是**必须消费**的权威字段：只拿它做过滤而不把它下发到请求
 * 体，所有模型都会退化到网关默认上限（实测仅 32000），大段输出被截断成
 * finish_reason:length，用户侧只看到「已达到输出 token 上限」。缺失就保持
 * undefined，不猜默认值 —— 猜偏大被服务端 400 拒，猜偏小无谓截断。
 */
export interface WorkBuddyModel {
  id: string;
  name: string;
  /** 上下文窗口（远端 maxInputTokens）。 */
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsImages?: boolean;
  /** 可枚举的思考等级；只有单一默认档的模型不出现这个字段。 */
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  /** 计费倍率，形如 x0.29。**存字符串**：上游出现过 x 在前与 x 在后两种形态。 */
  creditsRate?: string;
  /** 此刻生效的促销价（x0.50 或「免费」）。 */
  discountedCreditsRate?: string;
  /** 被 agent 或试用横幅引用 ⇒ 服务端声明它可选。 */
  agentReferenced?: boolean;
}

/**
 * 静态兜底目录。
 *
 * **刻意为空**，见文件头第三条。目录拉不到时调用方应如实报错（catalog.failed），
 * 而不是给出一份来源不明、调不通的模型清单。真实 id 要等 §4 步骤 0 用真凭据
 * 拉过 /v3/config 与个人模型端点之后再补。
 */
export const STATIC_FALLBACK_MODELS: readonly WorkBuddyModel[] = [];

// ---------- 基础读值 ----------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 去掉控制字符（含 CR/LF/Tab），并把连续空白折叠为单个空格。
 *
 * ⚠️ 不是洁癖：`scope` 实测是多行文本（profile / offline_access / email 各占一
 * 行）。带换行落盘后，按行解析的读取方式（YAML 多行标量等）会把结构读坏，而症状
 * 却是「有效期/昵称字段丢失」—— 离病因很远，很难往回推。
 */
export function stripControlChars(value: string): string {
  return value
    // deno-lint-ignore no-control-regex -- 这里就是要匹配控制字符本身
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** 从 JSON 读字符串字段：number 也接受（后端把 uid 之类的 id 返成数字的情况）。 */
export function readStringField(
  data: Record<string, unknown>,
  key: string,
): string {
  const value = data[key];
  if (typeof value === "string") return stripControlChars(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/** 从 JSON 读数值字段（兼容后端返回的数字型字符串）。 */
export function readNumberField(
  data: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = data[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    return Number(value);
  }
  return undefined;
}

// ---------- JWT ----------

/**
 * 解 JWT 的 payload 段。
 *
 * 用 atob 而不是 Buffer：Buffer 是 Node 的全局，Deno **不提供**。这份代码跑在
 * Deno 上，而 JWT 兜底只在真登录/过期判定里才触发 —— 正是最不该到运行期才炸的
 * 那条路径，测试里也最容易漏掉。
 */
function decodeJwtPayload(token: unknown): Record<string, unknown> | undefined {
  if (typeof token !== "string" || token.length === 0) return undefined;
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** 读 JWT 的 exp / iat（秒 → 毫秒）。字段缺失或非数值返回 undefined。 */
export function jwtClaimMs(
  token: unknown,
  claim: "exp" | "iat",
): number | undefined {
  const value = decodeJwtPayload(token)?.[claim];
  return typeof value === "number" && Number.isFinite(value)
    ? value * 1000
    : undefined;
}

/** JWT 里的昵称（nickname → preferred_username → name）。 */
export function jwtNickname(token: unknown): string {
  const payload = decodeJwtPayload(token);
  if (payload === undefined) return "";
  for (const key of ["nickname", "preferred_username", "name"]) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) {
      return stripControlChars(value);
    }
  }
  return "";
}

/** JWT 里的 subject（uid 兜底）。 */
export function jwtSubject(token: unknown): string {
  const sub = decodeJwtPayload(token)?.sub;
  return typeof sub === "string" ? stripControlChars(sub) : "";
}

// ---------- 过期判定 ----------

/**
 * 凭据的过期时刻（毫秒）。
 *
 * 接受三种历史写法：纯数字（>1e12 视为毫秒，否则秒）、ISO 字符串、以及
 * 都解析不了的垃圾。三种都失败时退到 access_token 的 JWT exp —— 那是权威值。
 */
export function credentialExpiresAtMs(
  credential: WorkBuddyCredential,
): number | undefined {
  const raw = typeof credential.expires_at === "string"
    ? credential.expires_at.trim()
    : "";
  if (raw.length > 0) {
    if (/^\d+$/.test(raw)) {
      const asNumber = Number(raw);
      if (Number.isFinite(asNumber)) {
        return asNumber > 1e12 ? asNumber : asNumber * 1000;
      }
    } else {
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return jwtClaimMs(credential.access_token, "exp");
}

/**
 * 是否已过期。
 *
 * ⚠️ 解析不出过期时刻时返回 **false**（不判过期）：宁可多发一次请求让上游用 401
 * 告诉我们，也不要凭「不知道」把还有效的凭据拦在门外。反过来判断会把「刚登录
 * 成功、expires_at 归一化失败」的账号永久锁死在「请重新登录」。
 */
export function isWorkBuddyExpired(
  credential: WorkBuddyCredential,
  nowMs: number = Date.now(),
): boolean {
  const expiresAt = credentialExpiresAtMs(credential);
  return expiresAt === undefined ? false : nowMs >= expiresAt;
}

/** 能不能静默续期。 */
export function isWorkBuddyRefreshable(
  credential: WorkBuddyCredential,
): boolean {
  return typeof credential.refresh_token === "string" &&
    credential.refresh_token.length > 0;
}

/**
 * 把「绝对时间字段」或「相对秒数」归一化成毫秒时间戳字符串。
 *
 * ⚠️ 实测 `/v2/plugin/auth/token` **只**返回 expiresIn / refreshExpiresIn（相对
 * 秒数），没有 expiresAt。不换算的话凭据 expires_at 会一直是空串：面板显示
 * 「有效期未知」，且每次请求都要先吃一发 401 才知道该不该续期。
 */
function absoluteExpiryMs(
  record: Record<string, unknown>,
  absoluteKey: string,
  relativeKey: string,
  accessToken: string,
): string {
  const absolute = readStringField(record, absoluteKey);
  if (absolute.length > 0) {
    const asNumber = /^\d+$/.test(absolute)
      ? Number(absolute)
      : Date.parse(absolute);
    if (Number.isFinite(asNumber)) {
      return String(asNumber > 1e12 ? asNumber : asNumber * 1000);
    }
    // 不是可解析的时间：原样保留，别把垃圾抹成空串（抹了会丢掉线索）。
    return absolute;
  }
  const relativeSeconds = readNumberField(record, relativeKey);
  if (relativeSeconds === undefined) return "";
  // 基准：access_token 的签发时刻（iat）优先，缺失时用当前时刻。
  const baseMs = jwtClaimMs(accessToken, "iat") ?? Date.now();
  return String(baseMs + relativeSeconds * 1000);
}

// ---------- 登录响应解析 ----------

/** 解析 `/v2/plugin/auth/token` 的响应体。 */
export function parseTokenData(data: unknown): WorkBuddyToken {
  const record = isRecord(data) ? data : {};
  const accessToken = readStringField(record, "accessToken");
  const tokenType = readStringField(record, "tokenType");
  return {
    accessToken,
    refreshToken: readStringField(record, "refreshToken"),
    expiresAt: absoluteExpiryMs(record, "expiresAt", "expiresIn", accessToken),
    refreshExpiresAt: absoluteExpiryMs(
      record,
      "refreshExpiresAt",
      "refreshExpiresIn",
      accessToken,
    ),
    tokenType: tokenType.length > 0 ? tokenType : "Bearer",
    scope: readStringField(record, "scope"),
    domain: readStringField(record, "domain"),
  };
}

/** 解析 `/v2/plugin/login/account` 的响应体。 */
export function parseAccountData(data: unknown): WorkBuddyAccount {
  const record = isRecord(data) ? data : {};
  const type = readStringField(record, "type");
  return {
    uid: readStringField(record, "uid"),
    nickname: readStringField(record, "nickname"),
    enterpriseId: readStringField(record, "enterpriseId"),
    accountType: type.length > 0 ? type : "personal",
  };
}

/** 合成落盘凭据（账号信息缺失的字段逐级回退到 JWT）。 */
export function buildCredential(
  token: WorkBuddyToken,
  account: WorkBuddyAccount,
): WorkBuddyCredential {
  return {
    access_token: token.accessToken,
    refresh_token: token.refreshToken,
    expires_at: token.expiresAt,
    refresh_expires_at: token.refreshExpiresAt,
    token_type: token.tokenType,
    scope: token.scope,
    domain: token.domain,
    user_id: account.uid.length > 0
      ? account.uid
      : jwtSubject(token.accessToken),
    nickname: account.nickname.length > 0
      ? account.nickname
      : jwtNickname(token.accessToken),
    enterprise_id: account.enterpriseId,
    account_type: account.accountType,
  };
}

// ---------- 模型 id 过滤 ----------

/**
 * 自动选择别名 —— 服务端自己挑一个后端，不是真实模型。
 *
 * ⚠️ 只按这两个**字面量**过滤，绝不做前缀匹配：`default-model` / `fast-model`
 * 这类抽象别名**被 craft agent 引用**、是官方推荐的输入框入口（用户在官方 UI
 * 里选得到），前缀匹配会把它们和 `default` 一起误杀。
 */
export function isAutoSelectAlias(id: string): boolean {
  return id === "auto" || id === "default";
}

/**
 * 这个 id 是不是可对话模型（排除补全 / 内部专用线 / 出图）。
 *
 * 四条判据各挡一类，都是实测得来的：
 * - `nes-` / `completion-` / `codewise-` 前缀：补全与内部专用线。其中
 *   `codewise-default-model-v2` 实测**调不通**（后端回 `code 11102 model service
 *   info not found`，即后端未开放），列进选择器等于给用户一个必然报错的选项。
 * - `supportsExtra === true`：能带额外工具的内部变体。
 * - `maxOutputTokens` 落在 (0, 256]：补全模型的特征（对话模型实测普遍 ≥24000，
 *   256 是留了余量的经验阈值）。
 * - `tags` 含 `text-to-image`：出图模型（如 hunyuan-image-alpha）。
 */
export function isChatModel(
  id: string,
  meta: Record<string, unknown> | undefined,
): boolean {
  if (id.startsWith("nes-")) return false;
  if (id.startsWith("completion-")) return false;
  if (id.startsWith("codewise-")) return false;
  if (meta !== undefined && meta.supportsExtra === true) return false;
  const maxOutput = readNumberField(meta ?? {}, "maxOutputTokens");
  if (maxOutput !== undefined && maxOutput > 0 && maxOutput <= 256) {
    return false;
  }
  const tags = meta?.tags;
  if (Array.isArray(tags) && tags.some((tag) => tag === "text-to-image")) {
    return false;
  }
  return true;
}

// ---------- 可调性探测（目录里判不出来的那个事实） ----------

/**
 * 「这个模型 id 服务端到底认不认」的判定结果。
 *
 * ⚠️ 为什么要专门去问服务端：目录元数据里**没有任何字段能区分可调与不可调**。
 * 逐字段对照过（中国版实测 47 个 id / 34 可调 / 13 不可调）：缺失 `relatedModels.`
 * `builtin-lite`、有没有 iconUrl、是否落在两个端点的交集里 —— 三种猜测都会同时
 * 误杀活模型和漏放死模型。所以唯一的事实来源是服务端自己的路由表。
 */
export type WorkBuddyVerdict = "live" | "dead" | "unknown";

/**
 * 后端「没有这个模型的服务」的业务码。
 *
 * 实测（带齐全部归属头）：
 * - `11102 model [X] service info not found` —— 路由表里没这个 id；
 * - `11103 Backend [X] is not supported` —— 有 id 但后端被下线（实测
 *   hunyuan-image-alpha-edit 回的是这条，不是 11102）。
 *
 * ⚠️ 这两个码与请求体无关：加不加 `reasoning:{effort}`、换不换 max_tokens，
 * 返回都一样。反过来 `11101`（反序列化失败）、`11133`（上游供应商拒收参数）
 * 都发生在路由解析**之后**，与这个模型能不能调无关 —— 判据必须窄。
 */
export const WORKBUDDY_MODEL_UNAVAILABLE_CODES = new Set([11102, 11103]);

/**
 * 把一次探测响应判成可调性结论。
 *
 * - `dead`：明确命中「服务端没有这个模型」那两个码；
 * - `live`：请求进了路由（哪怕随后被上游以参数不合法拒绝）—— 因为 11133/
 *   10000/11151/14003 这些码只在**路由解析成功之后**才可能出现；
 * - `unknown`：网络错、401/5xx、解析不出报文 —— **一律不算 dead**。把未知当死
 *   会让一次网络抖动把整个选择器清空。
 */
export function classifyModelProbe(body: unknown): WorkBuddyVerdict {
  if (!isRecord(body)) return "unknown";
  const code = readNumberField(body, "code");
  if (code !== undefined && WORKBUDDY_MODEL_UNAVAILABLE_CODES.has(code)) {
    return "dead";
  }
  return "live";
}

/**
 * 按可调性结论筛掉「服务端明确没有这个模型」的条目。
 *
 * ⚠️ **只丢 `dead`，`unknown` 一律留下**：unknown 的来源是网络抖动 / 401 / 5xx，
 * 与「这个模型不存在」毫无关系。若把未知当死，一次上游故障就会让用户的选择器
 * 在几秒内被清空 —— 而那批模型其实全都好着。判据宁可漏杀不可错杀。
 */
export function dropUnavailableModels<T extends { id: string }>(
  models: readonly T[],
  verdicts: ReadonlyMap<string, WorkBuddyVerdict>,
): T[] {
  if (verdicts.size === 0) return [...models];
  return models.filter((model) => verdicts.get(model.id) !== "dead");
}

/**
 * 探测请求体：**故意发一个空 messages**。
 *
 * 这是全篇最反直觉的一处设计，代价与收益都实测过：
 * - 空 messages 时服务端仍会**先做路由解析**，再把空参数丢给上游供应商拒绝，
 *   于是回 `11133`（活）；
 * - 死模型卡在路由那一步，回 `11102`（死）。
 * 两者恰好可区分，且没有一次 token 生成。
 *
 * 对照：body 里带一条真消息（`max_tokens:1`）同样 0 误判，但每个模型要等
 * 1~4 秒真推理，整轮 47 个模型 70 秒起，还得消耗额度并污染会话计数。
 * 空 messages 整轮并发 6 跑完 5.7 秒。
 *
 * ⚠️ `stream` 必须为 true：`stream:false` 会被网关在**任何模型检查之前**直接
 * 以 `11101 Non-stream chat request is currently not supported` 拒掉，那样连
 * 死模型都测不出来（实测 47 个全部误判为活）。
 */
export function buildModelProbeBody(model: string): Record<string, unknown> {
  return { model, stream: true, messages: [] };
}

// ---------- 倍率归一化 ----------

/**
 * 倍率文本的共用解析：先试 x 前缀写法，再试 x 后缀写法，统一输出 `x<数字>`。
 *
 * 两种写法都接受（而不是由调用方指定唯一形态）：实测已经出现过同一后端两套
 * 写法共存的情形，若哪天互换，本函数仍然正确。
 */
function normalizeRate(
  value: unknown,
  prefixed: RegExp,
  suffixed: RegExp,
): string | undefined {
  if (typeof value !== "string") return undefined;
  // 丢掉可能存在的单位后缀（实测 "x0.03 credits"）。
  const head = value.trim().split(/\s+/)[0] ?? "";
  const match = prefixed.exec(head) ?? suffixed.exec(head);
  return match?.[1] !== undefined ? "x" + match[1] : undefined;
}

/**
 * `data.models[].credits` 的展示倍率。
 *
 * 实测是**字符串**而非数字，常态是 **x 在前**：`"x0.29"` / `"x1.62"`；早期
 * scoped 端点会带 ` credits` 后缀；`""` / 字段缺失表示无倍率信息（如 `auto`、
 * `codewise-*`）。归一化后存**纯文本**而不是数字：它只用于显示，而带后缀和
 * 空串两种退化形态转成数字会引入一堆无谓的解析失败分支。
 */
export function normalizeCreditsRate(value: unknown): string | undefined {
  return normalizeRate(
    value,
    /^(?:x(\d+(?:\.\d+)?))\b/i,
    /^(\d+(?:\.\d+)?)x\b/i,
  );
}

/**
 * 促销价（`discount.discountedCredits`）。
 *
 * ⚠️ 实测是 **x 在后**（`"0.50x"`），与 credits 的常态形态相反。两者若用同一
 * 个正则，会让**每一个促销价静默解析失败**：界面上仍显示原价，后台却已按
 * 促销价计费 —— 表现为「为什么我的消耗比显示的贵」，而且没有任何报错可循。
 */
export function normalizeDiscountedRate(value: unknown): string | undefined {
  return normalizeRate(
    value,
    /^(\d+(?:\.\d+)?)x\b/i,
    /^(?:x(\d+(?:\.\d+)?))\b/i,
  );
}

/**
 * 倍率展示文案：`"x0.17→x0.50"`（原价→促销价），无促销时只给原价。
 *
 * 用箭头而不是「（促销 x…）」：这段文案会被拼进**模型切换菜单的名字**里，
 * 菜单宽度有限，箭头更短，也一眼看得出折扣幅度。
 */
export function formatCreditsRate(
  rate: string | undefined,
  discounted: string | undefined,
): string | undefined {
  if (rate === undefined) return discounted;
  return discounted === undefined ? rate : rate + "→" + discounted;
}

// ---------- 促销 ----------

/** 解析 `HH:MM`（容忍不补零的 `7:50`）为当日分钟数；非法返回 undefined。 */
export function parseHHMM(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (match === null) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : undefined;
}

/**
 * 取指定时区「当前墙上时间」的当日分钟数。
 *
 * 用 Intl 而不是手算 UTC 偏移：活动时区由服务端下发（实测 `Asia/Shanghai`），
 * 硬编码 +8 会在其它时区的活动上算错。时区字符串非法时返回 undefined，由调用
 * 方按「不误杀」处理。
 */
export function zonedMinutes(now: Date, timeZone: unknown): number | undefined {
  const zone = typeof timeZone === "string" && timeZone.length > 0
    ? timeZone
    : "Asia/Shanghai";
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const hours = Number(parts.find((part) => part.type === "hour")?.value);
    const minutes = Number(parts.find((part) => part.type === "minute")?.value);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return undefined;
    return hours * 60 + minutes;
  } catch {
    return undefined;
  }
}

/** 活动是否声明了任何时间窗口（每日时段或有效期）。 */
export function hasTimeWindow(schedule: unknown): boolean {
  if (!isRecord(schedule)) return false;
  const daily = schedule.daily;
  if (Array.isArray(daily) && daily.length > 0) return true;
  return schedule.validFrom !== undefined || schedule.validUntil !== undefined;
}

/**
 * 这条促销此刻是否生效。
 *
 * ⚠️ **必须**本地推算时段，不能只看 `enabled`：`enabled: true` 只表示活动启用，
 * 此刻打不打折由 `schedule` 决定。实测同一模型存在两条互补活动（夜间
 * `23:00–7:50` 带 0.50x、白天只挂角标），不看时段就会**全天**显示夜间折扣价 ——
 * 用户按折扣价预期消费，后台却按原价计费，账实不符且无处申诉。
 *
 * 取不到本地时间（时区数据缺失/格式变更）时返回 true：宁可多显示一条已过期
 * 促销，也不能把「正在打折」判成「没打折」。
 */
export function promotionActiveNow(
  item: Record<string, unknown>,
  now: Date = new Date(),
): boolean {
  const schedule = item.schedule;
  if (!isRecord(schedule)) return true;
  const from = typeof schedule.validFrom === "string"
    ? Date.parse(schedule.validFrom)
    : Number.NaN;
  const until = typeof schedule.validUntil === "string"
    ? Date.parse(schedule.validUntil)
    : Number.NaN;
  if (Number.isFinite(from) && now.getTime() < from) return false;
  if (Number.isFinite(until) && now.getTime() >= until) return false;
  const daily = schedule.daily;
  if (!Array.isArray(daily) || daily.length === 0) return true;
  const minutes = zonedMinutes(now, schedule.timezone);
  if (minutes === undefined) return true;
  return daily.some((slot) => {
    if (!isRecord(slot)) return false;
    const start = parseHHMM(slot.start);
    const end = parseHHMM(slot.end);
    if (start === undefined || end === undefined) return false;
    // 支持跨零点（如 23:00–7:50）。
    return start <= end
      ? minutes >= start && minutes < end
      : minutes >= start || minutes < end;
  });
}

/** 促销优先级；缺失或非法按 0（最低）处理。 */
function priorityOf(item: Record<string, unknown>): number {
  const value = item.priority;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * 从 `data.modelPromotions` 提取「模型 id → **此刻生效的**促销价」映射。
 *
 * 真实结构是**数组**，每项靠 `modelIds` 关联到具体模型（不是一张全局表）：
 * ```
 * [{ "kind": "discount", "enabled": true, "priority": 100,
 *    "discount": { "discountedCredits": "0.50x", "factor": 0.5 },
 *    "schedule": { "daily": [{ "start": "23:00", "end": "7:50" }],
 *                 "timezone": "Asia/Shanghai" },
 *    "modelIds": ["glm-5.2"] }]
 * ```
 * 四种退化情形都要处理：时段未到/已过（schedule）、有效期已过（validUntil）、
 * `enabled: false`、同一模型命中多条（取 priority 最高者）。
 *
 * ⚠️ 注意字段层级：**`schedule` 挂在促销项上，`factor` / `discountedCredits` 挂
 * 在 `discount` 里**。两处层级混用（极易发生）会让时间窗判断永久落空，于是夜间
 * 折扣变成全天显示。
 *
 * ⚠️ **`factor: 0` 是「免费」而不是「活动已结束」**：实测 hy4-preview 的夜间
 * 活动是 `{discountedCredits:"0x", factor:0}`，它真的免费；早期把 `0x` 当哨兵
 * 丢弃，于是「夜间免费」永远显示不出来。作为防御：**没有任何时间窗口**的
 * `factor: 0` 仍按「已结束占位」跳过 —— 免费额度必然限时，没窗口的 `0x` 更
 * 可能是遗留占位。真正的「已结束」由有效期表达。
 */
export function parsePromotions(
  record: Record<string, unknown>,
  now: Date = new Date(),
): Map<string, string> {
  const result = new Map<string, string>();
  /** id → 已写入的 priority（同 id 多活动时高优先级覆盖）。 */
  const chosen = new Map<string, number>();
  const promotions = record.modelPromotions;
  if (!Array.isArray(promotions)) return result;
  const ordered = promotions
    .filter((entry): entry is Record<string, unknown> => isRecord(entry))
    // 升序写入，Map.set 天然让高 priority 覆盖低 priority。
    .sort((a, b) => priorityOf(a) - priorityOf(b));
  for (const promotion of ordered) {
    if (promotion.enabled === false) continue;
    if (!promotionActiveNow(promotion, now)) continue;
    const discount = promotion.discount;
    if (!isRecord(discount)) continue;
    const factor = discount.factor;
    const schedule = promotion.schedule;
    const windowed = isRecord(schedule) && hasTimeWindow(schedule);
    let rate: string | undefined;
    if (factor === 0) {
      if (!windowed) continue;
      rate = "免费";
    } else {
      rate = normalizeDiscountedRate(discount.discountedCredits);
      // 归一化后仍是 x0，说明是无 factor 的 "0x" 占位，同样跳过。
      if (rate === "x0") continue;
    }
    if (rate === undefined) continue;
    const modelIds = promotion.modelIds;
    if (!Array.isArray(modelIds)) continue;
    const priority = priorityOf(promotion);
    for (const id of modelIds) {
      if (typeof id !== "string" || id.length === 0) continue;
      const previous = chosen.get(id);
      if (previous !== undefined && previous > priority) continue;
      chosen.set(id, priority);
      result.set(id, rate);
    }
  }
  return result;
}
// ---------- 目录（模型列表）解析 ----------

/**
 * 承载「输入框可选的模型」的 agent 名，两个端点用不同的名字：
 * - `craft`：`/v3/config` 用；
 * - `cli`：企业模型端点 `/console/enterprises/{scope}/models` 用。
 *
 * 两者不会同时存在，取**先出现**的那个。
 */
const PREFERRED_AGENT_NAMES = ["cli", "craft"] as const;

/** 从 `productFeaturesConfig.ModelTrialBanner` 提取试用模型 id。 */
export function trialModelIds(data: Record<string, unknown>): string[] {
  const features = data.productFeaturesConfig;
  if (!isRecord(features)) return [];
  const banner = features.ModelTrialBanner;
  if (!isRecord(banner)) return [];
  const banners = banner.banners;
  if (!Array.isArray(banners)) return [];
  const ids: string[] = [];
  for (const item of banners) {
    if (!isRecord(item)) continue;
    const target = item.targetModelId;
    if (typeof target === "string" && target.length > 0) ids.push(target);
  }
  return ids;
}

/**
 * 服务端没下发 name 时的兜底展示名。
 *
 * 刻意**不抄**参考实现那张 15 条的 `MODEL_DISPLAY_NAMES` 常量表：那张表是国际版
 * 的模型池、且是客户端构建期写死的。拿它当中国版兜底，等于给用户一个可能根本不
 * 存在的模型名；而表里对老模型的叫法还会过时（实测 kimi-k2.6 的旧名已改）。
 * 这里只做「由 id 推一个可读名字」（与 dsh-plugin 的 readName 同一算法：丢掉
 * free 词、逐段首字母大写），宁可朴素也不撒谎。
 */
export function displayNameForModel(id: string): string {
  return id
    .split("-")
    .filter((word) => word !== "" && word.toLowerCase() !== "free")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ") || id;
}

/** `parseModelMeta` 的返回类型：只含可选能力字段。 */
export type WorkBuddyModelMeta = Pick<
  WorkBuddyModel,
  | "contextWindow"
  | "maxOutputTokens"
  | "supportsImages"
  | "reasoningEfforts"
  | "defaultReasoningEffort"
>;

/**
 * 提取单个 `data.models[]` 条目的能力字段。
 *
 * 数字只保留正数（与参考实现的 Rust 端一致）。能力字段只在远端**显式**下发
 * 时保留：缺失即 undefined，**不猜默认值** —— `maxOutputTokens` 猜偏大会被
 * 服务端 400 拒绝，猜偏小则把用户输出无谓截断。
 */
export function parseModelMeta(
  record: Record<string, unknown> | undefined,
): WorkBuddyModelMeta {
  const meta: WorkBuddyModelMeta = {};
  if (record === undefined) return meta;
  const limit = readNumberField(record, "maxInputTokens");
  if (limit !== undefined && limit > 0) meta.contextWindow = limit;
  const maxOutput = readNumberField(record, "maxOutputTokens");
  if (maxOutput !== undefined && maxOutput > 0) {
    meta.maxOutputTokens = maxOutput;
  }
  if (typeof record.supportsImages === "boolean") {
    meta.supportsImages = record.supportsImages;
  }
  const reasoning = record.reasoning;
  if (isRecord(reasoning)) {
    // supportedEfforts 是**可枚举**的等级列表，只在模型真支持多等级时下发；
    // 只有单一默认 effort 的模型此处缺省，就不暴露等级选择器。
    const supported = reasoning.supportedEfforts;
    if (Array.isArray(supported)) {
      const efforts = supported.filter((entry): entry is string =>
        typeof entry === "string" && entry.length > 0
      );
      if (efforts.length > 0) meta.reasoningEfforts = efforts;
    }
    const defaultEffort = reasoning.defaultEffort;
    if (typeof defaultEffort === "string" && defaultEffort.length > 0) {
      meta.defaultReasoningEffort = defaultEffort;
    }
  }
  return meta;
}

/**
 * 从 `/v3/config`（或同形状的企业模型端点）解析可对话模型。
 *
 * 响应结构：
 * ```
 * { data: { agents: [{ name: "craft", models: ["auto", ...] }, ...],
 *         models: [{ id, name, maxInputTokens, maxOutputTokens,
 *                   supportsImages, credits, reasoning: {...} }],
 *         modelPromotions: [...],
 *         productFeaturesConfig?: { ModelTrialBanner: { banners: [...] } } } }
 * ```
 *
 * 解析顺序即优先级：
 * 1. **agent 引用的模型** —— 主对话模型，排最前；
 * 2. `data.models` 里其余可对话模型 —— 只取 agent 的话，一批模型会在选择器
 *    里直接消失（实测国际版的 craft 只引用 5 个抽象别名）；
 * 3. **试用横幅模型** —— 只由 `ModelTrialBanner` 下发，实测可正常调用。
 *
 * 解析失败返回空数组，由调用方回退静态兜底表。
 */
export function parseModelsFromConfig(
  body: unknown,
  now: Date = new Date(),
): WorkBuddyModel[] {
  if (!isRecord(body)) return [];
  const data = body.data;
  if (!isRecord(data)) return [];

  // data.models: id → 远端声明的模型元数据。
  const metaById = new Map<string, Record<string, unknown>>();
  if (Array.isArray(data.models)) {
    for (const entry of data.models) {
      if (!isRecord(entry)) continue;
      if (typeof entry.id === "string") metaById.set(entry.id, entry);
    }
  }

  // 促销是**独立于 data.models 的全局活动表**（按 modelIds 索引），故先整表
  // 解析，再在 push 时按 id 关联。
  const promotions = parsePromotions(data, now);

  // 收集全部 agent 引用的 id（含 craft/ask/plan/cli），用于打 agentReferenced 标记：
  // 上层若按「只保留白名单里的 id」与兜底表合并，不在兜底表里的服务端模型会被
  // 丢掉 —— 实测 hy4-preview-f（新用户限时免费变体）只由 /v3/config 下发、且被
  // agent 引用，却在兜底表之外，于是用户看不到那个免费变体。
  const agentReferencedIds = new Set<string>();
  if (Array.isArray(data.agents)) {
    for (const agent of data.agents) {
      if (!isRecord(agent)) continue;
      if (!Array.isArray(agent.models)) continue;
      for (const model of agent.models) {
        if (typeof model === "string") agentReferencedIds.add(model);
      }
    }
  }

  const parsed: WorkBuddyModel[] = [];
  const seen = new Set<string>();
  const make = (
    id: string,
    meta: Record<string, unknown> | undefined,
  ): WorkBuddyModel => {
    const remoteName = typeof meta?.name === "string" && meta.name.length > 0
      ? meta.name
      : undefined;
    const rate = normalizeCreditsRate(meta?.credits);
    const discounted = promotions.get(id);
    return {
      id,
      name: remoteName ?? displayNameForModel(id),
      ...parseModelMeta(meta),
      ...rate !== undefined ? { creditsRate: rate } : {},
      ...discounted !== undefined ? { discountedCreditsRate: discounted } : {},
    };
  };
  const push = (id: string): void => {
    if (isAutoSelectAlias(id) || seen.has(id)) return;
    if (!isChatModel(id, metaById.get(id))) return;
    seen.add(id);
    parsed.push({
      ...make(id, metaById.get(id)),
      ...agentReferencedIds.has(id) ? { agentReferenced: true } : {},
    });
  };

  // 1. agent 引用的模型优先。
  for (const agentName of PREFERRED_AGENT_NAMES) {
    const agents = data.agents;
    if (!Array.isArray(agents)) break;
    let found = false;
    for (const agent of agents) {
      if (!isRecord(agent) || agent.name !== agentName) continue;
      if (Array.isArray(agent.models)) {
        for (const model of agent.models) {
          if (typeof model === "string") push(model);
        }
      }
      found = true;
      break;
    }
    if (found) break;
  }

  // 2. 补齐 data.models 里其余可对话模型（含只在该端点下发的模型）。
  for (const id of metaById.keys()) push(id);

  // 3. 追加试用横幅模型。**刻意不过 isChatModel**：它既不在 agent 列表也不在
  //    data.models 里，是官方入口且实测可正常调用；按「未知 id 一律拒掉」处理
  //    就会把它丢掉。只挡掉自动选择别名（那不是模型）。
  for (const id of trialModelIds(data)) {
    if (isAutoSelectAlias(id) || seen.has(id)) continue;
    seen.add(id);
    parsed.push(make(id, metaById.get(id)));
  }

  return parsed;
}
// ---------- 请求头 ----------

/**
 * 基础请求头：X-Domain + User-Agent + 可选企业头。
 *
 * ⚠️ `X-Domain` 用 `||` 而不是 `??`：凭据里的 domain 经 readStringField 读取，
 * **字段缺失时是空串而不是 undefined**，用 `??` 会让 X-Domain 以空值发出去
 * （参考实现里这是真实缺陷，已被单测复现）。
 *
 * 企业账号要**同时**带 X-Enterprise-Id 与 X-Tenant-Id：缺任一头服务端就
 * 认不出租户，表现为个人额度里扣企业模型的账。
 */
export function workBuddyBaseHeaders(
  credential: WorkBuddyCredential,
): Record<string, string> {
  const headers: Record<string, string> = {
    [HTTP_HEADER_DOMAIN]: credential.domain || WORKBUDDY_API_DOMAIN,
    "User-Agent": WORKBUDDY_USER_AGENT,
  };
  const enterpriseId = credential.enterprise_id;
  if (enterpriseId !== undefined && enterpriseId.length > 0) {
    headers[HTTP_HEADER_ENTERPRISE_ID] = enterpriseId;
    headers[HTTP_HEADER_TENANT_ID] = enterpriseId;
  }
  return headers;
}

/** 基础头 + Bearer 令牌。 */
export function workBuddyAuthHeaders(
  credential: WorkBuddyCredential,
): Record<string, string> {
  return {
    ...workBuddyBaseHeaders(credential),
    Authorization: "Bearer " + credential.access_token,
  };
}

/**
 * 匿名登录头（`/v2/plugin/auth/state`）。
 *
 * 四个 X-No-* 缺任一个，服务端就会去找一个「不存在的登录态」而失败：它们是
 * 显式声明「本次请求不携带任何身份」，不是可选项。
 */
export function workBuddyAnonymousHeaders(): Record<string, string> {
  return {
    [HTTP_HEADER_DOMAIN]: WORKBUDDY_API_DOMAIN,
    [HTTP_HEADER_NO_AUTHORIZATION]: "true",
    [HTTP_HEADER_NO_USER_ID]: "true",
    [HTTP_HEADER_NO_ENTERPRISE_ID]: "true",
    [HTTP_HEADER_NO_DEPARTMENT_INFO]: "true",
    "User-Agent": WORKBUDDY_USER_AGENT,
  };
}

/**
 * 目录请求头（scoped 模型端点 / `/v3/config`）。
 *
 * ⚠️ 这里 `X-Product` 发的是**部署类型**（SaaS），而聊天请求里的 `X-Product`
 * 发的是**归属名**（WorkBuddy）—— 参考实现两处同名不同义，是从代码里踩出来的
 * 坑，所以常量必须分开命名，不能复用同一个。
 */
export function workBuddyCatalogHeaders(
  credential: WorkBuddyCredential,
): Record<string, string> {
  return {
    ...workBuddyAuthHeaders(credential),
    [HTTP_HEADER_PRODUCT]: WORKBUDDY_DEPLOYMENT_TYPE,
    [HTTP_HEADER_PRODUCT_CODE]: WORKBUDDY_PRODUCT_CODE,
  };
}

/**
 * 聊天请求头。
 *
 * ⚠️ `X-Domain` 取**产品常量**而不是凭据里的 domain：凭据里的 domain 是
 * 登录那一刻服务端下发的**快照**，账号迁区后会变旧，而请求实际发往
 * WORKBUDDY_ENDPOINT —— 两个不一致时服务端按错的域解析租户。用 `||` 兜住
 * 空串（Headers.set 不接受空值，但这里返回普通对象，所以走 || 不是为类型）。
 *
 * ⚠️ User-Agent 必须 `set` 而不是 append：框架注入的 UA 键是小写，append 会
 * 同时发出两个 User-Agent，服务端取到的可能不是我们那一份。
 */
export function workBuddyChatHeaders(
  credential: WorkBuddyCredential,
): Record<string, string> {
  const headers: Record<string, string> = {
    ...workBuddyBaseHeaders(credential),
    Authorization: "Bearer " + credential.access_token,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    [HTTP_HEADER_DOMAIN]: WORKBUDDY_API_DOMAIN,
    [HTTP_HEADER_PRODUCT]: WORKBUDDY_ATTRIBUTION_NAME,
    [HTTP_HEADER_PRODUCT_CODE]: WORKBUDDY_PRODUCT_CODE,
    [HTTP_HEADER_AGENT_PURPOSE]: "conversation",
    [HTTP_HEADER_IDE_NAME]: WORKBUDDY_ATTRIBUTION_NAME,
    [HTTP_HEADER_IDE_TYPE]: WORKBUDDY_ATTRIBUTION_NAME,
    [HTTP_HEADER_IDE_VERSION]: WORKBUDDY_CLIENT_VERSION,
  };
  return headers;
}

// ---------- 401 / 内容拦截 ----------

/**
 * 腾讯侧**安全策略拦截**（业务码 11140）判定。
 *
 * ⚠️ 这类拒绝**也回 HTTP 403**，报文实测：
 * ```
 * {"code":11140,"msg":"request illegal","requestId":"…",
 *  "displayMsg":{"en":"…safety review…","zh":"内容未通过安全审核，请调整后重试。"}}
 * ```
 * 同一报文还会在 CodeArts 侧以 HTTP 200 + SSE 内嵌错误帧的形式出现。
 *
 * 只看状态码无法区分：403 同时覆盖「真认证失败 / 额度耗尽 / 权限不足 / 安全
 * 策略」。所以用三个**独立**信号（任一命中即可），而不是一个。
 *
 * ⚠️ 服务端称它是「内容」问题，实测却是**账号级**的：同一份请求体（system +
 * 两个字）发往池里 7 个账号，结果 2 个 200 / 4 个 403+11140 / 1 个 429。
 * 用户侧现象吻合 —— 连「你好」都被拦、换新会话照样被拦。所以处理方式与 401
 * 相同：换号，不能回复「请调整内容」（那会把用户指向错误方向）。
 */
export function isContentRejection(body: string): boolean {
  if (body.length === 0) return false;
  return /"code"\s*:\s*11140/.test(body) ||
    /request illegal/i.test(body) ||
    /安全审核|safety review/i.test(body);
}

/**
 * 一个 SSE 数据帧是不是「内容被拦截」错误帧。
 *
 * ⚠️ 判据必须**窄**：只在 `choices` 缺失时才可能是错误帧。因为「安全审核」/
 * 「request illegal」/ 字面量 11140 都可能出现在**模型自己写的正文**里（讨论
 * 审核话题的助手会说出这些词），而正常的 content 帧永远带 choices。
 *
 * ⚠️ 早期版本把这帧**静默丢掉**：帧分类器只认 `error`/`choices`/`usage`，
 * 而这个报文是顶层 `{code,msg,displayMsg}`，于是表现成「干净结束、没有报错」——
 * 用户以为模型答完了，其实一句都没收到。
 */
export function isContentRejectionFrame(payload: string): boolean {
  const text = payload.trim();
  if (text.length === 0 || text === "[DONE]") return false;
  const parsed = safeParseJson(text);
  if (!isRecord(parsed)) return false;
  if (parsed.choices !== undefined) return false;
  return isContentRejection(text);
}

// ---------- 请求体组装 ----------

/** 是否为 DeepSeek 系模型（前缀匹配，不区分大小写）。 */
export function isDeepSeekModel(model: string): boolean {
  return /^deepseek/i.test(model.trim());
}

/** 组装请求体时需要的、来自目录的一项能力。 */
export interface WorkBuddyChatPlan {
  /** 输出上限。undefined = 远端没下发，**不下发该字段**（保持网关默认）。 */
  maxOutputTokens?: number;
  /** 该模型真实支持的思考等级；空或缺省 = 不暴露等级选择。 */
  efforts?: readonly string[];
  /** 声明的默认等级。 */
  defaultEffort?: string;
}

export interface WorkBuddyBodyOptions {
  /** 调用方（DSH）显式给的上限，优先级最高。 */
  maxTokens?: number;
  reasoningEffort?: string;
  temperature?: number;
  stop?: string[];
}

/**
 * 组装 `/v2/chat/completions` 的请求体。
 *
 * 请求体与响应都是**标准 OpenAI 形状**，所以这里只做增删，不做字段翻译 ——
 * 任何「把 TRAE 那种自造格式搬到 OpenAI」的转换在这里都是多余的。
 *
 * @param sessionId 稳定的会话 id。WorkBuddy 用 `prompt_cache_key` 做前缀缓存：
 *   实测同一段 8k token 前缀，不带该字段 `prompt_cache_hit_tokens=0`（credit 0.34），
 *   带上则命中 7808（credit 0.02）—— **仅这一个字段，费用差约 17 倍**。
 *
 * @param plan 来自目录的该模型能力；undefined 时按「什么都别猜」处理。
 */
export function buildChatBody(
  model: string,
  messages: unknown,
  sessionId: string,
  plan: WorkBuddyChatPlan | undefined,
  options: WorkBuddyBodyOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    prompt_cache_key: sessionId,
  };
  if (Array.isArray(options.stop) && options.stop.length > 0) {
    body.stop = options.stop;
  }
  if (options.temperature !== undefined) body.temperature = options.temperature;

  // 输出上限。**此前完全没下发过该字段**，于是上限由网关默认决定（实测仅
  // 32000），大段输出被截成 finish_reason:"length" —— 现象是「模型说写完了
  // 但文件只有一半」，且本地无从调整。
  //   优先级：调用方显式值 → 远端 maxOutputTokens。
  // 都没有就**不发这个字段**，让网关用自己的默认（编一个数：偏大被 400 拒绝、
  // 偏小把输出无谓截断）。
  const maxTokens = options.maxTokens ?? plan?.maxOutputTokens;
  if (maxTokens !== undefined && maxTokens > 0) body.max_tokens = maxTokens;

  // 思考开关。**实测关键结论（直连三站点对照）**：
  //   - 裸请求 → reasoning_content 恒为 0；
  //   - 仅 reasoning_effort:high → 返回思考；
  //   - 仅 thinking:{type:"enabled"} → 仍为 0；
  //   - 两者都带 → 返回思考。
  // 即 reasoning_effort 才是真正的开关。三个站点行为一致 ⇒ 与 endpoint/UA 无关。
  // thinking 仍保留，用来对齐官方客户端出站形态并覆盖后端将来按它判定的情形。
  const efforts = plan?.efforts ?? [];
  const deepseek = isDeepSeekModel(model);
  if (deepseek) body.thinking = { type: "enabled" };
  if (
    options.reasoningEffort !== undefined && efforts.length > 0 &&
    efforts.includes(options.reasoningEffort)
  ) {
    // 只在该模型确实支持该等级时才发，否则服务端因非法参数 400。
    body.reasoning_effort = options.reasoningEffort;
  } else if (efforts.length > 0 && deepseek) {
    // deepseek 系：没选档（或所选档不支持）时**必须**补一个 —— 此时请求体里
    // 只剩 thinking，上游仍按不思考应答（实测）。回退顺序：声明的默认档 →
    const declared = plan?.defaultEffort;
    body.reasoning_effort = declared !== undefined && efforts.includes(declared)
      ? declared
      : efforts.includes("high")
      ? "high"
      : efforts[0];
  }
  return body;
}

/** 容错 JSON.parse（网关的 401 响应体可能是 openresty 的 HTML）。 */
export function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
// ---------- 目录下发（OpenAI 形状） ----------

/**
 * 一行模型目录的 OpenAI 形状。
 *
 * ⚠️ reasoning 字段**必须整体省略**而不是给空数组：harness 收到
 * efforts: [] 会以 INVALID_MODEL_REASONING 拒掉整个 provider —— 那是形状
 * 问题不是能力问题，「该模型不支持思考」只能靠「没有这个字段」表达。
 */
export interface WorkBuddyModelCard {
  id: string;
  name: string;
  context_window?: number;
  max_output_tokens?: number;
  input_modalities: string[];
  reasoning?: {
    efforts: Array<{ id: string; name: string }>;
    defaultEffort: string;
  };
  /** 合并后的倍率（原价→促销价）。插件 normalizeModel 不读，仅排查用。 */
  creditsRate?: string;
}

/** 目录行 → OpenAI 形状。缺失的能力字段一律不下发，不编默认值。 */
export function toWorkBuddyModelCard(
  model: WorkBuddyModel,
): WorkBuddyModelCard {
  const efforts = (model.reasoningEfforts ?? []).filter((effort) =>
    typeof effort === "string" && effort !== ""
  );
  const declared = model.defaultReasoningEffort;
  const defaultEffort = declared !== undefined && efforts.includes(declared)
    ? declared
    : efforts.includes("high")
    ? "high"
    : efforts[0] ?? "";
  const rate = formatCreditsRate(
    model.creditsRate,
    model.discountedCreditsRate,
  );
  return {
    id: model.id,
    name: model.name,
    ...model.contextWindow !== undefined
      ? { context_window: model.contextWindow }
      : {},
    ...model.maxOutputTokens !== undefined
      ? { max_output_tokens: model.maxOutputTokens }
      : {},
    input_modalities: model.supportsImages === true
      ? ["text", "image"]
      : ["text"],
    ...efforts.length === 0 ? {} : {
      reasoning: {
        efforts: efforts.map((effort) => ({ id: effort, name: effort })),
        defaultEffort,
      },
    },
    ...rate !== undefined ? { creditsRate: rate } : {},
  };
}
// ---------- 流内内容拦截 ----------

/** 拦截发生时的原因，原样带上那一帧的文本。 */
export interface WorkBuddyRejection {
  payload: string;
}

/**
 * 给上游 SSE 套一层**只读扫描**：字节原样转发，只在遇到 11140 帧时收尾。
 *
 * 为什么需要这一层：上游把内容拦截塞在一个 **HTTP 200 的 SSE 流**里，帧分类器
 * 只认 error/choices/usage，这一帧会被当噪声丢掉 —— 表现是「干净地结束、没有任何
 * 报错」，用户看到的是模型答到一半停住。参考实现为此专门造了错误对象。
 *
 * 为什么判定要窄（只认**没有 choices 的帧**）：模型正文里完全可能出现「安全审核」
 * 「request illegal」乃至字面量 11140，而合法内容帧一定带 choices。
 *
 * 为什么改写帧内容：客户端已经消费了半条流，直接抛错只会得到「流断在那里」，
 * 和原来一样看不到原因。所以补一个 OpenAI 形状的 error 帧再 [DONE] 收尾 ——
 * 这是**唯一**一处会动帧内容的地方，且只在失败时发生。
 */
export function guardWorkBuddyStream(
  upstream: ReadableStream<Uint8Array>,
  onRejection: (rejection: WorkBuddyRejection) => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let carry = "";
  let rejected = false;
  const scan = (text: string): boolean => {
    carry += text;
    // 只判定**完整行**：半行可能是下一个 chunk 的一半，提前判定会切坏 JSON。
    for (
      let at = carry.lastIndexOf("\n");
      at >= 0;
      at = carry.lastIndexOf("\n")
    ) {
      const line = carry.slice(0, at).trim();
      carry = carry.slice(at + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!isContentRejectionFrame(payload)) continue;
      rejected = true;
      onRejection({ payload });
      return true;
    }
    return false;
  };
  return new ReadableStream({
    async start(controller) {
      const reader = upstream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          // 同一个 chunk 里若已出现拦截帧，就不要把它前半段（正常的模型输出）
          // 也交给客户端 —— 那会让用户看到「先答了再断」。
          if (
            value !== undefined &&
            !scan(decoder.decode(value, { stream: true }))
          ) {
            controller.enqueue(value);
          }
          if (rejected) break;
        }
      } catch (error) {
        controller.error(error);
        return;
      } finally {
        reader.releaseLock();
      }
      if (rejected) {
        const message =
          "WorkBuddy content rejection (code 11140): the account, not" +
          " the prompt, was blocked; retrying on another account is the fix";
        controller.enqueue(
          encoder.encode(
            "data: " + JSON.stringify({
              error: { message, type: "content_rejection", code: 11140 },
            }) + "\n\n",
          ),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      }
      controller.close();
    },
  });
}
