import {
  cloneHeadersForUpstream,
  createStreamTransformer,
  ENV,
  filterHealthyModels,
  getModelHealth,
  getProviderHealth,
  probeChannel,
  providers,
  safeJsonParse,
  tryParseResponse,
} from "./src/core.ts";
export { ENV } from "./src/core.ts";
import { CatalogRegistry, isRosterDegraded } from "./src/runtime/health.ts";
import { CNB_MODELS, handleCnb } from "./src/cnb.ts";
import { readJsonBodyLimited } from "./src/deepseek-responses.ts";
import { handleDeepseekWeb } from "./src/deepseek-web.ts";
import { fetchZenModels, handleZen } from "./src/zen.ts";
import {
  getCommandCodeModels,
  handleCommandCode,
  peekCommandCodeModels,
} from "./src/commandcode/handler.ts";
import {
  claimTraeDailyCheckin,
  fetchTraeBalance,
  fetchTraeCheckinStatus,
  isTraeExpired,
  readTraeCredential,
  refreshTraeIfNeeded,
} from "./src/trae-account.ts";
import {
  fetchTraeCatalog,
  handleTraeChat,
  toModelCard,
  type TraeModel,
} from "./src/trae.ts";
import {
  buildChatBody,
  CHAT_COMPLETIONS_PATH,
  guardWorkBuddyStream,
  isWorkBuddyExpired,
  isWorkBuddyRefreshable,
  postWorkBuddyChatWithThrottleRetry,
  toWorkBuddyModelCard,
  tripWorkBuddyCircuit,
  WORKBUDDY_ENDPOINT,
  workBuddyChatHeaders,
  type WorkBuddyChatPlan,
  workBuddyCooldownRemaining,
  type WorkBuddyCredential,
  type WorkBuddyModel,
  workBuddyRetryAfterMs,
} from "./src/workbuddy.ts";
import {
  fetchWorkBuddyModels,
  isWorkBuddyUsable,
  readWorkBuddyCredential,
  refreshWorkBuddyCredential,
  refreshWorkBuddyIfNeeded,
  writeWorkBuddyCredential,
} from "./src/workbuddy-account.ts";
// The credential sits next to the project sources, like the deepseek login state.
// Resolved per request rather than once at import so a restart is not needed after
// the capture script writes it.
const TRAE_ROOT = new URL(".", import.meta.url).pathname.replace(/\/+$/, "")
  .replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1));
// Same resolution as TRAE_ROOT, same reason: the login script writes the
// credential next to the sources, so picking it up must not require a restart.
const WORKBUDDY_ROOT = TRAE_ROOT;
// ---------- 鉴权 ----------
function checkAuth(request: Request) {
  const authHeader = request.headers.get("authorization");
  const apiKeyHeader = request.headers.get("x-api-key");
  const allowedKeys = ENV.API_KEYS.split(",").map((k) => k.trim()).filter(
    Boolean,
  );
  if (allowedKeys.length === 0) return true;
  let providedKey: string | null = null;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    providedKey = authHeader.slice(7);
  } else if (apiKeyHeader) providedKey = apiKeyHeader;
  return !!providedKey && allowedKeys.includes(providedKey);
}

// ---------- 缓存 ----------
// How long a complete roster is kept, and how long an incomplete one is. The short
// window recovers from a startup race without re-polling every member on every request.
const cache: any = {
  data: {},
  TTL: 5 * 60 * 1000,
  DEGRADED_TTL: 15 * 1000,
};

// ---------- 主处理 ----------
// 反向代理模式：BACKEND_URL 有值时纯转发（流式进出，不解析），重活由后端干
async function readProxyBody(request: Request): Promise<Uint8Array | Response> {
  const maximum = Number(ENV.MAX_REQUEST_BODY_BYTES || 12 * 1024 * 1024);
  const limit = Number.isSafeInteger(maximum) && maximum > 0
    ? maximum
    : 12 * 1024 * 1024;
  const declared = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > limit) {
    return new Response(
      JSON.stringify({ error: "Request body is too large" }),
      { status: 413 },
    );
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        try {
          await reader.cancel();
        } catch { /* already closed */ }
        return new Response(
          JSON.stringify({ error: "Request body is too large" }),
          { status: 413 },
        );
      }
      chunks.push(value);
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  } finally {
    try {
      reader.releaseLock();
    } catch { /* already released */ }
  }
}

async function proxyToBackend(request: Request): Promise<Response> {
  const base = ENV.BACKEND_URL.replace(/\/+$/, "");
  const url = new URL(request.url);
  const target = base + url.pathname + url.search;
  const headers = new Headers();
  for (
    const name of [
      "content-type",
      "authorization",
      "accept",
      "user-agent",
      "x-api-key",
      "x-session-id",
      "x-conversation-id",
      "x-commandcode-admin-key",
    ]
  ) {
    const v = request.headers.get(name);
    if (v) headers.set(name, v);
  }
  headers.set("x-commandcode-internal-proxy", "1");
  // 仅对幂等请求重试；非幂等 POST 不自动重放，避免上游已计费后重复提交
  let body: Uint8Array | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const limited = await readProxyBody(request);
    if (limited instanceof Response) return limited;
    body = limited;
  }
  const canRetry = ["GET", "HEAD", "OPTIONS"].includes(
    request.method.toUpperCase(),
  );
  for (let attempt = 0; attempt < (canRetry ? 2 : 1); attempt++) {
    try {
      const resp = await fetch(target, {
        method: request.method,
        headers,
        body: body === undefined ? undefined : new Uint8Array(body.slice(0)),
        // @ts-ignore 流式请求体需要
        duplex: body === undefined ? "half" : undefined,
      });
      return resp;
    } catch (e: any) {
      if (canRetry && attempt === 0) {
        console.warn(
          `[proxy] fetch to backend failed (${e?.message || e}), retrying once`,
        );
        continue;
      }
      throw e;
    }
  }
  throw new Error("unreachable");
}

// ---------- /v1 聚合端点：一个入口用多个上游（kilo / zen / cnb / commandcode） ----------
// 模型 id 带命名空间前缀，GET /v1/models 聚合列出全部成员模型；POST 按前缀重写后
// 递归走成员 handler。裸 id 保持旧优先级，列表冷启动需先 GET 一次 /v1/models 暖缓存。
// openrouter is a member but withholds itself until a key is configured: an
// unauthenticated listing answers 401, and a channel that shows up and then 401s
// is worse than one that says it needs a key. `openrouterConfigured` is what the
// panel reports back so the switch and the roster agree.
const V1_AGGREGATE_MEMBERS = [
  "kilo",
  "zen",
  "cnb",
  "commandcode",
  "openrouter",
  // deepseek-web is served on its own prefix, but it has to be a member as well:
  // the harness's model catalog is built from `adapter.listModels()`, which reads
  // this aggregate, not from the plugin's separate project listing. Left out here,
  // the panel showed all ten of its models while the picker had none of them.
  "deepseek-web",
  // WorkBuddy joins for the same reason: its catalog is read from the account
  // file, so leaving it out would report a channel whose models the harness
  // cannot see at all.
  "workbuddy",
  // TRAE joins for the same reason, plus one more: its catalog is read from the
  // account's remote listing, so leaving it out would report a channel whose
  // models the harness cannot see at all.
  "trae",
];

