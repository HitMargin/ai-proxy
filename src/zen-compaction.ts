// deno-lint-ignore-file no-explicit-any
// Session compaction for the Zen free tier.
//
// Long tool-heavy sessions eventually exceed the model's context, and the
// free tier refuses rather than truncating. This reproduces OpenCode's
// official session compaction: keep a bounded tail of the conversation
// verbatim, summarise everything older into an anchored summary, and continue
// from `[summary] + tail` so the next compaction updates the same summary
// instead of restarting it.
//
// Ported from YuJunZhiXue/Cline-proxy (internal/app/compact.go), which itself
// ports OpenCode's `session/compaction.ts`. Kept behaviour-compatible on
// purpose: the template text, the 4-chars-per-token estimate and the
// prefix/suffix split are all part of the upstream contract.

const SUMMARY_OUTPUT_TOKENS = 4096;
const TOOL_OUTPUT_MAX_CHARS = 2000;
const SUMMARY_PREFIX = "[Conversation Summary]";
const PREVIOUS_SUMMARY_PREFIX = "[Previous Conversation Summary]";

/** OpenCode's official SUMMARY_TEMPLATE, verbatim. */
export const SUMMARY_TEMPLATE =
  `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Important Details
- [constraints/preferences, decisions and why, important facts/assumptions, exact context needed to continue, or "(none)"]

## Work State
### Completed
- [finished work, verified facts, or changes made; otherwise "(none)"]

### Active
- [current work, partial changes, or investigation state; otherwise "(none)"]

### Blocked
- [blockers, failing commands, or unknowns; otherwise "(none)"]

## Next Move
1. [immediate concrete action, or "(none)"]
2. [next action if known, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers when known.
- Do not mention the summary process or that context was compacted.`;

export interface CompactionConfig {
  enabled: boolean;
  /** Tail budget kept verbatim, in tokens. */
  keepTokens: number;
  /** Headroom reserved for the model output when deciding to compact. */
  buffer: number;
  /** Ceiling for the generated summary, in tokens. */
  maxSummaryTokens: number;
  /** Model asked to write the summary; defaults to the request's own model. */
  summaryModel: string;
}

export const DEFAULT_COMPACTION: CompactionConfig = {
  enabled: true,
  keepTokens: 8000,
  buffer: 20000,
  maxSummaryTokens: SUMMARY_OUTPUT_TOKENS,
  summaryModel: "",
};

export interface CompactionState {
  summary: string;
  recent: string;
  updatedAt: number;
}

export interface CompactionOutcome {
  changed: boolean;
  /** Machine-readable marker surfaced in logs and the panel. */
  note: string;
  /** Estimated tokens the summary step itself cost. */
  compactTokens: number;
  messages: any[];
}

type Json = Record<string, any>;

/**
 * OpenCode's token approximation: JSON length over four.
 *
 * Deliberately the same crude estimate upstream uses. A real tokenizer would
 * disagree with the server's own accounting and either compact far too early
 * or not at all.
 */
export function estimateTokens(text: string): number {
  return [...text].length / 4 | 0;
}

export function estimateJsonTokens(value: unknown): number {
  try {
    return JSON.stringify(value).length / 4 | 0;
  } catch {
    return 0;
  }
}

function messageText(message: Json): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((
        block,
      ) => (block && typeof block === "object" ? block.text : undefined))
      .filter((text): text is string => typeof text === "string")
      .join("\n");
  }
  return "";
}

function truncateToolOutput(text: string): string {
  if (text.length <= TOOL_OUTPUT_MAX_CHARS) return text;
  return `${text.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`;
}

/** One message to one line, matching OpenCode's serialization. */
export function serializeMessage(message: Json): string {
  switch (message?.role) {
    case "user":
      return `[User]: ${messageText(message)}`;
    case "system":
      return `[System update]: ${messageText(message)}`;
    case "tool":
      return `[Tool result]: ${truncateToolOutput(messageText(message))}`;
    case "assistant": {
      const lines: string[] = [];
      const text = messageText(message);
      if (text !== "") lines.push(`[Assistant]: ${text}`);
      const reasoning = message?.reasoning_content;
      if (typeof reasoning === "string" && reasoning !== "") {
        lines.push(`[Assistant reasoning]: ${reasoning}`);
      }
      if (Array.isArray(message?.tool_calls)) {
        for (const call of message.tool_calls) {
          const fn = call?.function;
          if (!fn || typeof fn.name !== "string" || fn.name === "") continue;
          lines.push(
            `[Assistant tool call]: ${fn.name}(${String(fn.arguments ?? "")})`,
          );
        }
      }
      return lines.join("\n");
    }
    default:
      return "";
  }
}

