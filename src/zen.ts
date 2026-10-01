// deno-lint-ignore-file no-explicit-any
import { ENV } from "./core.ts";
import { compactIfNeeded, fallbackTruncate } from "./zen-compaction.ts";
import {
  DEFAULT_EGRESS_COOLDOWN_MS,
  EgressPool,
  parseProxyList,
  type ProxyStrategy,
} from "./zen-egress.ts";

// OpenCode Zen free-tier compatibility layer.
//
// The public Zen endpoint is OpenAI-shaped on the wire but not client-agnostic:
// it accepts the pooled `public` credential only when the request carries the
// OpenCode desktop fingerprint, a canonical session/request identity and the
// four-tool fingerprint quartet. This module keeps that compatibility at the
// proxy boundary so DSH can use the same models without knowing the wire.

const DEFAULT_BASE_URL = "https://opencode.ai/zen";
const CLIENT_UA = "opencode/1.18.31";
const FINGERPRINT_TOOLS = ["bash", "glob", "grep", "read"] as const;
const QUARTET_DONORS: Record<string, string[]> = { bash: ["pwsh"] };
const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const REQUEST_RE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const MAX_BODY_BYTES = 12 * 1024 * 1024;

type Json = Record<string, any>;

function baseUrl(): string {
  const configured = (ENV.ZEN_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  return configured.endsWith("/v1") ? configured : `${configured}/v1`;
}

function jsonHeaders(extra: Record<string, string> = {}): Headers {
  return new Headers({
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    ...extra,
  });
}

function jsonResponse(
  body: unknown,
  status = 200,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: jsonHeaders(extra),
  });
}

function textToHex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

function base62(bytes: Uint8Array): string {
  const alphabet =
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  return [...bytes].map((value) => alphabet[value % alphabet.length]).join("");
}

async function sha256(text: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return new Uint8Array(digest);
}

/** Stable canonical OpenCode session for one DSH conversation. */
export async function zenSessionId(seed: string): Promise<string> {
  const value = String(seed || "global").trim();
  if (SESSION_RE.test(value)) return value;
  const digest = await sha256(`our-free-model\0${value}`);
  return `ses_${textToHex(digest.slice(0, 6))}${base62(digest.slice(6, 20))}`;
}

/** Fresh canonical request id; retries may reuse the caller's id. */
export function mintZenRequestId(): string {
  const stamp = Date.now().toString(16).padStart(12, "0").slice(-12);
  const random = new Uint8Array(14);
  crypto.getRandomValues(random);
  return `msg_${stamp}${base62(random)}`;
}

function combinedUserAgent(incoming: string | null): string {
  const value = String(incoming || "").trim();
  if (!value) return CLIENT_UA;
  return value.includes("opencode/") ? value : `${value} ${CLIENT_UA}`;
}

// ---------- egress pool ----------
//
// Zen meters its anonymous quota per egress address, so one IP runs out long
// before the models do. An optional pool spreads that quota across addresses.
const zenEgressPool = new EgressPool({
  proxies: parseProxyList(ENV.ZEN_PROXIES),
  strategy: zenProxyStrategy(),
  cooldownMs: zenProxyCooldownMs() ?? DEFAULT_EGRESS_COOLDOWN_MS,
});

function zenProxyStrategy(): ProxyStrategy {
  const value = String(ENV.ZEN_PROXY_STRATEGY || "round_robin");
  return value === "random" || value === "fill" ? value : "round_robin";
}

