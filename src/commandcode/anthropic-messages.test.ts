import {
  anthropicMessagesToChat,
  chatResponseToAnthropic,
  openAiStreamToAnthropic,
} from "./anthropic-messages.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal<T>(actual: T, expected: T, message = ""): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      message ||
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("Anthropic Messages request converts text, images, and tools", () => {
  const result = anthropicMessagesToChat({
    model: "deepseek/test",
    max_tokens: 64,
    system: "be brief",
    messages: [
      { role: "user", content: [{ type: "text", text: "look" }] },
      {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "call_1",
          name: "read",
          input: { path: "a.txt" },
        }],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "call_1",
          content: [{ type: "text", text: "done" }],
        }],
      },
    ],
    tools: [{
      name: "read",
      description: "read a file",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" } },
      },
    }],
    tool_choice: { type: "auto" },
  });
  assert(result.ok, "valid Messages request was rejected");
  equal(result.body.model, "deepseek/test");
  equal(result.body.max_tokens, 64);
  equal(result.body.messages[0], { role: "system", content: "be brief" });
  equal(result.body.messages[2].role, "assistant");
  equal(result.body.messages[2].tool_calls[0].function.name, "read");
  equal(result.body.messages[3], {
    role: "tool",
    tool_call_id: "call_1",
    content: "done",
  });
  equal(result.body.tools[0].function.name, "read");
  equal(result.body.tool_choice, "auto");
});

Deno.test("Anthropic Messages request rejects unsupported stateless fields", () => {
  const missingTokens = anthropicMessagesToChat({
    model: "deepseek/test",
    messages: [{ role: "user", content: "hi" }],
  });
  equal(missingTokens.ok, false);
  // 2026-10-18：stop_sequences/thinking/top_k 不再被拒（Claude Code 每轮都带，
  // 硬拒等于整渠道不可用）。改为映射：stop_sequences → `stop`，top_k 透传，
  // thinking 剥掉。见同文件底部的映射断言。
  // 2026-10-18：tool_choice 的 any/tool 也不再拒绝（Claude Code 会发），
  // 改映射，见下面的映射断言。仍拒绝的只剩"非对象"与"未知的 type"。
  const badToolChoice = anthropicMessagesToChat({
    model: "deepseek/test",
    max_tokens: 10,
    messages: [{ role: "user", content: "hi" }],
    tool_choice: { type: "definitely-not-a-type" },
  });
  equal(badToolChoice.ok, false);
});

Deno.test("Anthropic stop_sequences/top_k map into the chat body instead of failing", () => {
  const result = anthropicMessagesToChat({
    model: "deepseek/test",
    max_tokens: 10,
    messages: [{ role: "user", content: "hi" }],
    stop_sequences: ["stop-a", "stop-b"],
    top_k: 40,
    thinking: { type: "enabled", budget_tokens: 2048 },
  });
  equal(result.ok, true);
  if (!result.ok) return;
  // stop_sequences 映射为 OpenAI 的 `stop`
  equal(result.body.stop, ["stop-a", "stop-b"]);
  // top_k 原样透传
  equal(result.body.top_k, 40);
  // thinking 被剥掉：不进 wire body（Anthropic 的思考开关由渠道 effort 机制表达）
  equal("thinking" in result.body, false);
});

