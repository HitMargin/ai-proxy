import { ENV } from "../core.ts";
import {
  chatToResponses,
  handleDeepseekResponses,
  responsesToChatBody,
} from "../deepseek-responses.ts";
import { isGoModel, parseCatalog } from "./models.ts";
import { CommandCodeAccountPool } from "./pool.ts";
import {
  buildRequest,
  commandCodeSessionId,
  newStreamState,
  normalizeEvent,
  parseEventStream,
  usageSummary,
} from "./protocol.ts";
import { RequestStats } from "./request-stats.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal<T>(
  actual: T,
  expected: T,
  message = `expected ${JSON.stringify(expected)}, got ${
    JSON.stringify(actual)
  }`,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message);
  }
}

Deno.test("CommandCode model catalog uses plan overlay in both directions", () => {
  const markdown = [
    "| Id | Name | Context | Reasoning efforts | Price | Min plan | Best for |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    "| `openai/model` | Open | 1M | low, high | $1 | Go and above | test |",
    "| `google/gemini-x` | Gemini | 1M | high | $1 | GOAT and above | test |",
    "| `claude-x` | Claude | 1M | high | $1 | Max | test |",
  ].join("\n");
  const catalog = parseCatalog(markdown);
  equal(catalog.plans.get("openai/model"), true);
  equal(catalog.plans.get("google/gemini-x"), false);
  equal(catalog.efforts.get("openai/model"), ["low", "high"]);
  equal(
    isGoModel("google/gemini-x", catalog.plans),
    false,
    "GOAT must not match Go by prefix",
  );
  equal(
    isGoModel("brand-new-open-model", catalog.plans),
    true,
    "missing plan rows fall back to baseline",
  );
});

Deno.test("Responses max_output_tokens reaches the Chat gateway request", () => {
  const chat = responsesToChatBody({
    model: "openai/model",
    input: "hello",
    max_output_tokens: 1234,
  });
  equal(chat.max_tokens, 1234);
  equal(chat.messages, [{ role: "user", content: "hello" }]);
});

Deno.test("CommandCode handler translates Chat and Responses through a fake gateway", async () => {
  const previous = {
    key: ENV.COMMANDCODE_API_KEY,
    baseURL: ENV.COMMANDCODE_BASE_URL,
    accountsFile: ENV.COMMANDCODE_ACCOUNTS_FILE,
  };
  const previousFetch = globalThis.fetch;
  const previousDeployment = Deno.env.get("DENO_DEPLOYMENT_ID");
  ENV.COMMANDCODE_API_KEY = "handler-test-key";
  ENV.COMMANDCODE_BASE_URL = "https://fake.commandcode.test";
  ENV.COMMANDCODE_ACCOUNTS_FILE = "disabled-in-deploy-test";
  Deno.env.set("DENO_DEPLOYMENT_ID", "handler-test");
  globalThis.fetch = ((_input: URL | RequestInfo, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (headers.get("authorization") !== "Bearer handler-test-key") {
      throw new Error("missing CommandCode authorization");
    }
    if (!/^sess_[0-9a-f]{16}$/.test(headers.get("x-session-id") || "")) {
      throw new Error("invalid CommandCode session id");
    }
    const nl = String.fromCharCode(10);
    return Promise.resolve(
      new Response(
        [
          JSON.stringify({ type: "text-delta", text: "pong" }),
          JSON.stringify({
            type: "finish-step",
            finishReason: "stop",
            usage: { inputTokens: 8, outputTokens: 2 },
          }),
        ].join(nl) + nl,
        { status: 200 },
      ),
    );
  }) as unknown as typeof fetch;

  try {
    const { handleCommandCode } = await import("./handler.ts?handler-smoke");
    const chatRequest = new Request(
      "http://local/commandcode/v1/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/model",
          messages: [{ role: "user", content: "ping" }],
        }),
      },
    );
    const chatResponse = await handleCommandCode(
      "/commandcode/v1/chat/completions",
      chatRequest,
      new URL(chatRequest.url),
    );
    const chat = await chatResponse.json();
    equal(chat.choices?.[0]?.message?.content, "pong");

    const responsesRequest = new Request(
      "http://local/commandcode/v1/responses",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "openai/model", input: "ping" }),
      },
    );
    const responsesResponse = await handleCommandCode(
      "/commandcode/v1/responses",
      responsesRequest,
      new URL(responsesRequest.url),
    );
    const converted = await responsesResponse.json();
    equal(converted.output_text, "pong");
  } finally {
    globalThis.fetch = previousFetch;
    ENV.COMMANDCODE_API_KEY = previous.key;
    ENV.COMMANDCODE_BASE_URL = previous.baseURL;
    ENV.COMMANDCODE_ACCOUNTS_FILE = previous.accountsFile;
    if (previousDeployment === undefined) Deno.env.delete("DENO_DEPLOYMENT_ID");
    else Deno.env.set("DENO_DEPLOYMENT_ID", previousDeployment);
  }
});

