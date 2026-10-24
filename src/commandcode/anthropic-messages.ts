// deno-lint-ignore-file no-explicit-any

type Json = Record<string, any>;

export interface AnthropicConversionError {
  ok: false;
  message: string;
}

export interface AnthropicChatBody {
  ok: true;
  body: Json;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFromBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  return content.map((block) => {
    if (typeof block === "string") return block;
    if (!isRecord(block)) return "";
    if (block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
    return "";
  }).join("");
}

function imageDataUrl(source: unknown): string | undefined {
  if (!isRecord(source)) return undefined;
  if (source.type !== "base64") return undefined;
  if (
    typeof source.media_type !== "string" || typeof source.data !== "string"
  ) {
    return undefined;
  }
  return `data:${source.media_type};base64,${source.data}`;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return textFromBlocks(content);
  return content.map((block) => {
    if (typeof block === "string") return block;
    if (
      isRecord(block) && block.type === "text" && typeof block.text === "string"
    ) {
      return block.text;
    }
    return "";
  }).join("");
}

/** Convert an Anthropic Messages request into the Chat Completions shape. */
export function anthropicMessagesToChat(input: unknown):
  | AnthropicChatBody
  | AnthropicConversionError {
  if (!isRecord(input)) {
    return { ok: false, message: "request body must be an object" };
  }
  if (typeof input.model !== "string" || !input.model.trim()) {
    return { ok: false, message: "model is required" };
  }
  if (!Number.isSafeInteger(input.max_tokens) || Number(input.max_tokens) < 1) {
    return {
      ok: false,
      message: "max_tokens is required and must be a positive integer",
    };
  }
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    return { ok: false, message: "messages must be a non-empty array" };
  }
  if (
    input.stop_sequences !== undefined || input.thinking !== undefined ||
    input.top_k !== undefined
  ) {
    // 2026-10-18：这三者过去被硬拒（Claude Code 每轮都带，等于整渠道不可用）。
    // 实测（2026-10-18 直连 cnb 上游）：stop 数组 / top_k / thinking 对象全部
    // 200 出字（上游校验极松，未知字段不报错）。所以改为**尽力映射**而不是拒绝：
    //   - stop_sequences → OpenAI 的 `stop`（语义一致）
    //   - top_k → 原样透传（上游接受；不支持它的网关会忽略）
    //   - thinking → 剥掉（Anthropic 的思考开关由渠道自己的 effort 机制表达，
    //     直接透传一个 Anthropic 形状的对象反而可能被下游误读）
    // ⚠️ commandcode 上游是否接受 top_k 未实测；这里只对 cnb 路径保证可用，
    // commandcode 侧如遇问题再按渠道分叉。
  }
  let stop: Json | undefined;
  if (input.stop_sequences !== undefined) {
    if (!Array.isArray(input.stop_sequences)) {
      return { ok: false, message: "stop_sequences must be an array" };
    }
    stop = input.stop_sequences;
  }
  let topK: number | undefined;
  if (input.top_k !== undefined) {
    if (!Number.isSafeInteger(Number(input.top_k)) || Number(input.top_k) < 1) {
      return { ok: false, message: "top_k must be a positive integer" };
    }
    topK = Number(input.top_k);
  }

