// deno-lint-ignore-file no-explicit-any
type ChatBody = Record<string, any>;
export const DEFAULT_MAX_REQUEST_BYTES = 12 * 1024 * 1024;

export type JsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; message: string };

export async function readJsonBodyLimited(
  request: Request,
  maximumBytes = DEFAULT_MAX_REQUEST_BYTES,
): Promise<JsonBodyResult> {
  const declared = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > maximumBytes) {
    return { ok: false, status: 413, message: "Request body is too large" };
  }
  const reader = request.body?.getReader();
  if (!reader) {
    return { ok: false, status: 400, message: "Request body is required" };
  }
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        text += decoder.decode();
        break;
      }
      total += value.byteLength;
      if (total > maximumBytes) {
        try {
          await reader.cancel();
        } catch { /* already closed */ }
        return { ok: false, status: 413, message: "Request body is too large" };
      }
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    return {
      ok: false,
      status: 400,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      reader.releaseLock();
    } catch { /* already consumed */ }
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, status: 400, message: "Invalid JSON" };
  }
}

function responseId(prefix = "resp"): string {
  return `${prefix}_${Math.random().toString(36).slice(2)}${
    Date.now().toString(36)
  }`;
}

function textFromInputContent(content: any): any {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) {
    return [{ type: "text", text: content == null ? "" : String(content) }];
  }
  return content.map((part: any) => {
    if (typeof part === "string") return { type: "text", text: part };
    if (
      part?.type === "input_text" || part?.type === "output_text" ||
      part?.type === "text"
    ) {
      return { type: "text", text: String(part.text || "") };
    }
    if (part?.type === "input_image") {
      const url = typeof part.image_url === "string"
        ? part.image_url
        : part.image_url?.url;
      return { type: "image_url", image_url: { url: String(url || "") } };
    }
    if (part?.type === "image_url") return part;
    return { type: "text", text: String(part?.text || "") };
  });
}

function flattenInputText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") {
        if (["input_text", "output_text", "text"].includes(String(part.type))) {
          return String(part.text ?? "");
        }
        return "";
      }
      return String(part ?? "");
    }).join("");
  }
  if (content == null) return "";
  if (typeof content === "object") {
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  return String(content);
}

function validResponsesInput(input: unknown): boolean {
  if (typeof input === "string") return true;
  if (!Array.isArray(input)) return false;
  return input.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const value = item as Record<string, any>;
    if (value.type === "function_call") {
      return typeof value.name === "string" &&
        (typeof value.call_id === "string" || typeof value.id === "string") &&
        value.arguments !== undefined;
    }
    if (value.type === "function_call_output") {
      return (typeof value.call_id === "string" ||
        typeof value.id === "string") &&
        value.output !== undefined;
    }
    return typeof value.role === "string" && value.content !== undefined;
  });
}

export function responsesInputToMessages(
  input: any,
  instructions?: string,
): any[] {
  const messages: any[] = [];
  if (instructions) messages.push({ role: "system", content: instructions });
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }
  if (!Array.isArray(input)) return messages;
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "function_call") {
      messages.push({
        role: "assistant",
        content: [],
        tool_calls: [{
          id: item.call_id || item.id || responseId("call"),
          type: "function",
          function: {
            name: String(item.name || ""),
            arguments: typeof item.arguments === "string"
              ? item.arguments
              : JSON.stringify(item.arguments ?? {}),
          },
        }],
      });
      continue;
    }
    if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id || item.id || "",
        content: flattenInputText(item.output),
      });
      continue;
    }
    if (item.role) {
      messages.push({
        role: item.role,
        content: textFromInputContent(item.content),
      });
    }
  }
  return messages;
}

export function responsesToChatBody(body: any): ChatBody {
  return {
    model: body.model || "deepseek-chat",
    messages: responsesInputToMessages(body.input, body.instructions),
    tools: Array.isArray(body.tools) ? body.tools : undefined,
    max_tokens: body.max_output_tokens,
    stream: body.stream === true,
    reasoning_effort: body.reasoning?.effort ?? body.reasoning_effort,
    tool_choice: body.tool_choice,
    parallel_tool_calls: body.parallel_tool_calls,
  };
}