Deno.test("CommandCode safely continues pause_turn before output", async () => {
  const previous = {
    key: ENV.COMMANDCODE_API_KEY,
    baseURL: ENV.COMMANDCODE_BASE_URL,
    accountsFile: ENV.COMMANDCODE_ACCOUNTS_FILE,
    maxPauseTurns: ENV.COMMANDCODE_MAX_PAUSE_TURNS,
  };
  const previousFetch = globalThis.fetch;
  const previousDeployment = Deno.env.get("DENO_DEPLOYMENT_ID");
  ENV.COMMANDCODE_API_KEY = "pause-test-key";
  ENV.COMMANDCODE_BASE_URL = "https://fake.commandcode.test";
  ENV.COMMANDCODE_ACCOUNTS_FILE = "disabled-in-deploy-test";
  ENV.COMMANDCODE_MAX_PAUSE_TURNS = "2";
  Deno.env.set("DENO_DEPLOYMENT_ID", "pause-test");
  let calls = 0;
  const sessions: string[] = [];
  globalThis.fetch = ((_input: URL | RequestInfo, init?: RequestInit) => {
    calls++;
    const headers = new Headers(init?.headers);
    sessions.push(headers.get("x-session-id") || "");
    const events = calls === 1
      ? [{ type: "finish-step", rawFinishReason: "pause_turn" }]
      : [
        { type: "text-delta", text: "continued" },
        { type: "finish-step", finishReason: "stop" },
      ];
    return Promise.resolve(
      new Response(
        events.map((event) => JSON.stringify(event)).join("\n") + "\n",
        { status: 200 },
      ),
    );
  }) as unknown as typeof fetch;

  try {
    const { handleCommandCode } = await import("./handler.ts?pause-test");
    const request = new Request(
      "http://local/commandcode/v1/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/model",
          messages: [{ role: "user", content: "pause" }],
        }),
      },
    );
    const response = await handleCommandCode(
      "/commandcode/v1/chat/completions",
      request,
      new URL(request.url),
    );
    const body = await response.json();
    equal(response.status, 200);
    equal(body.choices?.[0]?.message?.content, "continued");
    equal(calls, 2);
    equal(sessions[0], sessions[1]);
  } finally {
    globalThis.fetch = previousFetch;
    ENV.COMMANDCODE_API_KEY = previous.key;
    ENV.COMMANDCODE_BASE_URL = previous.baseURL;
    ENV.COMMANDCODE_ACCOUNTS_FILE = previous.accountsFile;
    ENV.COMMANDCODE_MAX_PAUSE_TURNS = previous.maxPauseTurns;
    if (previousDeployment === undefined) Deno.env.delete("DENO_DEPLOYMENT_ID");
    else Deno.env.set("DENO_DEPLOYMENT_ID", previousDeployment);
  }
});

