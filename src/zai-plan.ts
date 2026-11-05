/**
 * zai-plan — Z.ai Start Plan 渠道（ZCode 桌面端的每日免费 GLM-5.3-Flash）。
 *
 * 线路（2026-11-04 实测打通，见 AGENTS.md「Z.ai Start Plan 渠道」）：
 *   POST https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages
 *   Authorization: Bearer <zcodejwttoken>        ← 凭据文件解密，无 exp，长期有效
 *   经 HTTP 代理出去（默认 Clash 127.0.0.1:7897）—— WAF（阿里云 ESA）按出口 IP
 *   区别对待：家宽直连 Bearer 一律 405「unusual activity」，代理出口放行。
 *   TLS 指纹无关（curl/Schannel 走代理同样 200），所以手写 CONNECT 隧道即可，
 *   不需要任何 sidecar。
 *
 * 协议：上游是 Anthropic Messages；对客户端暴露 OpenAI chat/completions，
 * 与其它渠道一致由本模块做双向转换（含工具调用）。
 *
 * 判据（AGENTS.md 同款纪律）：
 *   - 凭据文件按 mtime 热加载 —— ZCode 桌面刷新 token 后我们自动跟随；
 *   - 上游永远 stream:true（网关流式优先），非流式请求在网关侧聚合；
 *   - 错误轮不许声称 finish_reason:"stop"（错误帧 finish 一律 null）。
 */

// ---------------------------------------------------------------------------
// 凭据
// ---------------------------------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();

function credentialSecret(): string {
  const override = Deno.env.get("ZCODE_CREDENTIAL_SECRET");
  if (override) return override;
  const home = Deno.env.get("USERPROFILE") ?? Deno.env.get("HOME") ??
    Deno.env.get("HOME") ?? "";
  const platform = Deno.build.os === "windows"
    ? "win32"
    : Deno.build.os === "darwin"
    ? "darwin"
    : "linux";
  const username = home.split(/[\\/]/).filter(Boolean).pop() ?? "unknown";
  return `zcode-credential-fallback:${platform}:${home}:${username}`;
}

export async function decryptZCodeValue(
  value: string,
  secret?: string,
): Promise<string> {
  const prefix = "enc:v1:";
  if (!value.startsWith(prefix)) return value;
  const parts = value.slice(prefix.length).split(".");
  if (parts.length !== 3) throw new Error("bad ciphertext format");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    enc.encode(secret ?? credentialSecret()),
  );
  const key = new Uint8Array(digest.slice(0));
  return cryptoDecrypt(key, parts[0], parts[1], parts[2]);
}

async function cryptoDecrypt(
  key: Uint8Array,
  ivB64: string,
  tagB64: string,
  ctB64: string,
): Promise<string> {
  const iv = base64UrlDecode(ivB64);
  const tag = base64UrlDecode(tagB64);
  const ct = base64UrlDecode(ctB64);
  if (iv.length !== 12) throw new Error("bad iv length");
  if (tag.length !== 16) throw new Error("bad auth tag length");
  const full = new Uint8Array(ct.length + tag.length);
  full.set(ct, 0);
  full.set(tag, ct.length);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as unknown as BufferSource,
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    cryptoKey,
    full,
  );
  return dec.decode(plain);
}