function zenProxyCooldownMs(): number | undefined {
  const value = Number(ENV.ZEN_PROXY_COOLDOWN_MS);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * A client bound to one exit.
 *
 * Created per request on purpose: a cached client would keep a keep-alive
 * connection to the same address, which is exactly what the rotation is meant
 * to avoid. Zen is the only consumer, so the cost is one client per turn.
 */
function zenEgressClient(proxy: URL): Deno.HttpClient {
  return Deno.createHttpClient({ proxy: { url: proxy.toString() } });
}

export function zenEgressStatus(): {
  size: number;
  strategy: string;
  proxies: string[];
  cooldowns: { url: string; until: number; failures: number }[];
} {
  return {
    size: zenEgressPool.size,
    strategy: zenEgressPool.strategy,
    proxies: zenEgressPool.describe(),
    cooldowns: zenEgressPool.cooldowns(),
  };
}

// ---------- session compaction ----------

const ZEN_MODEL_LIMITS: Record<string, { context: number; output: number }> =
  {};

function zenModelLimits(model: string): { context: number; output: number } {
  return ZEN_MODEL_LIMITS[model] ?? { context: 1_000_000, output: 64_000 };
}

/**
 * Compact an oversized transcript, degrading to truncation if it fails.
 *
 * The summary call reuses this proxy's own Zen route so it carries the same
 * fingerprint as a real turn; a summary generated without it would be refused
 * exactly when the session is already too long to get help.
 */
async function maybeCompactZen(
  body: Json,
  model: string,
  session: string,
): Promise<void> {
  const messages = body?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return;
  const limits = zenModelLimits(model);
  const result = await compactIfNeeded({
    messages,
    body,
    contextWindow: limits.context,
    maxOutputTokens: limits.output,
    sessionId: session,
    config: {
      enabled: ENV.ZEN_COMPACTION !== "off",
      keepTokens: zenIntSetting("ZEN_COMPACTION_KEEP_TOKENS", 8000),
      buffer: zenIntSetting("ZEN_COMPACTION_BUFFER", 20000),
      maxSummaryTokens: zenIntSetting("ZEN_COMPACTION_MAX_SUMMARY", 4096),
      summaryModel: String(ENV.ZEN_COMPACTION_SUMMARY_MODEL || ""),
    },
    writeSummary: (prompt, summaryModel, maxTokens) =>
      writeZenSummary(prompt, summaryModel || model, maxTokens),
  });
  if (result.changed) {
    body.messages = result.messages;
    console.log(
      `[zen] ${result.note} session=${session} cost≈${result.compactTokens}`,
    );
  } else if (result.note === "summary-failed") {
    const truncated = fallbackTruncate(messages, limits.context);
    body.messages = truncated.messages;
    console.warn(
      `[zen] ${truncated.note} session=${session} (summary generation failed: ${
        lastSummaryError || "unknown"
      })`,
    );
    lastSummaryError = "";
  }
}

function zenIntSetting(name: string, fallback: number): number {
  const value = Number((ENV as Record<string, string | undefined>)[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Last summary failure, surfaced in the log so a silent fallback is explainable. */
let lastSummaryError = "";

async function writeZenSummary(
  prompt: string,
  model: string,
  maxTokens: number,
): Promise<string> {
  const session = await zenSessionId(`zen-summary:${Date.now()}`);
  const body: Json = {
    model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: maxTokens,
    stream: true,
  };
  // The free tier answers "only from within OpenCode" unless the request
  // carries the bash/glob/grep/read quartet, and it refuses every
  // non-streaming request. Measured against the live gateway, streaming
  // without the quartet is 403 and the quartet without streaming is also 403;
  // both together are 200. A summary that skipped either check would fail on
  // exactly the oversized sessions that need it most, so the same fingerprint
  // the real turn uses is applied here.
  applyZenFingerprint(body, false);

  const response = await fetch(`${baseUrl()}/chat/completions`, {
    method: "POST",
    headers: zenGatewayHeaders(
      new Request("http://zen.local/"),
      session,
      mintZenRequestId(),
      true,
    ),
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    lastSummaryError = `HTTP ${response.status} ${detail.slice(0, 160)}`;
    throw new Error(`summary request returned HTTP ${response.status}`);
  }
  const content = await collectChatStreamText(response);
  if (content.trim() === "") {
    lastSummaryError = "summary response carried no content";
    throw new Error("summary response carried no content");
  }
  lastSummaryError = "";
  return content;
}

/** Reassemble the assistant text from a chat SSE body. */
export async function collectChatStreamText(
  response: Response,
): Promise<string> {
  const body = await response.text();
  let text = "";
  for (const frame of body.split(/\r?\n\r?\n/)) {
    for (const line of frame.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (raw === "" || raw === "[DONE]") continue;
      try {
        const delta = JSON.parse(raw)?.choices?.[0]?.delta;
        if (typeof delta?.content === "string") text += delta.content;
      } catch {
        // A partial frame is dropped rather than failing the whole summary.
      }
    }
  }
  return text;
}

export function zenGatewayHeaders(
  request: Request,
  session: string,
  requestId: string,
  stream: boolean,
): Headers {
  const headers = new Headers();
  const accept = request.headers.get("accept");
  headers.set("accept", accept || (stream ? "text/event-stream" : "*/*"));
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  headers.set("authorization", `Bearer ${ENV.ZEN_BEARER_TOKEN || "public"}`);
  headers.set(
    "user-agent",
    combinedUserAgent(request.headers.get("user-agent")),
  );
  headers.set("x-opencode-client", "desktop");
  headers.set("x-opencode-session", session);
  headers.set("x-opencode-request", requestId);
  headers.set("x-opencode-project", "global");
  return headers;
}

function toolName(tool: any): string {
  if (!tool || typeof tool !== "object") return "";
  if (typeof tool.name === "string" && tool.name.trim()) {
    return tool.name.trim();
  }
  const fn = tool.function;
  if (fn && typeof fn === "object" && typeof fn.name === "string") {
    return fn.name.trim();
  }
  return "";
}

function quartetKey(name: string): string {
  const lower = String(name || "").trim().toLowerCase();
  return (FINGERPRINT_TOOLS as readonly string[]).includes(lower) ? lower : "";
}

function functionPart(tool: any): Json | null {
  return tool?.function && typeof tool.function === "object" &&
      !Array.isArray(tool.function)
    ? tool.function
    : null;
}

/**
 * Add the quartet required by Zen's free-tier gate. The returned map records
 * promoted/renamed tools so the response side can restore the caller's spelling.
 */
export function applyZenFingerprint(
  body: Json,
  flat = false,
): Map<string, string> {
  const map = new Map<string, string>();
  const source = Array.isArray(body.tools) ? body.tools : [];
  const hadClientTools = source.length > 0;
  const seen = new Set<string>();
  const output: any[] = [];

  for (const tool of source) {
    const current = toolName(tool);
    const key = quartetKey(current);
    if (!key) {
      output.push(tool);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    if (current !== key) {
      map.set(key, current);
      const fn = functionPart(tool);
      output.push(
        fn
          ? { ...tool, function: { ...fn, name: key } }
          : { ...tool, name: key },
      );
    } else {
      output.push(tool);
    }
  }

  const promoted = new Set<string>();
  for (const name of FINGERPRINT_TOOLS) {
    if (seen.has(name)) continue;
    const donors = QUARTET_DONORS[name] || [];
    const index = output.findIndex((tool) => {
      const original = toolName(tool);
      if (!original || quartetKey(original)) return false;
      const lower = original.toLowerCase();
      return !promoted.has(lower) && donors.includes(lower);
    });
    if (index < 0) continue;
    const tool = output[index];
    const original = toolName(tool);
    promoted.add(original.toLowerCase());
    map.set(name, original);
    const fn = functionPart(tool);
    output[index] = fn
      ? { ...tool, function: { ...fn, name } }
      : { ...tool, name };
    seen.add(name);
  }

  for (const name of FINGERPRINT_TOOLS) {
    if (seen.has(name)) continue;
    output.push(
      flat
        ? {
          type: "function",
          name,
          description:
            "This tool is currently unavailable and must not be used.",
          parameters: { type: "object", properties: {} },
        }
        : {
          type: "function",
          function: {
            name,
            description:
              "This tool is currently unavailable and must not be used.",
            parameters: { type: "object", properties: {} },
          },
        },
    );
  }

  body.tools = output;
  if (!body.tool_choice) {
    if (flat) body.tool_choice = "auto";
    else if (!hadClientTools) body.tool_choice = "none";
  }
  return map;
}

export function restoreZenToolName(
  name: string,
  map: Map<string, string>,
): string {
  return map.get(name) || name;
}

function restoreToolNames(value: any, map: Map<string, string>): any {
  if (!map.size) return value;
  if (Array.isArray(value)) {
    return value.map((item) => restoreToolNames(item, map));
  }
  if (!value || typeof value !== "object") return value;
  const output: Json = { ...value };
  if (
    typeof output.name === "string" &&
    ["function", "function_call", "tool_call"].includes(String(output.type))
  ) {
    output.name = restoreZenToolName(output.name, map);
  }
  if (
    output.function && typeof output.function === "object" &&
    typeof output.function.name === "string"
  ) {
    output.function = {
      ...output.function,
      name: restoreZenToolName(output.function.name, map),
    };
  }
  for (const key of Object.keys(output)) {
    if (key === "name" || key === "function") continue;
    output[key] = restoreToolNames(output[key], map);
  }
  return output;
}

export function zenEndpointForModel(
  model: string,
): "responses" | "messages" | "chat" {
  const base = String(model || "").split("/").pop() || "";
  if (/^muse[-_]?spark(?:$|[-_:.\s])/i.test(base)) return "responses";
  if (base === "union-alpha") return "messages";
  return "chat";
}

function chatContentText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part?.type === "text" || part?.type === "input_text") {
      return String(part.text || "");
    }
    return "";
  }).join("");
}

function chatToResponses(body: Json): Json {
  const input = (Array.isArray(body.messages) ? body.messages : []).map((
    message: Json,
  ) => ({
    type: "message",
    role: message.role === "assistant" ? "assistant" : "user",
    content: [{ type: "input_text", text: chatContentText(message.content) }],
  }));
  const tools = (Array.isArray(body.tools) ? body.tools : []).map(
    (tool: Json) => {
      const fn = tool.function || tool;
      return {
        type: "function",
        name: fn.name,
        description: fn.description,
        parameters: fn.parameters || { type: "object" },
      };
    },
  );
  return {
    model: body.model,
    input: input.length > 0 ? input : [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "..." }],
    }],
    stream: body.stream === true,
    store: false,
    max_output_tokens: Number(
      body.max_tokens || body.max_completion_tokens || 4096,
    ),
    ...(tools.length > 0 ? { tools } : {}),
    ...(body.tool_choice ? { tool_choice: body.tool_choice } : {}),
  };
}

