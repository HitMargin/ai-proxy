import {
  applyZenFingerprint,
  collectChatStreamText,
  handleZen,
  mintZenRequestId,
  restoreChatStream,
  zenEndpointForModel,
  zenGatewayHeaders,
  zenSessionId,
} from "./zen.ts";
import { __setZenCatalogForTest, type ZenCatalogEntry } from "./zen-catalog.ts";

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

Deno.test("Zen fingerprint fills the quartet even with no client tools", () => {
  // The free tier answers "only from within OpenCode" unless the quartet is
  // present. Measured live: streaming without it is 403, so a request that
  // carries no client tools still needs the quartet to be admitted at all.
  const body: Record<string, unknown> = {
    model: "mimo-v2.6-flash-free",
    messages: [{ role: "user", content: "summarise this" }],
  };
  const map = applyZenFingerprint(body, false);
  const tools = body.tools as Array<
    { function?: { name?: string }; name?: string }
  >;
  const names = tools.map((tool) => String(tool.function?.name || tool.name));
  // Compared as a joined string: this suite's assertEquals uses Object.is, which
  // would compare array identity rather than contents.
  assertEquals(names.sort().join(","), "bash,glob,grep,read");
  // Nothing was promoted, so the response needs no renaming.
  assertEquals(map.size, 0);
  // And a request that brings no tools of its own must not invite a call.
  assertEquals(body.tool_choice, "none");
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

Deno.test("Zen streams chat with a promoted tool name end to end", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        ));
        controller.enqueue(encoder.encode(
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"bash","arguments":"{}"}}]}}]}\n\n',
        ));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  try {
    const request = new Request("http://local/zen/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mimo-v2.6-flash-free",
        messages: [{ role: "user", content: "ping" }],
        tools: [{
          type: "function",
          function: { name: "pwsh", parameters: { type: "object" } },
        }],
        stream: true,
      }),
    });
    const response = await handleZen(
      "/zen/v1/chat/completions",
      request,
      new URL(request.url),
    );
    const text = await response.text();
    assertStringIncludes(text, '"content":"hi"');
    assertStringIncludes(text, '"name":"pwsh"');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("Zen restores promoted tool names in a chat SSE stream", async () => {
  const encoder = new TextEncoder();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"bash","arguments":"{}"}}]}}]}\n\n' +
          "data: [DONE]\n\n",
      ));
      controller.close();
    },
  });
  const restored = await new Response(
    restoreChatStream(source, new Map([["bash", "Bash"]])),
  ).text();
  assertStringIncludes(restored, '"name":"Bash"');
});

