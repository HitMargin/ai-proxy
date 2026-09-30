// deno-lint-ignore-file no-explicit-any
/**
 * Command Code Go provider for ai-proxy.
 * Core protocol/model/account concepts are derived from dsh-cmdgo-provider 0.9.1
 * (MIT, Copyright (c) 2026 Ajwyunsx): https://github.com/Ajwyunsx/dsh-cmdgo-provider
 */

import { ENV } from "../core.ts";
import { classifyStreamFailure } from "../runtime/stream-normalizer.ts";
import {
  handleDeepseekResponses,
  readJsonBodyLimited,
} from "../deepseek-responses.ts";
import {
  applyModalities,
  fetchAllModels,
  fetchCatalog,
  fetchCatalogModalities,
  type GoModel,
  hasKnownModality,
  selectGoModels,
} from "./models.ts";
import { type CommandCodeAccount, CommandCodeAccountPool } from "./pool.ts";
import {
  anthropicMessagesToChat,
  chatResponseToAnthropic,
  openAiStreamToAnthropic,
} from "./anthropic-messages.ts";
import {
  CommandCodeLoginManager,
  type CommandCodeLoginSuccess,
} from "./oauth.ts";
import {
  buildRequest,
  CC_VERSION,
  type CcUsageSummary,
  commandCodeHeaders,
  commandCodeSessionId,
  gatewayErrorMessage,
  missingToolCallIds,
  newStreamState,
  type NormalizedStreamEvent,
  normalizeEvent,
  parseEventStream,
  streamErrorCode,
  streamErrorText,
} from "./protocol.ts";
import { RequestStats } from "./request-stats.ts";
import { UsageReader, type UsageStatus } from "./usage.ts";

const DEFAULT_BASE_URL = "https://api.commandcode.ai";
const MODEL_TTL_MS = 15 * 60_000;
const MODALITY_TTL_MS = 6 * 60 * 60_000;
const MAX_FAILOVER_ATTEMPTS = 4;
const MAX_REPAIR_ATTEMPTS = 4;
const DEFAULT_MAX_PAUSE_TURNS = 2;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_TOKENS = 64_000;
const DEFAULT_CONTEXT_WINDOW = 1_000_000;
const MODULE_SESSION_SALT = crypto.randomUUID().replace(/-/g, "");
const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
};

function baseUrl(): string {
  const raw = (ENV.COMMANDCODE_BASE_URL || DEFAULT_BASE_URL).trim();
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  const loopback = host === "localhost" || host === "127.0.0.1" ||
    host === "[::1]" || host === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(
      "COMMANDCODE_BASE_URL must use HTTPS (HTTP is allowed only for loopback testing)",
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "COMMANDCODE_BASE_URL must not contain credentials, query parameters, or a fragment",
    );
  }
  return raw.replace(/\/+$/, "");
}

function trustedCatalogUrl(raw: string | undefined, fallback: string): string {
  const value = (raw || fallback).trim();
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  const loopback = host === "localhost" || host === "127.0.0.1" ||
    host === "[::1]" || host === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(
      "CommandCode catalog URLs must use HTTPS (HTTP only for loopback)",
    );
  }
  if (url.username || url.password) {
    throw new Error("CommandCode catalog URLs must not contain credentials");
  }
  return value;
}

function credentialFingerprint(value: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < value.length; index++) {
    hash ^= BigInt(value.charCodeAt(index) & 0xff);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

function usageKey(account: CommandCodeAccount): string {
  return `${account.id}:${credentialFingerprint(account.apiKey)}`;
}

function isLoopbackUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" ||
    host === "::1";
}

function managementRequest(request: Request, url: URL): boolean {
  const configuredAdminKey = (ENV.COMMANDCODE_ADMIN_KEY || "").trim();
  if (configuredAdminKey) {
    return request.headers.get("x-commandcode-admin-key") ===
      configuredAdminKey;
  }
  if (typeof Deno === "undefined") return false;
  try {
    if (Deno.env.get("DENO_DEPLOYMENT_ID")) return false;
  } catch {
    // Local Deno without env permission can still use loopback management.
  }
  if (request.headers.get("x-commandcode-internal-proxy") === "1") return false;
  return isLoopbackUrl(url) && request.method !== "OPTIONS";
}

function accountsFile(): string {
  return ENV.COMMANDCODE_ACCOUNTS_FILE || "./commandcode-accounts.json";
}

function numberSetting(name: string, fallback: number, minimum = 1): number {
  const value = Number(ENV[name]);
  return Number.isFinite(value) && value >= minimum
    ? Math.floor(value)
    : fallback;
}

function commandCodeMaxBodyBytes(): number {
  return numberSetting("COMMANDCODE_MAX_BODY_BYTES", 12 * 1024 * 1024, 1024);
}

function commandCodeVersion(): string {
  const value = (ENV.COMMANDCODE_VERSION || CC_VERSION).trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i.test(value)) {
    throw new Error("COMMANDCODE_VERSION must be a semantic version");
  }
  return value;
}

