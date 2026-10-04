import {
  classifyProbeStatus,
  HealthRegistry,
  type ProbeSample,
  type ProviderHealthSnapshot,
} from "./runtime/health.ts";

// ============================================
// 可扩展 AI API 代理框架（Deno Deploy 版）
// 原 Cloudflare Workers 逻辑保持不变
// ============================================

// ---------- 环境变量（模块级，启动时读一次；Workers 由 fetch 入口注入） ----------
function getEnv(name: string): string {
  if (typeof Deno !== "undefined") return Deno.env.get(name) || "";
  try {
    return ((globalThis as any).process?.env?.[name]) || "";
  } catch {
    return "";
  }
}

export const ENV: Record<string, string> = {
  API_KEYS: getEnv("API_KEYS"),
  COMMANDCODE_ADMIN_KEY: getEnv("COMMANDCODE_ADMIN_KEY"),
  MAX_REQUEST_BODY_BYTES: getEnv("MAX_REQUEST_BODY_BYTES"),
  DEFAULT_BEARER_TOKEN: getEnv("DEFAULT_BEARER_TOKEN"),
  // 其它 provider 可能用到的 key，按需添加。anthropic / gemini 的 provider 已删除
  // （见下方 providers 注释），所以它们的变量不再登记：ENV 的键名要等于
  // providers[].auth.envToken 才有人读，留着只会让人以为这两个渠道还活着。
  OPENROUTER_API_KEY: getEnv("OPENROUTER_API_KEY"),
  // The provider names its variable (`auth.envToken`) and this map is what that
  // lookup reads, so a keyed channel that is missing here silently falls through
  // to DEFAULT_BEARER_TOKEN - the wrong key, and an upstream 401 with nothing in
  // the logs. tokenharbor was in that state; it is listed for the same reason
  // openrouter is.
  TOKENHARBOR_API_KEY: getEnv("TOKENHARBOR_API_KEY"),
  ZLKPRO_API_KEY: getEnv("ZLKPRO_API_KEY"),
  ZEN_BASE_URL: getEnv("ZEN_BASE_URL"),
  ZEN_BEARER_TOKEN: getEnv("ZEN_BEARER_TOKEN"),
  // Egress rotation: Zen meters anonymous quota per address, so a pool of
  // http/https/socks5 proxies spreads it. Empty means a direct connection.
  ZEN_PROXIES: getEnv("ZEN_PROXIES"),
  ZEN_PROXY_STRATEGY: getEnv("ZEN_PROXY_STRATEGY"),
  ZEN_PROXY_COOLDOWN_MS: getEnv("ZEN_PROXY_COOLDOWN_MS"),
  // Session compaction, ported from OpenCode's official mechanism.
  ZEN_COMPACTION: getEnv("ZEN_COMPACTION"),
  ZEN_COMPACTION_KEEP_TOKENS: getEnv("ZEN_COMPACTION_KEEP_TOKENS"),
  ZEN_COMPACTION_BUFFER: getEnv("ZEN_COMPACTION_BUFFER"),
  ZEN_COMPACTION_MAX_SUMMARY: getEnv("ZEN_COMPACTION_MAX_SUMMARY"),
  ZEN_COMPACTION_SUMMARY_MODEL: getEnv("ZEN_COMPACTION_SUMMARY_MODEL"),
  // Capability metadata for Zen models, read from the models.dev catalog
  // because the gateway's own /models carries none. "off" skips the fetch.
  ZEN_CATALOG: getEnv("ZEN_CATALOG"),
  ZEN_MODEL_LIMITS: getEnv("ZEN_MODEL_LIMITS"),
  COMMANDCODE_API_KEY: getEnv("COMMANDCODE_API_KEY"),
  COMMANDCODE_BASE_URL: getEnv("COMMANDCODE_BASE_URL"),
  COMMANDCODE_VERSION: getEnv("COMMANDCODE_VERSION"),
  COMMANDCODE_MODELS_URL: getEnv("COMMANDCODE_MODELS_URL"),
  COMMANDCODE_CATALOG_URL: getEnv("COMMANDCODE_CATALOG_URL"),
  COMMANDCODE_REGISTRY_URL: getEnv("COMMANDCODE_REGISTRY_URL"),
  COMMANDCODE_ACCOUNTS_FILE: getEnv("COMMANDCODE_ACCOUNTS_FILE"),
  COMMANDCODE_MAX_TOKENS: getEnv("COMMANDCODE_MAX_TOKENS"),
  COMMANDCODE_MAX_BODY_BYTES: getEnv("COMMANDCODE_MAX_BODY_BYTES"),
  COMMANDCODE_MAX_PAUSE_TURNS: getEnv("COMMANDCODE_MAX_PAUSE_TURNS"),
  COMMANDCODE_MAX_INFLIGHT: getEnv("COMMANDCODE_MAX_INFLIGHT"),
  COMMANDCODE_MIN_INTERVAL_MS: getEnv("COMMANDCODE_MIN_INTERVAL_MS"),
  COMMANDCODE_TIMEOUT_MS: getEnv("COMMANDCODE_TIMEOUT_MS"),
  COMMANDCODE_SESSION_SALT: getEnv("COMMANDCODE_SESSION_SALT"),
  COMMANDCODE_ALLOW_REMOTE_IMAGES: getEnv("COMMANDCODE_ALLOW_REMOTE_IMAGES"),
  // 反向代理模式：指向本地隧道等后端时，Worker 只做字节转发（CPU 趋近于零）
  BACKEND_URL: getEnv("BACKEND_URL"),
};

