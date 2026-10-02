/**
 * WorkBuddy（中国版）登录 + 只读探针（一次性取证 / 日常登录入口）
 *
 * 运行：
 *   deno run -A .tmp-workbuddy-login.ts
 *
 * 流程（轮询式，客户端不起本地回调服务器）：
 *   1. POST /v2/plugin/auth/state?platform=workbuddy-ai  → state + authUrl
 *   2. 打开浏览器到 authUrl，你在页面里完成登录
 *   3. 轮询 GET /v2/plugin/auth/token?state=…（11217 = 还在登录中，继续等）
 *   4. 轮询 GET /v2/plugin/login/account?state=…（12151 = 账号信息未就绪）
 *   5. 写入 workbuddy-auth.json（已 gitignore）
 *   6. 跑只读探针：**三个 host 的模型目录** / 个人模型端点 / 账号资源 / 签到状态
 *
 * 全部探针**不消耗任何模型额度**。
 *
 * ⚠️ 第 6 步是移植计划 §4 步骤 0 的目的：同一个令牌分别打
 *    https://www.workbuddy.cn/v3/config 、https://copilot.tencent.com/v3/config
 *    与 https://www.workbuddy.ai/v3/config，看哪一边返回**非空** data.models，
 *    以此定稿 host 与 X-Domain。「HTTP 200 + models:null」不算数
 *    （见 AGENTS.md：业务 OK ≠ 有数据）。
 */

import {
  ACCOUNTS_PATH,
  AUTH_STATE_PATH,
  AUTH_TOKEN_PATH,
  buildCredential,
  CODE_ACCOUNT_NOT_READY,
  CODE_TOKEN_NOT_READY,
  CONFIG_PATH,
  HTTP_HEADER_DOMAIN,
  HTTP_HEADER_NO_AUTHORIZATION,
  HTTP_HEADER_NO_ENTERPRISE_ID,
  HTTP_HEADER_NO_USER_ID,
  isRecord,
  LOGIN_ACCOUNT_PATH,
  LOGIN_TIMEOUT_MS,
  parseAccountData,
  parseModelsFromConfig,
  parseTokenData,
  POLL_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
  safeParseJson,
  SCOPED_MODELS_PATH,
  STATE_REQUEST_TIMEOUT_MS,
  WORKBUDDY_API_DOMAIN,
  WORKBUDDY_CLIENT_VERSION,
  WORKBUDDY_ENDPOINT,
  WORKBUDDY_PLATFORM,
  WORKBUDDY_USER_AGENT,
  workBuddyAnonymousHeaders,
  workBuddyCatalogHeaders,
  type WorkBuddyCredential,
  type WorkBuddyToken,
} from "./src/workbuddy.ts";
import { writeWorkBuddyCredential } from "./src/workbuddy-account.ts";

/**
 * 候选 host。**只用于**「哪个 host 才是真中国版」这一步比对，不参与正常流程。
 *
 * 三个站点路由集完全相同（401 而非 404），所以「路由存在」证明不了 host；
 * 判据只能是「带真令牌时谁返回非空模型目录」。
 */
const CANDIDATE_ENDPOINTS = [
  WORKBUDDY_ENDPOINT,
  "https://copilot.tencent.com",
  "https://www.workbuddy.ai",
];

const OUTPUT = "./workbuddy-auth.json";
const ROOT = ".";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function responseCode(body: unknown): number {
  if (!isRecord(body)) return 0;
  const code = body.code;
  return typeof code === "number" && Number.isFinite(code) ? code : 0;
}

function responseMessage(body: unknown): string {
  if (!isRecord(body)) return "";
  const msg = body.msg;
  if (typeof msg === "string" && msg.length > 0) return msg;
  const message = body.message;
  return typeof message === "string" ? message : "";
}

function responseData(body: unknown): unknown {
  if (!isRecord(body)) return undefined;
  const data = body.data;
  return data === null ? undefined : data;
}

async function request(
  method: "GET" | "POST",
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  body?: string,
): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      ...body === undefined ? {} : { body },
    });
  } catch (error) {
    throw new Error(method + " " + url + " 网络错误: " + String(error));
  }
  // 先 text 再 try-parse：网关的 401 是 openresty 的 HTML，直接 json() 会抛。
  const text = await response.text();
  return { status: response.status, body: safeParseJson(text) };
}

// ── 登录三步 ────────────────────────────────────────────

