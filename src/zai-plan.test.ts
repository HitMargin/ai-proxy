import {
  aggregateAnthropicMessages,
  aggregateChunks,
  anthropicSseToOpenAiChunks,
  decryptZCodeValue,
  handleZaiPlan,
  imageBlockOf,
  resolveZaiPlanSession,
  toAnthropicBody,
  ZAI_PLAN_MODELS,
} from "./zai-plan.ts";
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";

// ---------- 凭据解密 ----------

async function encryptForTest(
  plain: string,
  secret: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const keyBytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)),
  );
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes as unknown as BufferSource,
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const full = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    cryptoKey,
    new TextEncoder().encode(plain),
  );
  const raw = new Uint8Array(full);
  const ct = raw.subarray(0, raw.length - 16);
  const tag = raw.subarray(raw.length - 16);
  const b64u = (b: Uint8Array) =>
    btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_")
      .replace(/=+$/, "");
  return `enc:v1:${b64u(iv)}.${b64u(tag)}.${b64u(ct)}`;
}

Deno.test("decryptZCodeValue round-trips the zcode credential format", async () => {
  const secret = "unit-test-secret";
  const cipher = await encryptForTest("a-token-value", secret);
  assertEquals(await decryptZCodeValue(cipher, secret), "a-token-value");
});

Deno.test("decryptZCodeValue passes plaintext through untouched", async () => {
  assertEquals(await decryptZCodeValue("plain-token", "s"), "plain-token");
});

