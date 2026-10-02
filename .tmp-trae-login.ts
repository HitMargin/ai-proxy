/**
 * TRAE 登录 + 只读探针（一次性取证，用于移植决策）
 *
 * 运行：
 *   deno run -A .tmp-trae-login.ts
 *
 * 流程：
 *   1. 打开浏览器到 TRAE 授权页（18 个参数，少一个就会停在「认证中」）
 *   2. 你在浏览器里完成登录/授权
 *   3. 回调落到本地 127.0.0.1:18080，拿到 refreshToken
 *   4. ExchangeToken 换 Cloud-IDE-JWT，写入 trae-auth.json
 *   5. 跑三个只读探针：模型目录+倍率 / 积分余额 / 签到状态
 *
 * 全部探针**不消耗任何模型额度**。
 *
 * 协议逐条取自 deepseek-harness-codearts（MIT）的 src/trae*.ts，
 * 按其注释里的实测结论实现；凡我实测与文档冲突处均在注释里标明。
 */

const CONSOLE_HOST = "https://www.trae.cn";
const AGENT_HOST = "https://trae-api-cn.mchost.guru";
const UG_HOST = "https://api.trae.cn";
const OAUTH_HOST = "https://api.trae.com.cn";

const CLIENT_ID = "en1oxy7wnw8j9n";
const APP_ID = "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8";
const PLUGIN_VERSION = "2.3.62834";
const IDE_VERSION = "0.1.52";
const IDE_VERSION_CODE = "20260811";

const BATCH_MODELS_PATH = "/api/ide/v1/batch_get_detail_param";
const EXCHANGE_PATH = "/cloudide/api/v3/trae/oauth/ExchangeToken";
const CHECKIN_STATUS_PATH = "/trae/api/v2/ug/checkin_credits/status";
const ENT_USAGE_PATH = "/trae/api/v2/pay/ide_user_ent_usage";

const OUTPUT = "./trae-auth.json";
const PORT = 18080;
const TIMEOUT_MS = 30_000;

/** 登录会话的设备指纹。machine_id 生成后必须复用，重新生成等于换机器。 */
interface Session {
  machine_id: string;
  device_id: string;
  trace_id: string;
}

interface TraeCredential {
  access_token: string;
  refresh_token: string;
  expires_at: string;
  uid: string;
  nickname?: string;
  machine_id: string;
  device_id: string;
}

// ── 工具 ────────────────────────────────────────────────

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 由 machine_id + device_id 派生 login_trace_id。
 * 取拼接串**尾部 16 字符**（对齐 Go 端 callback.go:55-63）。
 */
function machineTraceId(machineId: string, deviceId: string): string {
  const joined = machineId + deviceId;
  return joined.length >= 16 ? joined.slice(-16) : joined.padStart(16, "0");
}

/**
 * 解析回调里 URL 编码的 JSON 参数。
 * ⚠️ TRAE 的 userInfo 中文**双重编码**（实测昵称乱码 Óû§8847309959），
 * URLSearchParams 只解一层，故再容错解一层。
 */
function parseJsonParam(
  raw: string | null,
): Record<string, unknown> | undefined {
  if (raw === null || raw.length === 0) return undefined;
  for (const candidate of [raw, safeDecode(raw)]) {
    if (candidate === undefined) continue;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ) {
        return parsed as Record<string, unknown>;
      }
    } catch { /* 试下一个 */ }
  }
  return undefined;
}