Deno.test("CommandCode request keeps only tool calls with matching results", async () => {
  const envelope = await buildRequest({
    model: "openai/model",
    reasoning_effort: "high",
    messages: [
      { role: "system", content: "system prompt" },
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,AA==" },
          },
        ],
      },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_ok",
            type: "function",
            function: { name: "ok", arguments: '{"x":1}' },
          },
          {
            id: "call_orphan",
            type: "function",
            function: { name: "orphan", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_ok", content: "done" },
      {
        role: "tool",
        tool_call_id: "call_missing",
        content: [{
          type: "image_url",
          image_url: { url: "data:image/png;base64,BB==" },
        }],
      },
    ],
    tools: [{
      type: "function",
      function: { name: "ok", parameters: { type: "object" } },
    }],
  });
  equal(envelope.params.system, "system prompt");
  equal(envelope.params.reasoning_effort, "high");
  equal(envelope.params.tools[0].name, "ok");
  const serialized = JSON.stringify(envelope.params.messages);
  assert(
    serialized.includes("call_ok"),
    "matched tool call/result disappeared",
  );
  assert(
    !serialized.includes("call_orphan"),
    "orphan tool call was not removed",
  );
  assert(
    serialized.includes("data:image/png;base64,AA=="),
    "data image was not preserved",
  );
  assert(
    !serialized.includes("data:image/png;base64,BB=="),
    "image from an orphan tool result was not removed",
  );
});

Deno.test("CommandCode does not fetch remote images unless explicitly enabled", async () => {
  const envelope = await buildRequest({
    model: "openai/model",
    messages: [{
      role: "user",
      content: [{
        type: "image_url",
        image_url: { url: "http://127.0.0.1/private.png" },
      }],
    }],
  });
  const serialized = JSON.stringify(envelope.params.messages);
  assert(
    !serialized.includes("private.png"),
    "remote image URL was fetched by default",
  );
  assert(
    serialized.includes("image omitted"),
    "disabled remote image lacked a placeholder",
  );
});

Deno.test("CommandCode session id is stable, distinct, and CLI-shaped", async () => {
  const a1 = await commandCodeSessionId("conversation-a");
  const a2 = await commandCodeSessionId("conversation-a");
  const b = await commandCodeSessionId("conversation-b");
  const oneShot1 = await commandCodeSessionId();
  const oneShot2 = await commandCodeSessionId();
  assert(/^sess_[0-9a-f]{16}$/.test(a1), `invalid session id: ${a1}`);
  equal(a1, a2);
  assert(a1 !== b, "different conversations received the same session id");
  assert(oneShot1 !== oneShot2, "one-shot requests shared a session id");
});

Deno.test("CommandCode NDJSON parser handles split chunks and normalizes events", async () => {
  const encoder = new TextEncoder();
  const source = [
    '{"type":"text-start"}\n',
    '{"type":"text-delta","text":"hel',
    'lo"}\n{"type":"tool-call","id":"x","toolName":"f","input":{"a":1}}\n',
    '{"type":"finish-step","finishReason":"tool_calls","usage":{"inputTokens":10,',
    '"outputTokens":3,"inputTokenDetails":{"noCacheTokens":7,"cacheReadTokens":3}}}\n',
  ].join("");
  const bytes = encoder.encode(source);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, 17));
      controller.enqueue(bytes.slice(17, 61));
      controller.enqueue(bytes.slice(61));
      controller.close();
    },
  });
  const events = [];
  for await (const event of parseEventStream(stream)) events.push(event);
  equal(events.length, 4);
  const state = newStreamState();
  const normalized = events.flatMap((event) => normalizeEvent(event, state));
  equal(normalized.map((event) => event.type), ["text", "tool_call", "finish"]);
  const finish = normalized[2];
  assert(
    finish.type === "finish" && finish.reason === "tool_calls",
    "tool finish reason was lost",
  );
  equal(finish.usage, { inputTokens: 7, outputTokens: 3, cacheReadTokens: 3 });

  const truncatedState = newStreamState();
  normalizeEvent(
    { type: "tool-call", toolName: "f", input: {} },
    truncatedState,
  );
  const truncated = normalizeEvent({
    type: "finish-step",
    finishReason: "stop",
    rawFinishReason: "max_tokens",
  }, truncatedState);
  equal(
    truncated[0]?.type === "finish" ? truncated[0].reason : undefined,
    "length",
  );
});

