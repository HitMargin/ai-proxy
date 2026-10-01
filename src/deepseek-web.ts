import { safeJsonParse } from "./core.ts";
import {
  inspectResponseBody,
  readInspectedText,
  replayResponse,
} from "./runtime/stream-normalizer.ts";
import { acquireDeepseekGate } from "./deepseek-gate.ts";
import {
  getDeepSeekRiskSnapshot,
  noteDeepSeekRequest,
  noteDeepSeekRestriction,
  noteDeepSeekSuccess,
} from "./deepseek-risk.ts";
import { handleDeepseekResponses } from "./deepseek-responses.ts";
import {
  serializePrompt,
  type ToolCallRequest,
  ToolCallStreamFilter,
  type ToolSchemaLike,
  TranscriptEchoGuard,
} from "../third_party/dsh-deepseek-web-login/src/protocol.ts";

// ============================================
// DeepSeek 网页聊天端集成模块
// ============================================

const DEEPSEEK_WEB_HOME = "https://chat.deepseek.com/";
const DEEPSEEK_WEB_API = "https://chat.deepseek.com";
const DEEPSEEK_WEB_COOKIE_FILE = "./deepseek-cookies.txt";
const DEEPSEEK_WEB_AUTH_FILE = "./deepseek-auth.txt";
const DEEPSEEK_WEB_HEADERS_FILE = "./deepseek-headers.json";
const DEEPSEEK_WEB_COOLDOWN_FILE = "./deepseek-web-cooldown.json";
const DEEPSEEK_MAX_PROMPT_CHARS = 200_000;
const DEEPSEEK_MAX_REF_IMAGES = 24;
const DEEPSEEK_SESSION_REUSE_TURNS = (() => {
  const raw = typeof Deno !== "undefined"
    ? Number(Deno.env.get("DEEPSEEK_SESSION_REUSE_TURNS") ?? "20")
    : 20;
  return Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 20;
})();
type DeepSeekSessionSlot = {
  key: string;
  id: string;
  turns: number;
  cookies: string;
  auth: string;
};
let deepseekWebSessionSlot: DeepSeekSessionSlot | undefined;
const deepseekWebState: any = {
  chatSessionId: null,
  cookies: "",
  mtime: null,
  auth: "",
  authMtime: null,
  headers: {},
  headersMtime: null,
};

function deepseekWebLoadCookies(): string {
  let st: Deno.FileInfo | null = null;
  try {
    st = Deno.statSync(DEEPSEEK_WEB_COOKIE_FILE);
  } catch (e) {
    console.log("[deepseek-web] stat error:", e);
    return "";
  }
  if (!st?.isFile) {
    console.log("[deepseek-web] not a file");
    return "";
  }
  const mtime = st.mtime?.getTime() ?? 0;
  if (deepseekWebState.mtime === mtime) return deepseekWebState.cookies;
  let raw = "";
  try {
    raw = Deno.readTextFileSync(DEEPSEEK_WEB_COOKIE_FILE).trim();
  } catch {}
  if (!raw) return "";
  // 支持 Netscape cookies.txt 格式
  if (raw.includes("\t")) {
    raw = raw.split(String.fromCharCode(10)).filter((l) =>
      l && l.includes("\t")
    ).map((l) => {
      const c = l.split("\t");
      return c.length >= 7 ? c[5] + "=" + c[6] : "";
    }).filter(Boolean).join("; ");
  }
  deepseekWebState.mtime = mtime;
  deepseekWebState.cookies = raw.replace(/\r/g, "");
  console.log("[deepseek-web] loaded cookies from deepseek-cookies.txt");
  return deepseekWebState.cookies;
}

function deepseekWebLoadAuth(): string {
  try {
    const st = Deno.statSync(DEEPSEEK_WEB_AUTH_FILE);
    if (!st.isFile) return "";
    const mtime = st.mtime?.getTime() ?? 0;
    if (deepseekWebState.authMtime !== mtime) {
      const auth = Deno.readTextFileSync(DEEPSEEK_WEB_AUTH_FILE).trim();
      if (auth && auth !== deepseekWebState.auth) {
        deepseekWebState.chatSessionId = null;
      }
      deepseekWebState.auth = auth;
      deepseekWebState.authMtime = mtime;
      console.log("[deepseek-web] loaded Bearer token from deepseek-auth.txt");
    }
  } catch {}
  return deepseekWebState.auth;
}

class DeepSeekWebError extends Error {
  status: number;
  retryAfterMs: number;
  kind: string;

  constructor(
    message: string,
    status = 502,
    retryAfterMs = 0,
    kind = "upstream_error",
  ) {
    super(message);
    this.name = "DeepSeekWebError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.kind = kind;
  }
}

function deepseekWebRetryAfterMs(value: string | null): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : 0;
}

function deepseekWebHttpError(
  response: Response,
  text: string,
): DeepSeekWebError {
  const retry = deepseekWebRetryAfterMs(response.headers.get("retry-after"));
  const status = response.status;
  const kind = status === 429
    ? "rate_limit_exceeded"
    : (status === 401 || status === 403)
    ? "auth"
    : "upstream_error";
  return new DeepSeekWebError(
    `DeepSeek HTTP ${status}: ${text.slice(0, 200)}`,
    status,
    retry,
    kind,
  );
}