function safeDecode(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

/** 从 JSON 对象读字符串，兼容数字。 */
function jsonString(
  src: Record<string, unknown> | undefined,
  key: string,
): string {
  if (src === undefined) return "";
  const v = src[key];
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}

/**
 * 修复昵称双重编码乱码。
 *
 * ⚠️⚠️ 实测（2026-10-02 首次真实登录）：**照抄上游的实现会毁掉可读昵称**。
 *
 * 真实回调的 `ScreenName` 是 `（1761121491907`（全角括号 + 手机号），
 * 它**本来就不是乱码**。但 latin1→utf8 往返把它变成了「没有 CJK」的值，
 * 而上游那条规则（往返成功就采用）会把这个**损坏结果**当成修复后的昵称。
 * 同一份规则还会把真正的乱码 `Óû§8847309959` 变成 `用户7099`——
 * 即「修复」的结果既不修复乱码，又毁掉正常值。
 *
 * 判据：**往返之后没有 CJK，只有在「原文本来也没有 CJK」时才可信**；
 * 原文有 CJK 而往返后没有，说明这一步把字**弄丢了**，必须放弃往返结果。
 *
 * 附带的真实形态：本账号的 `credits`/签到说明 TRAE 用手机号作昵称，
 * 而全角括号是上游自己加的展示包装 —— 昵称是**非 ASCII 的合法值**。
 */
function fixNicknameMojibake(raw: string, uid: string): string {
  if (raw.length === 0) return raw;
  let candidate = raw;
  try {
    const roundTrip = Buffer.from(raw, "latin1").toString("utf8");
    if (
      roundTrip.length > 0 && !roundTrip.includes("\uFFFD") &&
      [...roundTrip].every((ch) => ch.charCodeAt(0) >= 32)
    ) {
      candidate = roundTrip;
    }
  } catch { /* 走兜底 */ }
  const inputHadCjk = /[\u4e00-\u9fff]/.test(raw);
  const candidateHasCjk = /[\u4e00-\u9fff]/.test(candidate);
  // 无 CJK 可丢 → 往返结果可信（或原文本就无 CJK）
  if (!inputHadCjk || candidateHasCjk) return candidate;
  // 原文有 CJK、往返后没了 → 往返毁掉了它，不能采用
  return `用户${uid.slice(-4)}`;
}

// ── 请求头 ──────────────────────────────────────────────

/**
 * SOLO 对话/模型列表头。
 * 注意 Authorization / X-Cloudide-Token / X-Ide-Token **三处同一值**，
 * 实测缺任一个都可能被上游拒绝。
 */
function soloHeaders(
  cred: TraeCredential,
  stream: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "application/json",
    "User-Agent": "TraeAgent/1.0.0",
    Authorization: `Cloud-IDE-JWT ${cred.access_token}`,
    "X-Cloudide-Token": cred.access_token,
    "X-Ide-Token": cred.access_token,
    "X-Uid": cred.uid,
    "X-App-Id": APP_ID,
    "X-App-Version": "default",
    "X-Ide-Version": IDE_VERSION,
    "X-Ide-Version-Code": IDE_VERSION_CODE,
    "X-App-Version-Code": IDE_VERSION_CODE,
    "X-Ide-Version-Type": "stable",
    "X-Device-Type": "macos",
    "X-OS-Version": "macOS 15.7.4",
    "X-Device-Brand": "Apple",
    "Request-Traffic-Type": "prod",
  };
  if (cred.machine_id.length > 0) headers["X-Machine-Id"] = cred.machine_id;
  if (cred.device_id.length > 0) headers["X-Device-Id"] = cred.device_id;
  return headers;
}

/** 签到/积分请求头（走 api.trae.cn，不带 SOLO 专属头）。 */
function ugHeaders(cred: TraeCredential): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "VSCode 1.107.1 (TRAE SOLO CN)",
    Authorization: `Cloud-IDE-JWT ${cred.access_token}`,
    "X-User-Region": "CN",
    ...(cred.device_id.length > 0 ? { "X-Device-Id": cred.device_id } : {}),
  };
}

// ── 步骤 1：登录 URL ───────────────────────────────────

/**
 * ⚠️ 参数一个都不能少：早期实现只发 5 个，登录页**永远停在授权中**。
 * 最易错的是回调参数名：必须是 `auth_callback_url`，
 * **不是** `callback_url`、也没有 `redirect_uri`。
 */