/**
 * Whether a channel has the credential its auth block asks for.
 *
 * The panel writes keys into settings and the plugin passes them to this process
 * as environment variables, so "configured" is answered here rather than inferred
 * from a failed request: a 401 from an unauthenticated listing is indistinguishable
 * from a dead upstream in the log, and the two need different fixes.
 */
function hasChannelCredential(key: string, provider: any): boolean {
  const auth = provider?.auth;
  if (!auth || auth.type === "none") return true;
  if (auth.type === "bearer") {
    // Per-provider first, shared fallback last: a provider that names its own
    // variable is expected to have been given one, and DEFAULT_BEARER_TOKEN is the
    // single-channel setup that must not silently serve the wrong upstream.
    return Boolean(
      auth.defaultToken ||
        (auth.envToken ? ENV[auth.envToken] : undefined) ||
        ENV.DEFAULT_BEARER_TOKEN,
    );
  }
  if (auth.type === "api-key") {
    const name = auth.header || "x-api-key";
    return Boolean(ENV[name.toUpperCase().replace(/-/g, "_")]);
  }
  return true;
}
function v1MemberModelIds(key: string): string[] {
  if (key === "cnb") return CNB_MODELS.map((m: any) => m.id);
  if (key === "commandcode") {
    return peekCommandCodeModels().map((model: any) => String(model.id));
  }
  return (cache.data[key]?.data?.data || []).map((m: any) => m.id);
}

function v1ResolveModel(model: string): { key: string; raw: string } | null {
  const slash = model.indexOf("/");
  if (slash > 0) {
    const key = model.slice(0, slash);
    if (V1_AGGREGATE_MEMBERS.includes(key)) {
      return { key, raw: model.slice(slash + 1) };
    }
    return null;
  }
  for (const key of V1_AGGREGATE_MEMBERS) {
    if (v1MemberModelIds(key).includes(model)) return { key, raw: model };
  }
  return null;
}

/**
 * What each aggregate member returned the last time it was asked for a model list.
 *
 * Separate from the probe registry on purpose: a probe answers whether a gateway can
 * serve a turn and only runs on demand, while this answers whether the channel is
 * *in the picker right now*, which is the question a shrinking roster raises.
 */
const catalog = new CatalogRegistry();

/**
 * A channel's own model listing, for a channel that is not an aggregate member.
 *
 * Asked of the local server rather than the upstream: the channel's handler is
 * where its listing is normalised, and deepseek-web's in particular is a fixed set
 * of variants the proxy answers from its own state.
 */