function chatToClaude(body: Json): Json {
  const messages: Json[] = [];
  let system = "";
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (message.role === "system") {
      system += chatContentText(message.content);
      continue;
    }
    messages.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content: chatContentText(message.content),
    });
  }
  const tools = (Array.isArray(body.tools) ? body.tools : []).map(
    (tool: Json) => {
      const fn = tool.function || tool;
      return {
        name: fn.name,
        description: fn.description,
        input_schema: fn.parameters || { type: "object" },
      };
    },
  );
  return {
    model: body.model,
    messages,
    stream: body.stream === true,
    max_tokens: Number(body.max_tokens || body.max_completion_tokens || 4096),
    ...(system ? { system } : {}),
    ...(tools.length > 0 ? { tools } : {}),
  };
}

function upstreamBodyForChat(
  body: Json,
  wire: "responses" | "messages" | "chat",
): Json {
  if (wire === "responses") return chatToResponses(body);
  if (wire === "messages") return chatToClaude(body);
  return body;
}

function responsesToChat(payload: Json, model: string): Json {
  let text = "";
  const toolCalls: Json[] = [];
  for (const item of Array.isArray(payload.output) ? payload.output : []) {
    if (item?.type === "function_call") {
      toolCalls.push({
        id: item.call_id || item.id,
        type: "function",
        function: { name: item.name, arguments: item.arguments || "{}" },
      });
    }
    for (const part of Array.isArray(item?.content) ? item.content : []) {
      if (part?.type === "output_text" || part?.type === "text") {
        text += String(part.text || "");
      }
    }
  }
  const usage = payload.usage || {};
  return {
    id: `chatcmpl-${payload.id || Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: payload.model || model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
    }],
    usage: {
      prompt_tokens: Number(usage.input_tokens || 0),
      completion_tokens: Number(usage.output_tokens || 0),
      total_tokens: Number(usage.total_tokens || 0),
    },
  };
}

function claudeToChat(payload: Json, model: string): Json {
  let text = "";
  const toolCalls: Json[] = [];
  for (const block of Array.isArray(payload.content) ? payload.content : []) {
    if (block?.type === "text") text += String(block.text || "");
    if (block?.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input || {}),
        },
      });
    }
  }
  const usage = payload.usage || {};
  return {
    id: `chatcmpl-${payload.id || Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: payload.model || model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: toolCalls.length > 0
        ? "tool_calls"
        : (payload.stop_reason === "max_tokens" ? "length" : "stop"),
    }],
    usage: {
      prompt_tokens: Number(usage.input_tokens || 0),
      completion_tokens: Number(usage.output_tokens || 0),
      total_tokens: Number(usage.input_tokens || 0) +
        Number(usage.output_tokens || 0),
    },
  };
}