// ---------- 工具函数 ----------
export function safeJsonParse(text: string) {
  try {
    return { data: JSON.parse(text), error: null as any };
  } catch (e) {
    return { data: null, error: e as any };
  }
}

export function cloneHeadersForUpstream(
  request: Request,
  provider: any,
  env: any,
) {
  const headers = new Headers();

  const allowedHeaders = [
    "accept",
    "accept-language",
    "content-type",
    "user-agent",
  ];
  for (const name of allowedHeaders) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  const auth = provider.auth;
  if (auth.type === "bearer") {
    const userToken = request.headers.get("authorization")?.replace(
      /^Bearer\s+/i,
      "",
    );
    // A per-provider variable, so two keyed channels do not overwrite each other
    // through the shared fallback. `DEFAULT_BEARER_TOKEN` stays last: it is the
    // one-channel setup, and a provider that names its own variable means the
    // operator is expected to keep them apart.
    const own = auth.envToken ? env[auth.envToken] : undefined;
    const token = userToken || auth.defaultToken || own ||
      env.DEFAULT_BEARER_TOKEN;
    if (token) headers.set("Authorization", `Bearer ${token}`);
  } else if (auth.type === "api-key") {
    const headerName = auth.header || "x-api-key";
    const userKey = request.headers.get(headerName);
    const key = userKey ||
      auth.defaultToken ||
      env[headerName.toUpperCase().replace(/-/g, "_")];
    if (key) headers.set(headerName, key);
  }

  headers.delete("content-length");
  headers.delete("host");
  headers.delete("connection");
  headers.delete("accept-encoding");

  try {
    headers.set("Host", new URL(provider.baseUrl).host);
  } catch (_) {}

  return headers;
}

// ---------- Adapters ----------
const adapters: Record<string, any> = {
  passthrough: {
    request: (body: any) => body,
    response: (body: any) => body,
    stream: (chunk: any) => chunk,
    isIdentity: true,
  },
};

