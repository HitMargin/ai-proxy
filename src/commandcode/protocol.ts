// deno-lint-ignore-file no-explicit-any
/**
 * Derived from dsh-cmdgo-provider 0.9.1 (MIT, Copyright (c) 2026 Ajwyunsx).
 * Adapted from the DSH adapter vocabulary to OpenAI Chat Completions.
 * Upstream: https://github.com/Ajwyunsx/dsh-cmdgo-provider
 *
 * Command Code Go private-gateway protocol translation.
 */

export const CC_VERSION = "1.31.0";
export const DEFAULT_MAX_TOKENS = 64_000;
export const PROJECT_SLUG = "ai-proxy";

export interface CcStreamEvent {
  type: string;
  [key: string]: unknown;
}

export interface CcUsage {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: {
    noCacheTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    cacheCreationTokens?: number;
    cacheCreationInputTokens?: number;
  };
  outputTokenDetails?: {
    textTokens?: number;
    reasoningTokens?: number;
  };
}

/** Usage after normalizing the gateway's cache/no-cache fields. */
export interface CcUsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

interface CcToolCallContent {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: unknown;
}

interface CcToolResultContent {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: { type: "text" | "error-text"; value: string };
}

interface CcImageContent {
  type: "image";
  image: string;
}

type CcUserPart = { type: "text"; text: string } | CcImageContent;
type CcMessage =
  | { role: "user"; content: string | CcUserPart[] }
  | {
    role: "assistant";
    content: Array<
      | { type: "text"; text: string }
      | { type: "reasoning"; text: string }
      | CcToolCallContent
    >;
  }
  | { role: "tool"; content: CcToolResultContent[] };

export interface CcRequestEnvelope {
  config: {
    workingDir: string;
    date: string;
    environment: string;
    structure: unknown[];
    isGitRepo: boolean;
    currentBranch: string;
    mainBranch: string;
    gitStatus: string;
    recentCommits: unknown[];
  };
  memory: string;
  taste: string;
  skills: null;
  permissionMode: string;
  params: {
    model: string;
    messages: CcMessage[];
    tools: Array<{
      type: "function";
      name: string;
      description?: string;
      input_schema: unknown;
    }>;
    system: string;
    max_tokens: number;
    stream: true;
    temperature?: number;
    top_p?: number;
    reasoning_effort?: string;
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function runtimeEnvironment(): string {
  try {
    if (typeof Deno !== "undefined") {
      return `${Deno.build.os}-${Deno.build.arch}`;
    }
  } catch {
    // Edge runtimes do not expose Deno.build.
  }
  return "web-unknown";
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (!Array.isArray(content)) return String(content);
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (!isRecord(part)) continue;
    if (["text", "input_text", "output_text"].includes(String(part.type))) {
      parts.push(String(part.text ?? ""));
    } else if (part.type === "refusal" && typeof part.refusal === "string") {
      parts.push(part.refusal);
    }
  }
  return parts.join("");
}

function imageUrlFromPart(part: any): string | undefined {
  if (typeof part === "string") return undefined;
  if (!isRecord(part)) return undefined;
  if (part.type === "image_url") {
    return typeof part.image_url === "string"
      ? part.image_url
      : part.image_url?.url;
  }
  if (part.type === "input_image") {
    return typeof part.image_url === "string"
      ? part.image_url
      : part.image_url?.url;
  }
  if (part.type === "image") {
    return typeof part.image === "string" ? part.image : undefined;
  }
  return undefined;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}

const MAX_REMOTE_IMAGE_BYTES = 5 * 1024 * 1024;

/** Preserve data URLs; fetch HTTP images once and project them as data URLs. */
async function readImageBytes(
  response: Response,
): Promise<Uint8Array | undefined> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REMOTE_IMAGE_BYTES) {
        try {
          await reader.cancel();
        } catch { /* already closed */ }
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch { /* already released */ }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function isPrivateImageHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return true;
  if (
    /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^169\.254\./.test(host)
  ) return true;
  const private172 = /^172\.(\d+)\./.exec(host);
  if (
    private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31
  ) return true;
  return /^(fc|fd|fe80)/.test(host);
}