function sseData(text: string): string {
  return `data: ${text}\n\n`;
}

function chatFrame(
  delta: Json,
  finishReason: string | null = null,
  usage?: Json,
): string {
  return sseData(JSON.stringify({
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: delta.model || "",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  }));
}

function responsesEventsToChat(
  body: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let sentText = false;
  let toolIndex = 0;
  return new ReadableStream({
    async pull(controller) {
      while (true) {
        const result = await reader.read();
        if (result.done) {
          controller.enqueue(encoder.encode(sseData("[DONE]")));
          controller.close();
          return;
        }
        buffer += decoder.decode(result.value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() || "";
        let output = "";
        for (const frame of frames) {
          for (const line of frame.split(/\r?\n/)) {
            if (!line.startsWith("data:")) continue;
            const raw = line.slice(5).trim();
            if (!raw || raw === "[DONE]") continue;
            let event: Json;
            try {
              event = JSON.parse(raw);
            } catch {
              continue;
            }
            const type = String(event.type || "");
            if (
              type === "response.output_text.delta" &&
              typeof event.delta === "string"
            ) {
              sentText = true;
              output += chatFrame({ model, content: event.delta });
            } else if (
              type === "response.output_item.added" &&
              event.item?.type === "function_call"
            ) {
              output += chatFrame({
                model,
                tool_calls: [{
                  index: toolIndex++,
                  id: event.item.call_id || event.item.id,
                  type: "function",
                  function: { name: event.item.name, arguments: "" },
                }],
              });
            } else if (type === "response.function_call_arguments.delta") {
              output += chatFrame({
                model,
                tool_calls: [{
                  index: Math.max(0, toolIndex - 1),
                  function: { arguments: String(event.delta || "") },
                }],
              });
            } else if (type === "response.completed") {
              const usage = event.response?.usage;
              output += chatFrame(
                {},
                "stop",
                usage
                  ? {
                    prompt_tokens: Number(usage.input_tokens || 0),
                    completion_tokens: Number(usage.output_tokens || 0),
                    total_tokens: Number(usage.total_tokens || 0),
                  }
                  : undefined,
              );
              if (!sentText && toolIndex === 0) {
                output += chatFrame({ model, content: "" });
              }
            }
          }
        }
        if (output) {
          controller.enqueue(encoder.encode(output));
          return;
        }
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function claudeEventsToChat(
  body: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let toolIndex = 0;
  return new ReadableStream({
    async pull(controller) {
      while (true) {
        const result = await reader.read();
        if (result.done) {
          controller.enqueue(encoder.encode(sseData("[DONE]")));
          controller.close();
          return;
        }
        buffer += decoder.decode(result.value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() || "";
        let output = "";
        for (const frame of frames) {
          for (const line of frame.split(/\r?\n/)) {
            if (!line.startsWith("data:")) continue;
            const raw = line.slice(5).trim();
            if (!raw || raw === "[DONE]") continue;
            let event: Json;
            try {
              event = JSON.parse(raw);
            } catch {
              continue;
            }
            if (
              event.type === "content_block_start" &&
              event.content_block?.type === "text"
            ) {
              output += chatFrame({
                model,
                content: String(event.content_block.text || ""),
              });
            } else if (
              event.type === "content_block_delta" &&
              event.delta?.type === "text_delta"
            ) {
              output += chatFrame({
                model,
                content: String(event.delta.text || ""),
              });
            } else if (
              event.type === "content_block_start" &&
              event.content_block?.type === "tool_use"
            ) {
              output += chatFrame({
                model,
                tool_calls: [{
                  index: toolIndex++,
                  id: event.content_block.id,
                  type: "function",
                  function: { name: event.content_block.name, arguments: "" },
                }],
              });
            } else if (
              event.type === "content_block_delta" &&
              event.delta?.type === "input_json_delta"
            ) {
              output += chatFrame({
                model,
                tool_calls: [{
                  index: Math.max(0, toolIndex - 1),
                  function: {
                    arguments: String(event.delta.partial_json || ""),
                  },
                }],
              });
            } else if (event.type === "message_delta") {
              const usage = event.usage;
              output += chatFrame(
                {},
                String(event.delta?.stop_reason || "stop") === "max_tokens"
                  ? "length"
                  : "stop",
                usage
                  ? {
                    prompt_tokens: Number(usage.input_tokens || 0),
                    completion_tokens: Number(usage.output_tokens || 0),
                  }
                  : undefined,
              );
            }
          }
        }
        if (output) {
          controller.enqueue(encoder.encode(output));
          return;
        }
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

export function restoreChatStream(
  body: ReadableStream<Uint8Array>,
  map: Map<string, string>,
): ReadableStream<Uint8Array> {
  if (map.size === 0) return body;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  return new ReadableStream({
    async pull(controller) {
      while (true) {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          return;
        }
        buffer += decoder.decode(result.value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() || "";
        const output: string[] = [];
        for (const frame of frames) {
          if (frame === "") continue;
          const lines = frame.split(/\r?\n/);
          const mapped: string[] = [];
          for (const line of lines) {
            if (!line.startsWith("data:")) {
              mapped.push(line);
              continue;
            }
            const raw = line.slice(5).trim();
            if (!raw || raw === "[DONE]") {
              mapped.push(line);
              continue;
            }
            try {
              mapped.push(
                `data: ${
                  JSON.stringify(restoreToolNames(JSON.parse(raw), map))
                }`,
              );
            } catch {
              mapped.push(line);
            }
          }
          output.push(mapped.join("\n"));
        }
        if (output.length > 0) {
          controller.enqueue(encoder.encode(`${output.join("\n\n")}\n\n`));
          return;
        }
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

async function readBody(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const result = await reader.read();
    if (result.done) return text + decoder.decode();
    total += result.value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("Request body is too large");
    }
    text += decoder.decode(result.value, { stream: true });
  }
}

function zenFailure(response: Response, text: string): Response {
  let payload: Json = {};
  try {
    payload = JSON.parse(text);
  } catch {
    payload = {};
  }
  const upstreamError = payload.error && typeof payload.error === "object"
    ? payload.error
    : payload;
  const type = String(upstreamError.type || "");
  const message = String(
    upstreamError.message || text || `Zen upstream HTTP ${response.status}`,
  );
  const code = type === "FreeTierError"
    ? "ZEN_FREE_TIER"
    : type === "RegionError"
    ? "ZEN_REGION_BLOCKED"
    : type === "FreeUsageLimitError"
    ? "ZEN_QUOTA"
    : "ZEN_UPSTREAM";
  const status = type === "FreeUsageLimitError" ? 429 : response.status || 502;
  const retryAfter = response.headers.get("retry-after") || "";
  return jsonResponse(
    { error: { type: type || "ZenUpstreamError", code, message } },
    status,
    retryAfter ? { "retry-after": retryAfter } : {},
  );
}

async function handleModels(): Promise<Response> {
  const session = await zenSessionId("zen:catalog");
  const requestId = mintZenRequestId();
  try {
    const response = await fetch(`${baseUrl()}/models`, {
      headers: zenGatewayHeaders(
        new Request("http://zen.local/"),
        session,
        requestId,
        false,
      ),
    });
    const text = await response.text();
    if (!response.ok) return zenFailure(response, text);
    let payload: Json;
    try {
      payload = JSON.parse(text);
    } catch {
      return jsonResponse({ error: "Zen returned non-JSON model list" }, 502);
    }
    const data = Array.isArray(payload.data) ? payload.data : [];
    return jsonResponse({
      ...payload,
      data: data.filter((model: Json) =>
        typeof model?.id === "string" && model.id.endsWith("-free")
      ),
    });
  } catch (error) {
    return jsonResponse({
      error: "Zen model list failed",
      detail: error instanceof Error ? error.message : String(error),
    }, 502);
  }
}

export async function handleZen(
  path: string,
  request: Request,
  _url: URL,
): Promise<Response> {
  if (request.method === "GET" && path.endsWith("/models")) {
    return handleModels();
  }
  if (
    request.method !== "POST" ||
    !/\/(chat\/completions|responses|messages)$/.test(path)
  ) {
    return jsonResponse({ error: "Zen route not found" }, 404);
  }

  let body: Json;
  try {
    const raw = await readBody(request);
    body = raw ? JSON.parse(raw) : {};
  } catch (error) {
    return jsonResponse({
      error: "Invalid Zen request body",
      detail: error instanceof Error ? error.message : String(error),
    }, 400);
  }
  const model = String(body.model || "");
  if (!model) return jsonResponse({ error: "model is required" }, 400);
  const wire = zenEndpointForModel(model);
  const incomingWire = path.endsWith("/responses")
    ? "responses"
    : path.endsWith("/messages")
    ? "messages"
    : "chat";
  if (incomingWire !== "chat" && incomingWire !== wire) {
    return jsonResponse({
      error: `Model ${model} is served by Zen /${wire}, not /${incomingWire}`,
    }, 400);
  }
  const session = await zenSessionId(
    request.headers.get("x-session-id") ||
      request.headers.get("x-conversation-id") ||
      request.headers.get("x-opencode-session") || "global",
  );

  // Compact before the body is derived: compaction rewrites `messages`, and
  // upstreamBodyForChat copies them, so compressing afterwards would send the
  // original oversized transcript. The fingerprint is applied after, because
  // the summary is written from the plain conversation.
  await maybeCompactZen(body, model, session);
  const upstreamBody = upstreamBodyForChat(body, wire);
  const renameMap = applyZenFingerprint(upstreamBody, wire === "responses");
  const incomingRequestId = request.headers.get("x-opencode-request") ||
    request.headers.get("x-request-id") || "";
  const requestId = REQUEST_RE.test(incomingRequestId)
    ? incomingRequestId
    : mintZenRequestId();
  const upstreamPath = `/${wire === "chat" ? "chat/completions" : wire}`;
  const target = `${baseUrl()}${upstreamPath}`;

  // Compact before fingerprinting: the fingerprint rewrites tools, and the
  // summary is written from the conversation, so the order matters.
  const egress = zenEgressPool.pick();
  let response: Response;
  try {
    response = await fetch(target, {
      method: "POST",
      headers: zenGatewayHeaders(
        request,
        session,
        requestId,
        upstreamBody.stream === true,
      ),
      body: JSON.stringify(upstreamBody),
      redirect: "error",
      signal: request.signal,
      ...(egress ? { client: zenEgressClient(egress.proxy) } : {}),
    });
  } catch (error) {
    // A transport error is usually the exit's fault, not the model's, so the
    // address is skipped rather than blamed on the roster.
    if (egress) zenEgressPool.coolDown(egress.index);
    return jsonResponse({
      error: "Zen transport failed",
      detail: error instanceof Error ? error.message : String(error),
    }, 502);
  }
  if (egress && (response.status === 429 || response.status >= 500)) {
    zenEgressPool.coolDown(egress.index);
  }
  if (!response.ok) {
    return zenFailure(
      response,
      await response.text().catch(() => ""),
    );
  }

  if (upstreamBody.stream === true) {
    if (!response.body) {
      return jsonResponse({ error: "Zen returned an empty stream" }, 502);
    }
    const converted = wire === "responses"
      ? responsesEventsToChat(response.body, model)
      : wire === "messages"
      ? claudeEventsToChat(response.body, model)
      : restoreChatStream(response.body, renameMap);
    return new Response(converted, {
      status: response.status,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "connection": "keep-alive",
        "access-control-allow-origin": "*",
      },
    });
  }

  const text = await response.text();
  let payload: Json;
  try {
    payload = JSON.parse(text);
  } catch {
    return jsonResponse({
      error: "Zen returned non-JSON response",
      detail: text.slice(0, 240),
    }, 502);
  }
  const restored = restoreToolNames(payload, renameMap);
  const converted = wire === "responses"
    ? responsesToChat(restored, model)
    : wire === "messages"
    ? claudeToChat(restored, model)
    : restored;
  return jsonResponse(converted);
}

export async function fetchZenModels(): Promise<any[]> {
  const response = await handleModels();
  if (!response.ok) return [];
  const payload = await response.json();
  return Array.isArray(payload?.data) ? payload.data : [];
}