function base64UrlDecode(input: string): Uint8Array {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// 网络：本地 zcode-bridge（127.0.0.1:20131）
// ---------------------------------------------------------------------------

function bridgeUrl(): string {
  const raw = Deno.env.get("ZAI_PLAN_BRIDGE");
  const trimmed = (raw ?? "").replace(/\/+$/, "");
  return trimmed || "http://127.0.0.1:20131";
}

const MESSAGES_PATH = "/v1/messages";

export interface UpstreamResponse {
  status: number;
  contentType: string;
  body: ReadableStream<Uint8Array>;
}

/** 发往本地 bridge 的 Anthropic /v1/messages（认证/WAF/额度由 bridge 处理）。 */
export async function upstreamRequest(
  opts: {
    method: string;
    path: string;
    headers: Record<string, string>;
    body?: string;
  },
): Promise<UpstreamResponse> {
  const resp = await fetch(bridgeUrl() + opts.path, {
    method: opts.method,
    headers: opts.headers,
    body: opts.body,
    signal: AbortSignal.timeout(600_000),
  });
  return {
    status: resp.status,
    contentType: resp.headers.get("content-type") ?? "",
    body: resp.body ?? new ReadableStream<Uint8Array>({
      start(c) {
        c.close();
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// OpenAI → Anthropic 请求体
// ---------------------------------------------------------------------------

export interface OpenAiTool {
  type: "function";
  function: { name: string; description?: string; parameters?: unknown };
}

export interface OpenAiMessage {
  role: string;
  content: unknown;
  tool_calls?: Array<{
    id: string;
    type?: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/** OpenAI 的 data-URL 图片 part → Anthropic base64 图片块；非 data URL 忽略。 */
export function imageBlockOf(
  part: Record<string, unknown>,
): Record<string, unknown> | null {
  const image_url = part.image_url as { url?: string } | undefined;
  const url = image_url?.url ?? "";
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(
    url,
  );
  if (!m) return null;
  return {
    type: "image",
    source: { type: "base64", media_type: m[1], data: m[2] },
  };
}

/**
 * 把一条消息的 content 规整为块序列：文本 + 图片（data URL）按原顺序交错。
 * 字符串内容视为单个文本块。
 */
function contentBlocksOf(m: OpenAiMessage): {
  text: string;
  blocks: Array<Record<string, unknown>>;
} {
  if (typeof m.content === "string") {
    return {
      text: m.content,
      blocks: m.content ? [{ type: "text", text: m.content }] : [],
    };
  }
  const parts = Array.isArray(m.content) ? m.content : [];
  const blocks: Array<Record<string, unknown>> = [];
  let text = "";
  for (const part of parts) {
    if (typeof part === "string") {
      blocks.push({ type: "text", text: part });
      text += part;
      continue;
    }
    const p = part as Record<string, unknown>;
    if (p.type === "text" && typeof p.text === "string") {
      blocks.push({ type: "text", text: p.text });
      text += p.text;
      continue;
    }
    if (p.type === "image_url") {
      const img = imageBlockOf(p);
      if (img) blocks.push(img);
    }
    // 其余 part 类型（视频/PDF 等）v1 不携带，静默跳过
  }
  return { text, blocks };
}

/** OpenAI messages → Anthropic system + messages（含工具双向映射）。 */
export function toAnthropicBody(
  body: {
    model?: string;
    messages?: OpenAiMessage[];
    max_tokens?: number;
    temperature?: number;
    tools?: OpenAiTool[];
    reasoning_effort?: string;
  },
  deviceMid: string | null,
  sessionId: string,
): Record<string, unknown> {
  const messages = body.messages ?? [];
  const systemParts: string[] = [];
  const out: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (m.role === "system" || m.role === "developer") {
      const text = typeof m.content === "string"
        ? m.content
        : textOfContent(m.content);
      if (text) systemParts.push(text);
      continue;
    }
    // ★ 2026-11-05 修：Anthropic 要求 user/assistant 严格交替，而 DSH 的
    // 并行工具调用会发 N 条连续的 tool 消息 —— 逐条转换会产出连续的 user
    // 消息（roles must alternate 400）。连续 tool 结果必须合并进**一条**
    // user 消息（多个 tool_result 块），这是 Anthropic 的官方形状。
    if (m.role === "tool") {
      const toolText = typeof m.content === "string"
        ? m.content
        : textOfContent(m.content);
      const block: Record<string, unknown> = {
        type: "tool_result",
        tool_use_id: m.tool_call_id ?? "",
        content: [{ type: "text", text: toolText ?? "" }],
      };
      const prev = out[out.length - 1];
      if (
        prev && prev.role === "user" &&
        Array.isArray(prev.content) &&
        (prev.content as Array<Record<string, unknown>>).every(
          (b) => b.type === "tool_result",
        )
      ) {
        // 上一段就是纯 tool_result 的 user 消息：并入，不开新消息
        (prev.content as Array<Record<string, unknown>>).push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }
    // 文本与图片（data URL）按原顺序交错成块
    const { text, blocks } = contentBlocksOf(m);
    for (const call of m.tool_calls ?? []) {
      let input: unknown = {};
      try {
        input = JSON.parse(call.function.arguments || "{}");
      } catch { /* 损坏参数按空对象发，上游会报参数错也比悬空好 */ }
      blocks.push({
        type: "tool_use",
        id: call.id,
        name: call.function.name,
        input,
      });
    }
    if (blocks.length) {
      out.push({
        role: m.role === "assistant" ? "assistant" : "user",
        content: blocks,
      });
    }
  }
  // ★ 兜底：OpenAI 允许连续同角色消息，Anthropic 要求 user/assistant 严格
  // 交替。把相邻同角色的消息合并（块数组直接拼接），任何历史形态都不会
  // 触发 roles-must-alternate 400。
  const merged: Array<Record<string, unknown>> = [];
  for (const msg of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === msg.role) {
      prev.content = [
        ...(prev.content as Array<Record<string, unknown>>),
        ...(msg.content as Array<Record<string, unknown>>),
      ];
    } else {
      merged.push(msg);
    }
  }
  const tools = (body.tools ?? [])
    .filter((t) => t?.type === "function" && t.function?.name)
    .map((t) => ({
      name: t.function.name,
      description: t.function.description ?? "",
      input_schema: t.function.parameters ?? { type: "object", properties: {} },
    }));
  const metadata: Record<string, unknown> = {
    user_id: JSON.stringify({
      device_id: deviceMid ?? "",
      account_uuid: "",
      session_id: sessionId,
    }),
  };
  // ★ 2026-11-05 实测（桥上逐档验证）：GLM-5.3-Flash 是常思模型，思考开关
  // 不可关（1210 报错原文：不支持关闭思考）；档位走 output_config.effort =
  // low / high / max（thinking 深度随档位递增）。桌面真实请求同款形状。
  const effort = typeof body.reasoning_effort === "string" &&
      ["low", "high", "max"].includes(body.reasoning_effort)
    ? body.reasoning_effort
    : undefined;
  return {
    model: "glm-5.3-flash",
    max_tokens: clampMaxTokens(body.max_tokens),
    stream: true,
    thinking: { type: "enabled" },
    ...(effort ? { output_config: { effort } } : {}),
    ...(systemParts.length ? { system: systemParts.join("\n\n") } : {}),
    ...(tools.length ? { tools } : {}),
    ...(Object.keys(metadata).length ? { metadata } : {}),
    ...(body.temperature !== undefined
      ? { temperature: body.temperature }
      : {}),
    messages: merged,
  };
}

function clampMaxTokens(requested: unknown): number {
  const n = typeof requested === "number" && Number.isFinite(requested)
    ? Math.floor(requested)
    : 0;
  return Math.min(Math.max(n || 8192, 16), 128000);
}

function textOfContent(content: unknown): string {
  if (content == null) return "";
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p === "object") {
          const part = p as Record<string, unknown>;
          if (typeof part.text === "string") return part.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("");
  }
  if (typeof content === "object") {
    const c = content as Record<string, unknown>;
    return typeof c.text === "string" ? c.text : "";
  }
  return String(content);
}

// ---------------------------------------------------------------------------
// Anthropic SSE → OpenAI SSE
// ---------------------------------------------------------------------------

const finishReasonOf = (stop: unknown): string | null => {
  if (stop === "end_turn" || stop === "stop_sequence") return "stop";
  if (stop === "tool_use") return "tool_calls";
  if (stop === "max_tokens") return "length";
  return null;
};

/**
 * 把 Anthropic SSE 字节流转成 OpenAI chat.completion.chunk 的 JSON 行流。
 * 错误事件输出 {"error":...} 且不带 finish_reason（判据：错误轮不许撒谎）。
 */
export async function* anthropicSseToOpenAiChunks(
  body: ReadableStream<Uint8Array>,
  model: string,
  created: number,
  requestId: string,
): AsyncGenerator<string> {
  let buffer = "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const openIds = new Map<number, { id: string; name: string }>();
  let toolIndex = 0;
  let usage: Record<string, number> | null = null;
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(payload);
        } catch {
          continue;
        }
        const type = ev.type as string;
        if (type === "message_start") {
          const u = (ev.message as Record<string, unknown>)?.usage as
            | Record<string, number>
            | undefined;
          if (u) {
            usage = {
              prompt_tokens: u.input_tokens ?? 0,
              completion_tokens: 0,
            };
          }
          yield chunkJson(
            requestId,
            model,
            created,
            {
              role: "assistant",
              content: "",
            },
            null,
            usage,
          );
          continue;
        }
        if (type === "content_block_start") {
          const block = ev.content_block as Record<string, unknown>;
          const index = ev.index as number;
          if (block?.type === "tool_use") {
            openIds.set(index, {
              id: String(block.id ?? ""),
              name: String(block.name ?? ""),
            });
            yield chunkJson(
              requestId,
              model,
              created,
              {
                tool_calls: [{
                  index: toolIndex,
                  id: String(block.id ?? ""),
                  type: "function",
                  function: { name: String(block.name ?? ""), arguments: "" },
                }],
              },
              null,
              null,
            );
            toolIndex++;
          }
          continue;
        }
        if (type === "content_block_delta") {
          const delta = ev.delta as Record<string, unknown>;
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            yield chunkJson(
              requestId,
              model,
              created,
              {
                content: delta.text,
              },
              null,
              null,
            );
          } else if (
            delta?.type === "thinking_delta" &&
            typeof delta.thinking === "string"
          ) {
            yield chunkJson(
              requestId,
              model,
              created,
              {
                reasoning_content: delta.thinking,
              },
              null,
              null,
            );
          } else if (
            delta?.type === "input_json_delta" &&
            typeof delta.partial_json === "string"
          ) {
            yield chunkJson(
              requestId,
              model,
              created,
              {
                tool_calls: [{
                  index: toolIndex - 1,
                  function: { arguments: delta.partial_json },
                }],
              },
              null,
              null,
            );
          }
          continue;
        }
        if (type === "message_delta") {
          const delta = ev.delta as Record<string, unknown> | undefined;
          const u = ev.usage as Record<string, number> | undefined;
          if (u && usage) {
            usage.completion_tokens = u.output_tokens ?? 0;
            // GLM 网关在 message_start 报 0/0，真实 input_tokens 随 message_delta
            // 才到（/v1/messages 在桥里是原样透传，0 是上游行为不是桥的）。
            if (typeof u.input_tokens === "number" && u.input_tokens > 0) {
              usage.prompt_tokens = u.input_tokens;
            }
          }
          const reason = finishReasonOf(delta?.stop_reason);
          if (reason) {
            finished = true;
            // 「未知」优先于「0」：整个流都没拿到 prompt_tokens 就不发 usage，
            // 让 DSH 显示未知而不是假 0%（AGENTS.md 同款纪律）。
            const reported = usage && usage.prompt_tokens > 0 ? usage : null;
            yield chunkJson(requestId, model, created, {}, reason, reported);
          }
          continue;
        }
        if (type === "error") {
          const err = ev.error as Record<string, unknown> | undefined;
          yield JSON.stringify({
            error: {
              message: `zai-plan upstream: ${
                err?.message ?? JSON.stringify(ev)
              }`,
              code: "UPSTREAM_ERROR",
            },
          });
          return;
        }
        // ping / content_block_stop / message_stop：忽略（finish 已在 message_delta 发过）
      }
    }
    if (!finished) {
      // 流被掐断：按项目判据补 stream_cut 错误帧，不声称正常结束
      yield JSON.stringify({
        error: { message: "zai-plan upstream stream cut", code: "stream_cut" },
      });
    }
  } finally {
    reader.releaseLock();
  }
}

function chunkJson(
  id: string,
  model: string,
  created: number,
  delta: Record<string, unknown>,
  finish: string | null,
  usage: Record<string, number> | null,
): string {
  return JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  });
}