export function deepseekWebBusinessError(event: any): DeepSeekWebError | null {
  const data = event?.data && typeof event.data === "object"
    ? event.data
    : event;
  const outerCode = Number(event?.code ?? 0);
  const innerCode = Number(data?.biz_code ?? event?.biz_code ?? 0);
  const bizCode = outerCode !== 0 ? outerCode : innerCode;
  const errorText = String(
    data?.biz_msg ?? data?.msg ?? event?.msg ?? event?.error?.message ?? "",
  ).trim();
  const contentText = String(
    event?.content ?? event?.toast?.content ?? event?.toast?.message ?? "",
  ).trim();
  const message = errorText || contentText;
  const hasErrorSignal = bizCode !== 0 || event?.type === "error" ||
    event?.type === "toast" || Boolean(event?.error || event?.toast) ||
    Boolean(errorText) || /invalid chat session/i.test(message);
  if (bizCode === 0 && !message && !hasErrorSignal) return null;
  if (bizCode === 0 && data?.code === 0 && !hasErrorSignal) return null;
  if (/invalid chat session/i.test(message)) {
    return new DeepSeekWebError(message, 502, 0, "invalid_session");
  }
  if (bizCode === 40001 || bizCode === 40003) {
    return new DeepSeekWebError(
      errorText || "DeepSeek authentication rejected",
      403,
      0,
      "auth",
    );
  }
  if (bizCode === 429) {
    return new DeepSeekWebError(
      errorText || "DeepSeek rate limited",
      429,
      30 * 60_000,
      "rate_limit_exceeded",
    );
  }
  if (
    bizCode === 5 ||
    /user is muted|account is muted|用户.*禁言|账号.*禁言/i.test(message)
  ) {
    const muteUntil = Number(
      data?.biz_data?.mute_until ?? data?.mute_until ?? 0,
    );
    const retryAfterMs =
      Number.isFinite(muteUntil) && muteUntil > Date.now() / 1000
        ? Math.max(60_000, Math.ceil((muteUntil * 1000) - Date.now()))
        : 2 * 60 * 60_000;
    return new DeepSeekWebError(
      message || "DeepSeek account is muted",
      429,
      retryAfterMs,
      "rate_limit_exceeded",
    );
  }
  const classificationText = event?.type === "error" || event?.type === "toast"
    ? message
    : errorText;
  if (/being generated|busy/i.test(classificationText)) {
    return new DeepSeekWebError(classificationText, 429, 5_000, "busy");
  }
  if (/too frequent|too many|throttl|频繁|quota/i.test(classificationText)) {
    return new DeepSeekWebError(
      classificationText,
      429,
      30_000,
      "rate_limit_exceeded",
    );
  }
  if (hasErrorSignal) {
    return new DeepSeekWebError(
      message || "DeepSeek stream error",
      502,
      0,
      "upstream_error",
    );
  }
  return null;
}

const DEEPSEEK_FALLBACK_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function deepseekWebRequestHeaders(
  cookies: string,
  auth: string,
  options: { pow?: string; referer?: string; accept?: string; json?: boolean } =
    {},
): Headers {
  const headers = new Headers();
  const captured = deepseekWebLoadHeaders();
  for (const [name, value] of Object.entries(captured)) {
    headers.set(name, value);
  }
  if (!headers.has("user-agent")) {
    headers.set("user-agent", DEEPSEEK_FALLBACK_UA);
  }
  if (!headers.has("accept-language")) {
    headers.set("accept-language", "zh-CN,zh;q=0.9,en;q=0.8");
  }
  if (!headers.has("x-client-platform")) {
    headers.set("x-client-platform", "web");
  }
  if (options.accept) headers.set("accept", options.accept);
  if (options.json) headers.set("content-type", "application/json");
  if (options.pow) headers.set("x-ds-pow-response", options.pow);
  headers.set("cookie", cookies);
  headers.set("authorization", `Bearer ${auth}`);
  headers.set("origin", DEEPSEEK_WEB_API);
  headers.set("referer", options.referer || DEEPSEEK_WEB_HOME);
  return headers;
}

function deepseekWebLoadHeaders(): Record<string, string> {
  try {
    const st = Deno.statSync(DEEPSEEK_WEB_HEADERS_FILE);
    if (!st.isFile) return deepseekWebState.headers || {};
    const mtime = st.mtime?.getTime() ?? 0;
    if (deepseekWebState.headersMtime !== mtime) {
      const parsed = safeJsonParse(
        Deno.readTextFileSync(DEEPSEEK_WEB_HEADERS_FILE),
      );
      const allowed = [
        "x-hif-dliq",
        "x-hif-leim",
        "x-client-platform",
        "x-client-version",
        "x-app-version",
        "accept-language",
        "user-agent",
      ];
      const source = parsed.error ? {} : (parsed.data || {});
      deepseekWebState.headers = Object.fromEntries(
        allowed.filter((key) => typeof source[key] === "string").map((
          key,
        ) => [key, source[key]]),
      );
      deepseekWebState.headersMtime = mtime;
    }
  } catch {}
  return deepseekWebState.headers || {};
}

let deepseekWasmExports: any = null;

async function deepseekSolvePow(
  challenge: DeepSeekPowChallenge,
): Promise<number> {
  if (!deepseekWasmExports) {
    const bytes = await Deno.readFile("./deepseek-sha3.wasm");
    const module = await WebAssembly.instantiate(bytes, {});
    deepseekWasmExports = module.instance.exports;
  }
  const wasm = deepseekWasmExports;
  const encoder = new TextEncoder();
  const alloc = (value: string) => {
    const bytes = encoder.encode(value);
    const ptr = wasm.__wbindgen_export_0(bytes.length, 1);
    new Uint8Array(wasm.memory.buffer).set(bytes, ptr);
    return { ptr, len: bytes.length };
  };
  const stack = wasm.__wbindgen_add_to_stack_pointer(-16);
  try {
    const target = alloc(challenge.challenge);
    const prefix = alloc(
      `${challenge.salt}_${challenge.expireAt ?? challenge.expire_at}_`,
    );
    wasm.wasm_solve(
      stack,
      target.ptr,
      target.len,
      prefix.ptr,
      prefix.len,
      challenge.difficulty,
    );
    const view = new DataView(wasm.memory.buffer);
    if (view.getInt32(stack, true) === 0) return -1;
    return view.getFloat64(stack + 8, true);
  } finally {
    wasm.__wbindgen_add_to_stack_pointer(16);
  }
}

type DeepSeekPowChallenge = {
  algorithm: string;
  challenge: string;
  salt: string;
  difficulty: number;
  signature: string;
  expire_at?: number;
  expireAt?: number;
};