Deno.test("decryptZCodeValue rejects a truncated ciphertext", async () => {
  let threw = false;
  try {
    await decryptZCodeValue("enc:v1:only.two", "s");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("zai-plan keeps the pinned catalog and fixed advertised subset", async () => {
  assertEquals(ZAI_PLAN_MODELS.map((model) => model.id), [
    "glm-5.3",
    "glm-5.3-flash",
    "glm-5.2",
    "glm-5.1",
    "glm-5",
    "glm-5-turbo",
    "glm-5v-turbo",
    "glm-4.7",
    "glm-4.6",
    "glm-4.6v",
    "glm-4.5-air",
  ]);

  const response = await handleZaiPlan(
    "/zai-plan/v1/models",
    new Request("http://proxy/zai-plan/v1/models"),
  );
  const body = await response.json() as { data: Array<{ id: string }> };
  assertEquals(body.data.map((model) => model.id), [
    "glm-5.3",
    "glm-5.3-flash",
  ]);
  const flash = body.data.find((model) => model.id === "glm-5.3-flash") as
    & { id: string }
    & Record<string, unknown>;
  assertEquals(flash?.context_window, 1000000);
  assertEquals(flash?.max_output_tokens, 128000);
  assertEquals(flash?.input_modalities, ["text", "image"]);
  assertEquals(
    (flash.reasoning_efforts as Array<{ id: string }> | undefined)
      ?.map((effort) => effort.id),
    ["low", "high", "max"],
  );
  assertEquals(
    flash.default_reasoning_effort,
    "max",
  );
  const glm53 = body.data.find((model) => model.id === "glm-5.3") as
    & { id: string }
    & Record<string, unknown>;
  assertEquals(glm53.context_window, 1000000);
  assertEquals(glm53.max_output_tokens, 128000);
  assertEquals(glm53.input_modalities, ["text"]);
  assertEquals(
    (glm53.reasoning_efforts as Array<{ id: string }> | undefined)
      ?.map((effort) => effort.id),
    ["low", "high", "max"],
  );
  assertEquals(glm53.default_reasoning_effort, "max");
});

Deno.test("zai-plan session headers win over per-request random ids", () => {
  const request = new Request("http://proxy/zai-plan/v1/chat/completions", {
    method: "POST",
    headers: { "x-session-id": "dsh-session-42" },
  });
  assertEquals(
    resolveZaiPlanSession(request, { metadata: { session_id: "body" } }),
    "dsh-session-42",
  );
});

function anthropicEventStream(
  events: Array<Record<string, unknown>>,
): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
  );
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function successfulAnthropicEvents(): Array<Record<string, unknown>> {
  return [
    {
      type: "message_start",
      message: {
        id: "msg_upstream",
        model: "glm-5.3-flash",
        usage: { input_tokens: 7 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "收到" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { input_tokens: 9, output_tokens: 3 },
    },
    { type: "message_stop" },
  ];
}

Deno.test("aggregateAnthropicMessages rebuilds a non-streaming message", async () => {
  const message = await aggregateAnthropicMessages(
    anthropicEventStream(successfulAnthropicEvents()),
    "glm-5.3-flash",
  );
  assertEquals(message.id, "msg_upstream");
  assertEquals(message.model, "glm-5.3-flash");
  assertEquals(message.stop_reason, "end_turn");
  assertEquals(message.usage, { input_tokens: 9, output_tokens: 3 });
  const content = message.content as Array<Record<string, unknown>>;
  assertEquals(content[0], { type: "text", text: "收到" });
});

Deno.test("aggregateAnthropicMessages rejects a stream without message_stop", async () => {
  const events = successfulAnthropicEvents().filter((event) =>
    event.type !== "message_stop"
  );
  await assertRejects(
    () =>
      aggregateAnthropicMessages(
        anthropicEventStream(events),
        "glm-5.3-flash",
      ),
    Error,
    "stream cut",
  );
});

Deno.test("zai-plan /messages preserves history metadata and forwards the session", async () => {
  let sent: { headers: Record<string, string>; body?: string } | undefined;
  const sender = async (options: {
    headers: Record<string, string>;
    body?: string;
  }) => {
    sent = options;
    return {
      status: 200,
      contentType: "text/event-stream",
      body: anthropicEventStream(successfulAnthropicEvents()),
    };
  };
  const request = new Request("http://proxy/zai-plan/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-session-id": "stable-session",
    },
    body: JSON.stringify({
      model: "glm-5.3-flash",
      max_tokens: 100,
      messages: [
        { role: "user", content: "第一轮" },
        { role: "assistant", content: "第一轮回答" },
        { role: "user", content: "第二轮" },
      ],
      stream: false,
    }),
  });
  const response = await handleZaiPlan(
    "/zai-plan/v1/messages",
    request,
    sender,
  );
  assertEquals(response.status, 200);
  assertEquals(sent?.headers["x-session-id"], "stable-session");
  const upstream = JSON.parse(String(sent?.body)) as Record<string, unknown>;
  assertEquals(upstream.stream, true);
  assertEquals(
    (upstream.messages as Array<Record<string, unknown>>).length,
    3,
  );
  const metadata = upstream.metadata as Record<string, unknown>;
  const userId = JSON.parse(String(metadata.user_id)) as Record<
    string,
    unknown
  >;
  assertEquals(userId.session_id, "stable-session");
  const message = await response.json() as Record<string, unknown>;
  assertEquals(message.type, "message");
  assertEquals(message.stop_reason, "end_turn");
});

Deno.test("zai-plan /responses converts input into a Responses result", async () => {
  let sent: { headers: Record<string, string>; body?: string } | undefined;
  const sender = async (options: {
    headers: Record<string, string>;
    body?: string;
  }) => {
    sent = options;
    return {
      status: 200,
      contentType: "text/event-stream",
      body: anthropicEventStream(successfulAnthropicEvents()),
    };
  };
  const request = new Request("http://proxy/zai-plan/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-session-id": "stable-session",
    },
    body: JSON.stringify({
      model: "glm-5.3-flash",
      input: [
        { role: "user", content: "第一轮" },
        { role: "assistant", content: "第一轮回答" },
        { role: "user", content: "第二轮" },
      ],
      stream: false,
    }),
  });
  const response = await handleZaiPlan(
    "/zai-plan/v1/responses",
    request,
    sender,
  );
  assertEquals(response.status, 200);
  assertEquals(sent?.headers["x-session-id"], "stable-session");
  const chatBody = JSON.parse(String(sent?.body)) as Record<string, unknown>;
  assertEquals(
    (chatBody.messages as Array<Record<string, unknown>>).length,
    3,
  );
  const result = await response.json() as Record<string, unknown>;
  assertEquals(result.object, "response");
  assertEquals(result.status, "completed");
  assertEquals(result.output_text, "收到");
  const usage = result.usage as Record<string, unknown>;
  assertEquals(usage.input_tokens, 9);
  assertEquals(usage.output_tokens, 3);
});

// ---------- OpenAI → Anthropic ----------

Deno.test("toAnthropicBody collects system into system and maps tools", () => {
  const body = toAnthropicBody(
    {
      messages: [
        { role: "system", content: "you are helpful" },
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "call_1",
            function: { name: "read_file", arguments: '{"path":"a.txt"}' },
          }],
        },
        { role: "tool", tool_call_id: "call_1", content: "file body" },
      ],
      max_tokens: 999,
      tools: [{
        type: "function",
        function: {
          name: "read_file",
          description: "reads",
          parameters: { type: "object", properties: {} },
        },
      }],
    },
    "device-123",
    "sess-1",
  );
  assertEquals(body.system, "you are helpful");
  assertEquals(body.model, "glm-5.3-flash");
  assertEquals(body.max_tokens, 999);
  assertEquals(body.stream, true);
  const messages = body.messages as Array<Record<string, unknown>>;
  assertEquals(messages.length, 3);
  assertEquals(
    (messages[1].content as Array<Record<string, unknown>>)[0].type,
    "tool_use",
  );
  const toolResult = (messages[2].content as Array<Record<string, unknown>>)[0];
  assertEquals(toolResult.type, "tool_result");
  assertEquals(toolResult.tool_use_id, "call_1");
  const tools = body.tools as Array<Record<string, unknown>>;
  assertEquals(tools.length, 1);
  assertEquals(tools[0].input_schema, { type: "object", properties: {} });
  const metadata = JSON.parse(
    (body.metadata as Record<string, string>).user_id,
  );
  assertEquals(metadata.device_id, "device-123");
  assertEquals(metadata.session_id, "sess-1");
});