function buildLoginUrl(session: Session, callbackUrl: string): string {
  const params = new URLSearchParams({
    login_version: "1",
    auth_from: "solo",
    login_channel: "native_ide",
    plugin_version: PLUGIN_VERSION,
    auth_type: "local",
    client_id: CLIENT_ID,
    redirect: "0",
    login_trace_id: session.trace_id,
    auth_callback_url: callbackUrl,
    machine_id: session.machine_id,
    device_id: session.device_id,
    x_device_id: session.device_id,
    x_machine_id: session.machine_id,
    x_device_brand: "PC",
    x_device_type: "PC",
    x_os_version: "1.0",
    x_app_version: IDE_VERSION,
    x_app_type: "stable",
  });
  return `${CONSOLE_HOST}/authorization?${params.toString()}`;
}

// ── 步骤 2：本地回调服务 ───────────────────────────────

interface CallbackInfo {
  refreshToken: string;
  accessToken: string;
  uid: string;
  nickname: string;
}

/**
 * ⚠️ 回调**直接回传 token**，不是 OAuth 的 `?code=` 授权码。
 * 真实形态：`?refreshToken=...&userInfo={...}&userJwt={...}`
 * 但**两套流程并存**——PKCE 流程回带 `code`/`authCodeInfo`，
 * 那种回调是合法的，不能判为无效（否则报错指向完全错误的方向）。
 */
function parseCallback(
  url: URL,
): { ok: true; info: CallbackInfo } | { ok: false; reason: string } {
  const q = url.searchParams;
  const userInfo = parseJsonParam(q.get("userInfo"));
  const userJwt = parseJsonParam(q.get("userJwt"));

  let refreshToken = q.get("refreshToken") ?? "";
  const uid = jsonString(userInfo, "UserID");
  const nickname = fixNicknameMojibake(jsonString(userInfo, "ScreenName"), uid);
  const jwtToken = jsonString(userJwt, "Token");
  const jwtRefresh = jsonString(userJwt, "RefreshToken");
  if (refreshToken.length === 0) refreshToken = jwtRefresh;

  const authCodeInfo = parseJsonParam(q.get("authCodeInfo"));
  const authCode = [
    q.get("code") ?? "",
    q.get("authCode") ?? "",
    jsonString(authCodeInfo, "code"),
    jsonString(authCodeInfo, "authCode"),
    q.get("authCodeInfo") ?? "",
  ].find((c) => c.trim().length > 0)?.trim() ?? "";

  const info: CallbackInfo = {
    refreshToken,
    accessToken: refreshToken.length === 0 ? jwtToken : "",
    uid,
    nickname,
  };
  if (info.refreshToken.length === 0 && info.accessToken.length === 0) {
    if (authCode.length > 0) {
      return {
        ok: false,
        reason:
          "上游返回了 PKCE 授权码（code/authCodeInfo），本脚本只支持 refreshToken 直传流程。请告知此情况。",
      };
    }
    return {
      ok: false,
      reason: "回调未携带 refreshToken / userJwt.Token / code",
    };
  }
  return { ok: true, info };
}

function waitForCallback(traceId: string): Promise<CallbackInfo> {
  return new Promise((resolve, reject) => {
    const server = Deno.serve({
      port: PORT,
      hostname: "127.0.0.1",
      onListen: () => {},
    }, (req) => {
      const url = new URL(req.url);
      if (url.pathname !== "/authorize") {
        return new Response("not found", { status: 404 });
      }
      const parsed = parseCallback(url);
      if (!parsed.ok) {
        console.error("\n❌ " + parsed.reason);
        return new Response("login failed: " + parsed.reason, { status: 400 });
      }
      // TRAE 不保证回传 machine_id/device_id，但会回传 login_trace_id。
      if (url.searchParams.get("login_trace_id") !== traceId) {
        console.warn("\n⚠️ login_trace_id 不匹配，仍按已解析的回调处理");
      }
      const html = `<!doctype html><meta charset="utf-8"><title>OK</title>
<body style="font-family:system-ui;padding:3rem;text-align:center">
<h2>✅ 登录成功</h2><p>可以关闭这个页面了。</p></body>`;
      resolve(parsed.info);
      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });
    const timer = setTimeout(() => {
      server.shutdown();
      reject(new Error("10 分钟内未收到回调，登录超时"));
    }, 10 * 60 * 1000);
    // deno-lint-ignore no-explicit-any
    (server.finished as any).then(() => clearTimeout(timer));
  });
}