async function deepseekWebCreatePow(
  cookies: string,
  auth: string,
  targetPath: string,
): Promise<string> {
  const r = await fetch(
    DEEPSEEK_WEB_API + "/api/v0/chat/create_pow_challenge",
    {
      method: "POST",
      headers: deepseekWebRequestHeaders(cookies, auth, {
        json: true,
        referer: DEEPSEEK_WEB_HOME,
      }),
      body: JSON.stringify({ target_path: targetPath }),
    },
  );
  const text = await r.text();
  if (!r.ok) throw deepseekWebHttpError(r, text);
  const json = safeJsonParse(text);
  if (json.error) {
    throw new DeepSeekWebError(
      "create PoW challenge failed: " + text.slice(0, 300),
      502,
      0,
      "upstream_error",
    );
  }
  const businessError = deepseekWebBusinessError(json);
  if (businessError) throw businessError;
  if (!json.data) {
    throw new DeepSeekWebError(
      "create PoW challenge failed: " + text.slice(0, 300),
      502,
      0,
      "upstream_error",
    );
  }
  const challenge = json.data.data?.biz_data?.challenge as
    | DeepSeekPowChallenge
    | undefined;
  if (!challenge || challenge.algorithm !== "DeepSeekHashV1") {
    throw new Error(
      "unsupported DeepSeek PoW challenge: " + text.slice(0, 300),
    );
  }
  if (
    !Number.isSafeInteger(challenge.difficulty) || challenge.difficulty <= 0 ||
    challenge.difficulty > 5_000_000
  ) {
    throw new Error("invalid DeepSeek PoW difficulty");
  }
  const answer = await deepseekSolvePow(challenge);
  if (answer < 0) throw new Error("DeepSeek PoW solution not found");
  const payload = JSON.stringify({
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: targetPath,
  });
  return btoa(payload);
}

async function deepseekWebDeleteSession(
  cookies: string,
  auth: string,
  chatSessionId: string,
): Promise<void> {
  try {
    await fetch(DEEPSEEK_WEB_API + "/api/v0/chat_session/delete", {
      method: "POST",
      headers: deepseekWebRequestHeaders(cookies, auth, {
        json: true,
        referer: DEEPSEEK_WEB_HOME,
      }),
      body: JSON.stringify({ chat_session_id: chatSessionId }),
    });
  } catch {
    // 清理失败不应覆盖已经生成的模型回复。
  }
}

function deepseekWebAccountKey(cookies: string, auth: string): string {
  const raw = `${auth}|${cookies}`;
  let hash = 2166136261;
  for (let index = 0; index < raw.length; index++) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function deepseekWebRetireSession(sessionId?: string): void {
  if (!sessionId || deepseekWebSessionSlot?.id === sessionId) {
    deepseekWebSessionSlot = undefined;
  }
}

async function deepseekWebLeaseSession(
  cookies: string,
  auth: string,
): Promise<{ id: string; reused: boolean }> {
  const key = deepseekWebAccountKey(cookies, auth);
  if (
    DEEPSEEK_SESSION_REUSE_TURNS > 0 && deepseekWebSessionSlot?.key === key &&
    deepseekWebSessionSlot.turns < DEEPSEEK_SESSION_REUSE_TURNS
  ) {
    deepseekWebSessionSlot.turns += 1;
    return { id: deepseekWebSessionSlot.id, reused: true };
  }
  const previous = deepseekWebSessionSlot;
  const id = await deepseekWebCreateSession(cookies, auth);
  if (DEEPSEEK_SESSION_REUSE_TURNS > 0) {
    deepseekWebSessionSlot = { key, id, turns: 1, cookies, auth };
    if (previous) {
      const delay = 60_000 + Math.floor(Math.random() * 60_000);
      setTimeout(() => {
        void deepseekWebDeleteSession(
          previous.cookies,
          previous.auth,
          previous.id,
        );
      }, delay);
    }
  } else {
    deepseekWebSessionSlot = undefined;
  }
  return { id, reused: false };
}

type DeepSeekWebImage = { data: Uint8Array; mediaType: string; name: string };

function deepseekWebCollectImages(messages: any[]): DeepSeekWebImage[] {
  const images: DeepSeekWebImage[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const part of content) {
      if (part?.type !== "image_url") continue;
      const url = typeof part.image_url === "string"
        ? part.image_url
        : part.image_url?.url;
      if (typeof url !== "string" || !url.startsWith("data:image/")) continue;
      const match = url.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (!match || seen.has(url)) continue;
      seen.add(url);
      try {
        const binary = atob(match[2]);
        const data = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
        images.push({
          data,
          mediaType: match[1],
          name: `image-${images.length + 1}.${match[1].split("/")[1] || "png"}`,
        });
      } catch {
        // 非法 base64 由上层返回明确错误。
      }
    }
  }
  if (images.length > DEEPSEEK_MAX_REF_IMAGES) {
    throw new Error(
      `DeepSeek accepts at most ${DEEPSEEK_MAX_REF_IMAGES} images per request`,
    );
  }
  return images;
}

async function deepseekWebUploadImage(
  cookies: string,
  auth: string,
  image: DeepSeekWebImage,
): Promise<string> {
  const targetPath = "/api/v0/file/upload_file";
  const powHeader = await deepseekWebCreatePow(cookies, auth, targetPath);
  const form = new FormData();
  form.append(
    "file",
    new Blob([image.data as unknown as BlobPart], { type: image.mediaType }),
    image.name,
  );
  const r = await fetch(DEEPSEEK_WEB_API + targetPath, {
    method: "POST",
    headers: deepseekWebRequestHeaders(cookies, auth, {
      pow: powHeader,
      referer: DEEPSEEK_WEB_HOME,
      accept: "application/json, text/plain, */*",
    }),
    body: form,
  });
  const text = await r.text();
  if (!r.ok) throw deepseekWebHttpError(r, text);
  const json = safeJsonParse(text);
  if (json.error) {
    throw new Error(
      `image upload returned invalid JSON: ${json.error.message}`,
    );
  }
  const businessError = deepseekWebBusinessError(json);
  if (businessError) throw businessError;
  const id = json.data?.data?.biz_data?.id ?? json.data?.data?.id ??
    json.data?.biz_data?.id ?? json.data?.id;
  if (typeof id !== "string" || !id) {
    throw new Error(
      `image upload did not return file id: ${text.slice(0, 300)}`,
    );
  }
  return id;
}

function deepseekWebTools(tools: any): ToolSchemaLike[] {
  if (!Array.isArray(tools)) return [];
  return tools.map((tool: any) => {
    const fn = tool?.function || tool;
    return {
      name: String(fn?.name || ""),
      description: String(fn?.description || ""),
      parameters: fn?.parameters || fn?.input_schema || {},
    };
  }).filter((tool: ToolSchemaLike) => tool.name);
}