async function fetchAuthState(): Promise<{ state: string; authUrl: string }> {
  const url = WORKBUDDY_ENDPOINT + AUTH_STATE_PATH +
    "?platform=" + encodeURIComponent(WORKBUDDY_PLATFORM);
  const { status, body } = await request(
    "POST",
    url,
    workBuddyAnonymousHeaders(),
    STATE_REQUEST_TIMEOUT_MS,
    "{}",
  );
  if (status !== 200) {
    throw new Error("auth/state HTTP " + status + ": " + responseMessage(body));
  }
  const data = responseData(body);
  if (!isRecord(data)) {
    throw new Error("auth/state 响应缺少 data 字段: " + JSON.stringify(body));
  }
  const state = typeof data.state === "string" ? data.state : "";
  const authUrl = typeof data.authUrl === "string" ? data.authUrl : "";
  if (state.length === 0) throw new Error("auth/state 响应缺少 state 字段");
  if (authUrl.length === 0) throw new Error("auth/state 响应缺少 authUrl 字段");
  return { state, authUrl };
}

/**
 * 登录页 URL 追加 version 与 loginSessionId。
 *
 * ⚠️ **只追加、不重建**：URL 里已有的 query（platform / state）必须原样保留，
 * 重建会丢参数、登录页直接失效。URL 非法时原样返回，不抛错。
 *
 * ⚠️ 这两个参数是从国际版实现继承的，对中国版**未实测**（计划附录 B 的开放问题
 * 之一）。保留是因为缺参数的后果是「服务端不认这次登录」，而多参数只是无害的
 * query —— 两种情况下先按国际版形态发，等实测出来再删。
 */
function decorateLoginUrl(authUrl: string): string {
  try {
    const url = new URL(authUrl);
    url.searchParams.set("version", WORKBUDDY_CLIENT_VERSION);
    url.searchParams.set("loginSessionId", crypto.randomUUID());
    return url.toString();
  } catch {
    return authUrl;
  }
}

async function loopGetToken(state: string): Promise<WorkBuddyToken> {
  const url = WORKBUDDY_ENDPOINT + AUTH_TOKEN_PATH +
    "?state=" + encodeURIComponent(state);
  const headers = {
    [HTTP_HEADER_NO_AUTHORIZATION]: "true",
    "User-Agent": WORKBUDDY_USER_AGENT,
  };
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  for (;;) {
    if (Date.now() >= deadline) throw new Error("获取 token 超时（5 分钟）");
    // 先睡再请求：服务端把「刚建 state」也当未就绪，立刻查只会白拿一个 11217。
    await sleep(POLL_INTERVAL_MS);
    let result: { status: number; body: unknown };
    try {
      result = await request("GET", url, headers, REQUEST_TIMEOUT_MS);
    } catch {
      continue; // 网络抖动不中断登录
    }
    const { status, body } = result;
    if (status === 200) {
      const data = responseData(body);
      if (data !== undefined) return parseTokenData(data);
      continue;
    }
    const code = responseCode(body);
    if (code === CODE_TOKEN_NOT_READY) continue;
    throw new Error(
      "auth/token HTTP " + status + " code=" + code + ": " +
        responseMessage(body),
    );
  }
}

async function loopGetAccount(
  state: string,
  token: WorkBuddyToken,
): Promise<ReturnType<typeof parseAccountData>> {
  const url = WORKBUDDY_ENDPOINT + LOGIN_ACCOUNT_PATH +
    "?state=" + encodeURIComponent(state);
  const headers = {
    // ⚠️ 登录阶段**服务端刚下发**的 domain 是权威值（与本次会话同时签发），所以
    // 这里优先用 token.domain，只在它为空串时才回退产品常量。与聊天请求的
    // 「产品常量优先」方向相反，这个差异是刻意的，不是笔误。
    [HTTP_HEADER_DOMAIN]: token.domain || WORKBUDDY_API_DOMAIN,
    "Authorization": "Bearer " + token.accessToken,
    [HTTP_HEADER_NO_USER_ID]: "true",
    [HTTP_HEADER_NO_ENTERPRISE_ID]: "true",
    "User-Agent": WORKBUDDY_USER_AGENT,
  };
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  for (;;) {
    if (Date.now() >= deadline) {
      throw new Error("获取账户信息超时（5 分钟）");
    }
    await sleep(POLL_INTERVAL_MS);
    let result: { status: number; body: unknown };
    try {
      result = await request("GET", url, headers, REQUEST_TIMEOUT_MS);
    } catch {
      continue;
    }
    const { status, body } = result;
    if (status === 200) {
      const data = responseData(body);
      if (data !== undefined) return parseAccountData(data);
      continue;
    }
    const code = responseCode(body);
    if (code === CODE_ACCOUNT_NOT_READY) continue;
    throw new Error(
      "login/account HTTP " + status + " code=" + code + ": " +
        responseMessage(body),
    );
  }
}

