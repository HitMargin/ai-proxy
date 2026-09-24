type ChatBody = Record<string, any>;

function responseId(prefix = "resp"): string {
  return `${prefix}_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function textFromInputContent(content: any): any {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [{ type: "text", text: content == null ? "" : String(content) }];
  return content.map((part: any) => {
    if (typeof part === "string") return { type: "text", text: part };
    if (part?.type === "input_text" || part?.type === "output_text" || part?.type === "text") {
      return { type: "text", text: String(part.text || "") };
    }
    if (part?.type === "input_image") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      return { type: "image_url", image_url: { url: String(url || "") } };
    }
    if (part?.type === "image_url") return part;
    return { type: "text", text: String(part?.text || "") };
  });
}

export function responsesInputToMessages(input: any, instructions?: string): any[] {
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
          function: { name: String(item.name || ""), arguments: String(item.arguments || "{}") },
        }],
      });
      continue;
    }
    if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id || item.id || "",
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
      });
      continue;
    }
    if (item.role) {
      messages.push({ role: item.role, content: textFromInputContent(item.content) });
    }
  }
  return messages;
}

export function responsesToChatBody(body: any): ChatBody {
  return {
    model: body.model || "deepseek-chat",
    messages: responsesInputToMessages(body.input, body.instructions),
    tools: Array.isArray(body.tools) ? body.tools : undefined,
    stream: body.stream === true,
    reasoning_effort: body.reasoning?.effort ?? body.reasoning_effort,
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

export function chatToResponses(chat: any, model: string): any {
  const message = chat?.choices?.[0]?.message || {};
  const text = String(message.content || "");
  const output: any[] = [];
  if (message.reasoning_content) {
    output.push({ id: responseId("rs"), type: "reasoning", summary: [], content: [], status: "completed" });
  }
  if (text) {
    output.push({
      id: responseId("msg"),
      type: "message",
      status: "completed",
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
      status: "completed",
    });
  }
  return {
    id: responseId(),
    object: "response",
    created_at: chat?.created || Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output,
    output_text: text,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: null,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: null,
    truncation: "disabled",
    usage: usageFromChat(chat),
    metadata: {},
  };
}

function sseEvent(type: string, sequence: number, payload: any): Uint8Array {
  return new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence, ...payload })}\n\n`);
}

export function chatStreamToResponsesStream(chatResponse: Response, model: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let sequence = 0;
      const id = responseId();
      const created = Math.floor(Date.now() / 1000);
      let text = "";
      let textItemId = "";
      const toolItems = new Map<number, { itemId: string; callId: string; name: string; args: string }>();
      const toolOutputIndices = new Map<number, number>();
      const toolOutputIndex = (index: number): number => {
        if (!toolOutputIndices.has(index)) toolOutputIndices.set(index, toolOutputIndices.size + (textItemId ? 1 : 0));
        return toolOutputIndices.get(index)!;
      };
      let usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
      const send = (type: string, payload: any) => controller.enqueue(sseEvent(type, sequence++, payload));
      const base = (status: string, output: any[] = [], finalUsage = usage) => ({
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
        controller.close();
        return;
      }
      const reader = chatResponse.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const handleData = (raw: string) => {
        if (!raw || raw === "[DONE]") return;
        let chunk: any;
        try { chunk = JSON.parse(raw); } catch { return; }
        if (chunk.usage) usage = usageFromChat(chunk);
        const delta = chunk.choices?.[0]?.delta || {};
        if (typeof delta.content === "string" && delta.content) {
          if (!textItemId) {
            textItemId = responseId("msg");
            send("response.output_item.added", {
              output_index: 0,
              item: { id: textItemId, type: "message", status: "in_progress", role: "assistant", content: [] },
            });
            send("response.content_part.added", {
              item_id: textItemId,
              output_index: 0,
              content_index: 0,
              part: { type: "output_text", text: "" },
            });
          }
          text += delta.content;
          send("response.output_text.delta", {
            item_id: textItemId,
            output_index: 0,
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
              item: { id: item.itemId, type: "function_call", call_id: item.callId, name: item.name, arguments: "", status: "in_progress" },
            });
          }
          const args = call.function?.arguments || "";
          item.args += args;
          if (args) send("response.function_call_arguments.delta", {
            item_id: item.itemId,
            output_index: toolOutputIndex(index),
            delta: args,
          });
        }
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
            if (line.startsWith("data:")) handleData(line.slice(5).trim());
          }
        }
        buffer += decoder.decode();
        if (buffer.startsWith("data:")) handleData(buffer.slice(5).trim());
        const output: any[] = [];
        if (text) {
          if (!textItemId) textItemId = responseId("msg");
          send("response.output_text.done", { item_id: textItemId, output_index: 0, content_index: 0, text });
          send("response.content_part.done", { item_id: textItemId, output_index: 0, content_index: 0, part: { type: "output_text", text } });
          output.push({ id: textItemId, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] });
        }
        for (const [index, item] of toolItems) {
          const outputIndex = toolOutputIndex(index);
          send("response.function_call_arguments.done", { item_id: item.itemId, output_index: outputIndex, arguments: item.args });
          output.push({ id: item.itemId, type: "function_call", call_id: item.callId, name: item.name, arguments: item.args, status: "completed" });
        }
        const response = { ...base("completed", output), output_text: text, reasoning: { effort: null, summary: null }, parallel_tool_calls: true, store: false, metadata: {} };
        send("response.completed", { response });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (error: any) {
        send("response.failed", { response: { ...base("failed"), error: { code: "upstream_stream_error", message: String(error?.message || error) } } });
      } finally {
        controller.close();
      }
    },
  });
}

export async function handleDeepseekResponses(request: Request, callChat: (body: any) => Promise<Response>): Promise<Response> {
  let body: any;
  try { body = await request.json(); }
  catch (error: any) {
    return new Response(JSON.stringify({ error: { message: "Invalid JSON", type: "invalid_request_error" } }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  const chatBody = responsesToChatBody(body);
  const chatResponse = await callChat(chatBody);
  if (!chatResponse.ok) return chatResponse;
  const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
  if (body.stream === true) {
    return new Response(chatStreamToResponsesStream(chatResponse, chatBody.model), {
      headers: { ...headers, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
    });
  }
  try {
    const chat = await chatResponse.json();
    return new Response(JSON.stringify(chatToResponses(chat, chatBody.model)), { headers });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: { message: String(error?.message || error), type: "upstream_error" } }), { status: 502, headers });
  }
}