Deno.test("Zen reassembles a summary out of streamed deltas", async () => {
  // The summary path streams because the gateway refuses non-streaming turns,
  // so the text has to be rebuilt from the frames before it can be used.
  const response = sseResponse([
    'data: {"choices":[{"delta":{"content":"## Objective"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"\\n- keep going"}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"bash","arguments":"{}"}}]}}]}\n\n',
    "data: [DONE]\n\n",
  ]);
  assertEquals(
    await collectChatStreamText(response),
    "## Objective\n- keep going",
  );
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

/** The local assertEquals is Object.is, so arrays and objects need this. */
function assertDeepEquals(actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`Expected ${b}, got ${a}`);
}

function assertNotEquals<T>(actual: T, expected: T): void {
  if (Object.is(actual, expected)) throw new Error("Values should differ");
}

// ---------- models.dev capability metadata ----------

function stubCatalog(entries: Record<string, any>): () => void {
  const index = new Map<string, ZenCatalogEntry>();
  for (const [id, value] of Object.entries(entries)) {
    index.set(id, {
      id,
      context: 0,
      output: 0,
      inputModalities: [],
      reasoning: false,
      efforts: [],
      toggleOnly: false,
      ...value,
    } as ZenCatalogEntry);
  }
  __setZenCatalogForTest(index);
  return () => __setZenCatalogForTest(null);
}

async function listZenModels(ids: string[]): Promise<any[]> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        object: "list",
        data: ids.map((id) => ({
          id,
          object: "model",
          created: 1,
          owned_by: "opencode",
        })),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  try {
    const response = await handleZen(
      "/zen/v1/models",
      new Request("http://local/zen/v1/models"),
      new URL("http://local/zen/v1/models"),
    );
    return (await response.json()).data;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

Deno.test("the model listing carries the catalog capabilities Zen omits", async () => {
  const restore = stubCatalog({
    "space-bunny-free": {
      context: 1048576,
      output: 524288,
      inputModalities: ["text", "image", "video"],
      reasoning: true,
      efforts: ["low", "medium", "high", "xhigh", "max"],
    },
  });
  try {
    const [row] = await listZenModels(["space-bunny-free"]);
    assertEquals(row.context_window, 1048576);
    assertEquals(row.max_output_tokens, 524288);
    assertDeepEquals(row.input_modalities, ["text", "image", "video"]);
    assertDeepEquals(
      row.reasoning_efforts.map((e: any) => e.id),
      ["low", "medium", "high", "xhigh", "max"],
    );
    assertEquals(row.reasoning_efforts[0].name, "low");
  } finally {
    restore();
  }
});

Deno.test("a model the catalog misses is returned exactly as Zen sent it", async () => {
  const restore = stubCatalog({});
  try {
    const [row] = await listZenModels(["jev-1.13-free"]);
    assertDeepEquals(row, {
      id: "jev-1.13-free",
      object: "model",
      created: 1,
      owned_by: "opencode",
    });
  } finally {
    restore();
  }
});

Deno.test("a toggle-only model gets no ladder and no invented off", async () => {
  const restore = stubCatalog({
    "longcat-2.5-preview-free": {
      context: 1000000,
      output: 131072,
      reasoning: true,
      toggleOnly: true,
    },
  });
  try {
    const [row] = await listZenModels(["longcat-2.5-preview-free"]);
    assertEquals(row.context_window, 1000000);
    assertEquals("reasoning_efforts" in row, false);
  } finally {
    restore();
  }
});
function assertStringIncludes(value: string, needle: string): void {
  if (!value.includes(needle)) {
    throw new Error(`Expected ${value} to include ${needle}`);
  }
}

/** Capture the body the proxy would send upstream for a Responses-shaped call. */
async function upstreamResponsesBody(
  model: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const originalFetch = globalThis.fetch;
  let seen: Record<string, unknown> = {};
  globalThis.fetch = (async (_input: unknown, init: RequestInit = {}) => {
    seen = JSON.parse(String(init.body || "{}"));
    return new Response(JSON.stringify({ output: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const request = new Request("http://local/zen/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "dsh-session",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "hi" }],
        ...body,
      }),
    });
    await handleZen("/zen/v1/responses", request, new URL(request.url));
    return seen;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

Deno.test("a published effort survives the Responses conversion", async () => {
  const restore = stubCatalog({
    "muse-spark-1.3-contributor-free": {
      reasoning: true,
      efforts: ["minimal", "low", "medium", "high", "xhigh"],
    },
  });
  try {
    const seen = await upstreamResponsesBody(
      "muse-spark-1.3-contributor-free",
      { reasoning_effort: "high" },
    );
    assertDeepEquals(seen.reasoning, { effort: "high" });
  } finally {
    restore();
  }
});

Deno.test("an effort the model never published is not sent upstream", async () => {
  const restore = stubCatalog({
    "muse-spark-1.3-contributor-free": {
      reasoning: true,
      efforts: ["minimal", "low", "medium", "high", "xhigh"],
    },
  });
  try {
    const seen = await upstreamResponsesBody(
      "muse-spark-1.3-contributor-free",
      { reasoning_effort: "max" },
    );
    assertEquals("reasoning" in seen, false);
  } finally {
    restore();
  }
});

Deno.test("an effort for a model the catalog missed is not invented", async () => {
  const restore = stubCatalog({});
  try {
    const seen = await upstreamResponsesBody(
      "muse-spark-9.9-contributor-free",
      { reasoning_effort: "high" },
    );
    assertEquals("reasoning" in seen, false);
  } finally {
    restore();
  }
});

Deno.test("no effort asked for means no reasoning key at all", async () => {
  const restore = stubCatalog({
    "muse-spark-1.3-contributor-free": {
      reasoning: true,
      efforts: ["minimal", "low", "medium", "high", "xhigh"],
    },
  });
  try {
    const seen = await upstreamResponsesBody(
      "muse-spark-1.3-contributor-free",
      {},
    );
    assertEquals("reasoning" in seen, false);
  } finally {
    restore();
  }
});

// ---------- upstream cut detection ----------

function sseText(frames: string[]): string {
  return frames.join("");
}

async function readAll(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let out = "";
  while (true) {
    const r = await reader.read();
    if (r.done) return out;
    out += dec.decode(r.value, { stream: true });
  }
}

function chunkStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(chunks[i++]));
    },
  });
}

function throwingStream(reason: unknown): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(
          enc.encode('data: {"choices":[{"delta":{"content":"half"}}]}\n\n'),
        );
        return;
      }
      controller.error(reason);
    },
  });
}

