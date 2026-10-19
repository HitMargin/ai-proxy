import {
  buildSummaryPrompt,
  compactIfNeeded,
  compactionState,
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

// ---------- 2026-10-19：降级截断必须按字节收敛 ----------
//
// 旧实现把参数当 token、内部再乘 0.6，于是调用方传进来的**字节预算**被当成
// token 用：420 万字节的中文历史估算成约 35 万 token，永远小于虚高的预算，
// 结果一条消息都不删、只多加 149 字节的说明。
// 生产日志里因此留下 `bytes 4121421 -> 4121570`（**变大**）与
// `bytes 4296416 -> 4296565`，而且每轮重复。
Deno.test("fallback truncation actually shrinks a body over the byte budget", () => {
  // 中文一字符三字节：构造一个明显超过预算的真实形态。
  const big = "长".repeat(20000); // ≈60000 字节
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: big },
    { role: "assistant", content: big },
    { role: "user", content: "最新问题" },
  ];
  const before = new TextEncoder().encode(JSON.stringify(messages)).length;
  const budget = 20000;
  assert(
    before > budget,
    `fixture must start over budget (${before} > ${budget})`,
  );

  const out = fallbackTruncate(messages, budget);
  const after = new TextEncoder().encode(JSON.stringify(out.messages)).length;

  // 判据一：必须真的变小，而且落到预算内。旧实现这里会 after > before。
  assert(
    after <= budget,
    `truncated body must fit the byte budget (got ${after}, budget ${budget})`,
  );
  // 判据二：最新的那条对话必须留下——截断是为了继续会话，不是为了清空。
  assertEqual(
    out.messages[out.messages.length - 1].content,
    "最新问题",
    "the newest turn must survive",
  );
  // 判据三：说明文字要在，且它本身计入预算（否则说明一次就超限）。
  assert(
    String(out.messages[0].content).startsWith("[context compaction]"),
    "the fallback must say that it truncated",
  );
});

// ★ 这条是上面那条的「单位哨兵」：旧 bug 的本质是把**字节**当 **token** 用。
// 只断言 after <= budget 抓不到它——因为旧式预算 `budget/4*0.6` 在数值上
// 恰好还是比 after 大，测试会假绿（我第一次就是这样，变异验证当场没红）。
// 真正的判别是**装进去的字节数**：按字节解释时能装下接近 budget 的内容，
// 按 token 解释时只能装 budget/4*0.6，差 6.7 倍。
Deno.test("fallback truncation fills the byte budget, not a token-derived one", () => {
  // 每条 900 字节左右的中文消息，堆到远超预算。
  const chunk = "中".repeat(300); // 900 字节
  const messages: any[] = [{ role: "system", content: "s" }];
  for (let i = 0; i < 200; i += 1) {
    messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: chunk });
  }
  const budget = 60000;
  const before = new TextEncoder().encode(JSON.stringify(messages)).length;
  assert(before > budget * 2, `fixture must be well over budget (${before})`);

  const out = fallbackTruncate(messages, budget);
  const after = new TextEncoder().encode(JSON.stringify(out.messages)).length;

  // 按字节解释：应装到接近 budget（>= 一半即说明没有按 1/6.7 打折）。
  // 按旧的 token 解释：预算仅 60000/4*0.6 = 9000 字节，只能装 10 条左右。
  assert(
    after >= budget * 0.5,
    `byte-based truncation should keep roughly the whole budget, got ${after} of ${budget}`,
  );
  assert(after <= budget, `and must not exceed it (got ${after})`);
});

Deno.test("fallback truncation says so when even the note does not fit", () => {
  // 预算小到连说明都装不下：不能假装成功，note 必须标出来。
  const messages = [{ role: "user", content: "x".repeat(5000) }];
  const out = fallbackTruncate(messages, 10);
  const after = new TextEncoder().encode(JSON.stringify(out.messages)).length;
  assert(
    out.note.includes("all messages dropped"),
    `an empty keep must be labelled, got ${JSON.stringify(out.note)}`,
  );
  assert(after > 10, "fixture: the note alone exceeds the tiny budget");
});