function deepseekWebProtocolMessages(messages: any[]): any[] {
  return messages.map((message: any) => {
    let content = message?.content;
    if (typeof content === "string") {
      content = [{ type: "text", text: content }];
    }
    if (!Array.isArray(content)) {
      content = [{
        type: "text",
        text: content == null ? "" : String(content),
      }];
    }
    content = content.map((part: any) => {
      if (part?.type !== "image_url") return part;
      const url = typeof part.image_url === "string"
        ? part.image_url
        : part.image_url?.url;
      return {
        type: "image",
        attachment: { attachmentId: String(url || "image").slice(0, 256) },
      };
    });
    if (Array.isArray(message?.tool_calls)) {
      content = content.concat(message.tool_calls.map((call: any) => ({
        type: "tool-call",
        name: call?.function?.name || call?.name || "",
        arguments: call?.function?.arguments || call?.arguments || "{}",
      })));
    }
    if (message?.role === "tool") {
      content = [{
        type: "tool-result",
        toolCallId: message.tool_call_id,
        content,
      }];
    }
    return {
      role: message?.role === "tool" ? "user" : (message?.role || "user"),
      content,
    };
  });
}

function deepseekWebBuildPrompt(
  messages: any[],
  tools: any,
  reasoningEffort = "high",
): string {
  const toolSchemas = deepseekWebTools(tools);
  const prompt = serializePrompt({
    system:
      `Reasoning effort: ${reasoningEffort}. Use the requested effort level, but never expose private reasoning in the answer.`,
    messages: deepseekWebProtocolMessages(messages),
    tools: toolSchemas,
    maxChars: DEEPSEEK_MAX_PROMPT_CHARS,
  });
  if (prompt.length > DEEPSEEK_MAX_PROMPT_CHARS) {
    throw new Error(
      `DeepSeek prompt exceeds ${DEEPSEEK_MAX_PROMPT_CHARS} characters`,
    );
  }
  return prompt;
}

async function deepseekWebCreateSession(
  cookies: string,
  auth: string,
): Promise<string> {
  const r = await fetch(DEEPSEEK_WEB_API + "/api/v0/chat_session/create", {
    method: "POST",
    headers: deepseekWebRequestHeaders(cookies, auth, {
      json: true,
      referer: DEEPSEEK_WEB_HOME,
    }),
    body: "{}",
  });
  const text = await r.text();
  if (!r.ok) throw deepseekWebHttpError(r, text);
  const json = JSON.parse(text);
  const businessError = deepseekWebBusinessError(json);
  if (businessError) throw businessError;
  const sessionId = json.data?.biz_data?.id ??
    json.data?.biz_data?.chat_session?.id;
  if (json.code !== 0 || typeof sessionId !== "string" || !sessionId) {
    throw new DeepSeekWebError(
      "create session bad response: " + text.slice(0, 300),
      502,
      0,
      "upstream_error",
    );
  }
  return sessionId;
}

function deepseekWebExtractToolCalls(
  content: string,
  tools: any,
): { content: string; toolCalls: ToolCallRequest[] } {
  const knownTools = new Set(deepseekWebTools(tools).map((tool) => tool.name));
  const filter = new ToolCallStreamFilter(
    knownTools.size ? knownTools : undefined,
  );
  const first = filter.push(content);
  const last = filter.flush();
  return {
    content: first.text + last.text,
    toolCalls: [...first.calls, ...last.calls],
  };
}

function deepseekWebParseChatResponse(
  text: string,
  tools: any,
): { content: string; toolCalls: ToolCallRequest[] } {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    const json = safeJsonParse(trimmed);
    if (json.error) {
      throw new Error("invalid DeepSeek chat response: " + json.error.message);
    }
    if (json.data?.code && json.data.code !== 0) {
      throw new Error("DeepSeek chat error: " + trimmed.slice(0, 300));
    }
    return deepseekWebExtractToolCalls(
      String(json.data?.data?.biz_data?.content || ""),
      tools,
    );
  }
  let content = "";
  let lastResponseFragmentId: string | null = null;
  const responseFragmentIds = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === "[DONE]") continue;
    const parsed = safeJsonParse(raw);
    if (parsed.error || !parsed.data) continue;
    const event = parsed.data;
    if (
      event.p === "response/fragments" && event.o === "APPEND" &&
      Array.isArray(event.v)
    ) {
      for (const fragment of event.v) {
        if (fragment?.type !== "RESPONSE") continue;
        if (fragment.id != null) {
          const id = String(fragment.id);
          responseFragmentIds.add(id);
          lastResponseFragmentId = id;
        }
        if (typeof fragment.content === "string") content += fragment.content;
      }
      continue;
    }
    if (
      event.p === "response/fragments/-1/content" &&
      typeof event.v === "string" && lastResponseFragmentId !== null
    ) {
      content += event.v;
      continue;
    }
    if (typeof event.p === "string") {
      const match = event.p.match(/^response\/fragments\/([^/]+)\/content$/);
      if (
        match && responseFragmentIds.has(match[1]) &&
        typeof event.v === "string"
      ) content += event.v;
      continue;
    }
    // 新版网页端会用无 path 的 data: {"v":"..."} 续写最后一个 RESPONSE fragment。
    // 在 RESPONSE fragment 已建立后才接收，避免把 THINK 的前导续段误算进正文。
    if (
      !event.p && lastResponseFragmentId !== null && typeof event.v === "string"
    ) content += event.v;
  }
  return deepseekWebExtractToolCalls(content, tools);
}

function estimateDeepSeekTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x3000 && code <= 0x9fff) cjk++;
  }
  return Math.max(1, Math.ceil(cjk / 1.5 + (text.length - cjk) / 4));
}

type DeepSeekStreamEvent = { type: "thinking" | "text"; content: string };