const accountPool = new CommandCodeAccountPool(
  accountsFile(),
  () => ENV.COMMANDCODE_API_KEY || "",
  (message) => console.warn(message),
  {
    maxConcurrent: numberSetting("COMMANDCODE_MAX_INFLIGHT", 0, 0),
    minIntervalMs: numberSetting("COMMANDCODE_MIN_INTERVAL_MS", 0, 0),
  },
);
const usageReader = new UsageReader({
  baseURL: () => baseUrl(),
  version: () => commandCodeVersion(),
  log: (message) => console.warn(message),
});
const loginManager = new CommandCodeLoginManager((message) =>
  console.info(message)
);
const requestStats = new RequestStats();

let catalogModels: GoModel[] = [];
let catalogError: string | undefined;
let catalogSyncedAt = 0;
let catalogSyncPromise: Promise<GoModel[]> | undefined;
let liveModalities: ReadonlyMap<string, readonly string[]> | undefined;
let liveModalitiesFetchedAt = 0;
let loginPersistence: Promise<void> | undefined;

class CommandCodeError extends Error {
  status: number;
  code: string;
  retryAfterMs: number;

  constructor(
    message: string,
    status = 502,
    code = "upstream_error",
    retryAfterMs = 0,
  ) {
    super(message);
    this.name = "CommandCodeError";
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

function retryAfterMs(response: Response): number {
  const raw = response.headers.get("retry-after");
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : 0;
}

function errorResponse(error: unknown): Response {
  const known = error instanceof CommandCodeError
    ? error
    : new CommandCodeError(
      error instanceof Error ? error.message : String(error),
    );
  const headers = new Headers(JSON_HEADERS);
  if (known.retryAfterMs > 0) {
    headers.set("Retry-After", String(Math.ceil(known.retryAfterMs / 1000)));
  }
  return new Response(
    JSON.stringify({
      error: {
        message: known.message,
        type: known.code,
        ...known.retryAfterMs > 0 ? { retry_after_ms: known.retryAfterMs } : {},
      },
    }),
    { status: known.status, headers },
  );
}

function jsonResponse(
  value: unknown,
  status = 200,
  extraHeaders: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...JSON_HEADERS,
      ...Object.fromEntries(new Headers(extraHeaders)),
    },
  });
}

function httpError(response: Response, body: string): CommandCodeError {
  const message = gatewayErrorMessage(body) ??
    `Command Code HTTP ${response.status}${
      body ? `: ${body.slice(0, 240)}` : ""
    }`;
  if (response.status === 401) {
    return new CommandCodeError(message, 401, "authentication");
  }
  if (response.status === 403) {
    let structuredCode = "";
    try {
      const parsed: any = JSON.parse(body);
      structuredCode = String(
        parsed?.error?.code ?? parsed?.code ?? parsed?.type ?? "",
      ).toLowerCase();
    } catch { /* use text fallback */ }
    const permission = body.toLowerCase().includes("model_not_in_plan") ||
      structuredCode.includes("model_not_in_plan");
    return new CommandCodeError(
      message,
      403,
      permission ? "permission_error" : "authentication",
    );
  }
  if (response.status === 429) {
    return new CommandCodeError(
      message,
      429,
      "rate_limit_exceeded",
      retryAfterMs(response),
    );
  }
  if (response.status === 400) {
    const code = /context|token limit|too many tokens/i.test(message)
      ? "context_length_exceeded"
      : "invalid_request_error";
    return new CommandCodeError(message, 400, code);
  }
  if (response.status >= 400 && response.status < 500) {
    return new CommandCodeError(
      message,
      response.status,
      response.status === 404 ? "not_found_error" : "invalid_request_error",
    );
  }
  return new CommandCodeError(message, 502, "upstream_error");
}

function streamError(event: any): CommandCodeError {
  if (event.type === "abort") {
    return new CommandCodeError(
      "Command Code gateway aborted the stream",
      502,
      "upstream_error",
    );
  }
  const message = streamErrorText(event) ?? "Command Code gateway error";
  const code = streamErrorCode(event, message);
  const status = code === "authentication"
    ? 401
    : code === "permission_error"
    ? 403
    : code === "billing_error"
    ? /premium|rate limit|quota|exhaust/i.test(message) ? 429 : 402
    : code === "rate_limit_exceeded"
    ? 429
    : code === "context_length_exceeded"
    ? 400
    : code === "timeout"
    ? 504
    : code === "invalid_request"
    ? 400
    : 502;
  return new CommandCodeError(message, status, code);
}

function failoverError(error: unknown): boolean {
  return error instanceof CommandCodeError &&
    [
      "authentication",
      "permission_error",
      "billing_error",
      "rate_limit_exceeded",
      "timeout",
      "upstream_error",
    ].includes(
      error.code,
    );
}

async function coolingError(): Promise<CommandCodeError> {
  const now = Date.now();
  const next = await accountPool.nextAvailableAt(now);
  return new CommandCodeError(
    next === undefined
      ? "All configured CommandCode accounts are cooling down or unavailable"
      : "All configured CommandCode accounts are cooling down",
    429,
    "rate_limit_exceeded",
    next === undefined ? 0 : Math.max(1_000, next - now),
  );
}