/** 非流式聚合：把 chunk 流收成一份完整的 chat.completion。 */
export async function aggregateChunks(
  chunkStream: AsyncGenerator<string>,
): Promise<Record<string, unknown>> {
  let content = "";
  let reasoning = "";
  const toolCalls: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }> = [];
  let finish: string | null = null;
  let usage: Record<string, number> | null = null;
  let error: Record<string, unknown> | null = null;
  let firstId = "";
  let created = 0;
  for await (const line of chunkStream) {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.error) {
      error = ev.error as Record<string, unknown>;
      continue;
    }
    const choices = ev.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    if (!choice) continue;
    firstId = String(ev.id ?? firstId);
    created = Number(ev.created ?? created) || created;
    const delta = choice.delta as Record<string, unknown> | undefined;
    if (delta) {
      if (typeof delta.content === "string") content += delta.content;
      if (typeof delta.reasoning_content === "string") {
        reasoning += delta.reasoning_content;
      }
      for (
        const tc of (delta.tool_calls as Array<Record<string, unknown>>) ?? []
      ) {
        const index = Number(tc.index ?? 0);
        while (toolCalls.length <= index) {
          toolCalls.push({
            id: "",
            type: "function",
            function: { name: "", arguments: "" },
          });
        }
        const slot = toolCalls[index];
        if (typeof tc.id === "string" && tc.id) slot.id = tc.id;
        const fn = tc.function as Record<string, unknown> | undefined;
        if (fn) {
          if (typeof fn.name === "string" && fn.name) {
            slot.function.name = fn.name;
          }
          if (typeof fn.arguments === "string") {
            slot.function.arguments += fn.arguments;
          }
        }
      }
    }
    if (choice.finish_reason != null) finish = choice.finish_reason as string;
    if (ev.usage) usage = ev.usage as Record<string, number>;
  }
  if (error) {
    throw new Error(String(error.message ?? "upstream error"));
  }
  const message: Record<string, unknown> = {
    role: "assistant",
    content: content || null,
    ...(reasoning ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  };
  return {
    id: firstId || `zai-plan-${Date.now()}`,
    object: "chat.completion",
    created: created || Math.floor(Date.now() / 1000),
    model: "glm-5.3-flash",
    choices: [{ index: 0, message, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  };
}

// ---------------------------------------------------------------------------
// handler
// ---------------------------------------------------------------------------

const KNOWN_MODELS = [
  {
    id: "glm-5.3-flash",
    object: "model",
    created: 0,
    owned_by: "zai-start-plan",
    context_window: 1000000,
    max_output_tokens: 128000,
    // ★ 阶梯与默认档来自上游自己的校验器（1210 报错原文列出 low/high/max）与
    // 桌面真实请求（output_config.effort=max）；常思模型，没有 off 档。
    reasoning_efforts: [
      { id: "low", name: "Low" },
      { id: "high", name: "High" },
      { id: "max", name: "Max" },
    ],
    default_reasoning_effort: "max",
    input_modalities: ["text", "image"],
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function handleZaiPlan(
  path: string,
  request: Request,
): Promise<Response> {
  if (path.endsWith("/models")) {
    return jsonResponse({ object: "list", data: KNOWN_MODELS });
  }
  if (!path.endsWith("/chat/completions") || request.method !== "POST") {
    return jsonResponse(
      {
        error: "unsupported zai-plan path (only /models and /chat/completions)",
      },
      404,
    );
  }
  let openai: Record<string, unknown>;
  try {
    openai = await request.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }
  const sessionId = crypto.randomUUID();
  const anthropicBody = toAnthropicBody(
    openai as Parameters<typeof toAnthropicBody>[0],
    null,
    sessionId,
  );
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "accept": "text/event-stream",
    "x-os-version": Deno.build.os === "windows" ? "10.0.26300" : "",
    "x-request-id": crypto.randomUUID(),
    "x-zcode-session-type": "main",
    "x-zcode-trace-id": crypto.randomUUID(),
    "x-query-id": crypto.randomUUID(),
    "x-zcode-query-source": "main_turn",
    "x-session-id": sessionId,
    "http-referer": "https://zcode.z.ai",
    "accept-encoding": "identity",
  };

  let upstream: UpstreamResponse;
  try {
    upstream = await upstreamRequest({
      method: "POST",
      path: MESSAGES_PATH,
      headers,
      body: JSON.stringify(anthropicBody),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({
      error:
        `zai-plan transport failed: ${message}（检查 ZAI_PLAN_PROXY 是否可达）`,
    }, 502);
  }
  if (upstream.status !== 200) {
    const text = await new Response(upstream.body).text();
    const hint = upstream.status === 405 || text.includes("3012")
      ? "WAF 拦截（3012）—— 出口 IP 被区别对待，检查 ZAI_PLAN_PROXY"
      : upstream.status === 401
      ? "凭据被拒 —— 打开 ZCode 桌面端刷新登录态"
      : text.includes("1005") || text.includes("quota")
      ? "额度未生效或已用尽（每日额度 09:00 重置；领取后延迟生效）"
      : "";
    return jsonResponse({
      error: `zai-plan upstream ${upstream.status}: ${text.slice(0, 300)}${
        hint ? " —— " + hint : ""
      }`,
    }, upstream.status === 401 ? 401 : upstream.status === 429 ? 429 : 502);
  }

  // ★ 2026-11-04：网关把业务错包成 HTTP 200 + JSON（实测 `{"code":1005,...}`），
  // 而 SSE 成功响应的 content-type 是 text/event-stream。先按 content-type 分流，
  // 否则一个 1005 会走进 SSE 转换器变成含糊的 "stream cut"。
  if (!upstream.contentType.includes("text/event-stream")) {
    const text = await new Response(upstream.body).text();
    let code: unknown = null;
    let msg = "";
    try {
      const j = JSON.parse(text);
      code = j?.code;
      msg = String(j?.msg ?? j?.error?.message ?? text.slice(0, 300));
    } catch {
      msg = text.slice(0, 300);
    }
    const hint = code === 1005 || /quota/i.test(msg)
      ? "额度未生效或已用尽（每日额度 09:00 重置；新领份额延迟生效，实测领取后约 3.5 小时）"
      : /3012|unusual activity/i.test(msg)
      ? "WAF 拦截 —— 出口 IP 被区别对待，检查 ZAI_PLAN_PROXY"
      : "";
    return jsonResponse({
      error: `zai-plan upstream ${upstream.status}${
        code ? ` code=${code}` : ""
      }: ${msg}${hint ? " —— " + hint : ""}`,
    }, 502);
  }

  const wantsStream = (openai as { stream?: boolean }).stream === true;
  const created = Math.floor(Date.now() / 1000);
  const requestId = `zai-plan-${sessionId}`;
  const chunkStream = anthropicSseToOpenAiChunks(
    upstream.body,
    "glm-5.3-flash",
    created,
    requestId,
  );
  if (!wantsStream) {
    try {
      const completion = await aggregateChunks(chunkStream);
      return jsonResponse(completion);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse({ error: message }, 502);
    }
  }
  const encoder = new TextEncoder();
  const sse = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for await (const line of chunkStream) {
          controller.enqueue(encoder.encode(`data: ${line}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        controller.enqueue(
          encoder.encode(
            `data: ${
              JSON.stringify({ error: { message, code: "UPSTREAM_ERROR" } })
            }\n\n`,
          ),
        );
        controller.close();
      }
    },
  });
  return new Response(sse, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "connection": "keep-alive",
    },
  });
}