async function normalizeImageUrl(
  raw: string,
  allowRemote: boolean,
): Promise<string | undefined> {
  const value = raw.trim();
  const dataMatch = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]*)$/i.exec(
    value,
  );
  if (dataMatch) {
    const payload = dataMatch[2] ?? "";
    const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
    const estimatedBytes = Math.floor(payload.length * 3 / 4) - padding;
    if (estimatedBytes <= 0 || estimatedBytes > MAX_REMOTE_IMAGE_BYTES) {
      return undefined;
    }
    return value;
  }
  if (!allowRemote || !/^https?:\/\//i.test(value)) return undefined;
  try {
    const remote = new URL(value);
    if (isPrivateImageHost(remote.hostname)) return undefined;
    const response = await fetch(value, {
      headers: { accept: "image/*" },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return undefined;
    const type = response.headers.get("content-type")?.split(";", 1)[0].trim()
      .toLowerCase() ?? "";
    if (!type.startsWith("image/")) return undefined;
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > MAX_REMOTE_IMAGE_BYTES) return undefined;
    const bytes = await readImageBytes(response);
    if (bytes === undefined || bytes.length === 0) {
      return undefined;
    }
    return `data:${type};base64,${bytesToBase64(bytes)}`;
  } catch {
    return undefined;
  }
}

interface ToolPairing {
  callIds: Set<string>;
  resultIds: Set<string>;
  dropIds: ReadonlySet<string>;
  emittedCalls: Set<string>;
  emittedResults: Set<string>;
  toolNames: Map<string, string>;
}

function toolId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function collectPairing(
  messages: readonly any[],
  dropToolCallIds: ReadonlySet<string>,
): ToolPairing {
  const pairing: ToolPairing = {
    callIds: new Set(),
    resultIds: new Set(),
    dropIds: dropToolCallIds,
    emittedCalls: new Set(),
    emittedResults: new Set(),
    toolNames: new Map(),
  };
  for (const message of messages) {
    if (!isRecord(message)) continue;
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const id = toolId(call?.id);
        if (!id) continue;
        pairing.callIds.add(id);
        const name = String(call?.function?.name ?? call?.name ?? "");
        if (name) pairing.toolNames.set(id, name);
      }
    }
    if (message.role === "tool") {
      const id = toolId(message.tool_call_id);
      if (id) pairing.resultIds.add(id);
    }
  }
  return pairing;
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function serializeAssistant(
  message: any,
  pairing: ToolPairing,
): CcMessage | undefined {
  const parts: Extract<CcMessage, { role: "assistant" }>["content"] = [];
  const reasoning = String(
    message.reasoning_content ?? message.reasoning ?? "",
  );
  if (reasoning) parts.push({ type: "reasoning", text: reasoning });
  const content = message.content;
  if (typeof content === "string" && content) {
    parts.push({ type: "text", text: content });
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === "string" && part) {
        parts.push({ type: "text", text: part });
      } else if (
        isRecord(part) &&
        ["text", "input_text", "output_text"].includes(String(part.type))
      ) {
        parts.push({ type: "text", text: String(part.text ?? "") });
      }
    }
  }
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      const id = toolId(call?.id);
      if (!id || pairing.dropIds.has(id)) continue;
      if (!pairing.resultIds.has(id) || !pairing.callIds.has(id)) continue;
      if (pairing.emittedCalls.has(id)) continue;
      pairing.emittedCalls.add(id);
      const rawArguments = call?.function?.arguments ?? call?.arguments ?? "{}";
      parts.push({
        type: "tool-call",
        toolCallId: id,
        toolName: String(call?.function?.name ?? call?.name ?? "unknown"),
        input: typeof rawArguments === "string"
          ? safeParseJson(rawArguments)
          : rawArguments,
      });
    }
  }
  return parts.length === 0 ? undefined : { role: "assistant", content: parts };
}

