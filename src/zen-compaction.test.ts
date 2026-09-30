import {
  buildSummaryPrompt,
  compactIfNeeded,
  estimateTokens,
  fallbackTruncate,
  findExistingSummary,
  resetCompactionStates,
  selectTail,
  serializeMessage,
  SUMMARY_TEMPLATE,
} from "./zen-compaction.ts";

/** Narrow an optional so the compiler proves the value is present. */
function assertExists<T>(
  value: T | undefined,
  message: string,
): asserts value is T {
  if (value === undefined) throw new Error(message);
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message = ""): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) {
    throw new Error(message || `expected ${right}, got ${left}`);
  }
}

Deno.test("compaction token estimate matches OpenCode's 4-chars approximation", () => {
  assertEqual(estimateTokens("abcd"), 1);
  assertEqual(estimateTokens("abc"), 0);
  assertEqual(estimateTokens("x".repeat(400)), 100);
});

Deno.test("compaction serializes each role the way OpenCode does", () => {
  assertEqual(serializeMessage({ role: "user", content: "hi" }), "[User]: hi");
  assertEqual(
    serializeMessage({ role: "tool", content: [{ text: "output" }] }),
    "[Tool result]: output",
  );
  assertEqual(
    serializeMessage({
      role: "assistant",
      content: "ok",
      reasoning_content: "why",
    }),
    "[Assistant]: ok\n[Assistant reasoning]: why",
  );
  assertEqual(
    serializeMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ function: { name: "read", arguments: "{}" } }],
    }),
    "[Assistant tool call]: read({})",
  );
});

Deno.test("compaction truncates a long tool result", () => {
  const serialized = serializeMessage({
    role: "tool",
    content: "x".repeat(5000),
  });
  assert(
    serialized.endsWith("\n[truncated]"),
    "tool output should be marked truncated",
  );
  assert(
    serialized.length < 5000,
    "tool output should be shorter than the input",
  );
});

Deno.test("tail selection keeps the budget and splits the overflowing message", () => {
  const serialized = ["a".repeat(400), "b".repeat(400), "c".repeat(400)];
  const selection = selectTail(serialized, 50);
  assertExists(selection, "a budget should produce a selection");
  // The budget is walked from the tail: "c" is 100 tokens, so it overflows a
  // 50-token budget and only its last 200 characters (50 tokens) are kept
  // verbatim. Everything older, plus "c"'s head, goes to the summary side.
  assertEqual(selection.split, 3);
  assertEqual(selection.recent.length, 1);
  assertEqual(selection.recent[0], "c".repeat(200));
  assert(
    selection.head.at(-1) === "c".repeat(200),
    "the overflowing message should be split, not dropped whole",
  );
});

Deno.test("tail selection declines when nothing is left for history", () => {
  assertEqual(selectTail(["short"], 0), undefined);
  assertEqual(selectTail([], 100), undefined);
});

Deno.test("summary prompt carries the official template and the previous summary", () => {
  const fresh = buildSummaryPrompt("", ["history"]);
  assert(
    fresh.includes("Create a new anchored summary"),
    "a first compaction creates a summary",
  );
  assert(
    fresh.includes(SUMMARY_TEMPLATE),
    "the official template must be present verbatim",
  );
  assert(fresh.endsWith("history"), "history must follow the prompt");

  const updated = buildSummaryPrompt("prior summary text", ["history"]);
  assert(
    updated.includes("Update the anchored summary"),
    "a later compaction updates it",
  );
  assert(
    updated.includes("prior summary text"),
    "the previous summary must be carried",
  );
});

Deno.test("an existing summary in the transcript is reused", () => {
  const messages = [
    { role: "system", content: "[Conversation Summary]\nold work" },
    { role: "user", content: "next" },
  ];
  assertEqual(findExistingSummary(messages, 2), "old work");
  assertEqual(findExistingSummary(messages, 0), "");
});

