import {
  aggregateChunks,
  anthropicSseToOpenAiChunks,
  decryptZCodeValue,
  toAnthropicBody,
} from "./zai-plan.ts";
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

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
  assertEquals((messages[1].content as Array<Record<string, unknown>>)[0].type, "tool_use");
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

Deno.test("toAnthropicBody clamps max_tokens and defaults it", () => {
  const noMax = toAnthropicBody({ messages: [] }, null, "s");
  assertEquals(noMax.max_tokens, 8192);
  const huge = toAnthropicBody({ messages: [], max_tokens: 99999999 }, null, "s");
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
  for await (const line of anthropicSseToOpenAiChunks(
    streamOf(sse),
    "glm-5.3-flash",
    1,
    "req",
  )) {
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
  for await (const line of anthropicSseToOpenAiChunks(
    streamOf(sse),
    "glm-5.3-flash",
    1,
    "req",
  )) {
    chunks.push(JSON.parse(line));
  }
  const start = (chunks[0].choices as Array<Record<string, unknown>>)[0];
  const delta = start.delta as {
    tool_calls: Array<{ function: { name: string; arguments: string } } & Record<string, unknown>>;
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
  for await (const line of anthropicSseToOpenAiChunks(
    streamOf(sse),
    "glm-5.3-flash",
    1,
    "req",
  )) {
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
  for await (const line of anthropicSseToOpenAiChunks(
    streamOf(sse),
    "glm-5.3-flash",
    1,
    "req",
  )) {
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
  const completion = await aggregateChunks(chunks());
  assertEquals(completion.id, "r1");
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