async function v1FetchOwnListing(prefix: string): Promise<any[]> {
  const port = ENV.PORT || 8000;
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/${prefix}/v1/models`,
      {
        headers: {
          authorization: `Bearer ${ENV.DEFAULT_BEARER_TOKEN || "public"}`,
        },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) return [];
    const parsed = await response.json();
    return Array.isArray(parsed?.data) ? parsed.data : [];
  } catch {
    // A channel that will not list is a channel with nothing to probe.
    return [];
  }
}

/** 模块级 JSON 响应。TRAE handler 在模块作用域，所以不能复用 handler 内的闭包。 */
function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * TRAE 目录缓存。
 *
 * 目录来自账号的远端列表，而**推理派发需要目录里的通道**（模型只在列出它的
 * 通道里可调用）。所以这份目录不是锦上添花的元数据，而是路由表的一部分 ——
 * 拉不到目录就没有正确路由，本代理宁可拒绝也不猜通道。
 *
 * 5 分钟窗口：面板要活列表，但每次派发都打一次上游会把免费额度换成请求数。
 */
const traeCatalog = {
  models: [] as TraeModel[],
  at: 0,
  loading: null as Promise<TraeModel[]> | null,
};

async function loadTraeCatalog(force = false): Promise<TraeModel[]> {
  const now = Date.now();
  if (
    !force && traeCatalog.models.length > 0 && now - traeCatalog.at < 300_000
  ) {
    return traeCatalog.models;
  }
  // 在飞请求共享一个 Promise：面板每 10 秒轮询一次，不共享就是每次都打上游。
  if (traeCatalog.loading !== null) return await traeCatalog.loading;
  const pending = (async () => {
    const credential = await readTraeCredential(TRAE_ROOT);
    if (credential === undefined) {
      throw new Error(
        "no TRAE credential. run: deno run -A .tmp-trae-login.ts",
      );
    }
    try {
      await refreshTraeIfNeeded(TRAE_ROOT, credential);
    } catch (error) {
      console.warn(
        "[trae] token refresh failed:",
        error instanceof Error ? error.message : error,
      );
    }
    const models = await fetchTraeCatalog(credential);
    // 一个模型都没有 = 上游没答上来，不是「这里什么都没有」。
    // 保留上一份目录，否则一次坏读会让整个渠道消失 5 秒。
    if (models.length === 0) {
      throw new Error(
        traeCatalog.models.length > 0
          ? "the remote listing came back empty (kept the previous one)"
          : "no TRAE models are available for this account",
      );
    }
    traeCatalog.models = models;
    traeCatalog.at = Date.now();
    console.log("[trae] catalog: " + models.length + " model(s) loaded");
    return models;
  })();
  traeCatalog.loading = pending;
  try {
    return await pending;
  } finally {
    // 无论成败都要清空，否则一次失败会把闸门永久卡住。
    traeCatalog.loading = null;
  }
}

async function handleTrae(path: string, request: Request): Promise<Response> {
  if (path === "/trae/v1/models") {
    try {
      const models = await loadTraeCatalog(
        request.url.includes("refresh=true"),
      );
      return jsonResponse({ object: "list", data: models.map(toModelCard) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[trae] catalog failed: " + message);
      return jsonResponse({ error: message }, 502);
    }
  }

  if (path === "/trae/v1/chat/completions" && request.method === "POST") {
    const parsed = await readJsonBodyLimited(request);
    // It answers {ok, value} / {ok:false, message, status} - not the body
    // itself. Treating the envelope as the body made every request look like it
    // had no model.
    if (!parsed.ok) {
      return jsonResponse({ error: parsed.message }, parsed.status);
    }
    const body = parsed.value as Record<string, unknown>;
    const requested = typeof body?.model === "string" ? String(body.model) : "";
    if (requested.length === 0) {
      return jsonResponse({ error: "model is required" }, 400);
    }

    let models: TraeModel[];
    try {
      models = await loadTraeCatalog();
    } catch (error) {
      return jsonResponse(
        { error: error instanceof Error ? error.message : String(error) },
        502,
      );
    }
    const model = models.find((entry) => entry.id === requested);
    if (model === undefined) {
      return jsonResponse({
        error: "Unknown TRAE model: " + requested,
        // 报出可选值而不是一句「未知」：前缀式路由剥掉 trae/ 后如果拿到的是
        // 别处的 id，这里是唯一能看出「少了前缀」的地方。
        available: models.map((entry) => entry.id).slice(0, 40),
      }, 400);
    }

    const credential = await readTraeCredential(TRAE_ROOT);
    if (credential === undefined) {
      return jsonResponse({ error: "no TRAE credential" }, 409);
    }
    try {
      await refreshTraeIfNeeded(TRAE_ROOT, credential);
    } catch (error) {
      // 非致命：让上游决定。过期 token 和没有 token 失败方式一样，
      // 而把一个换成另一个只会掩盖真正的原因。
      console.warn(
        "[trae] pre-chat refresh failed:",
        error instanceof Error ? error.message : error,
      );
    }
    try {
      return await handleTraeChat(credential, model, body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[trae] chat failed for " + requested + ": " + message);
      return jsonResponse({ error: message }, 502);
    }
  }

  return jsonResponse({ error: "Unknown TRAE route" }, 404);
}
// ---------- WorkBuddy（中国版） ----------

/**
 * WorkBuddy 目录缓存。
 *
 * 与 TRAE 目录同样**是路由表的一部分**：模型只在列出它的渠道里可调用，拉不到目录
 * 就没有正确路由。TTL 与共享在飞请求的写法照 TRAE（面板每 10 秒轮询一次，不共享
 * 就是每次都打上游）。
 */
const workBuddyCatalog = {
  models: [] as WorkBuddyModel[],
  at: 0,
  loading: null as Promise<WorkBuddyModel[]> | null,
  // Whether the credential file is present, cached because the roster check that
  // needs it is synchronous. A channel with no credential is dormant by the
  // user's choice, not degraded - see the isRosterDegraded call site.
  configured: false,
};

async function loadWorkBuddyCatalog(force = false): Promise<WorkBuddyModel[]> {
  const now = Date.now();
  if (
    !force && workBuddyCatalog.models.length > 0 &&
    now - workBuddyCatalog.at < 300_000
  ) {
    return workBuddyCatalog.models;
  }
  if (workBuddyCatalog.loading !== null) return await workBuddyCatalog.loading;
  const pending = (async () => {
    const credential = await readWorkBuddyCredential(WORKBUDDY_ROOT);
    workBuddyCatalog.configured = credential !== undefined;
    if (credential === undefined) {
      throw new Error(
        "no WorkBuddy credential. run: deno run -A .tmp-workbuddy-login.ts (opens a browser)",
      );
    }
    try {
      await refreshWorkBuddyIfNeeded(WORKBUDDY_ROOT, credential);
    } catch (error) {
      console.warn(
        "[workbuddy] token refresh failed:",
        error instanceof Error ? error.message : error,
      );
    }
    const models = await fetchWorkBuddyModels(credential);
    if (models.length === 0) {
      throw new Error(
        workBuddyCatalog.models.length > 0
          ? "the remote listing came back empty (kept the previous one)"
          : "no WorkBuddy models are available for this account",
      );
    }
    workBuddyCatalog.models = models;
    workBuddyCatalog.at = Date.now();
    console.log("[workbuddy] catalog: " + models.length + " model(s) loaded");
    return models;
  })();
  workBuddyCatalog.loading = pending;
  try {
    return await pending;
  } finally {
    // 无论成败都要清空，否则一次失败会把闸门永久卡住。
    workBuddyCatalog.loading = null;
  }
}

/**
 * 限流应答：429 + `Retry-After` + 剩余秒数。
 *
 * 与 deepseek-web 的冷却应答同构。客户端（DSH）读到 `Retry-After` 会自己退避，
 * 所以这里必须给出**秒数**而不是毫秒数，也必须让状态码真的是 429 —— 少了任一
 * 半，客户端就只会把这次限流当成一次普通的渠道故障弹给用户。
 */
function workBuddyThrottleResponse(
  cooldownMs: number,
  model: string,
): Response {
  const waitMs = Math.max(1, Math.ceil(cooldownMs));
  return new Response(
    JSON.stringify({
      error: {
        message: "WorkBuddy rate limited; retry after " +
          Math.ceil(waitMs / 1000) + "s",
        type: "rate_limit_exceeded",
      },
      retry_after_ms: waitMs,
      model,
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Retry-After": String(Math.ceil(waitMs / 1000)),
      },
    },
  );
}

/** 请求上游 `/v2/chat/completions`，返回原始 Response（流不落盘）。 */
async function postWorkBuddyChat(
  credential: WorkBuddyCredential,
  payload: Record<string, unknown>,
): Promise<Response> {
  return await fetch(WORKBUDDY_ENDPOINT + CHAT_COMPLETIONS_PATH, {
    method: "POST",
    headers: workBuddyChatHeaders(credential),
    body: JSON.stringify(payload),
    // 长会话的生成可能跑满几分钟；60s 会在正常思考时把流掐断。
    signal: AbortSignal.timeout(600_000),
  });
}

async function handleWorkBuddy(
  path: string,
  request: Request,
): Promise<Response> {
  if (path === "/workbuddy/v1/models") {
    try {
      const models = await loadWorkBuddyCatalog(
        request.url.includes("refresh=true"),
      );
      return jsonResponse({
        object: "list",
        data: models.map(toWorkBuddyModelCard),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[workbuddy] catalog failed: " + message);
      return jsonResponse({ error: message }, 502);
    }
  }

  if (path === "/workbuddy/v1/account" && request.method === "GET") {
    const credential = await readWorkBuddyCredential(WORKBUDDY_ROOT);
    if (credential === undefined) {
      return jsonResponse({
        configured: false,
        error:
          "no WorkBuddy credential. run: deno run -A .tmp-workbuddy-login.ts (opens a browser)",
      }, 409);
    }
    return jsonResponse({
      configured: true,
      nickname: credential.nickname ?? "",
      userId: credential.user_id ?? "",
      accountType: credential.account_type ?? "personal",
      // 三个字段分开报：过期但能续期是**可恢复**状态，与「需要重新登录」不同，
      // 面板要能据此给出不同的提示。
      expired: isWorkBuddyExpired(credential),
      refreshable: isWorkBuddyRefreshable(credential),
      usable: isWorkBuddyUsable(credential),
      models: workBuddyCatalog.models.length,
      catalogKnown: workBuddyCatalog.models.length > 0,
      // 令牌本身绝不出现在这里：这个响应会被渲染进面板，而截图只差一次按键。
    });
  }

  if (path === "/workbuddy/v1/chat/completions" && request.method === "POST") {
    const parsed = await readJsonBodyLimited(request);
    if (!parsed.ok) {
      return jsonResponse({ error: parsed.message }, parsed.status);
    }
    const body = parsed.value as Record<string, unknown>;
    const requested = typeof body?.model === "string" ? String(body.model) : "";
    if (requested.length === 0) {
      return jsonResponse({ error: "model is required" }, 400);
    }

    let models: WorkBuddyModel[];
    try {
      models = await loadWorkBuddyCatalog();
    } catch (error) {
      return jsonResponse(
        { error: error instanceof Error ? error.message : String(error) },
        502,
      );
    }
    const model = models.find((entry) => entry.id === requested);
    if (model === undefined) {
      return jsonResponse({
        error: "Unknown WorkBuddy model: " + requested,
        available: models.map((entry) => entry.id).slice(0, 40),
      }, 400);
    }

    const credential = await readWorkBuddyCredential(WORKBUDDY_ROOT);
    if (credential === undefined) {
      return jsonResponse({ error: "no WorkBuddy credential" }, 409);
    }
    let current = credential;
    try {
      const refreshed = await refreshWorkBuddyIfNeeded(
        WORKBUDDY_ROOT,
        current,
      );
      if (refreshed !== undefined) current = refreshed;
    } catch (error) {
      // 非致命：让上游决定。过期令牌和没有令牌失败方式一样，把一个换成另一个
      // 只会掩盖真正的原因。
      console.warn(
        "[workbuddy] pre-chat refresh failed:",
        error instanceof Error ? error.message : error,
      );
    }

    // 稳定的会话 id：WorkBuddy 用 prompt_cache_key 做前缀缓存，不带它同一段 8k
    // 前缀的命中是 0（实测费用差约 17 倍）。用请求头带的会话 id，缺失才现生成。
    const sessionId = request.headers.get("x-session-id")?.trim() ||
      request.headers.get("x-conversation-id")?.trim() ||
      ("workbuddy-" + crypto.randomUUID());
    const plan: WorkBuddyChatPlan = {
      maxOutputTokens: model.maxOutputTokens,
      efforts: model.reasoningEfforts ?? [],
      defaultEffort: model.defaultReasoningEffort,
    };
    const payload = buildChatBody(
      model.id,
      body.messages ?? [],
      sessionId,
      plan,
      {
        maxTokens: typeof body.max_tokens === "number"
          ? body.max_tokens
          : undefined,
        reasoningEffort: typeof body.reasoning_effort === "string"
          ? body.reasoning_effort
          : undefined,
        temperature: typeof body.temperature === "number"
          ? body.temperature
          : undefined,
        stop: Array.isArray(body.stop) ? body.stop.map(String) : undefined,
      },
    );

    // 限流闸门：上一轮刚撞过 429 的话，先在本地拒一次，把上游抖动挡在外面。
    // 过了窗口才发请求 —— 否则每次都拿一个必然 429 的请求去确认上游还在限流。
    const cooldown = workBuddyCooldownRemaining();
    if (cooldown > 0) {
      return workBuddyThrottleResponse(cooldown, requested);
    }

    let upstream: Response;
    try {
      upstream = await postWorkBuddyChat(current, payload);
      // 撞到 429 就退避再来一次（编排与判据见 postWorkBuddyChatWithThrottleRetry）。
      //
      // 实测这个渠道的 429 是随机抖动而不是并发阈值（并发 3/5 挂 1~2 个、并发 6/8
      // 全过），所以一次短退避重试通常就落在窗口外，而直接把 429 抛给用户等于
      // 让一次 1~2 秒的抖动毁掉整轮对话。只重试一次：上游持续限流时，第二次的
      // 等待由冷却窗口替我们承担。
      const sent = await postWorkBuddyChatWithThrottleRetry(
        () => postWorkBuddyChat(current, payload),
      );
      upstream = sent.response;
      if (sent.attempts === 2) {
        console.warn(
          "[workbuddy] chat throttled for " + requested + "; backed off " +
            sent.backoffMs + "ms before one retry: " +
            sent.throttledBody.slice(0, 200),
        );
        // 第二次还撞 ⇒ 持续限流，记窗口并把 Retry-After 应答给客户端。
        if (upstream.status === 429) {
          const again = await upstream.text().catch(() => "");
          const window = tripWorkBuddyCircuit(
            again.slice(0, 200),
            workBuddyRetryAfterMs(upstream.headers.get("retry-after")),
          );
          return workBuddyThrottleResponse(window, requested);
        }
      }
      if (upstream.status === 401 || upstream.status === 403) {
        // 401 之后**静默续期并重试一次**。pre-flight 的续期只覆盖 expires_at 说
        // 该续的情况；服务端也能提前吊销（改密码、后台踢下线），那时文件里的
        // 有效期还没到。少了这一步，用户看到的是「模型突然全挂」，而真相是令牌
        // 过期且可自愈。
        try {
          const revived = await refreshWorkBuddyCredential(current);
          current = revived;
          await writeWorkBuddyCredential(WORKBUDDY_ROOT, revived);
          upstream = await postWorkBuddyChat(current, payload);
          console.log(
            "[workbuddy] token was stale; refreshed and retried (" +
              requested + ")",
          );
        } catch (error) {
          console.warn(
            "[workbuddy] retry after 401 failed:",
            error instanceof Error ? error.message : error,
          );
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[workbuddy] chat transport failed: " + message);
      return jsonResponse({ error: message }, 502);
    }

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      console.warn(
        "[workbuddy] chat HTTP " + upstream.status + " for " + requested +
          ": " +
          text.slice(0, 240),
      );
      return jsonResponse({
        error: "WorkBuddy chat HTTP " + upstream.status,
        detail: text.slice(0, 500),
      }, upstream.status);
    }
    if (upstream.body === null) {
      return jsonResponse(
        { error: "WorkBuddy chat returned an empty body" },
        502,
      );
    }

    // 原样透传：请求体与 SSE 都是标准 OpenAI，**一个字节都不翻译**。唯一的一层
    // 是只读扫描，拦到 11140 才改写帧（见 guardWorkBuddyStream）。
    const headers = new Headers();
    for (const name of ["content-type", "cache-control", "x-request-id"]) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    if (!headers.has("content-type")) {
      headers.set("content-type", "text/event-stream; charset=utf-8");
    }
    headers.set("cache-control", "no-cache");
    const guard: ReadableStream<Uint8Array> = guardWorkBuddyStream(
      upstream.body,
      (rejection) => {
        console.warn(
          "[workbuddy] in-stream content rejection (11140) for " + requested +
            ": " + rejection.payload.slice(0, 200),
        );
      },
    );
    return new Response(guard, { status: 200, headers });
  }

  return jsonResponse({ error: "Unknown WorkBuddy route" }, 404);
}
async function v1FetchMemberModels(): Promise<Record<string, any[]>> {
  const out: Record<string, any[]> = {};
  const now = Date.now();
  // 干净请求：手动携带各成员需要的默认凭据（zen 要 Bearer public），避免被客户端 token 污染
  const shimReq = new Request("http://internal/", {
    headers: {
      "content-type": "application/json",
      "authorization": "Bearer public",
    },
  });
  await Promise.allSettled(V1_AGGREGATE_MEMBERS.map(async (key) => {
    if (key === "zen") {
      const models = await fetchZenModels();
      out[key] = models;
      if (models.length > 0) catalog.ok(key, models.length, models.length, now);
      else {
        const reason = "Zen returned no free models";
        catalog.failed(key, reason, now);
        console.warn(`[v1] ${key}: ${reason}`);
      }
      return;
    }
    if (key === "cnb") {
      out[key] = CNB_MODELS;
      catalog.ok(key, CNB_MODELS.length, CNB_MODELS.length, now);
      return;
    }
    if (key === "deepseek-web") {
      // Asked of this proxy rather than of chat.deepseek.com: the ten entries are
      // a fixed set of variants the handler answers from its own state, so an
      // outbound call would add a dependency and a failure mode for no new data.
      const models = await v1FetchOwnListing("deepseek-web");
      out[key] = models;
      if (models.length > 0) {
        catalog.ok(key, models.length, models.length, now);
      } else {
        // Empty here means the login state is absent, not that the channel is
        // broken. Saying so is the difference between a fixable report and a
        // roster that is quietly short.
        const reason =
          "deepseek-web has no login state yet (cookie, token, headers)";
        catalog.failed(key, reason, now);
        console.warn(`[v1] ${key}: ${reason}`);
      }
      return;
    }
    if (key === "trae") {
      // Asked of the account's remote listing, not a local table: the set of
      // models AND their channels both come from upstream, and the channel is
      // what the dispatcher needs.
      try {
        const models = await loadTraeCatalog();
        out[key] = models.map(toModelCard);
        catalog.ok(key, models.length, models.length, now);
      } catch (error) {
        // Empty here means "not readable right now", not "there is nothing".
        // Reporting it that way is the difference between a fixable message and
        // a channel that quietly went missing.
        const reason = error instanceof Error ? error.message : String(error);
        catalog.failed(key, reason, now);
        console.warn(`[v1] ${key}: ${reason}`);
      }
      return;
    }
    if (key === "workbuddy") {
      // Asked of the account's remote listing, not a local table: the models,
      // their credits rate and their reasoning ladder all come from upstream,
      // and there is no static list to answer with (the CN fallback table is
      // deliberately empty - see STATIC_FALLBACK_MODELS).
      try {
        const models = await loadWorkBuddyCatalog();
        out[key] = models.map(toWorkBuddyModelCard);
        catalog.ok(key, models.length, models.length, now);
      } catch (error) {
        // Empty here means "not readable right now" - most often no credential
        // yet - not "this account has nothing". Reporting it that way is the
        // difference between a fixable message and a channel that went missing.
        const reason = error instanceof Error ? error.message : String(error);
        catalog.failed(key, reason, now);
        console.warn(`[v1] ${key}: ${reason}`);
      }
      return;
    }
    if (key === "commandcode") {
      const models = await getCommandCodeModels();
      out[key] = models;
      if (models.length > 0) catalog.ok(key, models.length, models.length, now);
      else {
        const reason = "CommandCode returned no models";
        catalog.failed(key, reason, now);
        console.warn(`[v1] ${key}: ${reason}`);
      }
      return;
    }
    const fresh = cache.data[key];
    if (fresh && now - fresh.timestamp < cache.TTL) {
      out[key] = fresh.data?.data || [];
      catalog.ok(
        key,
        (fresh.data?.data || []).length,
        (fresh.data?.data || []).length,
        now,
      );
      return;
    }
    const p: any = (providers as any)[key];
    // A channel that needs a credential it does not have is reported as needing
    // one, not as a listing that failed. Without this the log says "fetch
    // failed" for a 401 the user could have fixed by pasting a key, which is the
    // same message a dead upstream produces.
    if (!hasChannelCredential(key, p)) {
      const reason = `${key} needs an API key; set it in the ai-proxy panel`;
      catalog.failed(key, reason, now);
      return;
    }
    let modelsPath = p.endpoints.models;
    if (p.pathRewrite) modelsPath = p.pathRewrite(p.prefix + "/models");
    const headers = cloneHeadersForUpstream(shimReq, p, ENV);
    if (p.extraHeaders) {
      for (const [k, v] of Object.entries(p.extraHeaders)) {
        headers.set(k, v as string);
      }
    }
    let resp: Response;
    try {
      resp = await fetch(p.baseUrl + modelsPath, { headers });
    } catch (error) {
      // A member that cannot be reached used to vanish from the roster with no
      // trace: the response simply omitted it, so the picker quietly showed one
      // channel fewer and nothing said why. Record it instead of swallowing it.
      const reason = error instanceof Error ? error.message : String(error);
      catalog.failed(key, `listing request failed: ${reason}`, now);
      console.warn(`[v1] ${key} model list failed: ${reason}`);
      return;
    }
    const parsed = await tryParseResponse(resp);
    if (parsed.error || !parsed.data) {
      const reason = parsed.error
        ? `upstream answered ${JSON.stringify(parsed.error).slice(0, 160)}`
        : "upstream returned no model list";
      catalog.failed(key, reason, now, { status: resp.status });
      console.warn(
        `[v1] ${key} model list unusable (HTTP ${resp.status}): ${reason}`,
      );
      return;
    }
    const listed = Array.isArray(parsed.data?.data)
      ? parsed.data.data.length
      : 0;
    let filtered = parsed.data;
    if (p.filterModels) filtered = p.filterModels(parsed.data);
    const arr = filtered?.data || [];
    if (arr.length) cache.data[key] = { timestamp: now, data: filtered }; // 顺手暖成员缓存（裸 id 解析要用）
    out[key] = arr;
    if (arr.length === 0 && listed > 0) {
      // Not an outage: the upstream answered and its filter removed everything.
      // Still worth saying out loud, because a provider renaming a field turns
      // into a silently empty channel rather than an error anyone can read.
      const reason =
        `all ${listed} listed models were removed by the provider filter`;
      catalog.failed(key, reason, now, {
        status: resp.status,
        listedModels: listed,
      });
      console.warn(`[v1] ${key}: ${reason}`);
      return;
    }
    catalog.ok(key, listed, arr.length, now);
  }));
  return out;
}

async function handleAggregateV1(
  path: string,
  request: Request,
  url: URL,
): Promise<Response> {
  const json = (obj: any, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });

  if (path.endsWith("/models") && request.method === "GET") {
    const now = Date.now();
    // A roster that came back short is served for a moment, not for the full TTL.
    //
    // The proxy is spawned and immediately asked for models, at a point where the
    // host's networking may not have settled - on this machine every outbound
    // listing failed on the first request two seconds after start. Caching that
    // empty answer for the full window turned a startup race into a five minute
    // outage that survived restarts, because each restart raced again and cached
    // again. Restarting could not clear it, and the per-channel endpoints kept
    // working the whole time because they do not read this cache at all.
    const previous = cache.data["v1-aggregate"];
    const ttl = previous?.degraded === true
      ? Math.min(cache.TTL, cache.DEGRADED_TTL)
      : cache.TTL;
    if (!previous || now - previous.timestamp >= ttl) {
      const members = await v1FetchMemberModels();
      const data: any[] = [];
      for (const key of V1_AGGREGATE_MEMBERS) {
        for (const m of members[key] || []) {
          data.push({ ...m, id: `${key}/${m.id}`, owned_by: key });
        }
      }
      // Degraded means any member that SHOULD answer is absent or came back
      // empty. One channel failing while the rest answer is precisely the case
      // that used to hide: the roster looked healthy, only shorter, and stayed
      // that way for the whole window.
      //
      // A member with no credential is not that case: it is dormant by the
      // user's choice, and counting it pinned the roster to DEGRADED_TTL forever
      // - a 20x refetch rate and a warning at every start, for a channel that
      // was never going to answer until a key was pasted.
      const degraded = isRosterDegraded(
        V1_AGGREGATE_MEMBERS,
        members,
        (key) =>
          !hasChannelCredential(key, (providers as any)[key]) ||
          // WorkBuddy declares auth:{type:'none'} (the credential is a file, not
          // an env var), so the shared check says "has one" even when nothing has
          // ever logged in. Without this the roster is degraded from the first
          // boot until the user runs the login script - a 20x refetch rate and a
          // startup warning for a channel that was never going to answer.
          (key === "workbuddy" && !workBuddyCatalog.configured),
      );
      if (degraded && previous?.degraded !== true) {
        console.warn(
          `[v1] roster is incomplete (${data.length} models); retrying sooner than the full TTL`,
        );
      }
      cache.data["v1-aggregate"] = {
        timestamp: now,
        degraded,
        data: { object: "list", data },
      };
    }
    return json(cache.data["v1-aggregate"].data);
  }

  if (request.method === "POST") {
    const maximumBodyBytes = Number(
      ENV.MAX_REQUEST_BODY_BYTES || 12 * 1024 * 1024,
    );
    const parsed = await readJsonBodyLimited(
      request,
      Number.isSafeInteger(maximumBodyBytes) && maximumBodyBytes > 0
        ? maximumBodyBytes
        : 12 * 1024 * 1024,
    );
    if (!parsed.ok) {
      return json({ error: parsed.message }, parsed.status);
    }
    if (
      !parsed.value || typeof parsed.value !== "object" ||
      Array.isArray(parsed.value)
    ) {
      return json({ error: "Request body must be a JSON object" }, 400);
    }
    const openaiBody = parsed.value as Record<string, any>;
    const model = String(openaiBody.model || "");
    const resolved = model ? v1ResolveModel(model) : null;
    if (!resolved) {
      return json({
        error: `Unknown model: ${model || "(empty)"}`,
        hint:
          'use "kilo/<id>" / "zen/<id>" / "cnb/<id>" / "commandcode/<id>" (see GET /v1/models); bare ids resolve kilo→zen→cnb→commandcode after the list is warm',
      }, 400);
    }
    const rest = path.slice("/v1".length) || "/";
    const target = new URL(
      (providers as any)[resolved.key].prefix + rest,
      url.origin,
    );
    const h = new Headers();
    h.set(
      "content-type",
      request.headers.get("content-type") || "application/json",
    );
    const accept = request.headers.get("accept");
    if (accept) h.set("accept", accept);
    for (
      const name of [
        "user-agent",
        "x-session-id",
        "x-conversation-id",
        "x-request-id",
        "x-commandcode-admin-key",
      ]
    ) {
      const value = request.headers.get(name);
      if (value) h.set(name, value);
    }
    // 成员上游各有默认凭据（kilo 无、zen public、cnb 自建 CSRF），剥掉客户端 token 防污染；
    // 仅当本代理自身开了 API_KEYS 才透传（供递归时的 checkAuth 通过）
    if (!ENV.API_KEYS && resolved.key === "commandcode") {
      // 开放模式下不把客户端 token 送到上游，但保留一个仅供本地 handler 绑定的内部 scope。
      const credential = request.headers.get("authorization") ||
        request.headers.get("x-api-key");
      if (credential) h.set("x-commandcode-client-scope", credential);
    }
    if (ENV.API_KEYS) {
      for (const name of ["authorization", "x-api-key"]) {
        const v = request.headers.get(name);
        if (v) h.set(name, v);
      }
    }
    return await handler(
      new Request(target, {
        method: "POST",
        headers: h,
        body: JSON.stringify({ ...openaiBody, model: resolved.raw }),
        signal: request.signal,
      }),
    );
  }

  return json({
    error: "Not found",
    hint: "GET /v1/models | POST /v1/chat/completions | POST /v1/responses",
  }, 404);
}

export async function handler(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers":
            "Content-Type, Authorization, x-api-key, x-session-id, x-conversation-id, x-commandcode-admin-key",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    if (path !== "/" && path !== "") {
      if (!checkAuth(request)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }
    }

    if (ENV.BACKEND_URL) return await proxyToBackend(request);

    if (path === "/" || path === "") {
      return new Response(
        JSON.stringify({
          message: "Multi-Provider AI Proxy (Deno Deploy)",
          providers: Object.keys(providers),
        }),
        {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    // ---------- TRAE 账号：签到与积分余额 ----------
    //
    // These sit outside the /v1 aggregate on purpose. The account endpoints are
    // not a model route: they answer "is this account signed in, does it have
    // credits, has today's check-in been claimed" - questions the panel asks, not
    // the DSH picker.
    if (
      (path === "/trae/v1/account" && request.method === "GET") ||
      (path === "/trae/v1/checkin" && request.method === "POST")
    ) {
      const credential = await readTraeCredential(TRAE_ROOT);
      if (credential === undefined) {
        return new Response(
          JSON.stringify({
            configured: false,
            error:
              "no TRAE credential. run: deno run -A .tmp-trae-login.ts (opens a browser)",
          }),
          {
            status: 409,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          },
        );
      }
      // Refresh a day before expiry, so a long-idle proxy does not answer every
      // call with 401. A failure here is not fatal: keep the current credential
      // and let the upstream decide - replacing it with nothing hides the reason.
      try {
        await refreshTraeIfNeeded(TRAE_ROOT, credential);
      } catch (error) {
        console.warn(
          "[trae] token refresh failed:",
          error instanceof Error ? error.message : error,
        );
      }
      if (path === "/trae/v1/account") {
        // An expired token is reported, not treated as "signed out": the panel
        // can still show the balance, and the refresh above has already tried.
        const expired = isTraeExpired(credential);
        const [balance, checkin] = await Promise.all([
          fetchTraeBalance(credential).catch((error) => {
            console.warn(
              "[trae] balance lookup failed:",
              error instanceof Error ? error.message : error,
            );
            return undefined;
          }),
          fetchTraeCheckinStatus(credential).catch((error) => {
            console.warn(
              "[trae] checkin status failed:",
              error instanceof Error ? error.message : error,
            );
            return undefined;
          }),
        ]);
        return new Response(
          JSON.stringify({
            configured: true,
            // Never the tokens themselves. This response is rendered in a panel
            // and a screenshot is one keystroke away.
            uid: credential.uid,
            nickname: credential.nickname ?? "",
            expired,
            balance: balance ?? { total: 0, packs: [] },
            balanceKnown: balance !== undefined,
            checkin: checkin ?? null,
            checkinKnown: checkin !== undefined,
          }),
          {
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "no-store",
              "Access-Control-Allow-Origin": "*",
            },
          },
        );
      }
      const result = await claimTraeDailyCheckin(credential, fetch, {
        onThrottle: (attempt, waitMs) =>
          console.warn(
            `[trae] check-in throttled (9074), retry ${attempt} in ${waitMs}ms`,
          ),
      });
      if (result.throttled > 0) {
        console.log(
          `[trae] check-in succeeded after ${result.throttled} throttle(s)`,
        );
      }
      // The balance comes back with the claim so the panel can show the new
      // total without a second round trip - a second request is where a
      // "credited 100 but still shows 500" report comes from.
      const balance = await fetchTraeBalance(credential).catch(() => undefined);
      if (!result.ok) {
        console.warn(
          `[trae] check-in failed: code=${result.code} ${result.message}`,
        );
      }
      return new Response(
        JSON.stringify({
          ok: result.ok,
          code: result.code,
          message: result.message,
          credits: result.credits ?? null,
          throttled: result.throttled,
          alreadyClaimed: result.alreadyClaimed,
          balance: balance ?? { total: 0, packs: [] },
          balanceKnown: balance !== undefined,
        }),
        {
          // 200 on a business failure: the transport succeeded and the panel
          // renders `ok: false` with the reason. A 5xx would be retried by
          // callers, and replaying a claim is exactly what must not happen.
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    if (path === "/health" && request.method === "GET") {
      const observed = getProviderHealth();
      const providerHealth: Record<string, unknown> = {};
      const modelHealth: Record<string, Record<string, unknown>> = {};
      for (const key of Object.keys(providers)) {
        providerHealth[key] = observed[key] ?? {
          state: "unknown",
          checkedAt: null,
          modelCount: 0,
          stale: false,
        };
        const perModel = getModelHealth(key);
        if (Object.keys(perModel).length > 0) modelHealth[key] = perModel;
      }
      const states = Object.values(providerHealth).map((value: any) =>
        value?.state
      );
      // A member whose listing did not come back whole is missing from the picker,
      // which is a different question from whether it can serve a turn. Reported
      // separately so a shrinking roster can say why instead of just being smaller.
      const catalogIssues = catalog.failures();
      return new Response(
        JSON.stringify({
          status: states.includes("available")
            ? "ok"
            : states.includes("degraded")
            ? "degraded"
            : states.includes("unavailable")
            ? "unavailable"
            : "unknown",
          checkedAt: new Date().toISOString(),
          providers: providerHealth,
          // Provider-level counts cannot say *which* model is throttled or
          // refused, so the individual verdicts travel with the snapshot. A
          // picker labels each row from these instead of re-probing.
          models: modelHealth,
          catalog: catalog.all(),
          // Which channels hold a credential the panel can set. The panel reads this
          // to explain a channel that is present but has nothing behind it, rather
          // than leaving the user to infer it from an empty model list.
          credentials: Object.fromEntries(
            Object.entries(providers).map(([key, value]: [string, any]) => [
              key,
              { configured: hasChannelCredential(key, value) },
            ]),
          ),
          ...(Object.keys(catalogIssues).length > 0 ? { catalogIssues } : {}),
        }),
        {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    // 逐渠道主动探测。放在这里而不是复用模型列表的 ?health=true，是因为
    // Zen / DeepSeek 网页端 / CommandCode 都有自己的 handler，永远走不到通用
    // 探测分支；没有这个接口，它们的模型会一直停在「未探测」。
    if (path === "/health/probe" && request.method === "POST") {
      const provider = url.searchParams.get("provider")?.trim() ?? "";
      const channelPrefixes: Record<string, string> = {
        kilo: "kilo",
        zen: "zen",
        cnb: "cnb",
        commandcode: "commandcode",
        "deepseek-web": "deepseek-web",
        tokenharbor: "tokenharbor",
        workbuddy: "workbuddy",
      };
      const prefix = channelPrefixes[provider];
      if (!prefix) {
        return new Response(
          JSON.stringify({
            error: "unknown channel",
            channels: Object.keys(channelPrefixes),
          }),
          {
            status: 400,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          },
        );
      }

      // 实时拉取而不是读 v1MemberModelIds：后者依赖此前是否有人访问过
      // /v1/models 暖过缓存，冷启动时会是空列表，用户点「检查状态」就得到 0 个。
      const members = await v1FetchMemberModels();
      // A channel does not have to be an aggregate member to be probeable.
      // deepseek-web is not one - it is served on its own prefix - so reading the
      // aggregate alone found no rows for it and the probe answered
      // `probed: 0` for a channel that works, which is the same "silent zero" the
      // model list had. Fall back to the channel's own listing.
      let rows = members[provider] ?? [];
      if (rows.length === 0) rows = await v1FetchOwnListing(prefix);
      const listing = rows
        .map((row: any) => (typeof row?.id === "string" ? row.id : ""))
        .filter((value: string) => value !== "");
      if (!Array.isArray(listing) || listing.length === 0) {
        return new Response(
          JSON.stringify({ provider, probed: 0, models: {} }),
          {
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          },
        );
      }

      const apiKey = url.searchParams.get("key") ?? "";
      const limitParam = Number(url.searchParams.get("limit"));
      const limit = Number.isInteger(limitParam) && limitParam > 0
        ? Math.min(limitParam, listing.length)
        : listing.length;
      // The aggregate only routes its members. A channel that has its own prefix
      // has to be probed there, with the bare model id, or every model reads
      // unavailable regardless of whether it answers.
      const isAggregateMember = (V1_AGGREGATE_MEMBERS as readonly string[])
        .includes(provider);
      const results = await probeChannel(
        provider,
        listing.slice(0, limit).map((id: string) => `${provider}/${id}`),
        {
          origin: new URL("/", url).href.replace(/\/$/, ""),
          apiKey,
          basePath: isAggregateMember ? "/v1" : `/${prefix}/v1`,
        },
      );
      return new Response(
        JSON.stringify({
          provider,
          probed: Object.keys(results).length,
          models: results,
        }),
        {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    // /v1 聚合端点（kilo/zen/cnb/commandcode 多上游一个入口）
    if (path === "/v1" || path.startsWith("/v1/")) {
      return await handleAggregateV1(path, request, url);
    }

    // 匹配 provider
    let matchedProvider: any = null;
    let matchedKey = "";
    for (const [key, provider] of Object.entries(providers)) {
      if (!path.startsWith(provider.prefix)) continue;
      const rest = path.slice(provider.prefix.length);
      if (rest === "" || rest[0] === "/" || rest[0] === "?") {
        matchedProvider = provider;
        matchedKey = key;
        break;
      }
    }

    if (!matchedProvider) {
      return new Response(JSON.stringify({ error: "Unknown provider" }), {
        status: 404,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    const provider = matchedProvider;
    const providerKey = matchedKey;
    if (provider.customHandler === "zen") {
      return await handleZen(path, request, url);
    }
    if (provider.customHandler === "cnb") {
      return await handleCnb(path, request, url);
    }
    if (provider.customHandler === "deepseek-web") {
      return await handleDeepseekWeb(path, request, url);
    }
    if (provider.customHandler === "trae") {
      return await handleTrae(path, request);
    }
    if (provider.customHandler === "workbuddy") {
      return await handleWorkBuddy(path, request);
    }
    if (provider.customHandler === "commandcode") {
      return await handleCommandCode(path, request, url);
    }

    const baseUrl = provider.baseUrl;
    const endpoints = provider.endpoints;

    // 模型列表
    if (path.endsWith(endpoints.models) && request.method === "GET") {
      const now = Date.now();
      const cacheKey = providerKey;
      const forceHealth = url.searchParams.get("health") === "true";

      if (
        !forceHealth && cache.data[cacheKey] &&
        now - cache.data[cacheKey].timestamp < cache.TTL
      ) {
        return new Response(JSON.stringify(cache.data[cacheKey].data), {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      let modelsPath = endpoints.models;
      if (provider.pathRewrite) modelsPath = provider.pathRewrite(path);
      const targetUrl = baseUrl + modelsPath + url.search;
      const headers = cloneHeadersForUpstream(request, provider, ENV);
      if (provider.extraHeaders) {
        for (const [k, v] of Object.entries(provider.extraHeaders)) {
          headers.set(k, v as string);
        }
      }

      try {
        const resp = await fetch(targetUrl, { headers });
        const parsed = await tryParseResponse(resp);
        if (parsed.error) {
          return new Response(
            JSON.stringify({
              error: "Upstream returned non-JSON response",
              detail: parsed.error.message,
            }),
            {
              status: resp.status || 502,
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
            },
          );
        }
        let filteredData = parsed.data;
        if (provider.filterModels) {
          filteredData = provider.filterModels(parsed.data);
        }

        if (forceHealth && filteredData?.data?.length > 0) {
          const healthy = await filterHealthyModels(
            filteredData.data,
            providerKey,
            baseUrl,
          );
          filteredData.data = healthy;
          cache.data[cacheKey] = { timestamp: Date.now(), data: filteredData };
        } else if (!forceHealth) {
          cache.data[cacheKey] = { timestamp: Date.now(), data: filteredData };
          if (filteredData?.data?.length > 0) {
            // Deno Deploy 支持 EdgeRuntime.waitUntil；没有就 fire-and-forget
            const task = (async () => {
              const healthy = await filterHealthyModels(
                filteredData.data,
                providerKey,
                baseUrl,
              );
              cache.data[cacheKey] = {
                timestamp: Date.now(),
                data: { ...filteredData, data: healthy },
              };
            })().catch(() => {});
            if (
              typeof (globalThis as any).EdgeRuntime?.waitUntil === "function"
            ) {
              (globalThis as any).EdgeRuntime.waitUntil(task);
            }
          }
        }
        return new Response(JSON.stringify(filteredData), {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } catch (e: any) {
        return new Response(
          JSON.stringify({
            error: "Failed to fetch models",
            detail: e.message,
          }),
          {
            status: 500,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          },
        );
      }
    }

    // 聊天补全
    if (path.endsWith(endpoints.chat) && request.method === "POST") {
      let bodyText = "";
      try {
        bodyText = await request.text();
      } catch (e: any) {
        return new Response(
          JSON.stringify({
            error: "Failed to read request body",
            detail: e.message,
          }),
          {
            status: 400,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          },
        );
      }
      const parsed = safeJsonParse(bodyText);
      if (parsed.error) {
        return new Response(
          JSON.stringify({
            error: "Invalid JSON body",
            detail: parsed.error.message,
          }),
          {
            status: 400,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          },
        );
      }
      const openaiBody = parsed.data || {};
      const adapter = provider.adapter;
      let targetBody = openaiBody;
      if (adapter?.request) {
        try {
          targetBody = adapter.request(openaiBody);
        } catch (e: any) {
          return new Response(
            JSON.stringify({
              error: "Adapter request transform failed",
              detail: e.message,
            }),
            {
              status: 500,
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
            },
          );
        }
      }

      let chatPath = endpoints.chat;
      if (provider.pathRewrite) chatPath = provider.pathRewrite(path);
      const targetUrl = baseUrl + chatPath + url.search;
      const headers = cloneHeadersForUpstream(request, provider, ENV);
      if (provider.extraHeaders) {
        for (const [k, v] of Object.entries(provider.extraHeaders)) {
          headers.set(k, v as string);
        }
      }

      let upstreamResponse: Response;
      try {
        upstreamResponse = await fetch(targetUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(targetBody),
          redirect: "follow",
        });
      } catch (e: any) {
        return new Response(
          JSON.stringify({ error: "Proxy error", detail: e.message }),
          {
            status: 502,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          },
        );
      }

      if (targetBody.stream === true) {
        if (adapter.isIdentity) {
          return new Response(upstreamResponse.body, {
            status: upstreamResponse.status,
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }
        const transformer = createStreamTransformer(adapter, openaiBody);
        if (!transformer) {
          return new Response(upstreamResponse.body, {
            status: upstreamResponse.status,
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }
        return new Response(upstreamResponse.body!.pipeThrough(transformer), {
          status: upstreamResponse.status,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      const parsedResp = await tryParseResponse(upstreamResponse);
      if (parsedResp.error) {
        return new Response(
          JSON.stringify({
            error: "Upstream returned non-JSON response",
            detail: parsedResp.error.message,
          }),
          {
            status: upstreamResponse.status || 502,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          },
        );
      }
      let finalResponse = parsedResp.data;
      if (adapter?.response) {
        try {
          finalResponse = adapter.response(parsedResp.data);
        } catch (e: any) {
          return new Response(
            JSON.stringify({
              error: "Adapter response transform failed",
              detail: e.message,
            }),
            {
              status: 500,
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
            },
          );
        }
      }
      return new Response(JSON.stringify(finalResponse), {
        status: upstreamResponse.status,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (e: any) {
    return new Response(
      JSON.stringify({ error: "Server internal error", detail: e.message }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}

// 本地 Deno 直跑入口（Workers 里 Deno 未定义，自动跳过；Workers 入口见 worker.ts）
if (typeof Deno !== "undefined") {
  const serveOptions: { port: number; hostname?: string } = {
    port: Number(Deno.env.get("PORT") ?? 8000),
  };
  try {
    if (!Deno.env.get("DENO_DEPLOYMENT_ID")) {
      serveOptions.hostname = "127.0.0.1";
    }
  } catch {
    serveOptions.hostname = "127.0.0.1";
  }
  Deno.serve(serveOptions, handler);
}
