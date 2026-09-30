import {
  classifyResponseShape,
  classifyStreamFailure,
  inspectResponseBody,
  readInspectedText,
  replayResponse,
} from "./stream-normalizer.ts";

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

Deno.test("response shape classifier detects SSE without trusting headers", () => {
  equal(
    classifyResponseShape(new TextEncoder().encode('data: {"choices":[]}\n\n')),
    "sse",
  );
  equal(
    classifyResponseShape(new TextEncoder().encode('{"error":"nope"}')),
    "json",
  );
  equal(classifyResponseShape(new Uint8Array()), "empty");
  equal(
    classifyResponseShape(new TextEncoder().encode("plain text")),
    "unknown",
  );
});

Deno.test("body inspection replays every byte and corrects a lying header", async () => {
  const original = 'data: {"choices":[{"delta":{"content":"pong"}}]}\n\n' +
    "data: [DONE]\n\n";
  const response = new Response(original, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
  const inspected = await inspectResponseBody(response, 16);
  equal(inspected.shape, "sse");
  assert(inspected.head.length > 0, "inspection must read a prefix");
  const replayed = replayResponse(response, inspected, "text/event-stream");
  equal(replayed.headers.get("content-type"), "text/event-stream");
  equal(await replayed.text(), original);
});

Deno.test("inspection can be consumed as text after a partial read", async () => {
  const response = new Response('{"ok":true}', {
    headers: { "Content-Type": "text/event-stream" },
  });
  const inspected = await inspectResponseBody(response);
  equal(inspected.shape, "json");
  equal(await readInspectedText(inspected), '{"ok":true}');
});

Deno.test("body inspection has a bounded wait for a silent upstream", async () => {
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start() {/* deliberately never produces the first byte */},
    }),
  );
  const inspected = await inspectResponseBody(response, 16, 5);
  equal(inspected.timedOut, true);
  equal(await readInspectedText(inspected), "");
});

Deno.test("stream failure classification separates abort, timeout, cut, and transport", () => {
  const abort = new AbortController();
  abort.abort();
  equal(
    classifyStreamFailure(new Error("cancelled"), {
      abortedSignals: [abort.signal],
    }),
    "aborted",
  );
  equal(
    classifyStreamFailure(new DOMException("aborted", "AbortError")),
    "aborted",
  );
  equal(
    classifyStreamFailure(new DOMException("aborted", "AbortError"), {
      timeoutSignal: AbortSignal.abort(),
    }),
    "timeout",
  );
  equal(
    classifyStreamFailure(new Error("deadline"), {
      timeoutSignal: AbortSignal.abort(),
    }),
    "timeout",
  );
  equal(
    classifyStreamFailure(new Error("closed"), { deliveredOutput: true }),
    "stream_cut",
  );
  equal(classifyStreamFailure(new Error("socket reset")), "transport");
});
