/**
 * TRAE 账号模块：凭据读写、静默续期、每日签到、积分余额。
 *
 * 协议取自 deepseek-harness-codearts（MIT）的 src/trae*.ts，
 * 按其注释里的实测结论实现。凡本文与那份实现不一致处均在注释里标明理由。
 *
 * ## 为什么签到要单独一个模块
 *
 * 推理链路（llm_utils_chat）与积分链路（api.trae.cn 的 checkin/usage）**主机不同、
 * 鉴权头不同、错误语义不同**，而且签到有一条**只有实测才会撞上**的规则：
 * 业务码 9074 是**按 device_id 的全网高峰限流**，不是账号问题。所以它不能混进
 * 推理路径 —— 推理不该因为签到被限流而失败，反之亦然。
 */

/** TRAE 积分链路主机。 */
const UG_HOST = "https://api.trae.cn";
/** OAuth 主机（ExchangeToken）。 */
const OAUTH_HOST = "https://api.trae.com.cn";

const CHECKIN_STATUS_PATH = "/trae/api/v2/ug/checkin_credits/status";
const CHECKIN_CLAIM_PATH = "/trae/api/v2/ug/checkin_credits/claim";
const ENT_USAGE_PATH = "/trae/api/v2/pay/ide_user_ent_usage";
const EXCHANGE_PATH = "/cloudide/api/v3/trae/oauth/ExchangeToken";

const CLIENT_ID = "en1oxy7wnw8j9n";
const REQUEST_TIMEOUT_MS = 30_000;

export interface TraeCredential {
  access_token: string;
  refresh_token: string;
  /** 毫秒时间戳字符串（与本项目其它渠道的凭据约定一致）。 */
  expires_at: string;
  uid: string;
  nickname?: string;
  /**
   * 32 位 hex。**登录后绝不重新生成** —— 服务端按它标识设备，
   * 换值等于换机器，可能触发重新登录或被判定为异常设备。
   */
  machine_id: string;
  /** 32 位 hex。**每个账号必须互异**（同一天两账号共用会被「该设备已签到」拦截）。 */
  device_id: string;
}

export interface TraeCreditPack {
  name: string;
  total: number;
  used: number;
  remaining: number;
  /** 到期日（YYYY-MM-DD）；服务端不下发时为 undefined。 */
  expires?: string;
}

export interface TraeBalance {
  total: number;
  packs: TraeCreditPack[];
}

export interface TraeCheckinState {
  /** 服务端明确说「今天已领」。 */
  checkedIn: boolean;
  /** 今天可领的积分数（服务端下发，本机实测 100）。 */
  credits: number;
  /** 该活动是否存在。 */
  enabled: boolean;
}

export interface TraeClaimResult {
  ok: boolean;
  /** 业务码；0 为成功。 */
  code: number;
  message: string;
  /** 本次实际获得的积分（**必须补查 status 才拿得到**，claim 响应不含）。 */
  credits?: number;
  /** 命中过多少次 9074 退避。 */
  throttled: number;
  /** 今天本来就是已领状态（本次未真正领取）。 */
  alreadyClaimed: boolean;
}

// ---------- 凭据 ----------

/**
 * 文件读写是**注入的**，不是为了测试而抽象 —— 而是因为本项目的测试任务
 * `deno task test` 只开 `--allow-env`。不注入的话，四个碰文件的用例就得
 * 靠给 CI 加权限才能跑，而**给 CI 加权限比改注入点更容易被忽略**：改权限会让
 * 整套测试拿到文件系统写权限，而这个模块之外的代码也会跟着受益。
 */
export type TraeReadFile = (path: string) => Promise<string>;
export type TraeWriteFile = (path: string, data: string) => Promise<void>;

/**
 * 解析凭据文件。
 *
 * 返回 undefined 而不是抛错，是为了让「没登录过」与「文件坏了」都能走同一条
 * 「请先登录」路径 —— 对用户是同一件事。
 */