function openAiUsage(usage: CcUsageSummary | undefined): any {
  if (!usage) return undefined;
  const promptTokens = usage.inputTokens + (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: promptTokens + usage.outputTokens,
    prompt_tokens_details: {
      cached_tokens: usage.cacheReadTokens ?? 0,
      cache_write_tokens: usage.cacheWriteTokens ?? 0,
    },
    completion_tokens_details: {
      reasoning_tokens: usage.reasoningTokens ?? 0,
    },
  };
}

function modelToOpenAi(model: GoModel): Record<string, unknown> {
  const efforts = model.efforts?.filter((effort) =>
    ["low", "medium", "high", "xhigh", "max"].includes(effort)
  );
  return {
    id: model.id,
    object: "model",
    created: 0,
    owned_by: "commandcode",
    name: model.name,
    context_window: model.contextWindow || DEFAULT_CONTEXT_WINDOW,
    max_output_tokens: numberSetting(
      "COMMANDCODE_MAX_TOKENS",
      DEFAULT_MAX_TOKENS,
    ),
    input_modalities: model.inputModalities ?? ["text"],
    reasoning_efforts: [
      "off",
      ...(efforts?.length
        ? efforts
        : ["low", "medium", "high", "xhigh", "max"]),
    ],
  };
}

function liveModalitiesAvailable(): boolean {
  if (typeof Deno === "undefined") return false;
  try {
    return !Deno.env.get("DENO_DEPLOYMENT_ID");
  } catch {
    return true;
  }
}