// ---------- Providers 配置 ----------
export const providers: Record<string, any> = {
  kilo: {
    prefix: "/kilo/v1",
    baseUrl: "https://api.kilo.ai/api/gateway",
    auth: { type: "none" },
    pathRewrite: (path: string) => path.replace(/^\/kilo\/v1/, ""),
    endpoints: { models: "/models", chat: "/chat/completions" },
    adapter: adapters.passthrough,
    filterModels: (data: any) => {
      if (!data?.data) return data;
      return { ...data, data: data.data.filter((m: any) => m.isFree === true) };
    },
  },
  zen: {
    prefix: "/zen/v1",
    baseUrl: "https://opencode.ai/zen",
    auth: { type: "bearer", defaultToken: "public" },
    pathRewrite: (path: string) => path.replace(/^\/zen/, ""),
    endpoints: {
      models: "/models",
      chat: "/chat/completions",
      responses: "/responses",
      messages: "/messages",
    },
    adapter: adapters.passthrough,
    customHandler: "zen",
    healthProbe: false,
    filterModels: (data: any) => {
      if (!data?.data) return data;
      return {
        ...data,
        data: data.data.filter((m: any) => m.id && m.id.endsWith("-free")),
      };
    },
  },
  // anthropic and gemini were removed: neither is reachable without a per-user
  // key, and an empty channel in the picker is a dead control. Zen's Anthropic
  // Messages conversion is `chatToClaude` in zen.ts and does not use the adapters
  // that went with these two.
  openrouter_responses: {
    prefix: "/openrouter/v1/responses",
    baseUrl: "https://openrouter.ai/api/v1",
    auth: {
      type: "bearer",
      defaultToken: "",
      envToken: "OPENROUTER_API_KEY",
    },
    pathRewrite: (path: string) =>
      path.replace(/^\/openrouter\/v1\/responses/, "/responses"),
    endpoints: { chat: "/responses" },
    adapter: adapters.passthrough,
    filterModels: null,
  },
  openrouter: {
    prefix: "/openrouter/v1",
    baseUrl: "https://openrouter.ai/api/v1",
    auth: {
      type: "bearer",
      defaultToken: "",
      envToken: "OPENROUTER_API_KEY",
    },
    pathRewrite: (path: string) => path.replace(/^\/openrouter\/v1/, ""),
    endpoints: { models: "/models", chat: "/chat/completions" },
    adapter: adapters.passthrough,
    filterModels: null,
  },
  cnb: {
    prefix: "/cnb/v1",
    baseUrl: "https://cnb.cool",
    auth: { type: "none" },
    pathRewrite: (p: string) => p.replace(/^\/cnb\/v1/, ""),
    endpoints: {
      models: "/v1/models",
      chat: "/v1/chat/completions",
      responses: "/v1/responses",
    },
    adapter: adapters.passthrough,
    filterModels: null,
    customHandler: "cnb",
  },
  commandcode: {
    prefix: "/commandcode/v1",
    baseUrl: "https://api.commandcode.ai",
    auth: { type: "none" },
    pathRewrite: (path: string) => path.replace(/^\/commandcode\/v1/, ""),
    endpoints: {
      models: "/provider/v1/models",
      chat: "/alpha/generate",
      responses: "/alpha/generate",
    },
    adapter: adapters.passthrough,
    filterModels: null,
    customHandler: "commandcode",
  },
  "deepseek-web": {
    prefix: "/deepseek-web/v1",
    baseUrl: "https://chat.deepseek.com",
    auth: { type: "none" },
    pathRewrite: (path: string) =>
      path.replace(/^\/deepseek-web\/v1/, "/api/v0"),
    endpoints: { models: "/api/v0/models", chat: "/api/v0/chat/completion" },
    adapter: adapters.passthrough,
    filterModels: null,
    customHandler: "deepseek-web",
  },
  // TRAE speaks a translated protocol on its own host, so every path is served
  // by handleTrae: the baseUrl and endpoints are placeholders that are never
  // fetched. Declaring them keeps the prefix recognisable, which is what the
  // aggregator dispatches on.
  trae: {
    prefix: "/trae/v1",
    baseUrl: "https://trae-api-cn.mchost.guru",
    auth: { type: "none" },
    pathRewrite: (path: string) => path.replace(/^\/trae\/v1/, ""),
    endpoints: {
      models: "/api/ide/v1/batch_get_detail_param",
      chat: "/api/agent/v3/llm_utils_chat",
    },
    adapter: adapters.passthrough,
    filterModels: null,
    customHandler: "trae",
  },
  // WorkBuddy speaks plain OpenAI on its own host, but the credential lives in
  // a file, a 401 has to trigger a refresh-and-retry, and 11140 arrives inside a
  // 200 stream — so every path is served by handleWorkBuddy rather than the
  // generic upstream call. Like trae, the baseUrl and endpoints are placeholders
  // that are never fetched; declaring them keeps the prefix recognisable, which
  // is what the aggregator dispatches on.
  workbuddy: {
    prefix: "/workbuddy/v1",
    baseUrl: "https://www.workbuddy.cn/v1",
    auth: { type: "none" },
    pathRewrite: (path: string) => path.replace(/^\/workbuddy\/v1/, ""),
    endpoints: {
      models: "/v3/config",
      chat: "/v2/chat/completions",
    },
    adapter: adapters.passthrough,
    filterModels: null,
    customHandler: "workbuddy",
  },
  tokenharbor: {
    prefix: "/tokenharbor/v1",
    baseUrl: "https://tokenharbor.ai/v1",
    auth: {
      type: "bearer",
      defaultToken: "",
      envToken: "TOKENHARBOR_API_KEY",
    },
    pathRewrite: (path: string) => path.replace(/^\/tokenharbor\/v1/, ""),
    endpoints: { models: "/models", chat: "/chat/completions" },
    adapter: adapters.passthrough,
    filterModels: (data: any) => {
      if (!data?.data) return data;
      return {
        ...data,
        data: data.data.filter((m: any) => m.id && m.id.endsWith(":free")),
      };
    },
  },
  // ZLK Pro (zlkpro.tech) answers the plain OpenAI contract - /v1/models and
  // /v1/chat/completions, bearer auth - and, unlike kilo or zen, has no vendor
  // extension to rewrite. Probed 2026-10-03: streaming ends with `data: [DONE]`,
  // tool calls come back in the standard `choices[].message.tool_calls` shape, and
  // ids may carry slashes of their own (`openai/gpt-oss-20b`), which the aggregate
  // already handles because it splits on the first one only. So it is the same
  // passthrough shape as tokenharbor, with nothing filtered out.
  zlkpro: {
    prefix: "/zlkpro/v1",
    baseUrl: "https://zlkpro.tech/v1",
    auth: {
      type: "bearer",
      defaultToken: "",
      envToken: "ZLKPRO_API_KEY",
    },
    pathRewrite: (path: string) => path.replace(/^\/zlkpro\/v1/, ""),
    endpoints: { models: "/models", chat: "/chat/completions" },
    adapter: adapters.passthrough,
    filterModels: null,
  },
};