Deno.test("toAnthropicBody merges parallel tool results into one user message", () => {
  const body = toAnthropicBody(
    {
      messages: [
        { role: "user", content: "跑两个工具" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "call_a", function: { name: "f1", arguments: "{}" } },
            { id: "call_b", function: { name: "f2", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_a", content: "结果A" },
        { role: "tool", tool_call_id: "call_b", content: "结果B" },
      ],
    },
    null,
    "s",
  );
  const messages = body.messages as Array<Record<string, unknown>>;
  // user → assistant(tool_use×2) → user(tool_result×2 合并一条)
  assertEquals(messages.length, 3);
  assertEquals(messages[2].role, "user");
  const blocks = messages[2].content as Array<Record<string, unknown>>;
  assertEquals(blocks.length, 2);
  assertEquals(blocks[0].type, "tool_result");
  assertEquals(blocks[0].tool_use_id, "call_a");
  assertEquals(blocks[1].tool_use_id, "call_b");
});

Deno.test("toAnthropicBody merges consecutive user messages", () => {
  const body = toAnthropicBody(
    {
      messages: [
        { role: "user", content: "第一句" },
        { role: "user", content: "第二句" },
        { role: "assistant", content: "答" },
      ],
    },
    null,
    "s",
  );
  const messages = body.messages as Array<Record<string, unknown>>;
  assertEquals(messages.length, 2);
  assertEquals(messages[0].role, "user");
  assertEquals(messages[1].role, "assistant");
  const blocks = messages[0].content as Array<Record<string, unknown>>;
  assertEquals(
    blocks.map((b) => b.text).join(""),
    "第一句第二句",
  );
});

Deno.test("toAnthropicBody forwards a model outside the advertised subset", () => {
  const body = toAnthropicBody(
    {
      model: "glm-5.2",
      messages: [{ role: "user", content: "转发我" }],
    },
    null,
    "session",
  );
  assertEquals(body.model, "glm-5.2");
});

Deno.test("toAnthropicBody clamps max_tokens and defaults it", () => {
  const noMax = toAnthropicBody({ messages: [] }, null, "s");
  assertEquals(noMax.max_tokens, 8192);
  const huge = toAnthropicBody(
    { messages: [], max_tokens: 99999999 },
    null,
    "s",
  );
  assertEquals(huge.max_tokens, 128000);
});

// ---------- Anthropic SSE → OpenAI chunks ----------

async function* sseOf(lines: string[]): AsyncGenerator<Uint8Array> {
  const text = lines.map((l) => `data: ${l}\n\n`).join("");
  yield new TextEncoder().encode(text);
}

Deno.test("anthropicSseToOpenAiChunks maps text, thinking and usage", async () => {
  const sse = sseOf([
    JSON.stringify({
      type: "message_start",
      message: { usage: { input_tokens: 10 } },
    }),
    JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "收到" },
    }),
    JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "嗯" },
    }),
    JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 5 },
    }),
  ]);
  const chunks: Array<Record<string, unknown>> = [];
  for await (
    const line of anthropicSseToOpenAiChunks(
      streamOf(sse),
      "glm-5.3-flash",
      1,
      "req",
    )
  ) {
    chunks.push(JSON.parse(line));
  }
  assertEquals(chunks.length, 4);
  assertEquals(
    (chunks[0].choices as Array<Record<string, unknown>>)[0].delta,
    { role: "assistant", content: "" },
  );
  assertEquals(
    (chunks[1].choices as Array<Record<string, unknown>>)[0].delta,
    { content: "收到" },
  );
  assertEquals(
    (chunks[2].choices as Array<Record<string, unknown>>)[0].delta,
    { reasoning_content: "嗯" },
  );
  const last = chunks[3];
  assertEquals(
    (last.choices as Array<Record<string, unknown>>)[0].finish_reason,
    "stop",
  );
  assertEquals(last.usage, { prompt_tokens: 10, completion_tokens: 5 });
});