function syncCatalog(force = false): Promise<GoModel[]> {
  if (
    !force && catalogModels.length > 0 &&
    Date.now() - catalogSyncedAt < MODEL_TTL_MS
  ) return Promise.resolve(catalogModels);
  if (catalogSyncPromise) return catalogSyncPromise;
  catalogSyncPromise = (async () => {
    try {
      const modelsUrl = ENV.COMMANDCODE_MODELS_URL
        ? trustedCatalogUrl(
          ENV.COMMANDCODE_MODELS_URL,
          `${baseUrl()}/provider/v1/models`,
        )
        : `${baseUrl()}/provider/v1/models`;
      const all = await fetchAllModels(modelsUrl);
      let selected = selectGoModels(all);
      if (selected.length === 0) {
        throw new Error("Command Code returned no Go models");
      }
      catalogModels = selected;
      catalogSyncedAt = Date.now();
      catalogError = undefined;

      try {
        const catalog = await fetchCatalog(
          ENV.COMMANDCODE_CATALOG_URL
            ? trustedCatalogUrl(
              ENV.COMMANDCODE_CATALOG_URL,
              "https://cdn.jsdelivr.net/npm/command-code@latest/dist/bundled/command-code-knowledge/reference/models.md",
            )
            : undefined,
        );
        const overlaid = selectGoModels(all, catalog.plans);
        if (overlaid.length > 0) selected = overlaid;
        const unknown = selected.filter((model) => !hasKnownModality(model.id));
        const needsLiveModalities = unknown.some((model) =>
          !liveModalities?.has(model.id)
        );
        if (
          needsLiveModalities && liveModalitiesAvailable() &&
          Date.now() - liveModalitiesFetchedAt >= MODALITY_TTL_MS
        ) {
          try {
            liveModalities = await fetchCatalogModalities(
              ENV.COMMANDCODE_REGISTRY_URL
                ? trustedCatalogUrl(
                  ENV.COMMANDCODE_REGISTRY_URL,
                  "https://cdn.jsdelivr.net/npm/command-code@latest/dist/cli.mjs",
                )
                : undefined,
            );
            liveModalitiesFetchedAt = Date.now();
          } catch (error) {
            console.warn(
              `[commandcode] live modality catalog unavailable: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
        selected = applyModalities(selected, liveModalities).map((model) => ({
          ...model,
          ...catalog.efforts.has(model.id)
            ? { efforts: catalog.efforts.get(model.id) }
            : {},
        }));
        catalogModels = selected;
        catalogSyncedAt = Date.now();
      } catch (error) {
        console.warn(
          `[commandcode] effort/plan catalog unavailable; using baseline: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return catalogModels;
    } catch (error) {
      catalogError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      catalogSyncPromise = undefined;
    }
  })();
  return catalogSyncPromise;
}

export function peekCommandCodeModels(): Record<string, unknown>[] {
  return catalogModels.map(modelToOpenAi);
}

export async function getCommandCodeModels(
  force = false,
): Promise<Record<string, unknown>[]> {
  try {
    return (await syncCatalog(force)).map(modelToOpenAi);
  } catch {
    return peekCommandCodeModels();
  }
}

function declaredToolIds(body: Record<string, any>): Set<string> {
  const ids = new Set<string>();
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    for (
      const call of Array.isArray(message?.tool_calls) ? message.tool_calls : []
    ) {
      if (typeof call?.id === "string" && call.id) ids.add(call.id);
    }
  }
  return ids;
}

interface SessionBinding {
  seed?: string;
}

function sessionSeed(
  request: Request,
  explicitOverride?: string,
): string | undefined {
  const explicit = explicitOverride ??
    request.headers.get("x-session-id") ??
    request.headers.get("x-conversation-id");
  const clientScope = request.headers.get("authorization") ??
    request.headers.get("x-api-key") ??
    request.headers.get("x-commandcode-client-scope");
  if (!explicit || explicit.length > 512 || !clientScope) return undefined;
  const salt = ENV.COMMANDCODE_SESSION_SALT || MODULE_SESSION_SALT;
  return JSON.stringify({ salt, clientScope, explicit });
}

function deriveSession(request: Request): SessionBinding {
  const seed = sessionSeed(request);
  return seed === undefined ? {} : { seed };
}

async function statsSessionId(
  request: Request,
  requested?: string,
): Promise<string | undefined> {
  if (!requested) return undefined;
  if (/^sess_[0-9a-f]{16}$/.test(requested)) return requested;
  const seed = sessionSeed(request, requested);
  return seed === undefined ? undefined : await commandCodeSessionId(seed);
}

function commandCodeRequestSignal(
  request: Request,
  ...signals: AbortSignal[]
): AbortSignal {
  return AbortSignal.any([request.signal, ...signals]);
}

async function* generateEvents(
  body: Record<string, any>,
  request: Request,
  sessionId: string,
  cancellation?: StreamCancellation,
): AsyncGenerator<NormalizedStreamEvent> {
  await accountPool.initialize();
  const poolSize = await accountPool.size();
  if (poolSize === 0) {
    throw new CommandCodeError(
      "Command Code credential missing: set COMMANDCODE_API_KEY, run the local OAuth login, or add an account",
      401,
      "authentication",
    );
  }
  const schedulable = await accountPool.schedulableCount();
  if (schedulable === 0) {
    throw new CommandCodeError(
      "All configured Command Code accounts are disabled",
      503,
      "rate_limit_exceeded",
    );
  }
  if ((await accountPool.activeCount()) === 0) throw await coolingError();
  const timeoutSignal = AbortSignal.timeout(
    numberSetting("COMMANDCODE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 1_000),
  );
  const localAbort = new AbortController();
  if (cancellation) cancellation.abort = () => localAbort.abort();
  const upstreamSignal = commandCodeRequestSignal(
    request,
    timeoutSignal,
    localAbort.signal,
  );
  let gatewayBase: string;
  let gatewayVersion: string;
  try {
    gatewayBase = baseUrl();
    gatewayVersion = commandCodeVersion();
  } catch (error) {
    throw new CommandCodeError(
      error instanceof Error ? error.message : String(error),
      502,
      "configuration_error",
    );
  }
  const attempts = Math.max(1, Math.min(schedulable, MAX_FAILOVER_ATTEMPTS));
  const excluded = new Set<string>();
  const dropped = new Set<string>();
  const declared = declaredToolIds(body);
  let repairs = 0;
  let pauseTurns = 0;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const account = await accountPool.acquire(excluded);
    if (!account) throw await coolingError();
    exchangeLoop: while (true) {
      let yielded = false;
      try {
        const envelope = await buildRequest(body, {
          dropToolCallIds: dropped,
          allowRemoteImages: /^(1|true|yes)$/i.test(
            ENV.COMMANDCODE_ALLOW_REMOTE_IMAGES || "",
          ),
          maxOutputTokens: numberSetting(
            "COMMANDCODE_MAX_TOKENS",
            DEFAULT_MAX_TOKENS,
          ),
        });
        let response: Response;
        try {
          response = await fetch(`${gatewayBase}/alpha/generate`, {
            method: "POST",
            headers: commandCodeHeaders(
              account.apiKey,
              sessionId,
              gatewayVersion,
            ),
            redirect: "error",
            body: JSON.stringify(envelope),
            signal: upstreamSignal,
          });
        } catch (error) {
          const failure = classifyStreamFailure(error, {
            abortedSignals: [localAbort.signal, request.signal],
            timeoutSignal,
          });
          if (failure === "aborted") {
            throw new CommandCodeError(
              "Command Code request cancelled by client",
              499,
              "aborted",
            );
          }
          if (failure === "timeout") {
            throw new CommandCodeError(
              "Command Code request timed out",
              504,
              "timeout",
            );
          }
          throw new CommandCodeError(
            `Command Code transport failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
            502,
            "upstream_error",
          );
        }
        if (!response.ok) {
          throw httpError(
            response,
            await response.text().catch(() => ""),
          );
        }
        if (!response.body) {
          throw new CommandCodeError(
            "Command Code returned an empty response stream",
            502,
            "upstream_error",
          );
        }

        const state = newStreamState(
          new Map(
            envelope.params.tools.map((tool) => [tool.name, tool.input_schema]),
          ),
        );
        let eventCount = 0;
        for await (const event of parseEventStream(response.body)) {
          eventCount++;
          if (event.type === "error" || event.type === "abort") {
            throw streamError(event);
          }
          const normalized = normalizeEvent(event, state);
          for (const item of normalized) {
            if (item.type === "error") {
              throw new CommandCodeError(item.message, 502, "upstream_error");
            }
            if (item.type === "continue") {
              if (
                yielded ||
                pauseTurns >= numberSetting(
                    "COMMANDCODE_MAX_PAUSE_TURNS",
                    DEFAULT_MAX_PAUSE_TURNS,
                  )
              ) {
                throw new CommandCodeError(
                  "Command Code pause_turn continuation is not safe after output has started or the limit was reached",
                  502,
                  "unsupported_pause_turn",
                );
              }
              pauseTurns++;
              continue;
            }
            if (item.type === "finish" && item.usage) {
              requestStats.record({
                sessionId,
                model: String(body.model ?? ""),
                inputTokens: item.usage.inputTokens,
                outputTokens: item.usage.outputTokens,
                ...item.usage.cacheReadTokens === undefined
                  ? {}
                  : { cacheReadTokens: item.usage.cacheReadTokens },
                ...item.usage.cacheWriteTokens === undefined
                  ? {}
                  : { cacheWriteTokens: item.usage.cacheWriteTokens },
                ...item.usage.reasoningTokens === undefined
                  ? {}
                  : { reasoningTokens: item.usage.reasoningTokens },
                at: Date.now(),
              });
            }
            yielded = true;
            yield item;
          }
          if (state.finished) {
            await accountPool.reportSuccess(account);
            accountPool.release(account);
            return;
          }
        }
        if (state.brokenToolCall) {
          throw new CommandCodeError(
            "Command Code tool call arguments were truncated before a valid JSON payload",
            502,
            "stream_cut",
          );
        }
        if (state.pauseTurn) {
          if (
            !yielded &&
            pauseTurns < numberSetting(
                "COMMANDCODE_MAX_PAUSE_TURNS",
                DEFAULT_MAX_PAUSE_TURNS,
              )
          ) {
            continue exchangeLoop;
          }
          throw new CommandCodeError(
            "Command Code pause_turn continuation reached its safety limit",
            502,
            "unsupported_pause_turn",
          );
        }
        throw new CommandCodeError(
          `Command Code stream ended without finish-step or finish (${eventCount} event(s) received)`,
          502,
          "upstream_error",
        );
      } catch (caught) {
        const failure = classifyStreamFailure(caught, {
          abortedSignals: [localAbort.signal, request.signal],
          timeoutSignal,
          deliveredOutput: yielded,
        });
        if (failure === "aborted") {
          accountPool.release(account);
          throw new CommandCodeError(
            "Command Code request cancelled by client",
            499,
            "aborted",
          );
        }
        if (failure === "timeout") {
          accountPool.release(account);
          throw new CommandCodeError(
            "Command Code request timed out",
            504,
            "timeout",
          );
        }
        const rawMessage = caught instanceof Error
          ? caught.message
          : String(caught);
        const message = rawMessage.replaceAll(account.apiKey, "[redacted]");
        const error =
          caught instanceof CommandCodeError && message !== rawMessage
            ? new CommandCodeError(
              message,
              caught.status,
              caught.code,
              caught.retryAfterMs,
            )
            : caught;
        if (!yielded) {
          const repairIds = missingToolCallIds(message).filter((id) =>
            declared.has(id) && !dropped.has(id)
          );
          if (repairIds.length > 0 && repairs < MAX_REPAIR_ATTEMPTS) {
            for (const id of repairIds) dropped.add(id);
            repairs++;
            console.warn(
              `[commandcode] repairing request shape; dropping tool call ids: ${
                repairIds.join(", ")
              }`,
            );
            continue exchangeLoop;
          }
        }
        const canFailover = failoverError(error);
        if (canFailover) {
          await accountPool.reportFailure(
            account,
            message,
            error instanceof CommandCodeError ? error.retryAfterMs : 0,
          );
        }
        if (yielded || attempt >= attempts - 1 || !canFailover) {
          accountPool.release(account);
          throw error;
        }
        excluded.add(account.id);
        accountPool.release(account);
        break exchangeLoop;
      }
    }
  }
  throw await coolingError();
}

interface StreamCancellation {
  abort: () => void;
}

function openAiStream(
  events: AsyncGenerator<NormalizedStreamEvent>,
  model: string,
  cancellation?: StreamCancellation,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const id = `chatcmpl-${crypto.randomUUID().replace(/-/g, "")}`;
      const created = Math.floor(Date.now() / 1000);
      let roleSent = false;
      const send = (
        delta: Record<string, unknown>,
        finishReason: string | null = null,
        extra: Record<string, unknown> = {},
      ) => {
        const payload = {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
          ...extra,
        };
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
        );
      };
      const ensureRole = () => {
        if (!roleSent) {
          send({ role: "assistant", content: "" });
          roleSent = true;
        }
      };
      try {
        for await (const event of events) {
          if (event.type === "text") {
            ensureRole();
            send({ content: event.text });
          } else if (event.type === "reasoning") {
            ensureRole();
            send({ reasoning_content: event.text });
          } else if (event.type === "tool_call") {
            ensureRole();
            send({
              tool_calls: [{
                index: event.index,
                id: event.id,
                type: "function",
                function: { name: event.name, arguments: event.arguments },
              }],
            });
          } else {
            ensureRole();
            if (event.type === "error") {
              throw new CommandCodeError(event.message, 502, "upstream_error");
            }
            if (event.type === "continue") {
              throw new CommandCodeError(
                "Command Code pause_turn continuation is not supported by this stateless proxy",
                502,
                "unsupported_pause_turn",
              );
            }
            const usage = openAiUsage(event.usage);
            send({}, event.reason, usage ? { usage } : {});
          }
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (error) {
        if (cancelled) return;
        const known = error instanceof CommandCodeError
          ? error
          : new CommandCodeError(String(error));
        controller.enqueue(
          encoder.encode(`data: ${
            JSON.stringify({
              error: { message: known.message, type: known.code },
            })
          }\n\n`),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } finally {
        try {
          controller.close();
        } catch { /* consumer cancelled */ }
      }
    },
    cancel() {
      cancelled = true;
      cancellation?.abort();
      void events.return(undefined);
    },
  });
}

async function chatCompletion(
  body: Record<string, any>,
  request: Request,
): Promise<Response> {
  if (typeof body.model !== "string" || !body.model.trim()) {
    return jsonResponse({
      error: { message: "model is required", type: "invalid_request_error" },
    }, 400);
  }
  if (!Array.isArray(body.messages)) {
    return jsonResponse({
      error: {
        message: "messages must be an array",
        type: "invalid_request_error",
      },
    }, 400);
  }
  if (
    body.response_format !== undefined || body.stop !== undefined ||
    body.parallel_tool_calls === false || (body.n !== undefined && body.n !== 1)
  ) {
    return jsonResponse({
      error: {
        message:
          "CommandCode gateway does not support response_format, stop, parallel_tool_calls=false, or n!=1",
        type: "invalid_request_error",
      },
    }, 400);
  }
  if (
    body.tool_choice !== undefined && body.tool_choice !== "auto" &&
    body.tool_choice !== "none"
  ) {
    return jsonResponse({
      error: {
        message: "CommandCode gateway only supports tool_choice=auto or none",
        type: "invalid_request_error",
      },
    }, 400);
  }
  if (body.tool_choice === "none") body.tools = [];
  const model = body.model;
  await accountPool.initialize();
  if ((await accountPool.size()) === 0) {
    return errorResponse(
      new CommandCodeError(
        "Command Code credential missing: set COMMANDCODE_API_KEY, run the local OAuth login, or add an account",
        401,
        "authentication",
      ),
    );
  }
  if ((await accountPool.schedulableCount()) === 0) {
    return errorResponse(
      new CommandCodeError(
        "All configured Command Code accounts are disabled",
        503,
        "rate_limit_exceeded",
      ),
    );
  }
  if ((await accountPool.activeCount()) === 0) {
    return errorResponse(await coolingError());
  }
  const session = deriveSession(request);
  const sessionId = await commandCodeSessionId(session.seed);
  const cancellation: StreamCancellation = { abort: () => {} };
  const events = generateEvents(body, request, sessionId, cancellation);

  if (body.stream === true) {
    return new Response(openAiStream(events, model, cancellation), {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "X-Accel-Buffering": "no",
        "X-CommandCode-Session-Id": sessionId,
      },
    });
  }

  let content = "";
  let reasoning = "";
  const toolCalls: Array<
    {
      id: string;
      type: "function";
      function: { name: string; arguments: string };
      index: number;
    }
  > = [];
  let finishReason = "stop";
  let usage: CcUsageSummary | undefined;
  try {
    for await (const event of events) {
      if (event.type === "text") content += event.text;
      else if (event.type === "reasoning") reasoning += event.text;
      else if (event.type === "tool_call") {
        toolCalls.push({
          id: event.id,
          type: "function",
          function: { name: event.name, arguments: event.arguments },
          index: event.index,
        });
      } else {
        if (event.type === "error") {
          throw new CommandCodeError(event.message, 502, "upstream_error");
        }
        if (event.type === "continue") {
          throw new CommandCodeError(
            "Command Code pause_turn continuation is not supported by this stateless proxy",
            502,
            "unsupported_pause_turn",
          );
        }
        finishReason = event.reason;
        usage = event.usage;
      }
    }
  } catch (error) {
    return errorResponse(error);
  }

  const message: Record<string, unknown> = {
    role: "assistant",
    content: content || null,
  };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls.map(({ index: _index, ...call }) => call);
  }
  return jsonResponse(
    {
      id: `chatcmpl-${crypto.randomUUID().replace(/-/g, "")}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      ...openAiUsage(usage) ? { usage: openAiUsage(usage) } : {},
    },
    200,
    { "X-CommandCode-Session-Id": sessionId },
  );
}

function usageForAccount(
  account: CommandCodeAccount,
  force = false,
): UsageStatus | undefined {
  const key = usageKey(account);
  const cached = usageReader.snapshot(key);
  if (!force && usageReader.stale(key)) {
    void usageReader.refresh(key, account.apiKey).catch(() => undefined);
  }
  return cached;
}

async function statusSnapshot(
  request: Request,
  requestedSessionId?: string,
): Promise<Record<string, unknown>> {
  const sessionId = await statsSessionId(request, requestedSessionId);
  const accounts = await accountPool.list();
  const rows = await Promise.all(accounts.map(async (visible) => {
    const account = await accountPool.findById(visible.id);
    return {
      ...visible,
      configured: account !== undefined,
      cooling: visible.enabled && (visible.cooldownUntil ?? 0) > Date.now(),
      usage: account ? await usageForAccount(account) : undefined,
    };
  }));
  return {
    provider: "commandcode",
    modelCount: catalogModels.length,
    catalogError,
    activeAccounts: await accountPool.activeCount(),
    accounts: rows,
    login: loginManager.status,
    cache: requestStats.view(sessionId),
  };
}

async function readJsonBody(request: Request): Promise<Record<string, any>> {
  const result = await readJsonBodyLimited(request, 64 * 1024);
  return result.ok && result.value && typeof result.value === "object" &&
      !Array.isArray(result.value)
    ? result.value as Record<string, any>
    : {};
}

function persistLogin(info: CommandCodeLoginSuccess): Promise<void> {
  return accountPool.add(info).then((account) => {
    console.info(`[commandcode] OAuth key stored as account ${account.id}`);
  });
}

export async function handleCommandCode(
  path: string,
  request: Request,
  url: URL,
): Promise<Response> {
  const managementPath =
    /(\/status|\/usage(?:\/refresh)?|\/login(?:\/cancel)?|\/account\/toggle|\/account\/remove|\/logout)$/
      .test(path);
  const modelRefresh = path.endsWith("/models") &&
    url.searchParams.get("refresh") === "true";
  if ((managementPath || modelRefresh) && !managementRequest(request, url)) {
    return jsonResponse({
      error: {
        message:
          "Command Code management endpoints require COMMANDCODE_ADMIN_KEY or a loopback request",
        type: "permission_error",
      },
    }, 403);
  }
  if (path.endsWith("/messages") && request.method === "POST") {
    const parsed = await readJsonBodyLimited(
      request,
      commandCodeMaxBodyBytes(),
    );
    if (!parsed.ok) {
      return jsonResponse({
        type: "error",
        error: { type: "invalid_request_error", message: parsed.message },
      }, parsed.status);
    }
    let converted;
    try {
      converted = anthropicMessagesToChat(parsed.value);
    } catch (error) {
      return jsonResponse({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: error instanceof Error ? error.message : String(error),
        },
      }, 400);
    }
    if (!converted.ok) {
      return jsonResponse({
        type: "error",
        error: { type: "invalid_request_error", message: converted.message },
      }, 400);
    }
    const originalSignal = request.signal;
    const sessionHeader = request.headers.get("x-session-id") ??
      request.headers.get("x-conversation-id");
    const chatUrl = new URL(url);
    chatUrl.pathname = "/commandcode/v1/chat/completions";
    const headers = new Headers();
    if (sessionHeader) headers.set("x-session-id", sessionHeader);
    for (
      const name of [
        "authorization",
        "x-api-key",
        "x-commandcode-client-scope",
      ]
    ) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const proxyRequest = new Request(chatUrl, {
      method: "POST",
      headers,
      signal: originalSignal,
    });
    const chatResponse = await chatCompletion(converted.body, proxyRequest);
    if (converted.body.stream === true) {
      if (!chatResponse.ok) {
        const text = await chatResponse.text();
        return jsonResponse({
          type: "error",
          error: { type: "api_error", message: text.slice(0, 500) },
        }, chatResponse.status);
      }
      return openAiStreamToAnthropic(
        chatResponse,
        String(converted.body.model),
      );
    }
    let payload: unknown;
    try {
      payload = await chatResponse.json();
    } catch {
      payload = null;
    }
    if (!chatResponse.ok) {
      const message = payload && typeof payload === "object" &&
          (payload as Record<string, any>).error?.message
        ? String((payload as Record<string, any>).error.message)
        : "Command Code upstream request failed";
      return jsonResponse({
        type: "error",
        error: { type: "api_error", message },
      }, chatResponse.status);
    }
    const sessionId = chatResponse.headers.get("X-CommandCode-Session-Id");
    return jsonResponse(
      chatResponseToAnthropic(payload, String(converted.body.model)),
      200,
      sessionId ? { "X-CommandCode-Session-Id": sessionId } : {},
    );
  }
  if (path.endsWith("/responses") && request.method === "POST") {
    const originalSignal = request.signal;
    const sessionHeader = request.headers.get("x-session-id") ??
      request.headers.get("x-conversation-id");
    return await handleDeepseekResponses(
      request,
      async (chatBody) => {
        const chatUrl = new URL(url);
        chatUrl.pathname = "/commandcode/v1/chat/completions";
        const headers = new Headers();
        if (sessionHeader) headers.set("x-session-id", sessionHeader);
        for (
          const name of [
            "authorization",
            "x-api-key",
            "x-commandcode-client-scope",
          ]
        ) {
          const value = request.headers.get(name);
          if (value) headers.set(name, value);
        }
        const proxyRequest = new Request(chatUrl, {
          method: "POST",
          headers,
          signal: originalSignal,
        });
        return await chatCompletion(chatBody, proxyRequest);
      },
      commandCodeMaxBodyBytes(),
      true,
    );
  }

  if (path.endsWith("/models") && request.method === "GET") {
    const force = url.searchParams.get("refresh") === "true";
    const models = await getCommandCodeModels(force);
    return jsonResponse(
      { object: "list", data: models },
      200,
      catalogError
        ? { "X-CommandCode-Catalog-Error": catalogError.slice(0, 200) }
        : {},
    );
  }

  if (
    (path.endsWith("/status") || path.endsWith("/usage")) &&
    request.method === "GET"
  ) {
    return jsonResponse(
      await statusSnapshot(
        request,
        url.searchParams.get("sessionId") ?? undefined,
      ),
    );
  }

  if (path.endsWith("/usage/refresh") && request.method === "POST") {
    const body = await readJsonBody(request);
    const visible = await accountPool.list();
    const targets = typeof body.id === "string" && body.id
      ? visible.filter((account) => account.id === body.id)
      : visible;
    const resolved = await Promise.all(
      targets.map((account) => accountPool.findById(account.id)),
    );
    const configured = resolved.filter((
      account,
    ): account is CommandCodeAccount => account !== undefined);
    await Promise.all(
      configured.map((account) =>
        usageReader.refresh(usageKey(account), account.apiKey, { force: true })
          .catch(
            () => undefined,
          )
      ),
    );
    return jsonResponse({ ok: true, refreshed: configured.length });
  }

  if (path.endsWith("/login") && request.method === "POST") {
    try {
      const started = await loginManager.start();
      if (!loginPersistence && loginManager.status.status === "waiting") {
        loginPersistence = loginManager.waitForCallback().then(persistLogin)
          .finally(() => {
            loginPersistence = undefined;
          });
        loginPersistence.catch((error) =>
          console.warn(
            `[commandcode] OAuth login failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
        );
      }
      return jsonResponse({
        ok: true,
        ...started,
        status: loginManager.status,
      });
    } catch (error) {
      return errorResponse(
        new CommandCodeError(
          error instanceof Error ? error.message : String(error),
          501,
          "login_unavailable",
        ),
      );
    }
  }

  if (path.endsWith("/login/cancel") && request.method === "POST") {
    await loginManager.stop("user cancelled");
    return jsonResponse({ ok: true, status: loginManager.status });
  }

  if (path.endsWith("/account/toggle") && request.method === "POST") {
    const body = await readJsonBody(request);
    const changed =
      typeof body.id === "string" && typeof body.enabled === "boolean"
        ? await accountPool.toggle(body.id, body.enabled)
        : false;
    return jsonResponse(
      changed
        ? { ok: true }
        : { ok: false, error: "account not found or state unchanged" },
      changed ? 200 : 404,
    );
  }

  if (path.endsWith("/account/remove") && request.method === "POST") {
    const body = await readJsonBody(request);
    const removed = typeof body.id === "string"
      ? await accountPool.remove(body.id)
      : false;
    return jsonResponse(
      removed ? { ok: true } : { ok: false, error: "account not found" },
      removed ? 200 : 404,
    );
  }

  if (path.endsWith("/logout") && request.method === "POST") {
    const removed = await accountPool.clear();
    return jsonResponse({
      ok: true,
      removed,
      envCredentialStillConfigured: Boolean(
        (ENV.COMMANDCODE_API_KEY || "").trim(),
      ),
    });
  }

  if (path.endsWith("/chat/completions") && request.method === "POST") {
    const parsed = await readJsonBodyLimited(
      request,
      commandCodeMaxBodyBytes(),
    );
    if (!parsed.ok) {
      return jsonResponse({
        error: {
          message: parsed.message,
          type: parsed.status === 413
            ? "payload_too_large"
            : "invalid_request_error",
        },
      }, parsed.status);
    }
    if (
      !parsed.value || typeof parsed.value !== "object" ||
      Array.isArray(parsed.value)
    ) {
      return jsonResponse({
        error: {
          message: "Request body must be a JSON object",
          type: "invalid_request_error",
        },
      }, 400);
    }
    return await chatCompletion(parsed.value as Record<string, any>, request);
  }

  return jsonResponse({ error: "Command Code route not found" }, 404);
}