// ── 步骤 3：ExchangeToken ───────────────────────────────

/**
 * 用回调解出的凭证换最终凭据。
 * ⚠️ ExchangeToken 会**轮换** refreshToken（旧值即刻失效），必须回写。
 * ⚠️ 请求体字段是 **PascalCase**，且 ClientSecret 是字面量 `-`。
 */
async function exchangeCallback(
  cb: CallbackInfo,
  session: Session,
): Promise<TraeCredential> {
  let accessToken = cb.accessToken;
  let refreshToken = cb.refreshToken;
  let expiresAtMs = 0;

  if (cb.refreshToken.length > 0) {
    console.log("→ ExchangeToken 换 access token…");
    const resp = await fetch(OAUTH_HOST + EXCHANGE_PATH, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "TraeAgent/1.0.0",
      },
      body: JSON.stringify({
        ClientID: CLIENT_ID,
        RefreshToken: cb.refreshToken,
        ClientSecret: "-",
        UserID: "",
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(
        `ExchangeToken 失败 HTTP ${resp.status}：${text.slice(0, 200)}`,
      );
    }
    const body = await resp.json() as Record<string, unknown>;
    const result = (body.Result ?? body.result ?? body.Data ?? body) as Record<
      string,
      unknown
    >;
    accessToken = jsonString(result, "Token") ||
      jsonString(result, "AccessToken") || accessToken;
    refreshToken = jsonString(result, "RefreshToken") || refreshToken;
    const exp = Number(result.TokenExpireAt ?? result.ExpiresAt ?? 0);
    if (Number.isFinite(exp) && exp > 0) {
      expiresAtMs = exp > 1e12 ? exp : exp * 1000;
    }
    console.log("  ExchangeToken ok，refreshToken 已轮换（写回本地）");
  } else {
    console.log("→ 回调无 refreshToken，直接使用 userJwt.Token 兜底");
  }
  if (accessToken.length === 0) throw new Error("拿不到 access token");

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    // 统一存**毫秒时间戳字符串**（与本项目其它渠道约定一致）
    expires_at: String(expiresAtMs),
    uid: cb.uid,
    nickname: cb.nickname,
    machine_id: session.machine_id,
    device_id: session.device_id,
  };
}

// ── 探针 1：模型目录 + 倍率 ────────────────────────────

/**
 * 解析 `display_contact_config` 里的消耗倍率。
 * ⚠️ 它是**一个 JSON 字符串**而非对象，直接读 .consumption_rate 恒为 undefined。
 * ⚠️ `rate: 0` 是合法的「免费」，不能用 > 0 过滤。
 * ⚠️ `activity_discount.enable === true` **不等于**当前有折扣：
 * `off_peak` 型是 {type:"none", before:X, after:X, discount:100}，
 * 照显会得到「x0.13→x0.13」让人误以为有活动。
 */