// ── 只读探针 ────────────────────────────────────────────

async function probeConfig(
  credential: WorkBuddyCredential,
  endpoint: string,
): Promise<void> {
  const label = endpoint.replace("https://", "");
  console.log("");
  console.log("──── /v3/config @ " + label + " ────");
  try {
    const { status, body } = await request(
      "GET",
      endpoint + CONFIG_PATH,
      {
        ...workBuddyCatalogHeaders(credential),
        // 探针要能打任意候选 host，所以 X-Domain 跟随目标 host ——
        // 拿 A 站的域名去问 B 站，问不出真实结果。
        [HTTP_HEADER_DOMAIN]: label,
        "Accept": "application/json",
      },
      REQUEST_TIMEOUT_MS,
    );
    if (status !== 200) {
      console.log("  HTTP " + status + ": " + responseMessage(body));
      return;
    }
    const models = parseModelsFromConfig(body);
    // ⚠️ 判据是**非空数组**，不是 code===0：实测无效 Bearer 也会拿到
    // 200 + code 0 + models:null。
    if (models.length === 0) {
      console.log(
        "  models 为空（200 但没有数据 —— 不算成功，见 AGENTS.md「业务 OK ≠ 有数据」）",
      );
      return;
    }
    console.log("  ✅ " + models.length + " 个模型");
    for (const model of models.slice(0, 30)) {
      const bits: string[] = [];
      if (model.contextWindow !== undefined) {
        bits.push("ctx=" + model.contextWindow);
      }
      if (model.maxOutputTokens !== undefined) {
        bits.push("out=" + model.maxOutputTokens);
      }
      if (model.supportsImages === true) bits.push("vision");
      if (model.reasoningEfforts?.length) {
        bits.push("efforts=" + model.reasoningEfforts.join("/"));
      }
      const rate = model.discountedCreditsRate ?? model.creditsRate;
      if (rate !== undefined) bits.push(rate);
      if (model.agentReferenced === true) bits.push("agent");
      console.log(
        "    " + model.id.padEnd(28) + " " + model.name.padEnd(26) +
          bits.join(" "),
      );
    }
    if (models.length > 30) {
      console.log("    … 其余 " + (models.length - 30) + " 个略");
    }
  } catch (error) {
    console.log("  ❌ " + String(error));
  }
}

async function probeScopedModels(
  credential: WorkBuddyCredential,
): Promise<void> {
  console.log("");
  console.log("──── 个人模型端点 @ " + WORKBUDDY_API_DOMAIN + " ────");
  try {
    const { status, body } = await request(
      "GET",
      WORKBUDDY_ENDPOINT + SCOPED_MODELS_PATH,
      {
        ...workBuddyCatalogHeaders(credential),
        "Accept": "application/json",
      },
      REQUEST_TIMEOUT_MS,
    );
    if (status !== 200) {
      console.log(
        "  HTTP " + status + "（非 200 ⇒ 该端点不适用，回退 /v3/config）",
      );
      return;
    }
    const data = responseData(body);
    const rows = isRecord(data) && Array.isArray(data.models)
      ? data.models
      : Array.isArray(body)
      ? body
      : [];
    console.log("  ✅ " + rows.length + " 条");
    for (const row of rows.slice(0, 30)) {
      if (!isRecord(row)) continue;
      const id = typeof row.id === "string" ? row.id : "?";
      const name = typeof row.name === "string" ? row.name : "";
      console.log("    " + id.padEnd(28) + " " + name);
    }
  } catch (error) {
    console.log("  ❌ " + String(error));
  }
}

async function probeAccountResource(
  credential: WorkBuddyCredential,
): Promise<void> {
  console.log("");
  console.log("──── 账号资源 " + ACCOUNTS_PATH + " ────");
  try {
    const { status, body } = await request(
      "GET",
      WORKBUDDY_ENDPOINT + ACCOUNTS_PATH,
      { ...workBuddyCatalogHeaders(credential), "Accept": "application/json" },
      REQUEST_TIMEOUT_MS,
    );
    console.log("  HTTP " + status);
    console.log("  " + JSON.stringify(body).slice(0, 1200));
  } catch (error) {
    console.log("  ❌ " + String(error));
  }
}