export interface TailSelection {
  /** Older turns, to be summarised. */
  head: string[];
  /** Turns kept verbatim. */
  recent: string[];
  /** Index into the original message array where the tail begins. */
  split: number;
}

/**
 * Walk backwards accumulating a token budget.
 *
 * The message that overflows the budget is split rather than dropped whole:
 * its head joins the summarised side and its tail joins the verbatim side, so
 * a long tool result does not push the entire last turn out of the window.
 */
export function selectTail(
  serialized: readonly string[],
  keepTokens: number,
): TailSelection | undefined {
  if (serialized.length === 0 || keepTokens <= 0) return undefined;
  let total = 0;
  let split = serialized.length;
  let splitPrefix = "";
  let splitSuffix = "";
  for (let i = serialized.length - 1; i >= 0; i -= 1) {
    const next = total + estimateTokens(serialized[i]);
    if (next > keepTokens) {
      const remaining = keepTokens - total;
      if (remaining > 0) {
        const remainingChars = remaining * 4;
        const source = serialized[i];
        if (remainingChars <= 0) {
          split = i + 1;
        } else if (source.length > remainingChars) {
          splitPrefix = source.slice(0, source.length - remainingChars);
          splitSuffix = source.slice(source.length - remainingChars);
        } else {
          splitSuffix = source;
        }
        split = i + 1;
      }
      break;
    }
    total = next;
    split = i;
  }
  if (split === 0) return undefined;
  const head = [...serialized.slice(0, split)];
  if (splitPrefix !== "") head.push(splitPrefix);
  const recent = splitSuffix !== "" ? [splitSuffix] : [];
  recent.push(...serialized.slice(split));
  return { head, recent, split };
}

export function buildSummaryPrompt(
  previousSummary: string,
  context: readonly string[],
): string {
  const prefix = previousSummary !== ""
    ? "Update the anchored summary below using the conversation history above.\n" +
      "Preserve still-true details, remove stale details, and merge in the new facts.\n" +
      `<previous-summary>\n${previousSummary}\n</previous-summary>`
    : "Create a new anchored summary from the conversation history.";
  return [prefix, SUMMARY_TEMPLATE, ...context].join("\n\n");
}

/** Recover a summary a client already put in the transcript. */
export function findExistingSummary(
  messages: readonly any[],
  upTo: number,
): string {
  const limit = Math.min(Math.max(upTo, 0), messages.length);
  for (let i = 0; i < limit; i += 1) {
    const message = messages[i];
    if (!message || typeof message !== "object") continue;
    const content = typeof message.content === "string" ? message.content : "";
    for (const prefix of [SUMMARY_PREFIX, PREVIOUS_SUMMARY_PREFIX]) {
      if (content.startsWith(prefix)) {
        return content.slice(prefix.length).trim();
      }
    }
  }
  return "";
}

export type SummaryWriter = (
  prompt: string,
  model: string,
  maxTokens: number,
) => Promise<string>;

const states = new Map<string, CompactionState>();

/**
 * 压缩状态表的上限。
 *
 * 历史：这张表原本只被「有 `x-session-id` 的客户端」写入，键的数量天然有限，
 * 所以没有淘汰逻辑。2026-10-19 引入 `auto:` 派生键之后，每个不带会话头的
 * 对话都会新增一个键——不设限就是一处只增不减的泄漏。
 *
 * 256 足够覆盖并发会话数；淘汰按 `updatedAt` 最旧优先，丢掉的只是“下一轮要
 * 多算一次全量摘要”，不会串会话（键仍然按内容区分）。
 */
const COMPACTION_STATE_LIMIT = 256;

function evictOldestStates(count: number): void {
  if (count <= 0) return;
  const ordered = [...states.entries()].sort(
    (a, b) => a[1].updatedAt - b[1].updatedAt,
  );
  for (let i = 0; i < count && i < ordered.length; i += 1) {
    states.delete(ordered[i][0]);
  }
}

export function compactionState(
  sessionId: string,
): CompactionState | undefined {
  return sessionId === "" ? undefined : states.get(sessionId);
}

export function resetCompactionStates(): void {
  states.clear();
}

export interface CompactInput {
  messages: any[];
  /** Whole request, only used for the size estimate. */
  body?: unknown;
  contextWindow: number;
  maxOutputTokens: number;
  sessionId: string;
  config?: Partial<CompactionConfig>;
  writeSummary: SummaryWriter;
}