  const messages: Json[] = [];
  if (input.system !== undefined) {
    const system = textFromBlocks(input.system);
    if (system) messages.push({ role: "system", content: system });
  }
  // ★ 非 user/assistant 的 role 不再整单拒绝（2026-10-18）。Claude Code 的
  // 会话续接/转发链会在 messages 里混进 role:"system"/"tool"/"developer"
  // 甚至缺 role 的条目，硬拒等于整轮 400。降级策略：
  //   system/developer → 并入开头的 system 消息（语义就是系统级指令）
  //   tool → 转成 user 文本（与下方 tool_result 块同一套处理思路）
  //   其它/缺失 → 跳过，但记进 skippedRoles 供响应诊断
  const skippedRoles: string[] = [];
  const extraSystem: string[] = [];
  for (const raw of input.messages) {
    if (!isRecord(raw)) {
      skippedRoles.push("(non-object)");
      continue;
    }
    const role = typeof raw.role === "string" ? raw.role.toLowerCase() : "";
    if (role === "system" || role === "developer") {
      const extra = textFromBlocks(raw.content);
      if (extra) extraSystem.push(extra);
      continue;
    }
    if (role === "tool") {
      const toolText = textFromBlocks(raw.content);
      if (toolText) {
        messages.push({ role: "user", content: `[Tool Result]\n${toolText}` });
      }
      continue;
    }
    if (role !== "user" && role !== "assistant") {
      skippedRoles.push(role || "(missing)");
      continue;
    }
    const content = raw.content;
    const blocks = Array.isArray(content) ? content : [content];
    const textParts: Json[] = [];
    const toolCalls: Json[] = [];
    const toolResults: Array<{ id: string; content: string }> = [];
    for (const block of blocks) {
      if (typeof block === "string" || !isRecord(block)) {
        const text = textFromBlocks(block);
        if (text) textParts.push({ type: "text", text });
        continue;
      }
      if (block.type === "text" && typeof block.text === "string") {
        textParts.push({ type: "text", text: block.text });
      } else if (block.type === "image" && raw.role === "user") {
        const url = imageDataUrl(block.source);
        if (url) textParts.push({ type: "image_url", image_url: { url } });
      } else if (block.type === "tool_use" && raw.role === "assistant") {
        if (typeof block.id !== "string" || typeof block.name !== "string") {
          return { ok: false, message: "tool_use requires id and name" };
        }
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
      } else if (block.type === "tool_result") {
        // tool_result 规范上只出现在 user 消息里，但转发链可能挪到 assistant
        // 名下——内容本身仍是工具结果，按同一套处理，不拒。
        if (typeof block.tool_use_id !== "string") {
          return { ok: false, message: "tool_result requires tool_use_id" };
        }
        toolResults.push({
          id: block.tool_use_id,
          content: toolResultText(block.content),
        });
      }
    }
    if (textParts.length > 0) {
      messages.push({
        role: raw.role,
        content: textParts.length === 1 && textParts[0].type === "text"
          ? textParts[0].text
          : textParts,
      });
    }
    if (toolCalls.length > 0) {
      messages.push({ role: "assistant", content: "", tool_calls: toolCalls });
    }
    for (const result of toolResults) {
      messages.push({
        role: "tool",
        tool_call_id: result.id,
        content: result.content,
      });
    }
  }
  // messages 里混入的 system/developer 指令并到最前面（Anthropic 语义里它们
  // 本来就该是 system 层）；若上游需要单一 system 形状就拼一条。
  if (extraSystem.length > 0) {
    const merged = extraSystem.join("\n\n");
    if (
      messages[0] && messages[0].role === "system" &&
      typeof messages[0].content === "string"
    ) {
      messages[0] = {
        role: "system",
        content: messages[0].content + "\n\n" + merged,
      };
    } else {
      messages.unshift({ role: "system", content: merged });
    }
  }
  // 降级跳过可能清空整个 messages（例如全部条目缺 role）——这时上游只会回
  // 一句看不懂的 "cnb upstream request failed"。在转换层就给出明确诊断。
  if (messages.length === 0) {
    return {
      ok: false,
      message: "no usable messages after conversion" +
        (skippedRoles.length
          ? ` (skipped roles: ${skippedRoles.join(", ")})`
          : ""),
    };
  }