Deno.test("CommandCode usage keeps cache fields absent when gateway omits them", () => {
  equal(
    usageSummary({
      type: "finish",
      usage: { inputTokens: 5, outputTokens: 2 },
    }),
    {
      inputTokens: 5,
      outputTokens: 2,
    },
  );
});

Deno.test("CommandCode env account never leaks its key in public status", async () => {
  const pool = new CommandCodeAccountPool("", "secret-command-code-key");
  const account = await pool.pick();
  assert(
    account?.apiKey === "secret-command-code-key",
    "env fallback key was not selected",
  );
  const visible = await pool.list();
  equal(visible[0].source, "env");
  assert(!Object.hasOwn(visible[0], "apiKey"), "public account leaked apiKey");
});

Deno.test("CommandCode account pool rotates and cools without exposing keys", async () => {
  const pool = new CommandCodeAccountPool("", "");
  const first = await pool.add({
    apiKey: "key-one",
    userId: "user-alice",
    userName: "Alice",
  });
  const second = await pool.add({ apiKey: "key-two", userName: "Bob" });
  equal((await pool.pick())?.id, first.id);
  equal((await pool.pick())?.id, second.id);
  await pool.reportFailure(first, "rate limited");
  assert(
    (first.cooldownUntil ?? 0) > Date.now(),
    "failed account was not cooled",
  );
  equal(await pool.activeCount(), 1);
  const replaced = await pool.add({
    apiKey: "key-one-new",
    userId: "user-alice",
    userName: "Alice",
  });
  equal(replaced.id, first.id);
  equal((await pool.findById(first.id))?.apiKey, "key-one-new");
  const visible = await pool.list();
  assert(
    visible.every((account) => !Object.hasOwn(account, "apiKey")),
    "pool status leaked a key",
  );
});

Deno.test("CommandCode request stats expose only a short session label", () => {
  const stats = new RequestStats();
  const sessionId = "very-private-conversation-id";
  stats.record({
    sessionId,
    model: "openai/model",
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 8,
    at: Date.now(),
  });
  const view = stats.view(sessionId);
  equal(view.current?.label.length, 8);
  assert(
    !JSON.stringify(view).includes(sessionId),
    "full session id leaked in request stats",
  );
  equal(view.current?.cacheReportedRequests, 1);
});

Deno.test("CommandCode prefers total usage and includes reasoning output", () => {
  equal(
    usageSummary({
      type: "finish",
      usage: { inputTokens: 2, outputTokens: 1 },
      totalUsage: {
        inputTokens: 10,
        outputTokens: 4,
        outputTokenDetails: { textTokens: 2, reasoningTokens: 2 },
        inputTokenDetails: { cacheWriteTokens: 3 },
      },
    }),
    {
      inputTokens: 10,
      outputTokens: 4,
      cacheWriteTokens: 3,
      reasoningTokens: 2,
    },
  );
  equal(
    usageSummary({
      type: "finish",
      usage: {
        inputTokens: 3,
        outputTokenDetails: { textTokens: 2, reasoningTokens: 1 },
      },
    }),
    { inputTokens: 3, outputTokens: 3, reasoningTokens: 1 },
  );
});

Deno.test("CommandCode clamps requested output tokens at the configured cap", async () => {
  const envelope = await buildRequest({
    model: "openai/model",
    max_tokens: 9000,
    messages: [{ role: "user", content: "x" }],
  }, { maxOutputTokens: 128 });
  equal(envelope.params.max_tokens, 128);
});

Deno.test("CommandCode rejects unsupported pause_turn without replaying the request", () => {
  const normalized = normalizeEvent({
    type: "finish-step",
    rawFinishReason: "pause_turn",
  }, newStreamState());
  equal(normalized, [{ type: "continue" }]);
});

