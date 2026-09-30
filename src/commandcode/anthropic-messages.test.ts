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
  const unsupported = anthropicMessagesToChat({
    model: "deepseek/test",
    max_tokens: 10,
    messages: [{ role: "user", content: "hi" }],
    stop_sequences: ["stop"],
  });
  equal(unsupported.ok, false);
  const toolChoice = anthropicMessagesToChat({
    model: "deepseek/test",
    max_tokens: 10,
    messages: [{ role: "user", content: "hi" }],
    tool_choice: { type: "any" },
  });
  equal(toolChoice.ok, false);
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