function usageFromChat(chat: any): any {
  const usage = chat?.usage || {};
  const input = Number(usage.prompt_tokens || 0);
  const output = Number(usage.completion_tokens || 0);
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: Number(usage.total_tokens || input + output),
  };
}

function chatContentText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (
        part && typeof part === "object" &&
        ["text", "output_text"].includes(String(part.type))
      ) {
        return String(part.text ?? "");
      }
      return "";
    }).join("");
  }
  return content == null ? "" : String(content);
}

export function chatToResponses(
  chat: any,
  model: string,
  requestBody?: any,
): any {
  const choice = chat?.choices?.[0] || {};
  const message = choice.message || {};
  const finishReason = String(choice.finish_reason || "stop");
  const text = chatContentText(message.content);
  const failed = finishReason === "error";
  const incomplete = ["length", "max_tokens", "content_filter", "refusal"]
    .includes(
      finishReason,
    );
  const status = failed ? "failed" : incomplete ? "incomplete" : "completed";
  const outputStatus = failed || incomplete ? "incomplete" : "completed";
  const output: any[] = [];
  if (message.reasoning_content) {
    output.push({
      id: responseId("rs"),
      type: "reasoning",
      summary: [],
      content: [],
      status: outputStatus,
    });
  }
  if (text) {
    output.push({
      id: responseId("msg"),
      type: "message",
      status: outputStatus,
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }
  for (const call of message.tool_calls || []) {
    output.push({
      id: responseId("fc"),
      type: "function_call",
      call_id: call.id,
      name: call.function?.name || call.name,
      arguments: call.function?.arguments || call.arguments || "{}",
      status: outputStatus,
    });
  }
  return {
    id: responseId(),
    object: "response",
    created_at: chat?.created || Math.floor(Date.now() / 1000),
    status,
    model,
    output,
    output_text: text,
    error: failed
      ? { code: "upstream_error", message: "Upstream chat stream failed" }
      : null,
    incomplete_details: incomplete
      ? {
        reason: finishReason === "content_filter" || finishReason === "refusal"
          ? "content_filter"
          : "max_output_tokens",
      }
      : null,
    instructions: requestBody?.instructions ?? null,
    max_output_tokens: requestBody?.max_output_tokens ?? null,
    parallel_tool_calls: requestBody?.parallel_tool_calls ?? true,
    previous_response_id: requestBody?.previous_response_id ?? null,
    reasoning: requestBody?.reasoning ?? { effort: null, summary: null },
    store: false,
    temperature: null,
    text: requestBody?.text ?? { format: { type: "text" } },
    tool_choice: requestBody?.tool_choice ?? "auto",
    tools: Array.isArray(requestBody?.tools) ? requestBody.tools : [],
    top_p: null,
    truncation: requestBody?.truncation ?? "disabled",
    usage: usageFromChat(chat),
    metadata: requestBody?.metadata ?? {},
  };
}

function sseEvent(type: string, sequence: number, payload: any): Uint8Array {
  return new TextEncoder().encode(
    `event: ${type}\ndata: ${
      JSON.stringify({ type, sequence_number: sequence, ...payload })
    }\n\n`,
  );
}

export function chatStreamToResponsesStream(
  chatResponse: Response,
  model: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let sequence = 0;
      const id = responseId();
      const created = Math.floor(Date.now() / 1000);
      let text = "";
      let reasoning = "";
      let textItemId = "";
      let reasoningItemId = "";
      let textOutputIndex: number | null = null;
      let reasoningOutputIndex: number | null = null;
      let nextOutputIndex = 0;
      const toolItems = new Map<
        number,
        { itemId: string; callId: string; name: string; args: string }
      >();
      const toolOutputIndices = new Map<number, number>();
      const allocateOutputIndex = (): number => nextOutputIndex++;
      const textIndex = (): number => {
        if (textOutputIndex === null) textOutputIndex = allocateOutputIndex();
        return textOutputIndex;
      };
      const reasoningIndex = (): number => {
        if (reasoningOutputIndex === null) {
          reasoningOutputIndex = allocateOutputIndex();
        }
        return reasoningOutputIndex;
      };
      const toolOutputIndex = (index: number): number => {
        if (!toolOutputIndices.has(index)) {
          toolOutputIndices.set(index, allocateOutputIndex());
        }
        return toolOutputIndices.get(index)!;
      };
      let usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
      let finishReason = "stop";
      let sawFinish = false;
      const send = (type: string, payload: any) =>
        controller.enqueue(sseEvent(type, sequence++, payload));
      const base = (
        status: string,
        output: any[] = [],
        finalUsage = usage,
      ) => ({
        id,
        object: "response",
        created_at: created,
        status,
        model,
        output,
        error: null,
        incomplete_details: null,
        usage: finalUsage,
      });
      send("response.created", { response: base("in_progress") });
      if (!chatResponse.body) {
        send("response.failed", { response: base("failed") });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
        return;
      }
      const reader = chatResponse.body.getReader();
      upstreamReader = reader;
      const decoder = new TextDecoder();
      let buffer = "";
      const handleData = (raw: string) => {
        if (!raw || raw === "[DONE]") return;
        let chunk: any;
        try {
          chunk = JSON.parse(raw);
        } catch {
          return;
        }
        if (chunk.error || chunk.type === "error") {
          const message = String(
            chunk.error?.message || chunk.error || chunk.message ||
              "DeepSeek stream error",
          );
          throw new Error(message);
        }
        if (chunk.usage) usage = usageFromChat(chunk);
        const delta = chunk.choices?.[0]?.delta || {};
        const reason = chunk.choices?.[0]?.finish_reason;
        if (typeof reason === "string" && reason) {
          finishReason = reason;
          sawFinish = true;
        }
        if (delta.error || reason === "error") {
          throw new Error(
            String(
              delta.error?.message || delta.error || "DeepSeek stream error",
            ),
          );
        }
        if (
          typeof delta.reasoning_content === "string" && delta.reasoning_content
        ) {
          if (!reasoningItemId) {
            reasoningItemId = responseId("rs");
            send("response.output_item.added", {
              output_index: reasoningIndex(),
              item: {
                id: reasoningItemId,
                type: "reasoning",
                summary: [],
                content: [],
                status: "in_progress",
              },
            });
          }
          reasoning += delta.reasoning_content;
          send("response.reasoning_summary_text.delta", {
            item_id: reasoningItemId,
            output_index: reasoningOutputIndex,
            summary_index: 0,
            delta: delta.reasoning_content,
          });
        }
        if (typeof delta.content === "string" && delta.content) {
          if (!textItemId) {
            textItemId = responseId("msg");
            send("response.output_item.added", {
              output_index: textIndex(),
              item: {
                id: textItemId,
                type: "message",
                status: "in_progress",
                role: "assistant",
                content: [],
              },
            });
            send("response.content_part.added", {
              item_id: textItemId,
              output_index: textOutputIndex,
              content_index: 0,
              part: { type: "output_text", text: "" },
            });
          }
          text += delta.content;
          send("response.output_text.delta", {
            item_id: textItemId,
            output_index: textOutputIndex,
            content_index: 0,
            delta: delta.content,
          });
        }
        for (const call of delta.tool_calls || []) {
          const index = Number(call.index || 0);
          const item = toolItems.get(index) || {
            itemId: responseId("fc"),
            callId: call.id || responseId("call"),
            name: call.function?.name || "",
            args: "",
          };
          if (call.id) item.callId = call.id;
          if (call.function?.name) item.name = call.function.name;
          if (!toolItems.has(index)) {
            toolItems.set(index, item);
            send("response.output_item.added", {
              output_index: toolOutputIndex(index),
              item: {
                id: item.itemId,
                type: "function_call",
                call_id: item.callId,
                name: item.name,
                arguments: "",
                status: "in_progress",
              },
            });
          }
          const args = call.function?.arguments || "";
          item.args += args;
          if (args) {
            send("response.function_call_arguments.delta", {
              item_id: item.itemId,
              output_index: toolOutputIndex(index),
              delta: args,
            });
          }
        }
      };
      let readerCompleted = false;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index: number;
          while ((index = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, index).replace(/\r$/, "");
            buffer = buffer.slice(index + 1);
            if (line.startsWith("data:")) handleData(line.slice(5).trim());
          }
        }
        buffer += decoder.decode();
        if (buffer.startsWith("data:")) handleData(buffer.slice(5).trim());
        if (!sawFinish) {
          throw new Error("Upstream chat stream ended without finish_reason");
        }
        const finalStatus = finishReason === "error"
          ? "failed"
          : ["length", "max_tokens", "content_filter", "refusal"].includes(
              finishReason,
            )
          ? "incomplete"
          : "completed";
        const itemStatus = finalStatus === "failed"
          ? "incomplete"
          : finalStatus === "incomplete"
          ? "incomplete"
          : "completed";
        const finalItems: any[] = [];
        if (reasoningItemId) {
          finalItems[reasoningOutputIndex!] = {
            id: reasoningItemId,
            type: "reasoning",
            summary: [],
            content: [],
            status: itemStatus,
          };
          send("response.reasoning_summary_text.done", {
            item_id: reasoningItemId,
            output_index: reasoningOutputIndex,
            summary_index: 0,
            text: reasoning,
          });
          send("response.output_item.done", {
            output_index: reasoningOutputIndex,
            item: finalItems[reasoningOutputIndex!],
          });
        }
        if (text) {
          if (!textItemId) {
            textItemId = responseId("msg");
            textIndex();
          }
          send("response.output_text.done", {
            item_id: textItemId,
            output_index: textOutputIndex,
            content_index: 0,
            text,
          });
          send("response.content_part.done", {
            item_id: textItemId,
            output_index: textOutputIndex,
            content_index: 0,
            part: { type: "output_text", text },
          });
          finalItems[textOutputIndex!] = {
            id: textItemId,
            type: "message",
            status: itemStatus,
            role: "assistant",
            content: [{ type: "output_text", text, annotations: [] }],
          };
          send("response.output_item.done", {
            output_index: textOutputIndex,
            item: finalItems[textOutputIndex!],
          });
        }
        for (const [index, item] of toolItems) {
          const outputIndex = toolOutputIndex(index);
          send("response.function_call_arguments.done", {
            item_id: item.itemId,
            output_index: outputIndex,
            arguments: item.args,
          });
          finalItems[outputIndex] = {
            id: item.itemId,
            type: "function_call",
            call_id: item.callId,
            name: item.name,
            arguments: item.args,
            status: itemStatus,
          };
          send("response.output_item.done", {
            output_index: outputIndex,
            item: finalItems[outputIndex],
          });
        }
        const output = Array.from(
          { length: nextOutputIndex },
          (_, index) => finalItems[index],
        ).filter(Boolean);
        const response = {
          ...base(finalStatus, output),
          output_text: text,
          error: finalStatus === "failed"
            ? { code: "upstream_error", message: "Upstream chat stream failed" }
            : null,
          incomplete_details: finalStatus === "incomplete"
            ? {
              reason: ["content_filter", "refusal"].includes(finishReason)
                ? "content_filter"
                : "max_output_tokens",
            }
            : null,
          reasoning: { effort: null, summary: null },
          parallel_tool_calls: true,
          store: false,
          metadata: {},
        };
        send(
          finalStatus === "failed"
            ? "response.failed"
            : finalStatus === "incomplete"
            ? "response.incomplete"
            : "response.completed",
          { response },
        );
        readerCompleted = true;
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (error: any) {
        if (cancelled) return;
        send("response.failed", {
          response: {
            ...base("failed"),
            error: {
              code: "upstream_stream_error",
              message: String(error?.message || error),
            },
          },
        });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } finally {
        if (!readerCompleted) {
          try {
            await reader.cancel();
          } catch { /* already closed */ }
        }
        try {
          reader.releaseLock();
        } catch { /* already released */ }
        controller.close();
      }
    },
    cancel() {
      cancelled = true;
      if (upstreamReader) {
        void upstreamReader.cancel().catch(() => undefined);
      }
    },
  });
}