Deno.test("Responses maps length completion to incomplete", () => {
  const response = chatToResponses(
    {
      choices: [{ finish_reason: "length", message: { content: "partial" } }],
    },
    "test-model",
    { max_output_tokens: 8 },
  );
  equal(response.status, "incomplete");
  equal(response.incomplete_details, { reason: "max_output_tokens" });
  equal(response.output[0].status, "incomplete");
});

Deno.test("Responses rejects unsupported continuation fields", async () => {
  const response = await handleDeepseekResponses(
    new Request("http://local/v1/responses", {
      method: "POST",
      body: JSON.stringify({
        model: "test",
        input: "x",
        previous_response_id: "r1",
      }),
    }),
    () => Promise.resolve(new Response("{}", { status: 200 })),
    1024 * 1024,
    true,
  );
  equal(response.status, 400);
});

Deno.test("CommandCode management rejects Host spoofing on deployment runtime", async () => {
  const previousDeployment = Deno.env.get("DENO_DEPLOYMENT_ID");
  const previousAdmin = ENV.COMMANDCODE_ADMIN_KEY;
  Deno.env.set("DENO_DEPLOYMENT_ID", "management-test");
  ENV.COMMANDCODE_ADMIN_KEY = "";
  try {
    const { handleCommandCode } = await import("./handler.ts?management-test");
    const request = new Request("http://localhost/commandcode/v1/status");
    const response = await handleCommandCode(
      "/commandcode/v1/status",
      request,
      new URL(request.url),
    );
    equal(response.status, 403);
  } finally {
    ENV.COMMANDCODE_ADMIN_KEY = previousAdmin;
    if (previousDeployment === undefined) Deno.env.delete("DENO_DEPLOYMENT_ID");
    else Deno.env.set("DENO_DEPLOYMENT_ID", previousDeployment);
  }
});

Deno.test("Responses stream emits incomplete and done events", async () => {
  const upstream = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode([
          `data: ${
            JSON.stringify({
              choices: [{ delta: { content: "partial" } }],
            })
          }`,
          `data: ${
            JSON.stringify({
              choices: [{ delta: {}, finish_reason: "length" }],
            })
          }`,
          "data: [DONE]",
        ].join("\n\n")));
        controller.close();
      },
    }),
  );
  const response = await handleDeepseekResponses(
    new Request("http://local/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "test", input: "x", stream: true }),
    }),
    () => Promise.resolve(upstream),
    1024 * 1024,
    true,
  );
  const text = await response.text();
  assert(
    text.includes("event: response.incomplete"),
    "missing response.incomplete",
  );
  assert(
    text.includes("event: response.output_item.done"),
    "missing output item done",
  );
  assert(text.includes("data: [DONE]"), "missing Responses DONE frame");
});

Deno.test("CommandCode direct requests enforce body size limits", async () => {
  const previous = ENV.COMMANDCODE_MAX_BODY_BYTES;
  ENV.COMMANDCODE_MAX_BODY_BYTES = "1024";
  try {
    const { handleCommandCode } = await import("./handler.ts?body-limit-test");
    const request = new Request(
      "http://local/commandcode/v1/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({
          model: "openai/model",
          messages: [{ role: "user", content: "x".repeat(2048) }],
        }),
      },
    );
    const response = await handleCommandCode(
      "/commandcode/v1/chat/completions",
      request,
      new URL(request.url),
    );
    equal(response.status, 413);
  } finally {
    ENV.COMMANDCODE_MAX_BODY_BYTES = previous;
  }
});

Deno.test("Responses stream converts upstream HTTP errors to response.failed", async () => {
  const response = await handleDeepseekResponses(
    new Request("http://local/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "test", input: "x", stream: true }),
    }),
    () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: { code: "rate_limit_exceeded", message: "busy" },
          }),
          { status: 429, headers: { "Retry-After": "7" } },
        ),
      ),
    1024 * 1024,
    true,
  );
  equal(response.status, 200);
  equal(response.headers.get("Retry-After"), "7");
  const text = await response.text();
  assert(text.includes("event: response.failed"), "missing response.failed");
  assert(text.includes("data: [DONE]"), "missing error DONE frame");
});