function readRate(
  entry: Record<string, unknown>,
): { rate?: number; original?: number; endsAt?: string } {
  const raw = entry.display_contact_config ?? entry.DisplayContactConfig;
  if (typeof raw !== "string" || raw.length === 0) return {};
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }

  const out: { rate?: number; original?: number; endsAt?: string } = {};

  const rateObj = config.consumption_rate ?? config.ConsumptionRate;
  if (typeof rateObj === "object" && rateObj !== null) {
    const rec = rateObj as Record<string, unknown>;
    if (rec.enable !== false) {
      const data = rec.data ?? rec.Data;
      if (typeof data === "object" && data !== null) {
        const v = Number((data as Record<string, unknown>).rate);
        if (Number.isFinite(v) && v >= 0) out.rate = v;
      }
    }
  }

  const disc = config.activity_discount ?? config.ActivityDiscount;
  if (typeof disc === "object" && disc !== null) {
    const rec = disc as Record<string, unknown>;
    if (rec.enable !== false) {
      const current = (rec.data as Record<string, unknown> | undefined)
        ?.current as
          | Record<string, unknown>
          | undefined;
      if (current && current.discount_type !== "none") {
        const before = Number(current.before_consumption_rate);
        const after = Number(current.consumption_rate);
        if (
          Number.isFinite(before) && before > 0 && Number.isFinite(after) &&
          before > after
        ) {
          out.original = before;
          if (out.rate === undefined) out.rate = after;
          // end_at 只在 limited 型带；已过期必须整个不展示折扣
          const limited = (rec.data as Record<string, unknown>).limited as
            | Record<string, unknown>
            | undefined;
          const endAt = Number(limited?.end_at);
          if (Number.isFinite(endAt) && endAt > 0) {
            const endsMs = endAt * 1000;
            if (endsMs > Date.now()) {
              out.endsAt = new Date(endsMs).toISOString().slice(0, 10);
            }
          }
        }
      }
    }
  }
  return out;
}

function parseBatchModels(body: unknown) {
  const rec = body as Record<string, unknown>;
  const groups = rec.function_configs ?? rec.FunctionConfigs;
  if (!Array.isArray(groups)) return [];
  const rows: {
    id: string;
    channel: string;
    enabled: boolean;
    hidden: boolean;
    custom: boolean;
    context?: number;
    efforts: string[];
    thinking: boolean;
    rate?: number;
    original?: number;
    endsAt?: string;
  }[] = [];
  for (const group of groups) {
    const g = group as Record<string, unknown>;
    const channel = String(g.function ?? g.Function ?? "");
    const list = g.config_info_list ?? g.ConfigInfoList;
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const e = item as Record<string, unknown>;
      const name = e.config_name ?? e.ConfigName;
      if (typeof name !== "string" || name.length === 0) continue;
      const usage = e.usage ?? e.Usage;
      if (usage !== undefined && usage !== "chat_completion") continue;
      const display = (e.display_config ?? e.DisplayConfig ?? {}) as Record<
        string,
        unknown
      >;
      // ⚠️ 上游可能下发 `support_thinking:false` 却带 options（TRAE 实测有这形态），
      // 那种在适配器里仍返回 undefined（UI 显示「未提供推理等级」），
      // 故必须同时判「未显式 false」与「options 非空」。
      const rc = e.reasoning_effort_config as
        | Record<string, unknown>
        | undefined;
      const efforts = rc && rc.support_thinking !== false &&
          Array.isArray(rc.options)
        ? rc.options.filter((o): o is string => typeof o === "string")
        : [];
      const thinking = efforts.length > 0;
      const rateInfo = readRate(e);
      rows.push({
        id: name,
        channel,
        enabled: e.config_switch !== false,
        hidden: e.is_invisible_to_user === true,
        custom: display.is_custom_model === true,
        context: Number(
          (e.context_window_tokens as Record<string, unknown> | undefined)
            ?.dev,
        ) || undefined,
        efforts,
        thinking,
        ...rateInfo,
      });
    }
  }
  return rows;
}