export interface CompactResult {
  changed: boolean;
  note: string;
  compactTokens: number;
  /** Rebuilt transcript when `changed`; empty otherwise. */
  messages: any[];
  /**
   * 摘要调用失败时的原因（仅 `note === "summary-failed"` 时存在）。
   *
   * ★ 2026-10-19 加。此前调用方只能看到「summary generation failed」这五个字，
   * 而生产日志里它连续出现几十行，没有任何线索区分超时、401、上游拒答、
   * 或返回空内容——**那不是日志，是一句没有信息的噪音**。判据：失败必须带上
   * 自己的原因，否则排查时只能靠猜（和 AGENTS.md 里“只在统计里出现的失败
   * 等于没有日志的失败”同一条）。
   */
  error?: string;
  /**
   * 没有压缩时**为什么没压**（`changed === false` 且 `note === ""` 时存在）。
   *
   * ★ 2026-10-19 加，第五次修这个函数。前四次都在修「压了但没压够」，
   * 直到实测发现还有一条更糟的路径：**压根没压，而且一声不吭**。
   *
   * 复现（形态 B：6 轮 × 40 万字符，body 7.2 MB）：
   *
   *     writeSummaryCalled = false
   *     after = before = 7204563   <= 预算? NO
   *
   * 原因链：`maybeCompactCnb` 为了给摘要 prompt 限体积，先把**头部**每条
   * 消息截到 600 字符；这一步把整个 transcript 也缩小了，于是
   * `selectTail` 认为「全都装得下」→ 返回 undefined → `split <= 0`
   * → `compactIfNeeded` 在 line 355 静默 return `{changed:false, note:""}`。
   * 而 `maybeCompactCnb` 只处理 `changed` 与 `note === "summary-failed"`，
   * 这条路径两个都不命中 ⇒ body 一个字节不改、日志一行不打、上游继续 413。
   *
   * 判据：**「没压」和「压了没压够」都不许静默**。调用方拿到原因后才能决定
   * 是否降级到字节截断。
   */
  skipped?: string;
}

/**
 * Compact in place when the estimated transcript no longer fits.
 *
 * `writeSummary` failing is not fatal: the caller falls back to plain
 * truncation so an over-long session still gets an answer instead of a hard
 * refusal from the free tier.
 */