async function* deepseekWebReadEvents(
  response: Response,
): AsyncGenerator<DeepSeekStreamEvent> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";
  let sink: "thinking" | "text" | null = null;
  let thinkingText = "";
  let responseText = "";
  const responseIds = new Set<string>();

  const append = (
    type: "thinking" | "text",
    value: string,
  ): DeepSeekStreamEvent[] => {
    if (!value) return [];
    if (type === "thinking") thinkingText += value;
    else responseText += value;
    sink = type;
    return [{ type, content: value }];
  };
  const snapshotDelta = (current: string, snapshot: string): string => {
    if (!snapshot) return "";
    if (!current) return snapshot;
    return snapshot.startsWith(current) ? snapshot.slice(current.length) : "";
  };
  const handleLine = (line: string): DeepSeekStreamEvent[] => {
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
      return [];
    }
    if (!line.startsWith("data:")) return [];
    const raw = line.slice(5).trim();
    if (!raw || raw === "[DONE]") return [];
    const parsed = safeJsonParse(raw);
    if (parsed.error || !parsed.data) return [];
    const event = parsed.data && typeof parsed.data === "object" && eventName &&
        !parsed.data.type
      ? { ...parsed.data, type: eventName }
      : parsed.data;
    eventName = "";
    const businessError = deepseekWebBusinessError(event);
    if (businessError) throw businessError;
    const out: DeepSeekStreamEvent[] = [];

    const snapshot = event?.v?.response;
    if (snapshot && Array.isArray(snapshot.fragments)) {
      for (const fragment of snapshot.fragments) {
        if (fragment?.type === "THINK" || fragment?.type === "REASONING") {
          sink = "thinking";
          const delta = snapshotDelta(
            thinkingText,
            String(fragment.content || ""),
          );
          out.push(...append("thinking", delta));
        } else if (fragment?.type === "RESPONSE") {
          sink = "text";
          if (fragment.id != null) responseIds.add(String(fragment.id));
          const delta = snapshotDelta(
            responseText,
            String(fragment.content || ""),
          );
          out.push(...append("text", delta));
        }
      }
    }

    if (event?.p === "response/fragments" && event?.o === "APPEND") {
      const fragments = Array.isArray(event.v) ? event.v : [event.v];
      for (const fragment of fragments) {
        if (fragment?.type === "THINK" || fragment?.type === "REASONING") {
          out.push(...append("thinking", String(fragment.content || "")));
        } else if (fragment?.type === "RESPONSE") {
          if (fragment.id != null) responseIds.add(String(fragment.id));
          out.push(...append("text", String(fragment.content || "")));
        }
      }
    } else if (
      event?.p === "response/fragments/-1/content" &&
      typeof event.v === "string"
    ) {
      out.push(...append(sink || "text", event.v));
    } else if (
      event?.p === "response/thinking_content" && typeof event.v === "string"
    ) {
      out.push(...append("thinking", event.v));
    } else if (event?.p === "response/content" && typeof event.v === "string") {
      out.push(...append("text", event.v));
    } else if (typeof event?.p === "string" && typeof event.v === "string") {
      const match = event.p.match(/^response\/fragments\/([^/]+)\/content$/);
      if (match && responseIds.has(match[1])) {
        out.push(...append("text", event.v));
      }
    } else if (!event?.p && typeof event?.v === "string" && sink) {
      out.push(...append(sink, event.v));
    }
    return out;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        for (const item of handleLine(line)) yield item;
      }
    }
    buffer += decoder.decode();
    for (const item of handleLine(buffer.replace(/\r$/, ""))) yield item;
  } finally {
    try {
      reader.releaseLock();
    } catch { /* ignore */ }
  }
}

async function deepseekWebProcess(
  response: Response,
  tools: any,
  callbacks: {
    onThinking?: (content: string) => void;
    onText?: (output: any) => void;
  } = {},
): Promise<
  {
    content: string;
    thinkingContent: string;
    toolCalls: ToolCallRequest[];
    sawThinking: boolean;
    sawText: boolean;
  }
> {
  const knownTools = new Set(deepseekWebTools(tools).map((tool) => tool.name));
  const filter = new ToolCallStreamFilter(
    knownTools.size ? knownTools : undefined,
  );
  const echoGuard = new TranscriptEchoGuard();
  let content = "";
  let thinkingContent = "";
  const toolCalls: ToolCallRequest[] = [];
  let sawThinking = false;
  let sawText = false;
  for await (const event of deepseekWebReadEvents(response)) {
    if (event.type === "thinking") {
      sawThinking = true;
      thinkingContent += event.content;
      callbacks.onThinking?.(event.content);
      continue;
    }
    const output = filter.push(event.content);
    const guarded = echoGuard.push(output.text);
    const safeText = guarded.text;
    if (safeText) sawText = true;
    content += safeText;
    toolCalls.push(...output.calls);
    callbacks.onText?.({ ...output, text: safeText });
  }
  const tail = filter.flush();
  const guardedTail = echoGuard.push(tail.text);
  const tailText = guardedTail.text + echoGuard.flush().text;
  if (tailText) sawText = true;
  content += tailText;
  toolCalls.push(...tail.calls);
  callbacks.onText?.({ ...tail, text: tailText });
  return { content, thinkingContent, toolCalls, sawThinking, sawText };
}

function deepseekWebOpenAIStream(
  response: Response,
  model: string,
  tools: any,
  prompt: string,
  cleanup: (force?: boolean) => Promise<void>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const id = "chatcmpl-" + Math.random().toString(36).slice(2);
      const created = Math.floor(Date.now() / 1000);
      let sentRole = false;
      const send = (
        delta: any,
        finish: string | null = null,
        extra: any = {},
      ) => {
        const payload = {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...extra,
        };
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
        );
      };
      let completed = false;
      try {
        const result = await deepseekWebProcess(response, tools, {
          onThinking: (content) => {
            if (!sentRole) {
              send({ role: "assistant", content: "" });
              sentRole = true;
            }
            send({ reasoning_content: content });
          },
          onText: (output) => {
            if (output.text) {
              if (!sentRole) {
                send({ role: "assistant", content: "" });
                sentRole = true;
              }
              send({ content: output.text });
            }
            for (const call of output.calls) {
              if (!sentRole) {
                send({ role: "assistant", content: "" });
                sentRole = true;
              }
              send({
                tool_calls: [{
                  index: 0,
                  id: call.id,
                  type: "function",
                  function: { name: call.name, arguments: call.arguments },
                }],
              });
            }
          },
        });
        noteDeepSeekSuccess();
        const finish = result.toolCalls.length
          ? "tool_calls"
          : result.sawText
          ? "stop"
          : "length";
        const completionTokens = estimateDeepSeekTokens(
          result.content + result.thinkingContent,
        );
        const usage = {
          prompt_tokens: estimateDeepSeekTokens(prompt),
          completion_tokens: completionTokens,
          total_tokens: estimateDeepSeekTokens(prompt) + completionTokens,
        };
        send({}, finish, { usage });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        completed = true;
      } catch (error: any) {
        if (error instanceof DeepSeekWebError) {
          deepseekWebTripCircuit(error.message, error.retryAfterMs, error.kind);
        }
        try {
          send({
            error: {
              message: String(error?.message || error),
              type: error?.kind || "upstream_error",
            },
          }, "error");
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch {
          // 客户端可能已经取消；清理必须继续执行。
        }
      } finally {
        try {
          await cleanup(!completed);
        } finally {
          try {
            controller.close();
          } catch { /* 客户端已取消 */ }
        }
      }
    },
  });
}