Deno.test("Anthropic messages with foreign roles are downgraded, not rejected", () => {
  // 2026-10-18：Claude Code 的会话续接/转发链会在 messages 里混进
  // role:"system"/"tool"/"developer" 甚至缺 role 的条目，硬拒等于整轮 400。
  const result = anthropicMessagesToChat({
    model: "deepseek/test",
    max_tokens: 10,
    messages: [
      { role: "system", content: "injected system" },
      { role: "user", content: "hi" },
      { role: "tool", content: "tool output" },
      { role: "developer", content: "developer note" },
      { content: "no role at all" },
    ],
  });
  equal(result.ok, true);
  if (!result.ok) return;
  const msgs = result.body.messages as Array<Record<string, unknown>>;
  // system/developer 的内容都进了 system 层
  const sys = msgs.find((m) => m.role === "system") as { content: string };
  assert(
    typeof sys?.content === "string",
    "system message must exist with string content",
  );
  assert(
    sys.content.includes("injected system"),
    "injected system must survive",
  );
  assert(
    sys.content.includes("developer note"),
    "developer content must merge into system",
  );
  // tool 转成 user 文本
  const toolAsUser = msgs.find((m) =>
    m.role === "user" && String(m.content).includes("[Tool Result]")
  );
  assert(!!toolAsUser, "a foreign tool message must become user text");
  // 原 user 消息仍在
  assert(
    msgs.some((m) => m.role === "user" && m.content === "hi"),
    "the real user message must survive",
  );
});

Deno.test("Anthropic tool_choice any/tool map into the chat body instead of failing", () => {
  // Claude Code 会发 type:"any"（必须调工具）与 type:"tool"（指定工具）。
  const anyResult = anthropicMessagesToChat({
    model: "deepseek/test",
    max_tokens: 10,
    messages: [{ role: "user", content: "hi" }],
    tool_choice: { type: "any" },
  });
  equal(anyResult.ok, true);
  if (!anyResult.ok) return;
  equal(
    anyResult.body.tool_choice,
    "required",
    '"any" maps to OpenAI "required"',
  );

  const toolResult = anthropicMessagesToChat({
    model: "deepseek/test",
    max_tokens: 10,
    messages: [{ role: "user", content: "hi" }],
    tool_choice: { type: "tool", name: "read" },
  });
  equal(toolResult.ok, true);
  if (!toolResult.ok) return;
  equal(
    (toolResult.body.tool_choice as Record<string, unknown>).type,
    "function",
    '"tool" maps to the function shell',
  );
});

Deno.test("Anthropic messages that degrade to empty produce a diagnostic, not an upstream 400", () => {
  const result = anthropicMessagesToChat({
    model: "deepseek/test",
    max_tokens: 10,
    messages: [{ content: "no role at all" }],
  });
  equal(result.ok, false);
  if (result.ok) return;
  assert(
    result.message.includes("no usable messages"),
    `the error must name the empty-conversion problem; got: ${result.message}`,
  );
});

Deno.test("Chat response converts to Anthropic message with usage", () => {
  const message = chatResponseToAnthropic({
    id: "chatcmpl-1",
    model: "deepseek/test",
    choices: [{
      finish_reason: "tool_calls",
      message: {
        content: "answer",
        reasoning_content: "think",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "read", arguments: '{"path":"a"}' },
        }],
      },
    }],
    usage: { prompt_tokens: 7, completion_tokens: 3 },
  }, "deepseek/test");
  equal(message.type, "message");
  equal(message.stop_reason, "tool_use");
  equal(message.content[0], { type: "thinking", thinking: "think" });
  equal(message.content[1], { type: "text", text: "answer" });
  equal(message.content[2].type, "tool_use");
  equal(message.content[2].input, { path: "a" });
  equal(message.usage, { input_tokens: 7, output_tokens: 3 });
});

Deno.test("OpenAI SSE converts to Anthropic Messages SSE", async () => {
  const upstream = new Response(
    [
      'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{}"}}]},"finish_reason":"tool_calls"}],"usage":{"completion_tokens":4}}\n\n',
      "data: [DONE]\n\n",
    ].join(""),
    { status: 200 },
  );
  const response = openAiStreamToAnthropic(upstream, "deepseek/test");
  const text = await response.text();
  assert(text.includes("event: message_start"), "missing message_start");
  assert(text.includes("event: content_block_start"), "missing content block");
  assert(text.includes("input_json_delta"), "missing tool argument delta");
  assert(
    text.includes('"stop_reason":"tool_use"'),
    "tool stop reason was lost",
  );
  assert(text.includes("event: message_stop"), "missing message_stop");
});