async function userParts(
  content: unknown,
  allowRemoteImages: boolean,
): Promise<CcUserPart[]> {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    const text = content == null ? "" : String(content);
    return text ? [{ type: "text", text }] : [];
  }
  const parts: CcUserPart[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      if (part) parts.push({ type: "text", text: part });
      continue;
    }
    if (!isRecord(part)) continue;
    const image = imageUrlFromPart(part);
    if (image !== undefined) {
      const normalized = await normalizeImageUrl(image, allowRemoteImages);
      parts.push(
        normalized === undefined
          ? {
            type: "text",
            text:
              "[image omitted: unsupported, unreadable, or oversized image]",
          }
          : { type: "image", image: normalized },
      );
      continue;
    }
    const text =
      ["text", "input_text", "output_text"].includes(String(part.type))
        ? String(part.text ?? "")
        : part.type === "refusal"
        ? String(part.refusal ?? "")
        : "";
    if (text) parts.push({ type: "text", text });
  }
  return parts;
}

async function serializeUser(
  message: any,
  pairing: ToolPairing,
  allowRemoteImages: boolean,
): Promise<CcMessage[]> {
  const out: CcMessage[] = [];
  if (message.role === "tool") {
    const id = toolId(message.tool_call_id);
    let keptResult = false;
    if (
      id && !pairing.dropIds.has(id) && pairing.callIds.has(id) &&
      !pairing.emittedResults.has(id)
    ) {
      pairing.emittedResults.add(id);
      keptResult = true;
      out.push({
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: id,
          toolName: String(
            message.name ?? pairing.toolNames.get(id) ?? "unknown",
          ),
          output: {
            type: message.is_error === true || message.isError === true
              ? "error-text"
              : "text",
            value: textFromContent(message.content) ||
              (message.is_error === true
                ? "Tool execution failed"
                : "(no output)"),
          },
        }],
      });
    }
    // Images embedded in tool output are carried in a following user message.
    const images = keptResult && Array.isArray(message.content)
      ? message.content.map(imageUrlFromPart).filter((
        value: unknown,
      ): value is string => typeof value === "string")
      : [];
    if (images.length > 0) {
      const normalized = await Promise.all(
        images.map((image: unknown) =>
          normalizeImageUrl(String(image), allowRemoteImages)
        ),
      );
      const parts: CcUserPart[] = normalized.map((image) =>
        image === undefined
          ? {
            type: "text",
            text: "[image omitted: tool image could not be read]",
          }
          : { type: "image", image }
      );
      out.push({ role: "user", content: parts });
    }
    return out.length > 0 ? out : [{ role: "user", content: "" }];
  }

  const parts = await userParts(message.content, allowRemoteImages);
  if (parts.length === 0) return [{ role: "user", content: "" }];
  const single = parts.length === 1 && parts[0].type === "text"
    ? parts[0].text
    : parts;
  return [{ role: "user", content: single }];
}

function serializeTools(tools: unknown): CcRequestEnvelope["params"]["tools"] {
  if (!Array.isArray(tools)) return [];
  const out: CcRequestEnvelope["params"]["tools"] = [];
  for (const raw of tools) {
    if (!isRecord(raw)) continue;
    const fn = isRecord(raw.function) ? raw.function : raw;
    const name = String(fn.name ?? "");
    if (!name) continue;
    out.push({
      type: "function",
      name,
      ...nonEmptyString(fn.description) ? { description: fn.description } : {},
      input_schema: fn.parameters ?? fn.input_schema ??
        { type: "object", properties: {} },
    });
  }
  return out;
}