async function deepseekWebChat(
  cookies: string,
  auth: string,
  chatSessionId: string,
  prompt: string,
  model: string,
  thinkingEnabled: boolean,
  refFileIds: string[],
): Promise<Response> {
  const body = JSON.stringify({
    chat_session_id: chatSessionId,
    parent_message_id: null,
    prompt,
    ref_file_ids: refFileIds,
    thinking_enabled: thinkingEnabled,
    search_enabled: false,
    model_type: "default",
    action: null,
    preempt: false,
  });
  const powHeader = await deepseekWebCreatePow(
    cookies,
    auth,
    "/api/v0/chat/completion",
  );
  const r = await fetch(DEEPSEEK_WEB_API + "/api/v0/chat/completion", {
    method: "POST",
    headers: deepseekWebRequestHeaders(cookies, auth, {
      pow: powHeader,
      referer: `${DEEPSEEK_WEB_API}/a/chat/s/${chatSessionId}`,
      accept: "text/event-stream",
      json: true,
    }),
    body,
  });
  if (!r.ok) {
    const text = await r.text();
    throw deepseekWebHttpError(r, text);
  }
  const inspected = await inspectResponseBody(r);
  if (inspected.timedOut) {
    throw new DeepSeekWebError(
      "DeepSeek returned headers but no response body before the sniff deadline",
      504,
      0,
      "timeout",
    );
  }
  if (inspected.shape === "sse") {
    return replayResponse(r, inspected, "text/event-stream");
  }
  const text = await readInspectedText(inspected);
  const parsed = safeJsonParse(text);
  if (parsed.error) {
    throw new DeepSeekWebError(
      `DeepSeek non-SSE response: ${text.slice(0, 300)}`,
      502,
      0,
      "upstream_error",
    );
  }
  const envelope = parsed.data?.data ? parsed.data : parsed;
  const businessError = deepseekWebBusinessError(envelope);
  if (businessError) throw businessError;
  const content = String(
    envelope?.data?.biz_data?.content ?? envelope?.biz_data?.content ?? "",
  );
  if (!content) {
    throw new DeepSeekWebError(
      `DeepSeek non-SSE response did not contain content: ${
        text.slice(0, 300)
      }`,
      502,
      0,
      "upstream_error",
    );
  }
  const sse = [
    `data: ${
      JSON.stringify({
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      })
    }\n\n`,
    `data: ${
      JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      })
    }\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  return new Response(sse, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function deepseekWebRiskHeaders(): Record<string, string> {
  const risk = deepseekWebCurrentRisk();
  return {
    "X-DeepSeek-Risk-Level": risk.riskLevel,
    "X-DeepSeek-Risk-Score": String(risk.riskScore),
  };
}

let deepseekWebBlockedUntil = 0;

function deepseekWebLoadCooldown(): number {
  if (deepseekWebBlockedUntil > Date.now()) return deepseekWebBlockedUntil;
  if (deepseekWebBlockedUntil > 0) deepseekWebBlockedUntil = 0;
  try {
    const parsed = safeJsonParse(
      Deno.readTextFileSync(DEEPSEEK_WEB_COOLDOWN_FILE),
    );
    const until = Number(parsed.data?.blockedUntil || 0);
    if (Number.isFinite(until) && until > Date.now()) {
      deepseekWebBlockedUntil = until;
    } else if (until) Deno.removeSync(DEEPSEEK_WEB_COOLDOWN_FILE);
  } catch {}
  return deepseekWebBlockedUntil > Date.now() ? deepseekWebBlockedUntil : 0;
}

function deepseekWebSaveCooldown(reason: string): void {
  try {
    Deno.writeTextFileSync(
      DEEPSEEK_WEB_COOLDOWN_FILE,
      JSON.stringify({
        blockedUntil: deepseekWebBlockedUntil,
        reason,
        updatedAt: new Date().toISOString(),
      }),
    );
  } catch {}
}

function deepseekWebTripCircuit(
  message: string,
  durationMs?: number,
  kind = "",
): void {
  const text = String(message || "");
  if (/being generated|busy/i.test(text) || kind === "busy") return;
  const isRateLimit = kind === "rate_limit_exceeded" ||
    /\b429\b|muted|mute|throttl|too frequent|too many|频繁|quota/i.test(text);
  const isAuthFailure = kind === "auth" || /\b401\b|\b403\b/i.test(text);
  if (!isRateLimit && !isAuthFailure && !(Number(durationMs) > 0)) return;
  const fallback = isAuthFailure ? 2 * 60 * 60_000 : 30 * 60_000;
  const requested = Number(durationMs);
  const duration = Math.max(
    Number.isFinite(requested) && requested > 0 ? requested : fallback,
    fallback,
  );
  deepseekWebBlockedUntil = Math.max(
    deepseekWebLoadCooldown(),
    Date.now() + duration,
  );
  deepseekWebSaveCooldown(text.slice(0, 160));
  noteDeepSeekRestriction(text.slice(0, 120), duration);
  console.warn(
    `[deepseek-web] upstream refused request; pausing this account for ${
      Math.round(duration / 60_000)
    } minutes`,
  );
}

function deepseekWebErrorResponse(error: any): Response {
  const status = Number(error?.status) || 502;
  const cooldownMs = Math.max(0, deepseekWebLoadCooldown() - Date.now());
  const rawRetryAfterMs = Number(error?.retryAfterMs) > 0
    ? Number(error.retryAfterMs)
    : 0;
  const retryAfterMs = status === 401 || status === 403 || status === 429
    ? Math.max(rawRetryAfterMs, cooldownMs)
    : rawRetryAfterMs;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };
  if (retryAfterMs > 0) {
    headers["Retry-After"] = String(Math.ceil(retryAfterMs / 1000));
  }
  return new Response(
    JSON.stringify({
      error: {
        message: String(error?.message || error),
        type: error?.kind || "upstream_error",
      },
    }),
    { status, headers },
  );
}

function deepseekWebCurrentRisk(): any {
  const risk: any = { ...getDeepSeekRiskSnapshot() };
  const remaining = Math.max(0, deepseekWebLoadCooldown() - Date.now());
  if (remaining > 0) {
    risk.cooldownRemainingMs = remaining;
    risk.riskLevel = "high";
    risk.riskScore = Math.max(Number(risk.riskScore || 0), 80);
    risk.factors = [...(risk.factors || []), "persistent cooldown active"];
  }
  return risk;
}

function deepseekWebReasoningEffort(body: any, model: string): string {
  const modelEffort =
    String(model).toLowerCase().match(/-(off|low|high|max)$/)?.[1] || "";
  const raw = String(
    body?.reasoning_effort ?? body?.reasoning?.effort ?? body?.thinking_level ??
      modelEffort,
  ).toLowerCase();
  if (["off", "none", "disabled"].includes(raw)) return "off";
  if (["low", "minimal"].includes(raw)) return "low";
  if (["high"].includes(raw)) return "high";
  if (["max"].includes(raw)) return "max";
  // 与上游适配器一致：网页端没有 medium 档位；旧客户端传 medium 时按 high 处理。
  if (["medium", "normal"].includes(raw)) return "high";
  return model.includes("reasoner") ? "high" : "off";
}

export async function handleDeepseekWeb(
  path: string,
  request: Request,
  url: URL,
): Promise<Response> {
  // Log the routes that are asked for, but not the model listing. The panel polls
  // the roster every ten seconds and this channel is listed, so one unconditional
  // line here produced one entry per poll and buried everything else - including
  // the entries that matter, like a cooldown being entered. The listing answers
  // identically every time, so it carries no news.
  if (!path.endsWith("/models")) {
    console.log("[deepseek-web] handle:", path, request.method);
  }
  if (path.endsWith("/responses") && request.method === "POST") {
    const chatUrl = new URL(request.url);
    chatUrl.pathname = "/deepseek-web/v1/chat/completions";
    return await handleDeepseekResponses(request, async (chatBody: any) => {
      const chatRequest = new Request(chatUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(chatBody),
      });
      return await handleDeepseekWeb(
        "/deepseek-web/v1/chat/completions",
        chatRequest,
        chatUrl,
      );
    });
  }
  if (path.endsWith("/risk.txt") && request.method === "GET") {
    const risk = deepseekWebCurrentRisk();
    const text = [
      `DeepSeek risk: ${risk.riskLevel} (${risk.riskScore}/100)`,
      `requests_last_5m=${risk.requestsLast5m}`,
      `consecutive_requests=${risk.consecutiveRequests}`,
      `cooldown_ms=${risk.cooldownRemainingMs}`,
      `factors=${risk.factors.join("; ")}`,
      risk.disclaimer,
    ].join("\n") + "\n";
    return new Response(text, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        ...deepseekWebRiskHeaders(),
      },
    });
  }
  if (path.endsWith("/risk") && request.method === "GET") {
    return new Response(JSON.stringify(deepseekWebCurrentRisk()), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        ...deepseekWebRiskHeaders(),
      },
    });
  }
  // 模型列表（静态返回，DeepSeek 网页版主要就两个模型）
  if (path.endsWith("/models") && request.method === "GET") {
    const efforts = [
      { id: "off", name: "Off", description: "关闭思考" },
      { id: "low", name: "Low", description: "开启思考（网页端等同 High）" },
      { id: "high", name: "High", description: "开启思考" },
      { id: "max", name: "Max", description: "开启思考（网页端等同 High）" },
    ];
    const model = (
      id: string,
      name: string,
      defaultEffort: string,
      maxOutputTokens: number,
    ) => ({
      id,
      object: "model",
      created: 0,
      owned_by: "deepseek",
      name,
      context_window: 1_048_576,
      max_output_tokens: maxOutputTokens,
      reasoning_efforts: efforts,
      default_reasoning_effort: defaultEffort,
    });
    const data = {
      object: "list",
      data: [
        model("deepseek-chat", "DeepSeek 网页 · 快速模式", "off", 16_384),
        model(
          "deepseek-chat-off",
          "DeepSeek 网页 · 快速模式 Off",
          "off",
          16_384,
        ),
        model("deepseek-chat-low", "DeepSeek 网页 · 思考 Low", "low", 16_384),
        model(
          "deepseek-chat-high",
          "DeepSeek 网页 · 思考 High",
          "high",
          16_384,
        ),
        model("deepseek-chat-max", "DeepSeek 网页 · 思考 Max", "max", 16_384),
        model("deepseek-reasoner", "DeepSeek 网页 · 深度思考", "high", 32_768),
        model(
          "deepseek-reasoner-off",
          "DeepSeek 网页 · 深度思考 Off",
          "off",
          32_768,
        ),
        model(
          "deepseek-reasoner-low",
          "DeepSeek 网页 · 深度思考 Low",
          "low",
          32_768,
        ),
        model(
          "deepseek-reasoner-high",
          "DeepSeek 网页 · 深度思考 High",
          "high",
          32_768,
        ),
        model(
          "deepseek-reasoner-max",
          "DeepSeek 网页 · 深度思考 Max",
          "max",
          32_768,
        ),
      ],
    };
    return new Response(JSON.stringify(data), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  if (path.endsWith("/chat/completions") && request.method === "POST") {
    let bodyText: string;
    try {
      bodyText = await request.text();
    } catch (e: any) {
      return new Response(
        JSON.stringify({ error: "Failed to read body", detail: e.message }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }
    const p = safeJsonParse(bodyText);
    if (p.error) {
      console.log("[deepseek-web] invalid json:", p.error.message);
      return new Response(
        JSON.stringify({ error: "Invalid JSON", detail: p.error.message }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }
    const openaiBody = p.data || {};
    const model = String(openaiBody.model || "deepseek-chat");
    const messages = Array.isArray(openaiBody.messages)
      ? openaiBody.messages
      : [];
    console.log("[deepseek-web] model:", model, "messages:", messages.length);

    // 网页端每轮只接收一段 prompt；保留 DSH 传入的完整上下文。
    const reasoningEffort = deepseekWebReasoningEffort(openaiBody, model);
    let prompt: string;
    try {
      prompt = deepseekWebBuildPrompt(
        messages,
        openaiBody.tools,
        reasoningEffort,
      );
    } catch (e: any) {
      return new Response(
        JSON.stringify({ error: "Invalid messages", detail: e.message }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }
    console.log(
      "[deepseek-web] prompt chars:",
      prompt.length,
      "reasoning:",
      reasoningEffort,
    );

    const cookies = deepseekWebLoadCookies();
    console.log(
      "[deepseek-web] cookies loaded:",
      cookies ? "yes (" + cookies.length + ")" : "no",
    );
    if (!cookies) {
      return new Response(
        JSON.stringify({
          error: "deepseek-cookies.txt missing",
          detail:
            "Run .tmp-extract-deepseek-cookies.ts to capture the DeepSeek login state",
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
    const auth = deepseekWebLoadAuth();
    if (!auth) {
      return new Response(
        JSON.stringify({
          error: "deepseek-auth.txt missing",
          detail:
            "Run .tmp-extract-deepseek-cookies.ts again to capture the DeepSeek Bearer token",
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
    const cooldownMs = deepseekWebLoadCooldown() - Date.now();
    if (cooldownMs > 0) {
      return new Response(
        JSON.stringify({
          error: {
            message: "DeepSeek cooling down",
            type: "rate_limit_exceeded",
          },
          retry_after_ms: cooldownMs,
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Retry-After": String(Math.ceil(cooldownMs / 1000)),
          },
        },
      );
    }

    let releaseGate: (() => void) | null = null;
    try {
      releaseGate = await acquireDeepseekGate();
    } catch (e: any) {
      return new Response(
        JSON.stringify({
          error: "DeepSeek gate unavailable",
          detail: e.message,
        }),
        {
          status: 503,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }
    const postGateCooldownMs = deepseekWebLoadCooldown() - Date.now();
    if (postGateCooldownMs > 0) {
      releaseGate?.();
      return new Response(
        JSON.stringify({
          error: {
            message: "DeepSeek cooling down",
            type: "rate_limit_exceeded",
          },
          retry_after_ms: postGateCooldownMs,
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Retry-After": String(Math.ceil(postGateCooldownMs / 1000)),
          },
        },
      );
    }

    noteDeepSeekRequest(prompt.length);

    let images: DeepSeekWebImage[];
    try {
      images = deepseekWebCollectImages(messages);
    } catch (e: any) {
      releaseGate?.();
      return new Response(
        JSON.stringify({ error: "Invalid image input", detail: e.message }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }
    const refFileIds: string[] = [];
    try {
      for (const image of images) {
        refFileIds.push(await deepseekWebUploadImage(cookies, auth, image));
      }
    } catch (e: any) {
      if (e instanceof DeepSeekWebError) {
        deepseekWebTripCircuit(e.message, e.retryAfterMs, e.kind);
      }
      releaseGate?.();
      return deepseekWebErrorResponse(e);
    }

    let sessionLease: { id: string; reused: boolean };
    try {
      sessionLease = await deepseekWebLeaseSession(cookies, auth);
    } catch (e: any) {
      if (e instanceof DeepSeekWebError) {
        deepseekWebTripCircuit(e.message, e.retryAfterMs, e.kind);
      }
      releaseGate?.();
      return deepseekWebErrorResponse(e);
    }
    let chatSessionId = sessionLease.id;

    let cleanedUp = false;
    const cleanup = async (force = false) => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (force) deepseekWebRetireSession(chatSessionId);
      if (force || !sessionLease.reused || DEEPSEEK_SESSION_REUSE_TURNS === 0) {
        await deepseekWebDeleteSession(cookies, auth, chatSessionId);
      }
      releaseGate?.();
    };
    let upstream: Response;
    try {
      upstream = await deepseekWebChat(
        cookies,
        auth,
        chatSessionId,
        prompt,
        model,
        reasoningEffort !== "off",
        refFileIds,
      );
    } catch (e: any) {
      if (e instanceof DeepSeekWebError && e.kind === "invalid_session") {
        deepseekWebRetireSession(chatSessionId);
        await deepseekWebDeleteSession(cookies, auth, chatSessionId);
        try {
          sessionLease = await deepseekWebLeaseSession(cookies, auth);
          chatSessionId = sessionLease.id;
          upstream = await deepseekWebChat(
            cookies,
            auth,
            chatSessionId,
            prompt,
            model,
            reasoningEffort !== "off",
            refFileIds,
          );
        } catch (retryError: any) {
          if (retryError instanceof DeepSeekWebError) {
            deepseekWebTripCircuit(
              retryError.message,
              retryError.retryAfterMs,
              retryError.kind,
            );
          }
          await cleanup(true);
          return deepseekWebErrorResponse(retryError);
        }
      } else {
        if (e instanceof DeepSeekWebError) {
          deepseekWebTripCircuit(e.message, e.retryAfterMs, e.kind);
        }
        await cleanup(true);
        return deepseekWebErrorResponse(e);
      }
    }

    if (openaiBody.stream === true) {
      return new Response(
        deepseekWebOpenAIStream(
          upstream,
          model,
          openaiBody.tools,
          prompt,
          cleanup,
        ),
        {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
            "X-Accel-Buffering": "no",
            ...deepseekWebRiskHeaders(),
          },
        },
      );
    }

    let result: Awaited<ReturnType<typeof deepseekWebProcess>>;
    try {
      result = await deepseekWebProcess(upstream, openaiBody.tools);
    } catch (e: any) {
      if (e instanceof DeepSeekWebError) {
        deepseekWebTripCircuit(e.message, e.retryAfterMs, e.kind);
      }
      await cleanup(true);
      return deepseekWebErrorResponse(e);
    } finally {
      await cleanup();
    }

    noteDeepSeekSuccess();
    const content = result.content;
    const toolCalls = result.toolCalls;
    const finishReason = toolCalls.length
      ? "tool_calls"
      : content
      ? "stop"
      : "length";
    const responseId = "chatcmpl-" + Math.random().toString(36).slice(2);
    const created = Math.floor(Date.now() / 1000);
    const message: any = { role: "assistant", content };
    if (result.thinkingContent) {
      message.reasoning_content = result.thinkingContent;
    }
    if (toolCalls.length) {
      message.tool_calls = toolCalls.map((call: ToolCallRequest) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      }));
      message.content = null;
    }
    const responseBody = {
      id: responseId,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: {
        prompt_tokens: estimateDeepSeekTokens(prompt),
        completion_tokens: estimateDeepSeekTokens(
          content + result.thinkingContent,
        ),
        total_tokens: estimateDeepSeekTokens(prompt) +
          estimateDeepSeekTokens(content + result.thinkingContent),
      },
    };

    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        ...deepseekWebRiskHeaders(),
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
}