  const body: Json = {
    model: input.model,
    max_tokens: Number(input.max_tokens),
    messages,
    stream: input.stream === true,
  };
  if (typeof input.temperature === "number") {
    body.temperature = input.temperature;
  }
  if (typeof input.top_p === "number") body.top_p = input.top_p;
  if (stop !== undefined) body.stop = stop;
  if (topK !== undefined) body.top_k = topK;
  if (input.tools !== undefined) {
    if (!Array.isArray(input.tools)) {
      return { ok: false, message: "tools must be an array" };
    }
    body.tools = input.tools.map((tool) => {
      if (!isRecord(tool) || typeof tool.name !== "string") {
        throw new Error("each tool requires a name");
      }
      return {
        type: "function",
        function: {
          name: tool.name,
          ...(typeof tool.description === "string"
            ? { description: tool.description }
            : {}),
          parameters: isRecord(tool.input_schema)
            ? tool.input_schema
            : { type: "object" },
        },
      };
    });
  }
  if (input.tool_choice !== undefined) {
    if (!isRecord(input.tool_choice)) {
      return { ok: false, message: "tool_choice must be an object" };
    }
    if (input.tool_choice.type === "auto") body.tool_choice = "auto";
    else if (input.tool_choice.type === "none") body.tool_choice = "none";
    else if (input.tool_choice.type === "any") {
      // Anthropic 的 "any" = 必须调一个工具；OpenAI 语义里最接近的是 "required"。
      // 上游若不认 "required" 会忽略——比整轮 400 好（Claude Code 会发这个值）。
      body.tool_choice = "required";
    } else if (
      input.tool_choice.type === "tool" &&
      typeof input.tool_choice.name === "string"
    ) {
      // "指定必须调某个工具"在 OpenAI 通用形状里没有统一表达；用 function 壳
      // （部分网关认），上游不认就忽略——同样比整轮 400 好。
      body.tool_choice = {
        type: "function",
        function: { name: input.tool_choice.name },
      };
    } else {
      return {
        ok: false,
        message: "tool_choice.type must be one of auto/none/any/tool (got " +
          JSON.stringify(input.tool_choice.type ?? null) +
          ")",
      };
    }
  }
  return { ok: true, body };
}

function stopReason(reason: unknown): string {
  if (reason === "tool_calls" || reason === "tool_use") return "tool_use";
  if (reason === "length" || reason === "max_tokens") return "max_tokens";
  return "end_turn";
}