export async function compactIfNeeded(
  input: CompactInput,
): Promise<CompactResult> {
  const config = { ...DEFAULT_COMPACTION, ...(input.config ?? {}) };
  if (!config.enabled) {
    return {
      changed: false,
      note: "",
      compactTokens: 0,
      messages: [],
      skipped: "compaction disabled",
    };
  }
  const contextWindow = input.contextWindow;
  if (contextWindow <= 0) {
    return {
      changed: false,
      note: "",
      compactTokens: 0,
      messages: [],
      skipped: "contextWindow <= 0",
    };
  }
  const messages = input.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      changed: false,
      note: "",
      compactTokens: 0,
      messages: [],
      skipped: "no messages",
    };
  }

  const threshold = contextWindow -
    Math.max(input.maxOutputTokens, config.buffer);
  const estimate = estimateJsonTokens(input.body ?? { messages });
  if (estimate <= threshold) {
    return {
      changed: false,
      note: "",
      compactTokens: 0,
      messages: [],
      skipped: `estimate ${estimate} <= threshold ${threshold}`,
    };
  }

  // One serialized line per original message, index-aligned with `messages`.
  // Filtering first would shift the indices and make `split` point at the
  // wrong turn, silently dropping the newest messages from the tail.
  const serialized = messages.map((message) =>
    message && typeof message === "object" ? serializeMessage(message) : ""
  );
  const selection = selectTail(serialized, config.keepTokens);
  if (!selection || selection.split <= 0) {
    // ★ 2026-10-19 第五次修。这条分支曾让一个 7.2 MB 的请求**原样发出去**：
    // 调用方（maybeCompactCnb）为了给摘要限体积先把头部消息截到 600 字符，
    // 整个 transcript 随之缩到 keepTokens 之下，于是这里判定“没有可压缩的
    // 部分”——但 body 仍远超字节上限。什么都不改、什么都不说，是这套逻辑里
    // 最坏的失败形态：上游 413，日志干净，看起来一切正常。
    return {
      changed: false,
      note: "",
      compactTokens: 0,
      messages: [],
      skipped: `nothing to summarise: keepTokens=${config.keepTokens} ` +
        `already covers all ${serialized.length} messages`,
    };
  }

  const state = compactionState(input.sessionId);
  let previousSummary = state?.summary ?? "";
  const previousRecent = state?.recent ?? "";
  if (previousSummary === "") {
    previousSummary = findExistingSummary(messages, selection.split);
  }

  const head = selection.head.join("\n\n");
  const context = [previousRecent, head].filter((part) => part !== "");
  if (previousSummary === "" && context.length === 0) {
    return {
      changed: false,
      note: "",
      compactTokens: 0,
      messages: [],
      skipped: "no head content and no previous summary",
    };
  }

  const prompt = buildSummaryPrompt(previousSummary, context);
  const summaryModel = config.summaryModel !== "" ? config.summaryModel : "";
  // A refused summary must not surface as a failed request: the caller falls
  // back to truncation so an over-long session still gets an answer.
  let summary: string;
  try {
    summary = await input.writeSummary(
      prompt,
      summaryModel,
      config.maxSummaryTokens,
    );
  } catch (e) {
    return {
      changed: false,
      note: "summary-failed",
      compactTokens: 0,
      messages: [],
      // 把真实原因带上去：调用方会写进日志。
      error: e instanceof Error ? e.message : String(e),
    };
  }
  if (typeof summary !== "string" || summary.trim() === "") {
    return {
      changed: false,
      note: "summary-failed",
      compactTokens: 0,
      messages: [],
      error: "summary response was empty",
    };
  }

  const rebuilt: any[] = [];
  for (const message of messages) {
    if (message && typeof message === "object" && message.role === "system") {
      rebuilt.push(message);
    }
  }
  rebuilt.push({ role: "system", content: `${SUMMARY_PREFIX}\n${summary}` });
  if (state?.summary) {
    rebuilt.push({
      role: "system",
      content: `${PREVIOUS_SUMMARY_PREFIX}\n${state.summary}`,
    });
  }
  // The tail of the original transcript, kept verbatim so the model still sees
  // the most recent turns rather than only a summary of them.
  rebuilt.push(...messages.slice(selection.split));
  // The count has to be read before the in-place rewrite below empties the
  // original array.
  const kept = messages.length - selection.split;

  // Mutate in place as well as returning the new list. A caller that holds the
  // original array reference (the common case: a parsed request body) would
  // otherwise keep the oversized transcript and compact nothing, which is
  // exactly the failure compaction exists to prevent.
  messages.length = 0;
  messages.push(...rebuilt);
  input.messages = messages;
  if (input.sessionId !== "") {
    // ★ 2026-10-19：引入 `auto:` 派生键之后，键的数量不再天然有界——每个
    // 不带头部的对话都会新增一个。原注释说“不要每请求造唯一 id，因为 map
    // 没有淘汰”，这个理由现在同样要落实成代码：超上限时按最旧优先淘汰。
    // 淘汰是安全的：丢失状态只会让下一次压缩退化成全量重算一次，不会串会话。
    if (!states.has(input.sessionId) && states.size >= COMPACTION_STATE_LIMIT) {
      evictOldestStates(states.size - COMPACTION_STATE_LIMIT + 1);
    }
    states.set(input.sessionId, {
      summary,
      recent: selection.recent.join("\n\n"),
      updatedAt: Date.now(),
    });
  }

  return {
    changed: true,
    note: `[compacted via summary] kept=${kept} msgs`,
    compactTokens: estimateTokens(prompt) + estimateTokens(summary),
    messages: rebuilt,
  };
}

/**
 * Last-resort truncation, used when the summary call itself fails.
 *
 * Keeps every system message plus as much of the tail as the budget allows,
 * and says so in a system note rather than silently dropping turns.
 *
 * ⚠️ 2026-10-19 修（旧版的判据是错的，导致这个函数**什么都没删**）：
 * 旧签名收的是 `contextWindow`（token），而调用方 `maybeCompactCnb` 传的是
 * `Math.floor(bytesBudget / 4)`——一个**由字节预算推导出来的数**，看似 token，
 * 实则按 `bytes/4` 换算。函数内部又乘一次 0.6，于是预算被算成
 * `bytes * 0.6 / 4`。而 `estimateTokens` 是 `字符数/4`：中文一字符三字节，
 * 420 万字节 ≈ 140 万字符 ≈ **35 万 token**，永远小于那个 63 万的假预算
 * ⇒ 一条消息都不丢，只多加 149 字节的 system note。
 * 日志里因此出现 `bytes 4121421 -> 4121570`（**变大** 149）这种「说了压缩
 * 却一个字节没减」的形态，而且每轮重复。
 *
 * 判据：**上游限的是字节，降级截断就必须按字节做账**。参数直接收字节预算，
 * 与 `maybeCompactCnb` 里那道 `bytes <= budget` 的闸门同一把尺子，不再做
 * 任何单位换算——换算正是这个 bug 的来源。
 */