// ---------- 2026-10-19 第二次：截断必须把「非消息开销」也扣掉 ----------
//
// 第一次修好了单位（字节 vs token），但生产日志仍有
//   [compacted via truncation] bytes 1096888 -> 1018872 | WARNING: still over budget (921600B)
// 因为 budget 管的是**整个 body**，而函数只看得见 messages；差额是 model /
// max_tokens / tools 定义等固定开销。消息装到 92 万内，body 仍 101 万。
Deno.test("fallback truncation subtracts overhead that is not in the messages", () => {
  const chunk = "中".repeat(300); // 900 字节
  const messages: any[] = [];
  for (let i = 0; i < 200; i += 1) {
    messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: chunk });
  }
  const budget = 40000;
  // 上游真实形态：工具定义等固定开销占了 15 KB。
  const overhead = 15000;

  const withoutOverhead = fallbackTruncate(messages, budget);
  const withOverhead = fallbackTruncate(messages, budget, overhead);
  const sizeOf = (list: any[]) =>
    new TextEncoder().encode(JSON.stringify(list)).length;

  // 不扣开销时，消息可以用满 40K；扣了之后必须明显更少。
  assert(
    sizeOf(withOverhead.messages) < sizeOf(withoutOverhead.messages),
    "knowing the overhead must leave less room for messages",
  );
  // 判据：消息 + 开销必须落进 budget，而不是只有消息落进去。
  assert(
    sizeOf(withOverhead.messages) + overhead <= budget,
    `messages + overhead must fit the budget, got ${
      sizeOf(withOverhead.messages) + overhead
    } > ${budget}`,
  );
});

Deno.test("a failed summary carries its reason", async () => {
  resetCompactionStates();
  const messages = [
    { role: "user", content: "z".repeat(6000) },
    { role: "assistant", content: "final" },
  ];
  const result = await compactIfNeeded({
    messages,
    body: { messages },
    contextWindow: 900,
    maxOutputTokens: 90,
    sessionId: "ses_reason",
    config: { keepTokens: 20, buffer: 100, maxSummaryTokens: 32 },
    writeSummary: async () => {
      throw new Error("upstream said 413 BODY_TOO_LARGE");
    },
  });
  assertEqual(result.note, "summary-failed");
  // 没有原因时日志只有“summary generation failed”五个字，排查只能靠猜。
  assert(
    (result.error ?? "").includes("BODY_TOO_LARGE"),
    `the failure reason must survive, got ${JSON.stringify(result.error)}`,
  );
});

Deno.test("an empty summary is reported as empty, not as a generic failure", async () => {
  resetCompactionStates();
  const messages = [
    { role: "user", content: "z".repeat(6000) },
    { role: "assistant", content: "final" },
  ];
  const result = await compactIfNeeded({
    messages,
    body: { messages },
    contextWindow: 900,
    maxOutputTokens: 90,
    sessionId: "ses_empty",
    config: { keepTokens: 20, buffer: 100, maxSummaryTokens: 32 },
    writeSummary: async () => "   ",
  });
  assertEqual(result.note, "summary-failed");
  assertEqual(result.error, "summary response was empty");
});

Deno.test("compaction state is evicted once the table is full", async () => {
  resetCompactionStates();
  // 表上限 256。塞满之后再压一个新的键，最旧的必须被淘汰，否则就是泄漏。
  const big = "z".repeat(4000);
  for (let i = 0; i < 300; i += 1) {
    const messages = [
      { role: "user", content: big },
      { role: "assistant", content: "ok" },
    ];
    await compactIfNeeded({
      messages,
      body: { messages },
      contextWindow: 100,
      maxOutputTokens: 10,
      sessionId: `evict_${i}`,
      config: { keepTokens: 5, buffer: 10, maxSummaryTokens: 8 },
      writeSummary: async () => "summary",
    });
  }
  // 早期键应已被淘汰，近期的必须还在。
  assertEqual(
    compactionState("evict_0"),
    undefined,
    "the oldest key must be evicted once the table is full",
  );
  assert(
    compactionState("evict_299") !== undefined,
    "the newest key must survive eviction",
  );
});