// ---------- 健康检查 ----------
const healthRegistry = new HealthRegistry();
const modelHealthRegistry = new Map<string, Map<string, ProbeSample>>();

export function getProviderHealth(): Record<string, ProviderHealthSnapshot>;
export function getProviderHealth(provider: string): ProviderHealthSnapshot;
export function getProviderHealth(provider?: string) {
  return provider === undefined
    ? healthRegistry.all()
    : healthRegistry.get(provider);
}

/**
 * Per-model verdicts for one provider, keyed by the upstream model id.
 *
 * The provider-level snapshot only carries counts, so a panel cannot say which
 * specific model is throttled or refused. This keeps the individual samples the
 * probe already paid for; the picker can label each row without re-probing.
 */
export function getModelHealth(
  provider: string,
): Record<string, ProbeSample & { latencyMs?: number }> {
  const recorded = modelHealthRegistry.get(provider);
  const result: Record<string, ProbeSample & { latencyMs?: number }> = {};
  if (!recorded) return result;
  for (const [modelId, sample] of recorded) {
    result[modelId] = { ...sample };
  }
  return result;
}

/**
 * Record one verdict per model for a provider, keyed by the upstream model id.
 *
 * Exposed separately from {@link filterHealthyModels} because the channels with
 * their own handlers (Zen, DeepSeek Web, CommandCode) never reach the generic
 * probe branch in `main.ts`, so without this their models stay permanently
 * unprobed no matter how often the user asks for a check.
 */
