import {
  applyZenFingerprint,
  handleZen,
  mintZenRequestId,
  zenEndpointForModel,
  zenGatewayHeaders,
  zenSessionId,
} from "./zen.ts";

function sseResponse(frames: string[]): Response {
  return new Response(frames.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

Deno.test("Zen session and request ids use canonical OpenCode shapes", async () => {
  const first = await zenSessionId("conversation-a");
  const second = await zenSessionId("conversation-a");
  const other = await zenSessionId("conversation-b");
  assertMatch(first, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assertEquals(first, second);
  assertNotEquals(first, other);
  assertMatch(mintZenRequestId(), /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
});

Deno.test("Zen headers carry the desktop fingerprint without the client token", () => {
  const request = new Request("http://local/zen/v1/chat/completions", {
    headers: {
      "user-agent": "dsh/test",
      authorization: "Bearer client-secret",
    },
  });
  const headers = zenGatewayHeaders(
    request,
    "ses_0123456789abZYXWVUT987654",
    "msg_0123456789abZYXWVUT987654",
    true,
  );
  assertEquals(headers.get("authorization"), "Bearer public");
  assertStringIncludes(headers.get("user-agent") || "", "opencode/1.");
  assertEquals(headers.get("x-opencode-client"), "desktop");
  assertEquals(headers.get("x-opencode-project"), "global");
  assertEquals(
    headers.get("x-opencode-session"),
    "ses_0123456789abZYXWVUT987654",
  );
  assertEquals(
    headers.get("x-opencode-request"),
    "msg_0123456789abZYXWVUT987654",
  );
  assertEquals(headers.get("authorization")?.includes("client-secret"), false);
});

Deno.test("Zen fingerprint promotes pwsh and fills the quartet", () => {
  const body: Record<string, unknown> = {
    model: "deepseek-v4-free",
    messages: [],
    tools: [{
      type: "function",
      function: { name: "pwsh", parameters: { type: "object" } },
    }],
  };
  const map = applyZenFingerprint(body, false);
  const tools = body.tools as Array<
    { function?: { name?: string }; name?: string }
  >;
  const names = tools.map((tool) => String(tool.function?.name || tool.name));
  assertEquals(new Set(names).size, names.length);
  assertEquals(names.includes("bash"), true);
  assertEquals(names.includes("glob"), true);
  assertEquals(names.includes("grep"), true);
  assertEquals(names.includes("read"), true);
  assertEquals(map.get("bash"), "pwsh");
});

Deno.test("Zen selects the model-specific upstream endpoint", () => {
  assertEquals(zenEndpointForModel("muse-spark-1.3-free"), "responses");
  assertEquals(zenEndpointForModel("union-alpha"), "messages");
  assertEquals(zenEndpointForModel("kilo-auto-free"), "chat");
});

Deno.test("Zen handler forwards fingerprint headers and quartet to chat", async () => {
  const originalFetch = globalThis.fetch;
  let seenUrl = "";
  let seenHeaders = new Headers();
  let seenBody: Record<string, unknown> = {};
  globalThis.fetch = async (input, init = {}) => {
    seenUrl = String(input);
    seenHeaders = new Headers(init.headers || {});
    seenBody = JSON.parse(String(init.body || "{}"));
    return new Response(
      JSON.stringify({
        id: "chatcmpl-1",
        model: "kilo-auto-free",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "pong" },
          finish_reason: "stop",
        }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const request = new Request("http://local/zen/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "dsh-session",
      },
      body: JSON.stringify({
        model: "kilo-auto-free",
        messages: [{ role: "user", content: "ping" }],
        tools: [{
          type: "function",
          function: { name: "pwsh", parameters: { type: "object" } },
        }],
        stream: false,
      }),
    });
    const response = await handleZen(
      "/zen/v1/chat/completions",
      request,
      new URL(request.url),
    );
    assertEquals(response.status, 200);
    assertEquals(seenUrl, "https://opencode.ai/zen/v1/chat/completions");
    assertEquals(seenHeaders.get("x-opencode-client"), "desktop");
    assertEquals(seenHeaders.get("authorization"), "Bearer public");
    assertEquals(
      seenHeaders.get("x-opencode-session")?.startsWith("ses_"),
      true,
    );
    const tools = seenBody.tools as Array<
      { function?: { name?: string }; name?: string }
    >;
    assertEquals(
      tools.map((tool) => tool.function?.name || tool.name).includes("bash"),
      true,
    );
    const payload = await response.json();
    assertEquals(payload.choices[0].message.content, "pong");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("Zen handler converts a Responses stream back to Chat Completions SSE", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    sseResponse([
      'data: {"type":"response.output_text.delta","delta":"hi"}\n\n',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":1}}}\n\n',
      "data: [DONE]\n\n",
    ]);
  try {
    const request = new Request("http://local/zen/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "muse-spark-1.3-free",
        messages: [{ role: "user", content: "ping" }],
        stream: true,
      }),
    });
    const response = await handleZen(
      "/zen/v1/chat/completions",
      request,
      new URL(request.url),
    );
    assertEquals(response.status, 200);
    const text = await response.text();
    assertStringIncludes(text, '"content":"hi"');
    assertStringIncludes(text, '"finish_reason":"stop"');
    assertStringIncludes(text, "[DONE]");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function assertMatch(value: string, pattern: RegExp): void {
  if (!pattern.test(value)) {
    throw new Error(`Expected ${value} to match ${pattern}`);
  }
}

function assertEquals<T>(actual: T, expected: T): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`Expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertNotEquals<T>(actual: T, expected: T): void {
  if (Object.is(actual, expected)) throw new Error("Values should differ");
}

function assertStringIncludes(value: string, needle: string): void {
  if (!value.includes(needle)) {
    throw new Error(`Expected ${value} to include ${needle}`);
  }
}
