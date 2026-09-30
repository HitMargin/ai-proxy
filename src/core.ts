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
  // 其它 provider 可能用到的 key，按需添加
  ANTHROPIC_API_KEY: getEnv("ANTHROPIC_API_KEY"),
  GEMINI_API_KEY: getEnv("GEMINI_API_KEY"),
  OPENROUTER_API_KEY: getEnv("OPENROUTER_API_KEY"),
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
    const token = userToken || auth.defaultToken || env.DEFAULT_BEARER_TOKEN;
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
  toAnthropic: {
    request: (openaiBody: any) => {
      const systemMessages = openaiBody.messages.filter((m: any) =>
        m.role === "system"
      );
      const system = systemMessages.map((m: any) => m.content).join("\n");
      const userMessages = openaiBody.messages.filter((m: any) =>
        m.role !== "system"
      );

      const anthropicMessages = userMessages.map((m: any) => {
        const role = m.role === "assistant" ? "assistant" : "user";
        let content;
        if (Array.isArray(m.content)) {
          content = m.content.map((block: any) => {
            if (typeof block === "string") return { type: "text", text: block };
            if (block.type === "text") {
              return { type: "text", text: block.text || "" };
            }
            if (block.type === "image_url") {
              const url = typeof block.image_url === "string"
                ? block.image_url
                : block.image_url?.url || "";
              const match = url.match(/^data:(image\/\w+);base64,(.+)$/);
              if (match) {
                return {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: match[1],
                    data: match[2],
                  },
                };
              }
              return { type: "text", text: `[Image URL: ${url}]` };
            }
            return { type: "text", text: "[unsupported block]" };
          });
        } else {
          content = m.content;
        }
        return { role, content };
      });

      const result: any = {
        model: openaiBody.model,
        messages: anthropicMessages,
        max_tokens: openaiBody.max_tokens || openaiBody.max_completion_tokens ||
          1024,
        temperature: openaiBody.temperature ?? 1.0,
        top_k: openaiBody.top_k,
        stop_sequences: Array.isArray(openaiBody.stop)
          ? openaiBody.stop
          : openaiBody.stop
          ? [openaiBody.stop]
          : undefined,
        stream: openaiBody.stream || false,
      };
      if (system) result.system = system;
      return result;
    },
    response: (anthropicBody: any) => {
      let content = "";
      if (Array.isArray(anthropicBody.content)) {
        content = anthropicBody.content
          .filter((block: any) => block.type === "text")
          .map((block: any) => block.text || "")
          .join("");
      } else if (typeof anthropicBody.content === "string") {
        content = anthropicBody.content;
      }
      const stopReason = anthropicBody.stop_reason || "stop";
      const map: any = {
        end_turn: "stop",
        max_tokens: "length",
        stop_sequence: "stop",
        tool_use: "tool_calls",
      };
      const finishReason = map[stopReason] || stopReason;
      return {
        id: anthropicBody.id || `msg_${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: anthropicBody.model || "unknown",
        choices: [{
          index: 0,
          message: { role: "assistant", content },
          finish_reason: finishReason,
        }],
        usage: anthropicBody.usage
          ? {
            prompt_tokens: anthropicBody.usage.input_tokens || 0,
            completion_tokens: anthropicBody.usage.output_tokens || 0,
            total_tokens: (anthropicBody.usage.input_tokens || 0) +
              (anthropicBody.usage.output_tokens || 0),
          }
          : undefined,
      };
    },
    stream: (chunk: any) => chunk,
    isIdentity: false,
  },
  toGemini: {
    request: (openaiBody: any) => {
      const systemMessages = openaiBody.messages.filter((m: any) =>
        m.role === "system"
      );
      const systemText = systemMessages.map((m: any) => m.content).join("\n");
      const contents = openaiBody.messages
        .filter((m: any) => m.role !== "system")
        .map((m: any) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: Array.isArray(m.content)
            ? m.content.map((block: any) => {
              if (typeof block === "string") return { text: block };
              if (block.type === "text") return { text: block.text || "" };
              if (block.type === "image_url") {
                const url = typeof block.image_url === "string"
                  ? block.image_url
                  : block.image_url?.url || "";
                const match = url.match(/^data:(image\/\w+);base64,(.+)$/);
                if (match) {
                  return { inlineData: { mimeType: match[1], data: match[2] } };
                }
                return { text: `[Image URL: ${url}]` };
              }
              return { text: "[unsupported block]" };
            })
            : [{ text: m.content }],
        }));
      const result: any = {
        contents,
        generationConfig: {
          temperature: openaiBody.temperature ?? 1.0,
          maxOutputTokens: openaiBody.max_tokens ||
            openaiBody.max_completion_tokens || 1024,
          topP: openaiBody.top_p,
          stopSequences: openaiBody.stop,
        },
      };
      if (systemText) {
        result.systemInstruction = { parts: [{ text: systemText }] };
      }
      if (openaiBody.stream) result.stream = true;
      return result;
    },
    response: (geminiBody: any) => {
      const candidate = geminiBody.candidates?.[0];
      const content = candidate?.content?.parts?.[0]?.text || "";
      const finishReason = candidate?.finishReason || "STOP";
      const map: any = {
        STOP: "stop",
        MAX_TOKENS: "length",
        SAFETY: "content_filter",
        RECITATION: "content_filter",
      };
      return {
        id: `gemini-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: geminiBody.model || "gemini-pro",
        choices: [{
          index: 0,
          message: { role: "assistant", content },
          finish_reason: map[finishReason] || finishReason.toLowerCase(),
        }],
        usage: geminiBody.usageMetadata
          ? {
            prompt_tokens: geminiBody.usageMetadata.promptTokenCount || 0,
            completion_tokens: geminiBody.usageMetadata.candidatesTokenCount ||
              0,
            total_tokens: geminiBody.usageMetadata.totalTokenCount || 0,
          }
          : undefined,
      };
    },
    stream: (chunk: any) => chunk,
    isIdentity: false,
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
  anthropic: {
    prefix: "/anthropic/v1",
    baseUrl: "https://api.anthropic.com",
    auth: { type: "api-key", header: "x-api-key" },
    pathRewrite: (path: string) => path.replace(/^\/anthropic\/v1/, "/v1"),
    endpoints: { models: "/v1/models", chat: "/v1/messages" },
    adapter: adapters.toAnthropic,
    filterModels: null,
    extraHeaders: { "anthropic-version": "2023-06-01" },
  },
  gemini: {
    prefix: "/gemini/v1",
    baseUrl: "https://generativelanguage.googleapis.com",
    auth: { type: "api-key", header: "x-goog-api-key" },
    pathRewrite: (path: string) => path.replace(/^\/gemini\/v1/, "/v1beta"),
    endpoints: {
      models: "/v1beta/models",
      chat: "/v1beta/models/gemini-pro:generateContent",
    },
    adapter: adapters.toGemini,
    filterModels: null,
  },
  openrouter_responses: {
    prefix: "/openrouter/v1/responses",
    baseUrl: "https://openrouter.ai/api/v1",
    auth: { type: "bearer", defaultToken: "" },
    pathRewrite: (path: string) =>
      path.replace(/^\/openrouter\/v1\/responses/, "/responses"),
    endpoints: { chat: "/responses" },
    adapter: adapters.passthrough,
    filterModels: null,
  },
  openrouter: {
    prefix: "/openrouter/v1",
    baseUrl: "https://openrouter.ai/api/v1",
    auth: { type: "bearer", defaultToken: "" },
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
  tokenharbor: {
    prefix: "/tokenharbor/v1",
    baseUrl: "https://tokenharbor.ai/v1",
    auth: { type: "bearer", defaultToken: "" },
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
 * Probe one model through this proxy's own aggregate route.
 *
 * Asking the channel's upstream directly would bypass the request rewriting
 * that channel needs (the Zen fingerprint, the CLI gateway protocol, the web
 * session headers), and a model that works in the panel would then be reported
 * as broken. Going back through `/v1` tests the same path a real turn takes.
 */
async function testModelThroughProxy(
  origin: string,
  modelId: string,
  apiKey: string,
  timeoutMs: number,
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
    const response = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: modelId,
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

    if (adapter === adapters.toAnthropic) {
      const type = data.type;
      if (type === "message_start") {
        messageId = data.message?.id || `msg_${Date.now()}`;
        model = data.message?.model || model;
        openAiChunk = {
          id: messageId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{
            index: 0,
            delta: { role: "assistant" },
            finish_reason: null,
          }],
        };
      } else if (type === "content_block_delta") {
        const text = data.delta?.text || "";
        if (text) {
          openAiChunk = {
            id: messageId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{
              index: 0,
              delta: { content: text },
              finish_reason: null,
            }],
          };
        }
      } else if (type === "message_delta") {
        const stopReason = data.delta?.stop_reason || "stop";
        const map: any = {
          end_turn: "stop",
          max_tokens: "length",
          stop_sequence: "stop",
          tool_use: "tool_calls",
        };
        openAiChunk = {
          id: messageId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: map[stopReason] || stopReason,
          }],
        };
      }
    } else if (adapter === adapters.toGemini) {
      if (data.candidates && data.candidates.length > 0) {
        const c = data.candidates[0];
        const text = c.content?.parts?.[0]?.text || "";
        if (text) {
          openAiChunk = {
            id: messageId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{
              index: 0,
              delta: { content: text },
              finish_reason: null,
            }],
          };
        }
        if (c.finishReason) {
          const map: any = {
            STOP: "stop",
            MAX_TOKENS: "length",
            SAFETY: "content_filter",
            RECITATION: "content_filter",
          };
          openAiChunk = {
            id: messageId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: map[c.finishReason] ||
                c.finishReason.toLowerCase(),
            }],
          };
        }
      }
    }
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