export function recordModelHealth(
  provider: string,
  samples: ReadonlyMap<string, ProbeSample>,
): void {
  modelHealthRegistry.set(provider, new Map(samples));
  healthRegistry.record(provider, [...samples.values()]);
}

/**
 * Probe one model through this proxy's own route.
 *
 * Asking the channel's upstream directly would bypass the request rewriting
 * that channel needs (the Zen fingerprint, the CLI gateway protocol, the web
 * session headers), and a model that works in the panel would then be reported
 * as broken. Going back through the proxy tests the same path a real turn takes.
 *
 * `basePath` is the channel's own prefix, not `/v1`. The aggregate only routes its
 * members, so a channel that is not one - deepseek-web - came back "unavailable"
 * through `/v1` while answering perfectly on its own prefix. The same applies to
 * the model name: the aggregate needs `channel/model`, a channel's own route needs
 * the bare id.
 */
async function testModelThroughProxy(
  origin: string,
  modelId: string,
  apiKey: string,
  timeoutMs: number,
  basePath = "/v1",
): Promise<ProbeSample> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = new Headers({
      "Content-Type": "application/json",
      accept: "text/event-stream",
    });
    if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
    // The aggregate addresses models as `channel/model`; a channel's own route
    // takes the bare id, so the prefix is dropped when not going through `/v1`.
    const wireModel = basePath === "/v1"
      ? modelId
      : modelId.replace(new RegExp(`^${modelId.split("/")[0]}/`), "");
    const response = await fetch(`${origin}${basePath}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: wireModel,
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
        max_tokens: 1,
      }),
      signal: controller.signal,
    });
    if (response.ok) {
      // A 2xx only proves the model accepted the turn; a stream that then dies
      // before any token is a real failure the user would hit, so the body is
      // read far enough to notice an immediate error frame.
      const text = await response.text().catch(() => "");
      if (isUpstreamErrorFrame(text)) {
        return {
          state: "unavailable",
          status: response.status,
          reason: firstErrorMessage(text),
          latencyMs: Date.now() - startedAt,
          checkedAt: Date.now(),
        };
      }
      return {
        state: "available",
        status: response.status,
        latencyMs: Date.now() - startedAt,
        checkedAt: Date.now(),
      };
    }
    return {
      ...classifyProbeStatus(response.status),
      latencyMs: Date.now() - startedAt,
      checkedAt: Date.now(),
    };
  } catch (error) {
    return {
      state: "unknown",
      latencyMs: Date.now() - startedAt,
      reason: error instanceof Error ? error.message : String(error),
      checkedAt: Date.now(),
    };
  } finally {
    clearTimeout(timer);
  }
}

function isUpstreamErrorFrame(text: string): boolean {
  if (text === "") return false;
  return /"error"\s*:|"code"\s*:\s*"?(FreeUsageLimitError|RegionError|rate_limit|quota|insufficient)/i
    .test(text);
}

function firstErrorMessage(text: string): string {
  try {
    const payload = JSON.parse(text);
    const error = payload?.error;
    if (typeof error === "string") return error.slice(0, 200);
    if (typeof error?.message === "string") return error.message.slice(0, 200);
  } catch {
    // A non-JSON body is reported as-is below.
  }
  return text.slice(0, 200);
}

/**
 * Probe a whole channel and store the verdicts.
 *
 * The fan-out is deliberately narrow: these are metered free tiers, and a wide
 * burst would throttle the very user whose availability is being established.
 */
export async function probeChannel(
  provider: string,
  modelIds: readonly string[],
  options: {
    origin: string;
    apiKey: string;
    concurrency?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** The channel's own prefix, when it is not served through `/v1`. */
    basePath?: string;
  },
): Promise<Record<string, ProbeSample & { latencyMs?: number }>> {
  const concurrency = Math.max(
    1,
    Math.min(options.concurrency ?? 2, modelIds.length),
  );
  const timeoutMs = options.timeoutMs ?? 20_000;
  const samples = new Map<string, ProbeSample>();
  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < modelIds.length) {
      if (options.signal?.aborted) return;
      const index = cursor++;
      const modelId = modelIds[index];
      samples.set(
        modelId,
        await testModelThroughProxy(
          options.origin,
          modelId,
          options.apiKey,
          timeoutMs,
          options.basePath,
        ),
      );
    }
  });
  await Promise.all(workers);
  recordModelHealth(provider, samples);
  const result: Record<string, ProbeSample & { latencyMs?: number }> = {};
  for (const [modelId, sample] of samples) result[modelId] = { ...sample };
  return result;
}

async function testModel(
  baseUrl: string,
  modelId: string,
  providerKey: string,
): Promise<ProbeSample> {
  const provider = providers[providerKey];
  const url = `${baseUrl}${provider.endpoints.chat}`;
  const auth = provider.auth;
  const headers = new Headers({ "Content-Type": "application/json" });
  if (auth.type === "bearer") {
    headers.set("Authorization", `Bearer ${auth.defaultToken || ""}`);
  } else if (auth.type === "api-key") {
    const headerName = auth.header || "x-api-key";
    if (auth.defaultToken) headers.set(headerName, auth.defaultToken);
  }
  const testBody = {
    model: modelId,
    messages: [{ role: "user", content: "Hi" }],
    max_tokens: 1,
  };
  const finalBody = provider.adapter.request
    ? provider.adapter.request(testBody)
    : testBody;
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), 3000);
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(finalBody),
      signal: controller.signal,
    });
    return {
      ...classifyProbeStatus(resp.status),
      latencyMs: Date.now() - startedAt,
      checkedAt: Date.now(),
    };
  } catch (error) {
    return {
      state: "unknown",
      latencyMs: Date.now() - startedAt,
      reason: error instanceof Error ? error.message : String(error),
      checkedAt: Date.now(),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function filterHealthyModels(
  models: any[],
  providerKey: string,
  baseUrl: string,
) {
  if (!models || !models.length) {
    healthRegistry.record(providerKey, []);
    return models;
  }
  const concurrency = 5;
  const results = [];
  const samples: ProbeSample[] = [];
  const perModel = new Map<string, ProbeSample>();
  for (let i = 0; i < models.length; i += concurrency) {
    const chunk = models.slice(i, i + concurrency);
    const statuses = await Promise.all(
      chunk.map((m) => testModel(baseUrl, m.id, providerKey)),
    );
    for (let j = 0; j < chunk.length; j++) {
      samples.push(statuses[j]);
      perModel.set(chunk[j].id, statuses[j]);
      if (statuses[j].state !== "unavailable") results.push(chunk[j]);
    }
  }
  modelHealthRegistry.set(providerKey, perModel);
  healthRegistry.record(providerKey, samples);
  return results;
}

// ---------- 响应解析 ----------
export async function tryParseResponse(response: Response) {
  const ct = response.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    try {
      return { data: await response.json(), error: null as any };
    } catch (e) {
      return { data: null, error: e as any };
    }
  }
  const text = await response.text();
  return {
    data: null,
    error: new Error(`Non-JSON response: ${text.slice(0, 200)}`),
  };
}

// ---------- 流式转换 ----------
export function createStreamTransformer(adapter: any, requestBody: any) {
  if (adapter.isIdentity) return null;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  let messageId = `chatcmpl-${Date.now()}`;
  let model = requestBody.model || "";
  let created = Math.floor(Date.now() / 1000);

  function processSseData(dataStr: string) {
    if (!dataStr || dataStr === "[DONE]") return "data: [DONE]\n\n";
    let data;
    try {
      data = JSON.parse(dataStr);
    } catch {
      return "";
    }
    let openAiChunk: any = null;

    return openAiChunk ? `data: ${JSON.stringify(openAiChunk)}\n\n` : "";
  }

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.startsWith("data:")) {
          const output = processSseData(line.slice(5).trim());
          if (output) controller.enqueue(encoder.encode(output));
        }
      }
    },
    flush(controller) {
      if (buffer.trim()) {
        const line = buffer.trim();
        if (line.startsWith("data:")) {
          const output = processSseData(line.slice(5).trim());
          if (output) controller.enqueue(encoder.encode(output));
        }
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    },
  });
}