const GATEWAY_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** Translate an OpenAI Chat Completions request into Command Code's CLI envelope. */
export async function buildRequest(
  body: Record<string, any>,
  options: {
    dropToolCallIds?: ReadonlySet<string>;
    allowRemoteImages?: boolean;
    maxOutputTokens?: number;
  } = {},
): Promise<CcRequestEnvelope> {
  const inputMessages = Array.isArray(body.messages) ? body.messages : [];
  const pairing = collectPairing(
    inputMessages,
    options.dropToolCallIds ?? new Set(),
  );
  const messages: CcMessage[] = [];
  const systemParts: string[] = [];
  if (nonEmptyString(body.system)) systemParts.push(String(body.system));

  for (const message of inputMessages) {
    if (!isRecord(message)) continue;
    if (message.role === "system" || message.role === "developer") {
      const text = textFromContent(message.content);
      if (text) systemParts.push(text);
    } else if (message.role === "assistant") {
      const serialized = serializeAssistant(message, pairing);
      if (serialized) messages.push(serialized);
    } else {
      messages.push(
        ...await serializeUser(
          message,
          pairing,
          options.allowRemoteImages === true,
        ),
      );
    }
  }

  const requestedTokens = Number(
    body.max_completion_tokens ?? body.max_tokens ?? DEFAULT_MAX_TOKENS,
  );
  const outputCap = Number.isSafeInteger(options.maxOutputTokens) &&
      (options.maxOutputTokens ?? 0) > 0
    ? options.maxOutputTokens!
    : DEFAULT_MAX_TOKENS;
  const requestedOutput = Number.isSafeInteger(requestedTokens) &&
      requestedTokens > 0
    ? requestedTokens
    : DEFAULT_MAX_TOKENS;
  const maxTokens = Math.min(requestedOutput, outputCap);
  const effort = String(
    body.reasoning_effort ?? body.reasoning?.effort ?? "off",
  ).toLowerCase();
  const params: CcRequestEnvelope["params"] = {
    model: String(body.model ?? ""),
    messages,
    tools: serializeTools(body.tools),
    system: systemParts.join("\n\n"),
    max_tokens: maxTokens,
    stream: true,
  };
  if (typeof body.temperature === "number") {
    params.temperature = body.temperature;
  }
  if (typeof body.top_p === "number") params.top_p = body.top_p;
  if (GATEWAY_EFFORTS.has(effort)) params.reasoning_effort = effort;

  return {
    config: {
      workingDir: "ai-proxy",
      date: new Date().toISOString().split("T")[0],
      environment: runtimeEnvironment(),
      structure: [],
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "",
      gitStatus: "",
      recentCommits: [],
    },
    memory: "",
    taste: "",
    skills: null,
    permissionMode: "standard",
    params,
  };
}