export async function readTraeCredential(
  root: string,
  read: TraeReadFile = Deno.readTextFile,
): Promise<TraeCredential | undefined> {
  let raw: string;
  try {
    raw = await read(root + "/trae-auth.json");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<TraeCredential>;
    if (
      typeof parsed.access_token !== "string" ||
      parsed.access_token.length === 0
    ) {
      return undefined;
    }
    return {
      access_token: parsed.access_token,
      refresh_token: typeof parsed.refresh_token === "string"
        ? parsed.refresh_token
        : "",
      expires_at: typeof parsed.expires_at === "string"
        ? parsed.expires_at
        : "",
      uid: typeof parsed.uid === "string" ? parsed.uid : "",
      nickname: typeof parsed.nickname === "string"
        ? parsed.nickname
        : undefined,
      machine_id: typeof parsed.machine_id === "string"
        ? parsed.machine_id
        : "",
      device_id: typeof parsed.device_id === "string" ? parsed.device_id : "",
    };
  } catch {
    return undefined;
  }
}

export async function writeTraeCredential(
  root: string,
  credential: TraeCredential,
  write: TraeWriteFile = Deno.writeTextFile,
): Promise<void> {
  await write(
    root + "/trae-auth.json",
    JSON.stringify(credential, null, 2) + "\n",
  );
}

/** 凭据是否已过期。无法解析过期时间时**不**判定过期（宁可多续一次）。 */
export function isTraeExpired(
  credential: TraeCredential,
  nowMs: number = Date.now(),
): boolean {
  const raw = credential.expires_at;
  if (typeof raw !== "string" || raw.length === 0) return false;
  if (!/^\d+$/.test(raw)) {
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? false : nowMs >= parsed;
  }
  const value = Number(raw);
  const ms = value > 1_000_000_000_000 ? value : value * 1000;
  return nowMs >= ms;
}

/** 过期前多久开始续期（毫秒）。实测 access token 有效期 14 天。 */
const REFRESH_SKEW_MS = 24 * 60 * 60 * 1000;

export function needsTraeRefresh(
  credential: TraeCredential,
  nowMs: number = Date.now(),
): boolean {
  if (credential.refresh_token.length === 0) return false;
  const raw = credential.expires_at;
  if (!/^\d+$/.test(raw)) return false;
  const value = Number(raw);
  const ms = value > 1_000_000_000_000 ? value : value * 1000;
  return nowMs >= ms - REFRESH_SKEW_MS;
}

// ---------- 鉴权头 ----------

/**
 * 积分链路请求头。
 *
 * ⚠️ **不带** SOLO 专属头（X-Ide-Version / X-Machine-Id 等）—— 走 Cloud-IDE-JWT
 * 但走的是另一套 Ug 端点，混用会被拒。
 */
export function traeUgHeaders(
  credential: TraeCredential,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "accept": "application/json",
    "user-agent": "VSCode 1.107.1 (TRAE SOLO CN)",
    "authorization": "Cloud-IDE-JWT " + credential.access_token,
    "x-user-region": "CN",
  };
  if (credential.device_id.length > 0) {
    headers["x-device-id"] = credential.device_id;
  }
  return headers;
}

export type TraeFetcher = typeof fetch;