Deno.test("a chat stream that ends with [DONE] reports no cut", async () => {
  const body = chunkStream([
    'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
    "data: [DONE]\n\n",
  ]);
  const text = await readAll(restoreChatStream(body, new Map()));
  if (text.includes("stream_cut")) {
    throw new Error(`a completed stream was reported as cut: ${text}`);
  }
  if (!text.includes("[DONE]")) {
    throw new Error("the passthrough dropped [DONE]");
  }
});

Deno.test("a chat stream cut mid-answer is reported instead of a clean stop", async () => {
  const body = chunkStream([
    'data: {"choices":[{"delta":{"content":"the sentence stops "}}]}\n\n',
  ]);
  const text = await readAll(restoreChatStream(body, new Map()));
  const frame = text.split("\n\n").find((f) => f.includes("stream_cut"));
  if (!frame) throw new Error(`a cut stream was reported as complete: ${text}`);
  const payload = JSON.parse(frame.slice(5).trim());
  assertEquals(payload.error.code, "stream_cut");
  if (!payload.error.message.includes("after partial output")) {
    throw new Error(
      `the message should say output had been delivered: ${payload.error.message}`,
    );
  }
});

Deno.test("a reader that throws mid-stream is reported with its reason", async () => {
  const body = throwingStream(new Error("socket hang up"));
  const text = await readAll(restoreChatStream(body, new Map()));
  if (!text.includes("stream_cut")) {
    throw new Error(`a read failure was swallowed: ${text}`);
  }
  if (!text.includes("socket hang up")) {
    throw new Error(`the upstream reason was dropped: ${text}`);
  }
});

Deno.test("a cancellation is never reported as an upstream cut", async () => {
  // Two routes to the same verdict: the signal is aborted, and the reader
  // fails with an AbortError while the signal is still live. Either way the
  // client walked away and nothing about it is the gateway's fault.
  const aborted = new AbortController();
  aborted.abort();
  const viaSignal = await readAll(
    restoreChatStream(
      throwingStream(new Error("cancelled")),
      new Map(),
      [aborted.signal],
    ),
  );
  if (viaSignal.includes("stream_cut")) {
    throw new Error(`an aborted signal was reported as a fault: ${viaSignal}`);
  }
  const viaError = await readAll(
    restoreChatStream(
      throwingStream(new DOMException("cancelled", "AbortError")),
      new Map(),
      [new AbortController().signal],
    ),
  );
  if (viaError.includes("stream_cut")) {
    throw new Error(`an AbortError was reported as a fault: ${viaError}`);
  }
});

Deno.test("the Responses wire reports a cut when response.completed never arrives", async () => {
  const originalFetch = globalThis.fetch;
  const enc = new TextEncoder();
  let sent = false;
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream({
        pull(c) {
          if (!sent) {
            sent = true;
            c.enqueue(enc.encode(
              'data: {"type":"response.output_text.delta","delta":"partial"}' +
                "\n\n",
            ));
            return;
          }
          c.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as typeof fetch;
  try {
    const request = new Request("http://local/zen/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "dsh-session",
      },
      body: JSON.stringify({
        model: "muse-spark-1.3-contributor-free",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });
    const response = await handleZen(
      "/zen/v1/responses",
      request,
      new URL(request.url),
    );
    const text = response.body ? await readAll(response.body) : "";
    if (!text.includes("stream_cut")) {
      throw new Error(`a Responses cut was reported as complete: ${text}`);
    }
    if (!text.includes("response.completed")) {
      throw new Error(`the reason should name the missing frame: ${text}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("a client that advertises an old OpenCode version cannot downgrade the UA", () => {
  // Zen answers a stale client with 426 UpgradeRequired, so forwarding the
  // client's own opencode/ token let it pin the gateway to a version this proxy
  // does not speak.
  const stale = zenGatewayHeaders(
    new Request("http://zen.local/", {
      headers: { "user-agent": "some-client/2.0 opencode/1.1.55" },
    }),
    "ses_0123456789abZYXWVUT987654",
    "msg_0123456789abZYXWVUT987654",
    true,
  );
  const agent = stale.get("user-agent") || "";
  if (agent.includes("1.1.55")) {
    throw new Error(`the stale version survived: ${agent}`);
  }
  assertStringIncludes(agent, "some-client/2.0");
  assertStringIncludes(agent, "opencode/1.18.31");
});

Deno.test("a client with no opencode token still gets the client stamped on", () => {
  const headers = zenGatewayHeaders(
    new Request("http://zen.local/", {
      headers: { "user-agent": "curl/8.5.0" },
    }),
    "ses_0123456789abZYXWVUT987654",
    "msg_0123456789abZYXWVUT987654",
    true,
  );
  assertEquals(headers.get("user-agent"), "curl/8.5.0 opencode/1.18.31");
});