function randomHex(bytes = 8): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Stable official-shaped id for an explicit seed; one-shot calls stay isolated. */
export async function commandCodeSessionId(seed?: string): Promise<string> {
  if (!seed) return `sess_${randomHex()}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(seed),
  );
  return `sess_${
    [...new Uint8Array(digest)].map((byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("").slice(0, 16)
  }`;
}

export function commandCodeHeaders(
  apiKey: string,
  sessionId: string,
  version = CC_VERSION,
): Headers {
  return new Headers({
    "content-type": "application/json",
    accept: "text/event-stream, application/json",
    "user-agent": `commandcode/${version}`,
    "x-command-code-version": version,
    "x-cli-environment": "production",
    "x-taste-learning": "false",
    "x-session-id": sessionId,
    "x-project-slug": PROJECT_SLUG,
    authorization: `Bearer ${apiKey}`,
  });
}

function parseEventLine(line: string): CcStreamEvent | undefined {
  const value = line.trim();
  if (!value || value.startsWith(":")) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) && typeof parsed.type === "string"
      ? parsed as CcStreamEvent
      : undefined;
  } catch {
    return undefined;
  }
}

/** Parse the gateway's bare-NDJSON response stream. */
export async function* parseEventStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<CcStreamEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        const event = parseEventLine(line);
        if (event) yield event;
      }
      if (done) {
        completed = true;
        const tail = parseEventLine(buffer);
        if (tail) yield tail;
        return;
      }
    }
  } finally {
    if (!completed) {
      try {
        await reader.cancel();
      } catch { /* stream already closed */ }
    }
    try {
      reader.releaseLock();
    } catch { /* ignore */ }
  }
}

export function usageSummary(event: CcStreamEvent): CcUsageSummary | undefined {
  const usage = isRecord(event.totalUsage)
    ? event.totalUsage as unknown as CcUsage
    : isRecord(event.usage)
    ? event.usage as unknown as CcUsage
    : undefined;
  if (!usage) return undefined;
  const inputDetails = isRecord(usage.inputTokenDetails)
    ? usage.inputTokenDetails
    : undefined;
  const outputDetails = isRecord(usage.outputTokenDetails)
    ? usage.outputTokenDetails
    : undefined;
  const cacheRead = inputDetails?.cacheReadTokens;
  const cacheWrite =
    (usage as unknown as Record<string, unknown>).cacheWriteTokens as
      | number
      | undefined ??
      inputDetails?.cacheWriteTokens ??
      inputDetails?.cacheCreationTokens ??
      inputDetails?.cacheCreationInputTokens;
  const totalInput = usage.inputTokens;
  const noCache = inputDetails?.noCacheTokens;
  const inputTokens = noCache ??
    (totalInput !== undefined && cacheRead !== undefined
      ? Math.max(0, totalInput - cacheRead)
      : totalInput) ??
    0;
  return {
    inputTokens,
    outputTokens: usage.outputTokens ??
      ((outputDetails?.textTokens ?? 0) +
        (outputDetails?.reasoningTokens ?? 0)),
    ...cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {},
    ...cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {},
    ...outputDetails?.reasoningTokens !== undefined
      ? { reasoningTokens: outputDetails.reasoningTokens }
      : {},
  };
}

export type NormalizedStreamEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
    type: "tool_call";
    id: string;
    name: string;
    arguments: string;
    index: number;
  }
  | { type: "continue" }
  | { type: "error"; message: string }
  | {
    type: "finish";
    reason: "stop" | "tool_calls" | "length";
    usage?: CcUsageSummary;
  };

export interface CcStreamState {
  finished: boolean;
  nextBlockIndex: number;
  nextToolIndex: number;
  toolCallIds: Map<string, string>;
  toolIndexes: Map<number, number>;
  toolSchemas: Map<string, unknown>;
  providerUsage?: CcUsage;
  pauseTurn?: boolean;
  brokenToolCall?: boolean;
}

export function newStreamState(
  toolSchemas: ReadonlyMap<string, unknown> = new Map(),
): CcStreamState {
  return {
    finished: false,
    nextBlockIndex: 0,
    nextToolIndex: 0,
    toolCallIds: new Map(),
    toolIndexes: new Map(),
    toolSchemas: new Map(toolSchemas),
    brokenToolCall: false,
  };
}

function uniqueToolCallId(
  state: CcStreamState,
  declared: string,
  fingerprint: string,
): string | undefined {
  const base = declared || `call-${state.nextBlockIndex}`;
  let candidate = base;
  for (let suffix = 2;; suffix++) {
    const known = state.toolCallIds.get(candidate);
    if (known === undefined) {
      state.toolCallIds.set(candidate, fingerprint);
      return candidate;
    }
    if (known === fingerprint) return undefined;
    candidate = `${base}-${suffix}`;
  }
}

function mapFinishReason(
  raw: unknown,
  sawToolCall: boolean,
): "stop" | "tool_calls" | "length" {
  const reason = String(raw ?? "stop").toLowerCase();
  if (["length", "max_tokens", "max-output-tokens"].includes(reason)) {
    return "length";
  }
  if (
    reason === "tool_calls" || reason === "tool-calls" ||
    reason === "tool_use" || reason === "tool-use" || sawToolCall
  ) {
    return "tool_calls";
  }
  return "stop";
}

function coerceToolInput(input: unknown, schema: unknown): unknown {
  if (input === undefined || input === null) return {};
  if (typeof input === "string") {
    const parsed = safeParseJson(input);
    if (isRecord(parsed)) return parsed;
    const required = isRecord(schema) && Array.isArray(schema.required)
      ? schema.required.filter((value): value is string =>
        typeof value === "string"
      )
      : [];
    const properties = isRecord(schema) && isRecord(schema.properties)
      ? Object.keys(schema.properties)
      : [];
    const first = required[0] ?? properties[0];
    return first ? { [first]: parsed } : parsed;
  }
  if (Array.isArray(input) && input.length === 1) {
    return coerceToolInput(input[0], schema);
  }
  if (isRecord(schema) && schema.type === "object" && !isRecord(input)) {
    const properties = isRecord(schema.properties)
      ? Object.keys(schema.properties)
      : [];
    const first = properties[0];
    return first ? { [first]: input } : {};
  }
  return input;
}

function hasMalformedToolArguments(input: unknown): boolean {
  if (typeof input !== "string" || input.trim() === "") return false;
  try {
    JSON.parse(input);
    return false;
  } catch {
    return true;
  }
}

/** Convert one gateway event into OpenAI-compatible logical deltas. */
export function normalizeEvent(
  event: CcStreamEvent,
  state: CcStreamState,
): NormalizedStreamEvent[] {
  if (state.finished) return [];
  if (event.type === "text-start" || event.type === "reasoning-start") {
    state.nextBlockIndex++;
    return [];
  }
  if (event.type === "text-delta") {
    const text = typeof event.text === "string" ? event.text : "";
    return text ? [{ type: "text", text }] : [];
  }
  if (event.type === "reasoning-delta") {
    const text = typeof event.text === "string" ? event.text : "";
    return text ? [{ type: "reasoning", text }] : [];
  }
  if (event.type === "tool-call") {
    const blockIndex = state.nextBlockIndex++;
    const declared = typeof event.toolCallId === "string"
      ? event.toolCallId
      : typeof event.id === "string"
      ? event.id
      : "";
    const name = typeof event.toolName === "string" ? event.toolName : "";
    const rawInput = event.input ?? event.args ?? event.arguments ?? {};
    if (hasMalformedToolArguments(rawInput)) {
      state.brokenToolCall = true;
      return [];
    }
    const input = coerceToolInput(rawInput, state.toolSchemas.get(name));
    const args = typeof input === "string" ? input : JSON.stringify(input);
    const id = uniqueToolCallId(state, declared, `${name}\u0000${args}`);
    if (id === undefined) return [];
    const index = state.nextToolIndex++;
    state.toolIndexes.set(blockIndex, index);
    return [{ type: "tool_call", id, name, arguments: args, index }];
  }
  if (
    event.type === "provider-metadata" ||
    event.type === "cache-write-tokens" ||
    event.type === "cache-write"
  ) {
    const candidate = isRecord(event.usage)
      ? event.usage
      : isRecord(event.totalUsage)
      ? event.totalUsage
      : isRecord(event.tokens)
      ? event.tokens
      : undefined;
    if (candidate) state.providerUsage = candidate as unknown as CcUsage;
    return [];
  }
  // Provider-executed tool results are internal gateway events, not client
  // tool-call deltas. Keep them out of the OpenAI stream while preserving the
  // protocol's pairing behavior for ordinary client tool calls.
  if (event.type === "tool-result" || event.type === "tool-result-delta") {
    return [];
  }
  if (event.type === "finish-step" || event.type === "finish") {
    const rawReason = String(event.rawFinishReason ?? event.finishReason ?? "")
      .toLowerCase();
    if (rawReason === "pause_turn" || rawReason === "pause-turn") {
      state.pauseTurn = true;
      return [{ type: "continue" }];
    }
    const knownReasons = new Set([
      "",
      "stop",
      "end_turn",
      "stop_sequence",
      "length",
      "max_tokens",
      "max-output-tokens",
      "tool_calls",
      "tool-calls",
      "tool_use",
      "tool-use",
    ]);
    if (!knownReasons.has(rawReason)) {
      state.finished = true;
      return [{
        type: "error",
        message:
          `Command Code returned unsupported finish reason: ${rawReason}`,
      }];
    }
    state.finished = true;
    const usage = usageSummary(event) ??
      (state.providerUsage
        ? usageSummary({
          type: "finish",
          usage: state.providerUsage,
        })
        : undefined);
    return [{
      type: "finish",
      reason: state.brokenToolCall ? "length" : mapFinishReason(
        event.rawFinishReason ?? event.finishReason,
        state.nextToolIndex > 0,
      ),
      ...usage ? { usage } : {},
    }];
  }
  return [];
}

export function streamErrorText(event: CcStreamEvent): string | undefined {
  const direct = event.errorText ?? event.message;
  if (typeof direct === "string" && direct) return direct;
  const nested = event.error;
  if (typeof nested === "string" && nested) return nested;
  if (isRecord(nested)) {
    for (const key of ["message", "errorText", "detail"]) {
      const value = nested[key];
      if (typeof value === "string" && value) return value;
    }
    if (isRecord(nested.error) && typeof nested.error.message === "string") {
      return nested.error.message;
    }
  }
  return undefined;
}

export function streamErrorCode(
  event: CcStreamEvent,
  message: string,
): string {
  const text = message.toLowerCase();
  const structured = isRecord(event.error)
    ? String(event.error.code ?? event.error.type ?? "").toLowerCase()
    : String(event.code ?? event.type ?? "").toLowerCase();
  if (
    /unauthor|forbidden|invalid api key|invalid authorization|authentication|expired/
      .test(text) ||
    /unauthor|forbidden|invalid_api_key|authentication/.test(structured)
  ) return "authentication";
  if (
    /model_not_in_plan|premium_credits_exhausted|insufficient credits/.test(
      text,
    ) ||
    /model_not_in_plan|premium_credits_exhausted|insufficient_credits/.test(
      structured,
    )
  ) {
    return /premium_credits_exhausted|insufficient_credits/.test(
        text + structured,
      )
      ? "billing_error"
      : "permission_error";
  }
  if (/context|token limit|too many tokens|input.*length/.test(text)) {
    return "context_length_exceeded";
  }
  if (
    /tool result is missing|invalid|malformed|unsupported|required|must be|too (long|large)/
      .test(text)
  ) {
    return "invalid_request";
  }
  if (/rate ?limit|quota|too many requests|usage limit|exceeded/.test(text)) {
    return "rate_limit_exceeded";
  }
  return "upstream_error";
}

const MISSING_TOOL_RESULT_PATTERN =
  /tool result is missing for tool call[:\s]+["'`]?([A-Za-z0-9_.:@-]+)/gi;

export function missingToolCallIds(message: string): string[] {
  if (!/tool result is missing/i.test(message)) return [];
  const ids: string[] = [];
  for (const match of message.matchAll(MISSING_TOOL_RESULT_PATTERN)) {
    const id = match[1];
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export function gatewayErrorMessage(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      isRecord(parsed) && isRecord(parsed.error) &&
      typeof parsed.error.message === "string"
    ) {
      return parsed.error.message;
    }
    if (isRecord(parsed) && typeof parsed.message === "string") {
      return parsed.message;
    }
  } catch {
    // Non-JSON errors are reported with the HTTP status by the caller.
  }
  return undefined;
}