async function probeCheckinStatus(
  credential: WorkBuddyCredential,
): Promise<void> {
  console.log("");
  console.log("──── 签到状态（只读，不 claim） ────");
  for (
    const path of [
      "/v2/billing/meter/checkin-activity-status",
      "/v2/billing/meter/checkin-status",
    ]
  ) {
    try {
      const { status, body } = await request(
        "POST",
        WORKBUDDY_ENDPOINT + path,
        {
          ...workBuddyCatalogHeaders(credential),
          "Content-Type": "application/json",
        },
        REQUEST_TIMEOUT_MS,
        "{}",
      );
      console.log("  " + path + " → HTTP " + status);
      console.log("    " + JSON.stringify(body).slice(0, 600));
    } catch (error) {
      console.log("  " + path + " → ❌ " + String(error));
    }
  }
}

// ── 浏览器 ──────────────────────────────────────────────

/**
 * 打开浏览器。
 *
 * ⚠️ 走 cmd /c start 而不是直接 spawn 浏览器：WorkBuddy 登录 URL 带 &，
 * 直接 spawn 时 Windows 的参数解析会把它截断在第一个 &（浏览器只收到
 * ?theme=2）。参考实现 login.ts 的注释记录了同样的坑，并且必须显式传一对空引号
 * 作为 start 的窗口标题参数 —— 否则 start 把 URL 当标题，浏览器根本不打开。
 *
 * ⚠️ Deno 的开关叫 `windowsRawArguments`（Node 那边叫
 * `windowsVerbatimArguments`）：同一个语义的键，两边名字不同，照抄参考实现的
 * 键名会直接编译不过。
 *
 * ⚠️ **不抛错**：打不开浏览器不该让整个登录失败，调用方回落到「手动访问上面
 * 打印出来的 URL」。
 */
function openBrowser(url: string): void {
  try {
    if (Deno.build.os === "windows") {
      new Deno.Command("cmd", {
        args: ["/c", "start", '""', '"' + url + '"'],
        stdin: "null",
        stdout: "null",
        stderr: "null",
        windowsRawArguments: true,
      }).spawn().unref();
      return;
    }
    const opener = Deno.build.os === "darwin" ? "open" : "xdg-open";
    new Deno.Command(opener, {
      args: [url],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn().unref();
  } catch (error) {
    console.error("打不开浏览器，请手动访问上面的 URL：", error);
  }
}

async function main(): Promise<void> {
  console.log("WorkBuddy（中国版）登录 + 只读探针");
  console.log("=".repeat(60));

  const { state, authUrl } = await fetchAuthState();
  console.log("state = " + state);
  const loginUrl = decorateLoginUrl(authUrl);
  console.log("");
  console.log("🌐 打开浏览器，请在 WorkBuddy 页面完成登录…");
  console.log("   若未自动打开，请手动访问：");
  console.log("   " + loginUrl);
  console.log("");
  openBrowser(loginUrl);

  const token = await loopGetToken(state);
  console.log("");
  console.log(
    "✅ 拿到 token（expires_at=" + (token.expiresAt || "未知") + "）",
  );
  const account = await loopGetAccount(state, token);
  console.log(
    "✅ 账号：uid=" + (account.uid || "?") + " nickname=" +
      (account.nickname || "?") + " type=" + account.accountType +
      " domain=" + (token.domain || "(空串)"),
  );

  const credential = buildCredential(token, account);
  await writeWorkBuddyCredential(ROOT, credential);
  console.log("💾 凭据已写入 " + OUTPUT + "（已 gitignore）");
  console.log(
    "   access_token 前 24 字符：" + credential.access_token.slice(0, 24) + "…",
  );

  console.log("");
  console.log("=== 只读探针（不消耗模型额度）===");
  for (const endpoint of CANDIDATE_ENDPOINTS) {
    await probeConfig(credential, endpoint);
  }
  await probeScopedModels(credential);
  await probeAccountResource(credential);
  await probeCheckinStatus(credential);

  console.log("");
  console.log("=".repeat(60));
  console.log(
    "结论看这里：哪个 host 的 /v3/config 返回了**非空** models —— 那就是它。",
  );
  console.log("若三个都为空，把上面整段输出发我，我们再定 host 策略。");
}

if (import.meta.main) {
  await main();
}