Deno.test("compaction runs only past the threshold and rewrites the tail", async () => {
  resetCompactionStates();
  const messages = [
    { role: "system", content: "system prompt" },
    { role: "user", content: "a".repeat(4000) },
    { role: "assistant", content: "b".repeat(4000) },
    { role: "user", content: "c".repeat(4000) },
    { role: "assistant", content: "the most recent answer" },
  ];
  const input = { messages, body: { messages } };
  const result = await compactIfNeeded({
    messages: input.messages,
    body: input.body,
    contextWindow: 1000,
    maxOutputTokens: 100,
    sessionId: "ses_test",
    config: { keepTokens: 40, buffer: 200, maxSummaryTokens: 64 },
    writeSummary: async () => "## Objective\n- keep going",
  });
  assert(result.changed, "an oversized transcript should compact");
  assertEqual(result.note.includes("compacted via summary"), true);
  const rebuilt = input.messages;
  assertEqual(
    rebuilt[0].role,
    "system",
    "the system prompt must survive compaction",
  );
  assert(
    rebuilt.some((message: any) =>
      typeof message.content === "string" &&
      message.content.startsWith("[Conversation Summary]")
    ),
    "the anchored summary must be inserted",
  );
  assertEqual(
    rebuilt[rebuilt.length - 1].content,
    "the most recent answer",
    "the newest turn must be kept verbatim",
  );
});

Deno.test("compaction leaves a transcript that fits untouched", async () => {
  resetCompactionStates();
  const messages = [{ role: "user", content: "hi" }];
  const result = await compactIfNeeded({
    messages,
    body: { messages },
    contextWindow: 1_000_000,
    maxOutputTokens: 1000,
    sessionId: "ses_small",
    writeSummary: async () => {
      throw new Error("must not be called");
    },
  });
  assertEqual(result.changed, false);
  assertEqual(messages.length, 1, "the caller's array must not be replaced");
});

Deno.test("a second compaction updates the same summary instead of restarting", async () => {
  resetCompactionStates();
  const prompts: string[] = [];
  const build = (marker: string, size: number) => [
    { role: "system", content: "system" },
    ...Array.from({ length: 4 }, (_unused, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `${marker}${"x".repeat(size)}`,
    })),
  ];

  const first = build("one", 3000);
  await compactIfNeeded({
    messages: first,
    body: { messages: first },
    contextWindow: 800,
    maxOutputTokens: 80,
    sessionId: "ses_incremental",
    config: { keepTokens: 30, buffer: 100, maxSummaryTokens: 32 },
    writeSummary: async (prompt) => {
      prompts.push(prompt);
      return "summary-one";
    },
  });
  assert(
    prompts[0].includes("Create a new anchored summary"),
    "the first pass creates",
  );

  const second = [...first, { role: "user", content: `${"y".repeat(3000)}` }];
  await compactIfNeeded({
    messages: second,
    body: { messages: second },
    contextWindow: 800,
    maxOutputTokens: 80,
    sessionId: "ses_incremental",
    config: { keepTokens: 30, buffer: 100, maxSummaryTokens: 32 },
    writeSummary: async (prompt) => {
      prompts.push(prompt);
      return "summary-two";
    },
  });
  assert(
    prompts[1].includes("Update the anchored summary"),
    "the second pass updates",
  );
  assert(
    prompts[1].includes("summary-one"),
    "the previous summary must be carried forward",
  );
});

Deno.test("a failed summary call falls back to truncation", async () => {
  resetCompactionStates();
  const messages = [
    { role: "system", content: "system" },
    { role: "user", content: "z".repeat(6000) },
    { role: "assistant", content: "final" },
  ];
  const result = await compactIfNeeded({
    messages,
    body: { messages },
    contextWindow: 900,
    maxOutputTokens: 90,
    sessionId: "ses_fail",
    config: { keepTokens: 20, buffer: 100, maxSummaryTokens: 32 },
    writeSummary: async () => {
      throw new Error("upstream refused");
    },
  });
  assertEqual(result.changed, false);
  assertEqual(result.note, "summary-failed");

  const truncated = fallbackTruncate(messages, 900);
  assertEqual(truncated.changed, true);
  assert(
    truncated.messages[0].content.startsWith("[context compaction]"),
    "the fallback must say that it truncated",
  );
  assertEqual(
    truncated.messages[truncated.messages.length - 1].content,
    "final",
    "the newest turn must survive truncation",
  );
});