function parsedInput(value: unknown): unknown {
  if (typeof value !== "string") return isRecord(value) ? value : {};
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Convert a non-streaming Chat Completions response to Anthropic Messages. */
export function chatResponseToAnthropic(
  payload: unknown,
  requestedModel: string,
): Json {
  const body = isRecord(payload) ? payload : {};
  const choice = Array.isArray(body.choices) && isRecord(body.choices[0])
    ? body.choices[0]
    : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const content: Json[] = [];
  if (
    typeof message.reasoning_content === "string" && message.reasoning_content
  ) {
    content.push({ type: "thinking", thinking: message.reasoning_content });
  }
  if (typeof message.content === "string" && message.content) {
    content.push({ type: "text", text: message.content });
  }
  if (Array.isArray(message.tool_calls)) {
    for (const raw of message.tool_calls) {
      if (!isRecord(raw) || typeof raw.id !== "string") continue;
      const fn = isRecord(raw.function) ? raw.function : {};
      content.push({
        type: "tool_use",
        id: raw.id,
        name: typeof fn.name === "string" ? fn.name : "unknown",
        input: parsedInput(fn.arguments),
      });
    }
  }
  const usage = isRecord(body.usage) ? body.usage : {};
  return {
    id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    model: typeof body.model === "string" ? body.model : requestedModel,
    content,
    stop_reason: stopReason(choice.finish_reason),
    stop_sequence: null,
    usage: anthropicUsage(usage),
  };
}

/**
 * OpenAI 系 usage → Anthropic usage。
 *
 * ★ 2026-10-24 修（cnb /messages「未缓存输入 0 / 缓存读取 0 全都是 0」）：
 * 上游实测把**三种缓存形状同时报齐**——`prompt_tokens_details.cached_tokens`
 * （OpenAI）、`prompt_cache_hit_tokens`（DeepSeek）、Anthropic 原生的
 * `cache_read_input_tokens` / `cache_creation_input_tokens`——旧代码一个都没读，
 * message_start 写死 0、message_delta 只映射 completion_tokens，Claude 形态
 * 客户端的缓存记账永远是 0（同型病：插件侧「缓存 token 被整个丢掉」2026-10-02
 * 已修过一次，这是换了个入口复发）。
 *
 * 语义注意：Anthropic 的 `input_tokens` 是**未缓存**输入，不含 cache 读写；
 * 而 OpenAI 系 `prompt_tokens` 是全量（实测 cnb：prompt_tokens = hit + miss）。
 * 所以 input = prompt − read − write，clamp 到 0。缓存字段**只在 >0 时输出**——
 * 上游没报缓存是「没说话」，填 0 是「断言没有缓存」。
 */
export function anthropicUsage(
  u: Record<string, unknown> | undefined,
): Record<string, number> {
  const num = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;
  const nested = isRecord(u?.prompt_tokens_details)
    ? u.prompt_tokens_details
    : {};
  const prompt = num(u?.prompt_tokens);
  const cacheRead = Math.max(
    num(u?.cache_read_input_tokens),
    num(u?.prompt_cache_hit_tokens),
    num(nested.cached_tokens),
  );
  const cacheWrite = Math.max(
    num(u?.cache_creation_input_tokens),
    num(u?.prompt_cache_write_tokens),
  );
  const out: Record<string, number> = {
    input_tokens: Math.max(0, prompt - cacheRead - cacheWrite),
    output_tokens: num(u?.completion_tokens),
  };
  if (cacheRead > 0) out.cache_read_input_tokens = cacheRead;
  if (cacheWrite > 0) out.cache_creation_input_tokens = cacheWrite;
  return out;
}

function sseEvent(type: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(
    `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`,
  );
}

interface StreamBlock {
  kind: "text" | "thinking" | "tool";
  closed: boolean;
}

/** Translate the OpenAI SSE emitted by CommandCode into Anthropic Messages SSE. */
export function openAiStreamToAnthropic(
  response: Response,
  requestedModel: string,
): Response {
  let cancelled = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let nextIndex = 0;
      let textIndex = -1;
      let thinkingIndex = -1;
      const toolIndices = new Map<number, number>();
      const blocks: StreamBlock[] = [];
      let stop = "end_turn";
      // ★ 完整 usage 快照（不只是 completion_tokens）：input/cache 要在最终
      // message_delta 里带给客户端——Anthropic SDK 会把 delta 的 usage 合并进
      // message 对象，Claude 形态客户端从那里读缓存记账。message_start 时上游
      // 还没报 usage（OpenAI 系在尾帧才给），那里保持 0 是协议事实不是丢失。
      let lastUsage: Record<string, unknown> | undefined;
      const emit = (type: string, data: unknown) => {
        if (!cancelled) controller.enqueue(sseEvent(type, data));
      };
      const closeBlocks = () => {
        for (let index = 0; index < blocks.length; index++) {
          if (blocks[index].closed) continue;
          blocks[index].closed = true;
          emit("content_block_stop", { type: "content_block_stop", index });
        }
      };
      emit("message_start", {
        type: "message_start",
        message: {
          id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
          type: "message",
          role: "assistant",
          model: requestedModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
      const process = (data: string) => {
        if (data === "[DONE]") return;
        let chunk: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(data);
          if (!isRecord(parsed)) return;
          chunk = parsed;
        } catch {
          return;
        }
        if (isRecord(chunk.error)) {
          emit("error", {
            type: "error",
            error: {
              type: "api_error",
              message: String(chunk.error.message ?? "upstream stream error"),
            },
          });
          stop = "end_turn";
          return;
        }
        const choice =
          Array.isArray(chunk.choices) && isRecord(chunk.choices[0])
            ? chunk.choices[0]
            : {};
        const delta = isRecord(choice.delta) ? choice.delta : {};
        if (typeof delta.content === "string" && delta.content) {
          if (textIndex < 0) {
            textIndex = nextIndex++;
            blocks[textIndex] = { kind: "text", closed: false };
            emit("content_block_start", {
              type: "content_block_start",
              index: textIndex,
              content_block: { type: "text", text: "" },
            });
          }
          emit("content_block_delta", {
            type: "content_block_delta",
            index: textIndex,
            delta: { type: "text_delta", text: delta.content },
          });
        }
        if (
          typeof delta.reasoning_content === "string" && delta.reasoning_content
        ) {
          if (thinkingIndex < 0) {
            thinkingIndex = nextIndex++;
            blocks[thinkingIndex] = { kind: "thinking", closed: false };
            emit("content_block_start", {
              type: "content_block_start",
              index: thinkingIndex,
              content_block: { type: "thinking", thinking: "" },
            });
          }
          emit("content_block_delta", {
            type: "content_block_delta",
            index: thinkingIndex,
            delta: {
              type: "thinking_delta",
              thinking: delta.reasoning_content,
            },
          });
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const raw of delta.tool_calls) {
            if (!isRecord(raw)) continue;
            const callIndex = Number(raw.index ?? 0);
            let blockIndex = toolIndices.get(callIndex);
            if (blockIndex === undefined) {
              blockIndex = nextIndex++;
              toolIndices.set(callIndex, blockIndex);
              const fn = isRecord(raw.function) ? raw.function : {};
              blocks[blockIndex] = { kind: "tool", closed: false };
              emit("content_block_start", {
                type: "content_block_start",
                index: blockIndex,
                content_block: {
                  type: "tool_use",
                  id: typeof raw.id === "string"
                    ? raw.id
                    : `tool_${blockIndex}`,
                  name: typeof fn.name === "string" ? fn.name : "unknown",
                  input: {},
                },
              });
            }
            const fn = isRecord(raw.function) ? raw.function : {};
            if (typeof fn.arguments === "string" && fn.arguments) {
              emit("content_block_delta", {
                type: "content_block_delta",
                index: blockIndex,
                delta: { type: "input_json_delta", partial_json: fn.arguments },
              });
            }
          }
        }
        if (choice.finish_reason != null) {
          stop = stopReason(choice.finish_reason);
        }
        if (isRecord(chunk.usage)) {
          lastUsage = chunk.usage;
        }
      };
      try {
        if (!response.body) throw new Error("upstream returned no body");
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          buffer += decoder.decode(result.value, { stream: true });
          const frames = buffer.split(/\r?\n\r?\n/);
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            for (const line of frame.split(/\r?\n/)) {
              if (line.startsWith("data:")) process(line.slice(5).trim());
            }
          }
        }
        buffer += decoder.decode();
        if (buffer.trim().startsWith("data:")) {
          process(buffer.trim().slice(5).trim());
        }
        closeBlocks();
        emit("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stop, stop_sequence: null },
          // 全量 usage（input + cache）：SDK 用 delta 的 usage 覆盖合并，
          // 只发 output_tokens 的话缓存/输入记账就永远是 0。
          usage: anthropicUsage(lastUsage),
        });
        emit("message_stop", { type: "message_stop" });
      } catch (error) {
        emit("error", {
          type: "error",
          error: {
            type: "api_error",
            message: error instanceof Error ? error.message : String(error),
          },
        });
      } finally {
        try {
          await reader?.cancel();
        } catch { /* already closed */ }
        try {
          controller.close();
        } catch { /* consumer cancelled */ }
      }
    },
    cancel() {
      cancelled = true;
      void reader?.cancel().catch(() => undefined);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