async function responseErrorInfo(response: Response): Promise<{
  status: number;
  code: string;
  message: string;
  retryAfter?: string;
}> {
  let message = `Upstream request failed (HTTP ${response.status})`;
  let code = "upstream_error";
  try {
    const raw = await response.text();
    const parsed: any = JSON.parse(raw);
    const detail = parsed?.error ?? parsed;
    if (typeof detail?.message === "string" && detail.message) {
      message = detail.message;
    }
    if (typeof detail?.type === "string" && detail.type) code = detail.type;
    if (typeof detail?.code === "string" && detail.code) code = detail.code;
  } catch { /* retain generic error */ }
  return {
    status: response.status,
    code,
    message,
    ...(response.headers.get("retry-after")
      ? { retryAfter: response.headers.get("retry-after")! }
      : {}),
  };
}

export async function handleDeepseekResponses(
  request: Request,
  callChat: (body: any) => Promise<Response>,
  maximumBodyBytes = DEFAULT_MAX_REQUEST_BYTES,
  strictShape = false,
): Promise<Response> {
  const parsedBody = await readJsonBodyLimited(request, maximumBodyBytes);
  if (!parsedBody.ok) {
    return new Response(
      JSON.stringify({
        error: {
          message: parsedBody.message,
          type: parsedBody.status === 413
            ? "payload_too_large"
            : "invalid_request_error",
        },
      }),
      {
        status: parsedBody.status,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
  if (
    !parsedBody.value || typeof parsedBody.value !== "object" ||
    Array.isArray(parsedBody.value)
  ) {
    return new Response(
      JSON.stringify({
        error: {
          message: "Request body must be a JSON object",
          type: "invalid_request_error",
        },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  const body: any = parsedBody.value;
  if (
    strictShape && (
      body.previous_response_id != null || body.conversation != null ||
      body.background === true || body.store === true ||
      (body.truncation !== undefined && body.truncation !== "disabled") ||
      (Array.isArray(body.include) && body.include.length > 0) ||
      (body.text?.format?.type !== undefined &&
        body.text.format.type !== "text") ||
      (body.n !== undefined && body.n !== 1) ||
      (body.instructions !== undefined &&
        typeof body.instructions !== "string") ||
      (Array.isArray(body.tools) &&
        body.tools.some((tool: any) =>
          !tool || typeof tool !== "object" || tool.type !== "function" ||
          typeof tool.function?.name !== "string"
        ))
    )
  ) {
    return new Response(
      JSON.stringify({
        error: {
          message:
            "CommandCode stateless proxy does not support previous_response_id, conversation, background, store, non-default truncation/include, structured text format, or invalid input/tools",
          type: "invalid_request_error",
        },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  if (
    strictShape &&
    (typeof body.model !== "string" || body.model.trim().length === 0)
  ) {
    return new Response(
      JSON.stringify({
        error: { message: "model is required", type: "invalid_request_error" },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  if (strictShape && !validResponsesInput(body.input)) {
    return new Response(
      JSON.stringify({
        error: {
          message: "input must be a string or array",
          type: "invalid_request_error",
        },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  if (strictShape && body.tools !== undefined && !Array.isArray(body.tools)) {
    return new Response(
      JSON.stringify({
        error: {
          message: "tools must be an array",
          type: "invalid_request_error",
        },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  const chatBody = responsesToChatBody(body);
  const chatResponse = await callChat(chatBody);
  if (!chatResponse.ok) {
    const error = await responseErrorInfo(chatResponse);
    const errorHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      ...(error.retryAfter ? { "Retry-After": error.retryAfter } : {}),
    };
    if (body.stream === true) {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const id = responseId();
            const response = {
              id,
              object: "response",
              created_at: Math.floor(Date.now() / 1000),
              status: "failed",
              model: chatBody.model,
              output: [],
              error: { code: error.code, message: error.message },
              incomplete_details: null,
              usage: null,
            };
            controller.enqueue(
              encoder.encode(`event: response.failed\ndata: ${
                JSON.stringify({
                  type: "response.failed",
                  sequence_number: 0,
                  response,
                })
              }\n\n`),
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
        {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            ...(error.retryAfter ? { "Retry-After": error.retryAfter } : {}),
          },
        },
      );
    }
    return new Response(
      JSON.stringify({
        error: { code: error.code, message: error.message, type: error.code },
      }),
      { status: error.status, headers: errorHeaders },
    );
  }
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };
  if (body.stream === true) {
    return new Response(
      chatStreamToResponsesStream(chatResponse, chatBody.model),
      {
        headers: {
          ...headers,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      },
    );
  }
  try {
    const chat = await chatResponse.json();
    return new Response(
      JSON.stringify(chatToResponses(chat, chatBody.model, body)),
      { headers },
    );
  } catch (error: any) {
    return new Response(
      JSON.stringify({
        error: {
          message: String(error?.message || error),
          type: "upstream_error",
        },
      }),
      { status: 502, headers },
    );
  }
}