Deno.test("anthropicSseToOpenAiChunks maps tool_use blocks into tool_calls deltas", async () => {
  const sse = sseOf([
    JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "tu_1", name: "read_file" },
    }),
    JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"path"' },
    }),
    JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
    }),
  ]);
  const chunks: Array<Record<string, unknown>> = [];
  for await (
    const line of anthropicSseToOpenAiChunks(
      streamOf(sse),
      "glm-5.3-flash",
      1,
      "req",
    )
  ) {
    chunks.push(JSON.parse(line));
  }
  const start = (chunks[0].choices as Array<Record<string, unknown>>)[0];
  const delta = start.delta as {
    tool_calls: Array<
      & { function: { name: string; arguments: string } }
      & Record<string, unknown>
    >;
  };
  assertEquals(delta.tool_calls[0].id, "tu_1");
  assertEquals(delta.tool_calls[0].function.name, "read_file");
  assertEquals(
    (chunks[1].choices as Array<Record<string, unknown>>)[0].delta,
    { tool_calls: [{ index: 0, function: { arguments: '{"path"' } }] },
  );
  assertEquals(
    (chunks[2].choices as Array<Record<string, unknown>>)[0].finish_reason,
    "tool_calls",
  );
});

Deno.test("anthropicSseToOpenAiChunks emits an error frame without finish_reason", async () => {
  const sse = sseOf([
    JSON.stringify({ type: "error", error: { message: "boom" } }),
  ]);
  const lines: string[] = [];
  for await (
    const line of anthropicSseToOpenAiChunks(
      streamOf(sse),
      "glm-5.3-flash",
      1,
      "req",
    )
  ) {
    lines.push(line);
  }
  assertEquals(lines.length, 1);
  const ev = JSON.parse(lines[0]);
  assertStringIncludes(ev.error.message, "boom");
});

Deno.test("anthropicSseToOpenAiChunks reports stream_cut instead of claiming finish", async () => {
  const sse = sseOf([
    JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "半句" },
    }),
  ]);
  const lines: string[] = [];
  for await (
    const line of anthropicSseToOpenAiChunks(
      streamOf(sse),
      "glm-5.3-flash",
      1,
      "req",
    )
  ) {
    lines.push(line);
  }
  const last = JSON.parse(lines[lines.length - 1]);
  assertEquals(last.error?.code, "stream_cut");
});

// ---------- 聚合 ----------

Deno.test("aggregateChunks rebuilds a non-stream completion", async () => {
  async function* chunks(): AsyncGenerator<string> {
    yield JSON.stringify({
      id: "r1",
      created: 1,
      choices: [{ index: 0, delta: { role: "assistant", content: "" } }],
    });
    yield JSON.stringify({
      choices: [{ index: 0, delta: { content: "收到" } }],
    });
    yield JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    });
  }
  const completion = await aggregateChunks(chunks(), "glm-5.2");
  assertEquals(completion.id, "r1");
  assertEquals(completion.model, "glm-5.2");
  const choice = (completion.choices as Array<Record<string, unknown>>)[0];
  const message = choice.message as Record<string, unknown>;
  assertEquals(message.content, "收到");
  assertEquals(choice.finish_reason, "stop");
  assertEquals(completion.usage, { prompt_tokens: 3, completion_tokens: 2 });
});

Deno.test("aggregateChunks throws on an error frame instead of faking success", async () => {
  async function* chunks(): AsyncGenerator<string> {
    yield JSON.stringify({ error: { message: "exceed quota limit" } });
  }
  let message = "";
  try {
    await aggregateChunks(chunks());
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  assertStringIncludes(message, "exceed quota limit");
});

function streamOf(gen: AsyncGenerator<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await gen.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
  });
}

// ---------- dechunk ----------

Deno.test("toAnthropicBody maps data-URL images into Anthropic image blocks", () => {
  const body = toAnthropicBody(
    {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "这是什么颜色？" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,AAAA" },
          },
          {
            type: "image_url",
            image_url: { url: "https://example.com/x.png" },
          },
        ],
      }],
    },
    null,
    "s",
  );
  const messages = body.messages as Array<Record<string, unknown>>;
  const content = messages[0].content as Array<Record<string, unknown>>;
  assertEquals(content.length, 2); // http URL 图片被忽略，data URL 被映射
  assertEquals(content[0].type, "text");
  assertEquals(content[1].type, "image");
  assertEquals(
    (content[1].source as Record<string, string>).media_type,
    "image/png",
  );
  assertEquals(
    (content[1].source as Record<string, string>).data,
    "AAAA",
  );
});

Deno.test("imageBlockOf rejects non-data URLs", () => {
  assertEquals(
    imageBlockOf({ type: "image_url", image_url: { url: "https://x/y.png" } }),
    null,
  );
  assertEquals(imageBlockOf({ type: "text" }), null);
});
