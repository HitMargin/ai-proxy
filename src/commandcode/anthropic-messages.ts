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
    return {
      ok: false,
      message:
        "stop_sequences, thinking, and top_k are not supported by this gateway",
    };
  }

  const messages: Json[] = [];
  if (input.system !== undefined) {
    const system = textFromBlocks(input.system);
    if (system) messages.push({ role: "system", content: system });
  }
  for (const raw of input.messages) {
    if (!isRecord(raw) || (raw.role !== "user" && raw.role !== "assistant")) {
      return {
        ok: false,
        message: "each message must have role user or assistant",
      };
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
      } else if (block.type === "tool_result" && raw.role === "user") {
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
    else {
      return {
        ok: false,
        message: "CommandCode supports only Anthropic tool_choice auto or none",
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
    usage: {
      input_tokens: Number(usage.prompt_tokens ?? 0),
      output_tokens: Number(usage.completion_tokens ?? 0),
    },
  };
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
      let outputTokens = 0;
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
          outputTokens = Number(chunk.usage.completion_tokens ?? outputTokens);
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
          usage: { output_tokens: outputTokens },
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