/**
 * 最后一道截断：摘要调用失败、或摘要压不到线以下时使用。
 *
 * ⚠️ 2026-10-19 第二次修（第一次修掉了单位错误，但没修掉**口径**错误）：
 * 第一次改成按字节做账之后，日志里仍是
 *
 *     [compacted via truncation] (summary generation failed)
 *     bytes 1096888 -> 1018872 | WARNING: still over budget (921600B)
 *
 * 也就是说消息已经按字节装到 92 万以内，**但整个 body 仍有 101 万**。差额是
 * 消息之外的固定开销：`model` / `max_tokens` / `tools` 定义 / system 指令等。
 * 函数只看见了 `messages`，把 `budgetBytes` 全部给了它们，于是永远差那一截。
 *
 * 现在由调用方把「非消息部分的字节数」显式传进来（`overheadBytes`），
 * 预算先扣掉它再分给消息。判据：**截断后的 body 必须落进 budget**，
 * 而不是“消息部分落进 budget’”——后者是这次 WARNING 一直不退的原因。
 */
export function fallbackTruncate(
  messages: any[],
  budgetBytes: number,
  overheadBytes = 0,
): { changed: boolean; note: string; messages: any[] } {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { changed: false, note: "", messages };
  }
  const encoder = new TextEncoder();
  // 序列化后的字节数才是上游会看到的大小；按角色文本估会漏掉 tool_calls、
  // image_url 等字段，而图片恰恰是最占体积的那一类。
  const sizeOf = (message: any): number => {
    try {
      return encoder.encode(JSON.stringify(message)).length;
    } catch {
      return 0;
    }
  };

  const noteContent =
    `[context compaction] 请求体积超过该渠道的字节上限(约 ${budgetBytes} 字节),早期消息已被截断以继续会话。`;
  const noteBytes = sizeOf({ role: "system", content: noteContent });

  // 预算要同时容纳那条说明与非消息开销；否则说明本身就把预算吃掉，仍然超限。
  // 还要预留消息数组自身的结构字节：元素之间每个逗号 1 字节。这部分此前被
  // 完全漏算 —— 消息越小、条数越多漏得越多：每条 1500 字节的消息能留下 615
  // 条，光逗号就有 615 字节，body 因此超出预算 500 多字节（生产 922121/921600）。
  // 做法是装箱时每条按 sizeOf+1 记账（+1 是它后面的逗号），另留 2 字节方括号；
  // overheadBytes 通常已含空数组的 2 字节，故这里是净保守 2 字节。
  const STRUCT_BYTES = 2;
  const usable = Math.max(
    0,
    budgetBytes - overheadBytes - noteBytes - STRUCT_BYTES,
  );
  const costOf = (message: any): number => sizeOf(message) + 1;

  const kept: { index: number; message: any }[] = [];
  let used = 0;
  // system 消息先留（它们是指令，丢了会改变行为）。但 system 自己也可能是
  // 超大的那一条，所以这里同样受预算约束，而不是无条件全收。
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (!message || typeof message !== "object" || message.role !== "system") {
      continue;
    }
    const cost = costOf(message);
    if (used + cost > usable) continue;
    kept.push({ index: i, message });
    used += cost;
  }
  const keptIndex = new Set(kept.map((entry) => entry.index));
  // 再从尾部往回装：最近的对话最该留在模型眼前。
  for (let i = messages.length - 1; i >= 0 && used < usable; i -= 1) {
    if (keptIndex.has(i)) continue;
    const message = messages[i];
    if (!message || typeof message !== "object") continue;
    const cost = costOf(message);
    // 单条就超预算时跳过而不是 break：更早的那些也许更小，仍值得留下。
    if (used + cost > usable) continue;
    kept.push({ index: i, message });
    keptIndex.add(i);
    used += cost;
  }
  kept.sort((a, b) => a.index - b.index);
  const out = [
    { role: "system", content: noteContent },
    ...kept.map((entry) => entry.message),
  ];

  // 一条都没能留下时仍算“改了”——但那等于清空历史，必须在 note 里说清楚，
  // 不能让它看起来像一次成功压缩。
  const note = kept.length === 0
    ? "[compacted via truncation] (all messages dropped)"
    : "[compacted via truncation]";
  return { changed: true, note, messages: out };
}