async function postJson(
  fetcher: TraeFetcher,
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetcher(url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  try {
    return {
      status: response.status,
      json: JSON.parse(text) as Record<string, unknown>,
    };
  } catch {
    return { status: response.status, json: {} };
  }
}

// ---------- 签到 ----------

/**
 * 查今日签到状态。
 *
 * ⚠️ `checked_in` 与 `did_checked_in` **两个字段都要读**——本机实测这个账号
 * 只回 `did_checked_in:false`。只读一个会把「已领」误报成「未领」。
 * 方向取保守：误报未领最多让用户多点一次（服务端幂等，无害）；
 * 误报已领会让其**真的错过当天积分**。
 */
export async function fetchTraeCheckinStatus(
  credential: TraeCredential,
  fetcher: TraeFetcher = fetch,
): Promise<TraeCheckinState> {
  const { status, json } = await postJson(
    fetcher,
    UG_HOST + CHECKIN_STATUS_PATH,
    traeUgHeaders(credential),
    "{}",
  );
  if (status !== 200) {
    throw new Error("签到状态查询失败 HTTP " + status);
  }
  const credits = Number(json.credits ?? json.extra_credits ?? 0);
  return {
    checkedIn: json.checked_in === true || json.did_checked_in === true,
    credits: Number.isFinite(credits) ? credits : 0,
    enabled: json.enable !== false,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 领取今日积分。
 *
 * ## 三条实测约束（缺一条就会出现「显示成功但加 0 积分」）
 *
 * 1. **claim 响应不含积分数** —— 完整响应就是 `{"code":0,"message":"success"}`。
 *    真实数值只在**随后**的 status 里（早期实现读 claim 的 `credits`，恒为 0）。
 * 2. **claim 对「今天已领」幂等** —— 重复领取同样回 `code 0`，与真成功**无法区分**。
 *    所以必须**先查 status**，只有 `checked_in` 能判「是否已领」。
 * 3. **业务码非 0 才是失败**，HTTP 200 不代表成功。
 *
 * ## 9074
 *
 * `9074`「当前参与用户太多」是**按 device_id 的全网高峰限流**（本机 2026-10-02
 * 实测首次调用即撞，退避 5/10/15s 重试三次仍被拒）。它**不是账号问题**，
 * 也不是「设备已签到」。
 *
 * ⚠️ 不靠换 device_id 绕过 —— 参考实现会派生新设备号重试，但那是**登录时**的行为；
 * 对已落盘凭据换号等于让凭据与设备指纹失配。此处只退避。
 */
export async function claimTraeDailyCheckin(
  credential: TraeCredential,
  fetcher: TraeFetcher = fetch,
  options: {
    attempts?: number;
    backoffMs?: number;
    sleepFn?: (ms: number) => Promise<void>;
    onThrottle?: (attempt: number, waitMs: number) => void;
  } = {},
): Promise<TraeClaimResult> {
  const attempts = options.attempts ?? 4;
  const backoffMs = options.backoffMs ?? 5000;
  const wait = options.sleepFn ?? sleep;

  const before = await fetchTraeCheckinStatus(credential, fetcher);
  if (before.checkedIn) {
    return {
      ok: true,
      code: 0,
      message: "今天已经签过到了",
      credits: before.credits,
      throttled: 0,
      alreadyClaimed: true,
    };
  }

  let throttled = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    // ⚠️ 请求体必须是空串 `{}`（不是 {"req_source":2}）
    const { json } = await postJson(
      fetcher,
      UG_HOST + CHECKIN_CLAIM_PATH,
      traeUgHeaders(credential),
      "{}",
    );
    const code = Number(json.code ?? 0);
    if (code === 0) {
      // 补查 status 取真实积分数；补查失败仍算成功（领取本身已完成）
      let credits: number | undefined;
      try {
        const after = await fetchTraeCheckinStatus(credential, fetcher);
        credits = after.credits;
      } catch {
        credits = undefined;
      }
      return {
        ok: true,
        code: 0,
        message: "success",
        credits,
        throttled,
        alreadyClaimed: false,
      };
    }
    if (code !== 9074) {
      return {
        ok: false,
        code,
        message: typeof json.message === "string"
          ? json.message
          : "业务码 " + code,
        throttled,
        alreadyClaimed: false,
      };
    }
    throttled++;
    if (attempt < attempts) {
      const waitMs = attempt * backoffMs;
      options.onThrottle?.(attempt, waitMs);
      await wait(waitMs);
    }
  }
  return {
    ok: false,
    code: 9074,
    message: "当前参与用户太多，请稍后再试（全网高峰限流，不是账号问题）",
    throttled,
    alreadyClaimed: false,
  };
}

// ---------- 余额 ----------

/**
 * 查积分余额。
 *
 * ⚠️ **必须带 `require_usage: true`** —— 不带时上游不返回 `usage` 明细，
 * `credits_amount` 恒缺省为 0，余额会等于额度总额（**虚高**）。
 * 这个错误和「查询失败」在界面上长得一模一样。
 *
 * ⚠️ `expire_time` 是**秒级** Unix 时间戳，不乘 1000 会落在 1970 年。
 * ⚠️ 包名取 `display_desc`（本机实测「每月登录赠送」/「签到奖励」/「免费」），
 * 不是 `base.name`（后者实测为 undefined）。
 */
export async function fetchTraeBalance(
  credential: TraeCredential,
  fetcher: TraeFetcher = fetch,
): Promise<TraeBalance> {
  const { status, json } = await postJson(
    fetcher,
    UG_HOST + ENT_USAGE_PATH,
    traeUgHeaders(credential),
    '{"require_usage":true,"req_source":2}',
  );
  if (status !== 200) {
    throw new Error("积分余额查询失败 HTTP " + status);
  }
  const list = json.user_entitlement_pack_list;
  const packs: TraeCreditPack[] = [];
  let total = 0;
  if (Array.isArray(list)) {
    for (const item of list) {
      if (typeof item !== "object" || item === null) continue;
      const entry = item as Record<string, unknown>;
      const base = entry.entitlement_base_info as
        | Record<string, unknown>
        | undefined;
      const quota = base?.quota as Record<string, unknown> | undefined;
      if (!quota) continue;
      const limit = Number(quota.credits_limit);
      // credits_limit <= 0 的条目跳过（与 Go 端 EntUsage 同口径）
      if (!Number.isFinite(limit) || limit <= 0) continue;
      const usage = entry.usage as Record<string, unknown> | undefined;
      const used = usage ? Number(usage.credits_amount ?? 0) : 0;
      const safeUsed = Number.isFinite(used) && used > 0 ? used : 0;
      const expireSec = Number(entry.expire_time);
      const pack: TraeCreditPack = {
        name:
          typeof base?.display_desc === "string" && base.display_desc.length > 0
            ? base.display_desc
            : typeof entry.display_desc === "string" &&
                entry.display_desc.length > 0
            ? entry.display_desc
            : "资源包",
        total: limit,
        used: safeUsed,
        remaining: limit - safeUsed,
        ...(Number.isFinite(expireSec) && expireSec > 0
          ? { expires: new Date(expireSec * 1000).toISOString().slice(0, 10) }
          : {}),
      };
      packs.push(pack);
      total += pack.remaining;
    }
  }
  // 多包浮点噪声会放大成 655.67000031
  return { total: Math.round(total * 100) / 100, packs };
}

// ---------- 续期 ----------

/**
 * 用 refresh_token 换新 access token。
 *
 * ⚠️ ExchangeToken **轮换** refresh_token（旧值即刻失效），调用方**必须回写**。
 * 只换 access 不回写 refresh，下一次续期就会失败 —— 而那要等到 14 天后。
 *
 * 设备指纹字段**完全不动**：续期只改 token 与过期时间。
 */
export async function refreshTraeCredential(
  credential: TraeCredential,
  fetcher: TraeFetcher = fetch,
  nowMs: number = Date.now(),
): Promise<TraeCredential> {
  if (credential.refresh_token.length === 0) {
    throw new Error("无 refresh_token，请重新登录");
  }
  const { status, json } = await postJson(
    fetcher,
    OAUTH_HOST + EXCHANGE_PATH,
    {
      "content-type": "application/json",
      "accept": "application/json",
      "user-agent": "TraeAgent/1.0.0",
    },
    JSON.stringify({
      ClientID: CLIENT_ID,
      RefreshToken: credential.refresh_token,
      // 字面量 "-"，不是空串
      ClientSecret: "-",
      UserID: "",
    }),
  );
  if (status !== 200) {
    throw new Error("ExchangeToken 失败 HTTP " + status);
  }
  const result = (json.Result ?? json.result ?? json.Data ?? json) as Record<
    string,
    unknown
  >;
  const access = typeof result.Token === "string" && result.Token.length > 0
    ? result.Token
    : typeof result.AccessToken === "string"
    ? result.AccessToken
    : "";
  if (access.length === 0) throw new Error("ExchangeToken 响应缺少 Token");
  // 轮换：拿不到新的 refresh_token 就必须保留旧的，否则下一次续期必失败
  const rotated = typeof result.RefreshToken === "string" &&
      result.RefreshToken.length > 0
    ? result.RefreshToken
    : credential.refresh_token;
  const exp = Number(result.TokenExpireAt ?? result.ExpiresAt ?? 0);
  const expiresMs = Number.isFinite(exp) && exp > 0
    ? (exp > 1_000_000_000_000 ? exp : exp * 1000)
    : nowMs + 14 * 24 * 60 * 60 * 1000;
  return {
    ...credential,
    access_token: access,
    refresh_token: rotated,
    expires_at: String(expiresMs),
  };
}

/**
 * 需要时续期并回写。
 *
 * 返回 undefined 表示**不需要续期**（调用方据此跳过写盘，避免无谓 IO 与
 * mtime 抖动 —— 面板判断「是否已配置」依赖文件内容而非时间戳）。
 */
export async function refreshTraeIfNeeded(
  root: string,
  credential: TraeCredential,
  fetcher: TraeFetcher = fetch,
  nowMs: number = Date.now(),
): Promise<TraeCredential | undefined> {
  if (!needsTraeRefresh(credential, nowMs)) return undefined;
  const refreshed = await refreshTraeCredential(credential, fetcher, nowMs);
  await writeTraeCredential(root, refreshed);
  return refreshed;
}
