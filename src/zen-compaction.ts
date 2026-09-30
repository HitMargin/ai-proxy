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
    return { changed: false, note: "", compactTokens: 0, messages: [] };
  }
  const contextWindow = input.contextWindow;
  if (contextWindow <= 0) {
    return { changed: false, note: "", compactTokens: 0, messages: [] };
  }
  const messages = input.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { changed: false, note: "", compactTokens: 0, messages: [] };
  }

  const threshold = contextWindow -
    Math.max(input.maxOutputTokens, config.buffer);
  const estimate = estimateJsonTokens(input.body ?? { messages });
  if (estimate <= threshold) {
    return { changed: false, note: "", compactTokens: 0, messages: [] };
  }

  // One serialized line per original message, index-aligned with `messages`.
  // Filtering first would shift the indices and make `split` point at the
  // wrong turn, silently dropping the newest messages from the tail.
  const serialized = messages.map((message) =>
    message && typeof message === "object" ? serializeMessage(message) : ""
  );
  const selection = selectTail(serialized, config.keepTokens);
  if (!selection || selection.split <= 0) {
    return { changed: false, note: "", compactTokens: 0, messages: [] };
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
    return { changed: false, note: "", compactTokens: 0, messages: [] };
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
  } catch {
    return {
      changed: false,
      note: "summary-failed",
      compactTokens: 0,
      messages: [],
    };
  }
  if (typeof summary !== "string" || summary.trim() === "") {
    return {
      changed: false,
      note: "summary-failed",
      compactTokens: 0,
      messages: [],
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
 */
export function fallbackTruncate(
  messages: any[],
  contextWindow: number,
): { changed: boolean; note: string; messages: any[] } {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { changed: false, note: "", messages };
  }
  const budget = Math.floor(contextWindow * 0.6);
  const kept: { index: number; message: any }[] = [];
  let used = 0;
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message && typeof message === "object" && message.role === "system") {
      kept.push({ index: i, message });
      used += estimateTokens(messageText(message));
    }
  }
  for (let i = messages.length - 1; i >= 0 && used < budget; i -= 1) {
    if (kept.some((entry) => entry.index === i)) continue;
    const message = messages[i];
    if (!message || typeof message !== "object") continue;
    const cost = estimateTokens(messageText(message));
    if (used + cost > budget) continue;
    kept.push({ index: i, message });
    used += cost;
  }
  kept.sort((a, b) => a.index - b.index);
  const out = [
    {
      role: "system",
      content:
        `[context compaction] 上下文估算超过该模型限制(约 ${contextWindow} token),早期消息已被截断以继续会话。`,
    },
    ...kept.map((entry) => entry.message),
  ];
  return { changed: true, note: "[compacted via truncation]", messages: out };
}