async function probeModels(cred: TraeCredential) {
  const resp = await fetch(AGENT_HOST + BATCH_MODELS_PATH, {
    method: "POST",
    headers: soloHeaders(cred, false),
    body: JSON.stringify({
      functions: [
        "solo_agent",
        "solo_work_lite",
        "solo_agent_remote",
        "solo_design_lite",
        "solo_design_remote",
      ],
      agent_type: "",
      current_config_info: { config_name: "", is_custom_model: false },
      mode_type: 0,
      access_type: 0,
      ab_force_vids: "",
      ab_autotest_advanced_mode: 0,
      show_custom_model: true,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) {
    throw new Error(
      `目录拉取 HTTP ${resp.status}：${(await resp.text()).slice(0, 200)}`,
    );
  }
  return parseBatchModels(await resp.json());
}

// ── 探针 2/3：积分余额 + 签到状态 ──────────────────────

async function probeBalance(cred: TraeCredential) {
  // ⚠️ 必须带 require_usage:true，否则上游不返回 usage 明细，
  // credits_amount 恒缺省为 0，余额会等于额度总额（虚高）。
  const resp = await fetch(UG_HOST + ENT_USAGE_PATH, {
    method: "POST",
    headers: ugHeaders(cred),
    body: JSON.stringify({ require_usage: true, req_source: 2 }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) return { error: `HTTP ${resp.status}` };
  const body = await resp.json() as Record<string, unknown>;
  const list = (body.user_entitlement_pack_list ?? []) as unknown[];
  const packs: {
    name: string;
    total: number;
    used: number;
    remaining: number;
    expires?: string;
  }[] = [];
  let total = 0;
  for (const item of list) {
    const e = item as Record<string, unknown>;
    const base = e.entitlement_base_info as Record<string, unknown> | undefined;
    const quota = base?.quota as Record<string, unknown> | undefined;
    if (!quota) continue;
    const limit = Number(quota.credits_limit);
    if (!(limit > 0)) continue;
    const usage = e.usage as Record<string, unknown> | undefined;
    const used = usage ? Number(usage.credits_amount ?? 0) : 0;
    // ⚠️ expire_time 是**秒级**，不乘 1000 会落在 1970 年
    const expSec = Number(e.expire_time);
    const remaining = limit - used;
    packs.push({
      // ⚠️ 包名用 display_desc（实测「每月登录赠送」/「签到奖励」/「免费」），不是 base.name
      name: String(base?.display_desc ?? e.display_desc ?? "资源包"),
      total: limit,
      used,
      remaining,
      ...(Number.isFinite(expSec) && expSec > 0
        ? { expires: new Date(expSec * 1000).toISOString().slice(0, 10) }
        : {}),
    });
    total += remaining;
  }
  return { total: Math.round(total * 100) / 100, packs };
}

async function probeCheckin(cred: TraeCredential) {
  const resp = await fetch(UG_HOST + CHECKIN_STATUS_PATH, {
    method: "POST",
    headers: ugHeaders(cred),
    body: "{}",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) return { error: `HTTP ${resp.status}` };
  return await resp.json() as Record<string, unknown>;
}

// ── 主流程 ──────────────────────────────────────────────

function findBrowser(): string {
  const candidates = Deno.build.os === "windows"
    ? [
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    ]
    : [];
  for (const c of candidates) {
    try {
      if (Deno.statSync(c).isFile) return c;
    } catch { /* 下一个 */ }
  }
  throw new Error("未找到 Edge/Chrome");
}

async function main() {
  console.log("TRAE 登录 + 只读探针");
  console.log("=".repeat(60));

  const session: Session = {
    // ⚠️ device_id 是 **hex32**（不是 16 位数字——那是 CodeBuddy 的签到格式）
    machine_id: randomHex(16),
    device_id: randomHex(16),
    trace_id: "",
  };
  session.trace_id = machineTraceId(session.machine_id, session.device_id);
  console.log(`machine_id = ${session.machine_id}`);
  console.log(`device_id  = ${session.device_id}`);
  console.log(`trace_id   = ${session.trace_id}`);

  const callbackUrl = `http://127.0.0.1:${PORT}/authorize`;
  const loginUrl = buildLoginUrl(session, callbackUrl);
  const promise = waitForCallback(session.trace_id);

  console.log("\n🌐 打开浏览器，请在 TRAE 页面完成登录/授权…");
  console.log(`   若未自动打开，请手动访问：\n   ${loginUrl}\n`);
  const browser = findBrowser();
  new Deno.Command(browser, {
    args: [loginUrl],
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();

  const cb = await promise;
  console.log(`\n✅ 收到回调：uid=${cb.uid} nickname=${cb.nickname}`);

  const cred = await exchangeCallback(cb, session);
  await Deno.writeTextFile(OUTPUT, JSON.stringify(cred, null, 2));
  console.log(`💾 凭据已写入 ${OUTPUT}（已 gitignore）`);

  // ── 探针 ──
  console.log("\n" + "=".repeat(60));
  console.log("探针 1/3：模型目录（不消耗额度）");
  console.log("=".repeat(60));
  try {
    const rows = await probeModels(cred);
    // 合并：同 id 多通道，按「空档位不得覆盖有档位」择优
    const byId = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      const prev = byId.get(r.id);
      if (prev === undefined) {
        byId.set(r.id, r);
        continue;
      }
      if (prev.thinking && !r.thinking) continue;
      byId.set(r.id, r);
    }
    const usable = [...byId.values()].filter((r) =>
      !r.custom && r.enabled && !r.hidden
    );
    const blocked = [...byId.values()].filter((r) =>
      r.custom || !r.enabled || r.hidden
    );
    console.log(
      `合并 ${byId.size} 条 → 过滤后 ${usable.length} 条可用 / ${blocked.length} 条被过滤`,
    );
    console.log(
      "\n模型".padEnd(28) + "倍率".padEnd(12) + "通道".padEnd(20) + "思考档",
    );
    for (const r of usable.sort((a, b) => (a.rate ?? 9) - (b.rate ?? 9))) {
      const price = r.rate === undefined
        ? "?"
        : r.original !== undefined
        ? `x${r.original}→x${r.rate}`
        : r.rate === 0
        ? "免费"
        : `x${r.rate}`;
      const efforts = r.thinking ? r.efforts.join("/") : "(无)";
      console.log(
        r.id.padEnd(28) + price.padEnd(12) + r.channel.padEnd(20) + efforts,
      );
    }
    if (blocked.length > 0) {
      console.log("\n被过滤的条目：");
      for (const r of blocked) {
        const why = r.custom
          ? "自定义模型"
          : !r.enabled
          ? "已停用"
          : "官方隐藏";
        console.log(`  ${r.id} — ${why}`);
      }
    }
  } catch (e) {
    console.error(
      "❌ 目录探针失败：" + (e instanceof Error ? e.message : String(e)),
    );
  }

  console.log("\n" + "=".repeat(60));
  console.log("探针 2/3：积分余额（不消耗额度）");
  console.log("=".repeat(60));
  try {
    const bal = await probeBalance(cred);
    if ("error" in bal) console.error("❌ " + bal.error);
    else {
      console.log(`可用积分合计：${bal.total}`);
      for (const p of bal.packs) {
        console.log(
          `  ${p.name.padEnd(16)} ${
            String(p.remaining).padStart(8)
          } / ${p.total}` +
            `  到期 ${p.expires ?? "永久"}`,
        );
      }
    }
  } catch (e) {
    console.error("❌ " + (e instanceof Error ? e.message : String(e)));
  }

  console.log("\n" + "=".repeat(60));
  console.log("探针 3/3：今日签到状态（不消耗额度）");
  console.log("=".repeat(60));
  try {
    const st = await probeCheckin(cred);
    console.log(JSON.stringify(st, null, 1));
  } catch (e) {
    console.error("❌ " + (e instanceof Error ? e.message : String(e)));
  }

  console.log("\n" + "=".repeat(60));
  console.log("完成。下一步需要拿账号实发一次对话，确认哪些模型真能推理。");
}

if (import.meta.main) {
  try {
    await main();
  } catch (e) {
    console.error("\n❌ " + (e instanceof Error ? e.message : String(e)));
    Deno.exit(1);
  }
}
