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
  /**
   * `summary` 已经覆盖了前多少条消息。
   *
   * ★ 2026-10-20 加。起因是生产日志里同一个会话连续 24 次
   * `[compacted via summary] ... cost≈48449 → 64512`：每轮把**同一批已被
   * 总结过的历史**重新送进摘要 prompt，成本随轮次单调增长。
   *
   * 为什么代理场景必然重复：客户端（harness）每轮重发**完整**历史，而我们只
   * 压缩“这一次请求”，客户端自己的 transcript 不变。所以 [0, covered) 这段
   * 内容下一轮原样再来一遍——对摘要来说没有任何新信息。
   */
  covered?: number;
  /**
   * `messages[covered - 1]` 的指纹。
   *
   * 索引只在“历史只追加”时才有意义。客户端重写、截断、或换了会话时索引会
   * 指向别的消息，那时按 covered 切片就会**跳过未被总结的内容**——这是比多
   * 花钱严重得多的错。指纹对不上就退回全量重算。
   */
  coveredHash?: string;
}

/**
 * 一条消息的稳定指纹：长度 + djb2。
 *
 * 不用加密哈希：这里只需要区分“还是那条消息吗”，碰撞概率 2^-32 已远超需要，
 * 而摘要历史里每条消息都要算一次，便宜的算法就是对的算法。
 */
export function messageFingerprint(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  }
  return `${text.length}:${hash.toString(16)}`;
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
 * Rough token estimate, **width aware**.
 *
 * ★ 2026-10-21 修单位。旧版是 `字符数 / 4`，那只对 ASCII 成立：中文/日文/
 * 韩文一个字符通常就是一个 token，按 4 折算会少算约 4 倍。混用之后出现的是
 * 一种很难自查的账：日志说“尾巴只占 8000 token”，拼成 body 却是 886 KiB
 * （预算的 89%），于是每一轮都压到刚好不超、下一轮立刻又超，反复烧摘要。
 *
 * 现在按码位分类：CJK 与全角区（U+2E80 以上）一个字符算一个 token，其余仍
 * 按 4 折算。它依然是伪单位（没有真分词器），但和上游至少同一数量级；而
 * **真正卡体积的地方用 utf8Bytes / selectTailByBytes**，那个才是字节。
 */
export function estimateTokens(text: string): number {
  let wide = 0;
  let narrow = 0;
  for (const ch of text) {
    if ((ch.codePointAt(0) ?? 0) >= 0x2e80) wide += 1;
    else narrow += 1;
  }
  return wide + (narrow >> 2);
}

export function estimateJsonTokens(value: unknown): number {
  try {
    // 与 estimateTokens 同一把尺子：同一个字符串在两个函数里必须算出同一个数，
    // 否则调用方之间又会出现单位漂移（这正是本节要修的那类 bug）。
    return estimateTokens(JSON.stringify(value));
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

const utf8Encoder = new TextEncoder();

/** UTF-8 bytes of `text` — the unit the upstream body limit is enforced in. */
export function utf8Bytes(text: string): number {
  return utf8Encoder.encode(text).length;
}

/**
 * 一条消息在上游 body 里实际占的字节数。
 *
 * 用 `JSON.stringify` 而不是 `messageText`：图片的 base64、`tool_calls`
 * 的 arguments、以及 tool 结果的原文才是体积本体。`messageText` 会把它们
 * 丢掉（图片算 0）或截断（tool 结果截到 2000 字符）。实测一个真实会话：按消息
 * 文本统计平均 893 字符/条，按序列化字节是 25159 字节/条 —— 相差 28 倍，
 * 这就是“尾巴看着很小、body 却有 886 KiB”的来源。
 */
export function messageBytes(message: unknown): number {
  try {
    // +1: 消息之间的逗号。量级无关紧要，但便宜，且让界限偏向保守。
    return utf8Bytes(JSON.stringify(message ?? "")) + 1;
  } catch {
    return 0;
  }
}

export interface ByteTailSelection {
  /** Index of the first message kept verbatim. */
  split: number;
  /** Bytes the kept tail actually occupies. */
  bytes: number;
}

/**
 * Pack the tail by **UTF-8 bytes** instead of estimated tokens.
 *
 * 与 `selectTail` 的唯一区别就是单位，而单位正是问题所在：伪 token 在中文
 * （一字符三字节）和图片（base64 在 `messageText` 里直接消失）上会少算一个
 * 数量级，于是“预算内”的尾巴拼成 body 后仍然贴着上限。
 *
 * 不切消息：整条放得下就放，放不下就把这条交给摘要。切开一条 base64 图片
 * 只会得到一张坏图，而摘要那边本来就按字符数截头部。
 */
export function selectTailByBytes(
  messages: readonly any[],
  budgetBytes: number,
): ByteTailSelection {
  if (!Array.isArray(messages) || messages.length === 0 || budgetBytes <= 0) {
    return { split: messages?.length ?? 0, bytes: 0 };
  }
  let used = 0;
  let split = messages.length;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const cost = messageBytes(messages[i]);
    if (used + cost > budgetBytes) break;
    used += cost;
    split = i;
  }
  // ★ 2026-10-22：一条都装不下时也不许把**尾巴清空**。
  //
  // 旧行为：最后一条自己就超过 budget ⇒ split 落到 messages.length ⇒ 尾巴是
  // 零条消息 ⇒ 调用方拿到 `bytes: 0`，摘要那条捷径被判定为“没有可总结的部分”
  // 而跳过（见 cnb.ts 的形态 B 注释），7.2 MB 的 body 原样上传，每轮 413。
  //
  // 这不是“切消息”（304 行那条规矩仍然成立：放不下就交给摘要），而是给
  // **摘要留一个起点**：最新那一轮必须留在原文里，压缩是为了继续会话，
  // 不是为了把问题也清掉。它可能仍然超预算，超出的部分由调用方的
  // `fallbackTruncate` 收口（那边会把最后一条的正文硬截到剩余空间）。
  if (messages.length > 0 && split === messages.length) {
    const last = messages.length - 1;
    return { split: last, bytes: messageBytes(messages[last]) };
  }
  return { split, bytes: used };
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
  /** 总 token 窗口。`0` = 不设 token 闸门（见 `budgetBytes`）。 */
  contextWindow: number;
  maxOutputTokens: number;
  /**
   * 由调用方按**字节**算好的 body 预算——上游硬限用的单位。
   *
   * 给了它就额外按 UTF-8 **真实字节数**判一次超限，且**绝不换算成 token**：
   * 字节→token 没有正确常数（同一份 907,264 B 的 body，纯 ASCII 估算约
   * 22.7 万 token，纯中文约 30.2 万——固定除数必然错 33%）。两个单位各自
   * 在自己的尺子上判，任一超线即压缩。
   *
   * 与 `contextWindow` 是**或**关系：只给其一也行，两个都给则都要看。
   */
  budgetBytes?: number;
  sessionId: string;
  config?: Partial<CompactionConfig>;
  /**
   * 由调用方按**字节**算好的尾部起点（见 `selectTailByBytes`）。
   *
   * 为什么不在这里自己算：本模块的预算单位是 token，而调用方（cnb）的预算是
   * 上游那条 **1 MiB body** 的字节线。两把尺子必然漂开，实测就是“尾巴看着只
   * 占 8000 token、拼出来 886 KiB”。调用方知道真实字节预算，所以由它给 split，
   * 这里只负责按这个 split 切（0/缺省 = 沿用 keepTokens 的启发式）。
   */
  tailSplit?: number;
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
  // ★ 2026-10-23：字节预算与 token 窗口是**两条独立的触发线**，任一超线都压缩。
  //
  // 上游卡的是 body **字节**（cnb 实测 1,048,169 B 通过、1,049,193 B 直接
  // 413 [BODY_TOO_LARGE]），而 token 只是伪单位。之前只留 token 闸门，中文
  // 会话就能在“估算 100 K token”下把 body 顶到 1.2 MiB 再吃 413——压缩静默
  // 不触发。所以调用方知道真实字节预算时，这里直接按字节判。
  // `contextWindow: 0` = 该调用方没有 token 窗口，只关心字节，不是“别压缩”。
  const budgetBytes = Math.max(0, Math.floor(input.budgetBytes ?? 0));
  if (contextWindow <= 0 && budgetBytes <= 0) {
    return {
      changed: false,
      note: "",
      compactTokens: 0,
      messages: [],
      skipped: "neither contextWindow nor budgetBytes is set",
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

  // token 侧：窗口 <=0 时不构成约束，只算字节侧。
  const tokenGate = contextWindow > 0;
  const threshold = tokenGate
    ? contextWindow - Math.max(input.maxOutputTokens, config.buffer)
    : 0;
  const bodyValue = input.body ?? { messages };
  const estimate = tokenGate ? estimateJsonTokens(bodyValue) : 0;
  let bodyBytes = 0;
  if (budgetBytes > 0) {
    try {
      bodyBytes = utf8Bytes(JSON.stringify(bodyValue));
    } catch {
      // 序列化不了的 body 反正发不出去，别在这里替上游下判断。
      bodyBytes = 0;
    }
  }
  const overBytes = budgetBytes > 0 && bodyBytes > budgetBytes;
  const overTokens = tokenGate && estimate > threshold;
  if (!overBytes && !overTokens) {
    return {
      changed: false,
      note: "",
      compactTokens: 0,
      messages: [],
      skipped: [
        budgetBytes > 0 ? `body ${bodyBytes}B <= budget ${budgetBytes}B` : "",
        tokenGate ? `estimate ${estimate} <= threshold ${threshold}` : "",
      ].filter(Boolean).join(", "),
    };
  }

  // One serialized line per original message, index-aligned with `messages`.
  // Filtering first would shift the indices and make `split` point at the
  // wrong turn, silently dropping the newest messages from the tail.
  const serialized = messages.map((message) =>
    message && typeof message === "object" ? serializeMessage(message) : ""
  );
  // 调用方给了字节口径的 split，就按它切：那是上游真正会看到的体积。
  const forcedSplit = input.tailSplit ?? 0;
  let selection = forcedSplit > 0 && forcedSplit < serialized.length
    ? {
      head: [...serialized.slice(0, forcedSplit)],
      recent: [...serialized.slice(forcedSplit)],
      split: forcedSplit,
    }
    : selectTail(serialized, config.keepTokens);
  if (!selection || selection.split <= 0) {
    // ★ 2026-10-19 第五次修。这条分支曾让一个 7.2 MB 的请求**原样发出去**：
    // 调用方（maybeCompactCnb）为了给摘要限体积先把头部消息截到 600 字符，
    // 整个 transcript 随之缩到 keepTokens 之下，于是这里判定“没有可压缩的
    // 部分”——但 body 仍远超字节上限。什么都不改、什么都不说，是这套逻辑里
    // 最坏的失败形态：上游 413，日志干净，看起来一切正常。
    //
    // ★ 2026-10-23：既然上面已经确认超线（overBytes / overTokens），这里就
    // 不许再原样返回——那等于把同一场事故换个入口重演一遍。只剩一条消息时
    // 确实无从压缩（调用方在 changed=false 之后会自己截断尾部），否则至少把
    // 最后一条之外的全部交给摘要，保证“压缩必然收敛”。
    if (serialized.length <= 1) {
      return {
        changed: false,
        note: "",
        compactTokens: 0,
        messages: [],
        skipped: `nothing to summarise: body holds a single message ` +
          `(${serialized.length}); caller must truncate`,
      };
    }
    const forced = serialized.length - 1;
    selection = {
      head: [...serialized.slice(0, forced)],
      recent: [...serialized.slice(forced)],
      split: forced,
    };
  }

  const state = compactionState(input.sessionId);
  let previousSummary = state?.summary ?? "";
  const previousRecent = state?.recent ?? "";
  if (previousSummary === "") {
    previousSummary = findExistingSummary(messages, selection.split);
  }

  // ── 增量总结的起点（2026-10-20）─────────────────────────────────────
  //
  // 判据：**上一轮已经总结过的消息，这一轮不再送进摘要 prompt。**
  //
  // 代理场景下这段内容每轮都会原样重发（客户端重发完整历史，我们只压缩本次
  // 请求），所以不跳过的话，摘要成本随会话长度单调增长。生产日志实测同一个
  // session 连续 24 次 `cost≈48449 → 64512`，而其中绝大部分字节是重复的。
  //
  // 索引本身不可信：它只在“历史只追加”的前提下有意义。客户端重写历史、换了
  // 会话、或上游截断过时，同一个下标指向的是**别的消息**——那时按索引切片会
  // 跳过没被总结的内容，那是比多花钱严重得多的错（模型会失去它以为还在的
  // 上下文）。所以索引必须配一个指纹：对不上就退回全量重算。
  const trustedCovered = (() => {
    if (previousSummary === "") return -1;
    const covered = state?.covered;
    if (typeof covered !== "number" || covered <= 0) return -1;
    if (covered > serialized.length || covered > selection.split) return -1;
    if (
      state?.coveredHash !== messageFingerprint(serialized[covered - 1] ?? "")
    ) {
      return -1;
    }
    return covered;
  })();

  // 起点之前的内容已在 previousSummary 里；起点之后到 split 才是新内容。
  const delta = serialized.slice(
    trustedCovered >= 0 ? trustedCovered : 0,
    selection.split,
  );
  // 走增量时**不能**再拼 previousRecent：它落在 [0, covered) 里，已经由
  // previousSummary 代表，而它又必然出现在本轮重发的完整历史中。实测它占
  // head 的 31%，等于每轮白送三成摘要成本。
  const context = trustedCovered >= 0
    ? (delta.length > 0 ? [delta.join("\n\n")] : [])
    : [previousRecent, selection.head.join("\n\n")].filter((p) => p !== "");
  if (previousSummary === "" && context.length === 0) {
    return {
      changed: false,
      note: "",
      compactTokens: 0,
      messages: [],
      skipped: "no head content and no previous summary",
    };
  }

  // 增量起点已经越过尾部边界 = 上一轮的摘要仍然完全覆盖，本轮没有新内容可
  // 总结。直接复用，**一次摘要调用都不发**（成本 0，而不是再花几万 token 把
  // 同样的历史重算一遍）。
  const reuseOnly = trustedCovered >= 0 && delta.length === 0 &&
    previousSummary !== "";

  let summary = "";
  let prompt = "";
  if (!reuseOnly) {
    prompt = buildSummaryPrompt(previousSummary, context);
    const summaryModel = config.summaryModel !== "" ? config.summaryModel : "";
    // A refused summary must not surface as a failed request: the caller falls
    // back to truncation so an over-long session still gets an answer.
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
  } else {
    summary = previousSummary;
  }

  const rebuilt: any[] = [];
  for (const message of messages) {
    if (message && typeof message === "object" && message.role === "system") {
      rebuilt.push(message);
    }
  }
  rebuilt.push({ role: "system", content: `${SUMMARY_PREFIX}\n${summary}` });
  // 复用路径下 `summary` 就是 `state.summary`，再推一份 `[Previous ...]` 会让
  // 同一段文本在上下文里出现两次：字节翻倍、还不带任何新信息。
  if (state?.summary && !reuseOnly) {
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
      // 记下“总结到哪了”：下一轮从这里继续，不再重算 [0, covered)。
      // 复用路径下摘要没变，但覆盖范围仍应随 split 前移——从 covered 到
      // 新 split 之间的内容已经由同一份摘要代表了（它本来就是覆盖到 split 的）。
      covered: selection.split,
      coveredHash: messageFingerprint(serialized[selection.split - 1] ?? ""),
    });
  }

  return {
    changed: true,
    note: reuseOnly
      ? `[compacted reuse] kept=${kept} msgs`
      : `[compacted via summary] kept=${kept} msgs`,
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
/**
 * 把一条消息的正文硬截到 `room` 字节以内（用于“最新一轮绝不能消失”的兜底）。
 *
 * 为什么需要它：`fallbackTruncate` 的装箱器只做「整条收 / 整条不收」的判断，
 * 而生产里出现的恰恰是「最后一条自己就 > 预算」——于是两道循环都跳过它，
 * 请求里一个用户问题都没有（日志：`(all messages dropped)`）。
 * 截断的判据不是“字节数达标”，而是“字节数达标且还能继续会话”。
 *
 * 只改 `content`，其余字段（role / name / tool_call_id）原样保留，因为这些
 * 字段是上游校验 schema 用的，缺了会被 400。非字符串正文（多模态）无从下手，
 * 能整条放下就放下，否则返回 undefined 让调用方按“没留下”处理。
 */
function clipToRoom(message: any, room: number): any | undefined {
  if (room <= 0) return undefined;
  const encoder = new TextEncoder();
  const sizeOf = (m: any): number => {
    try {
      return encoder.encode(JSON.stringify(m)).length;
    } catch {
      return 0;
    }
  };
  if (typeof message.content !== "string") {
    return sizeOf(message) + 1 <= room ? message : undefined;
  }
  const text: string = message.content;
  const suffix = "\n[truncated]";
  // UTF-8 每字符至少 1 字节，所以字符数就是字节数的上界，可作初值。
  // 之后按 3/4 收敛：每轮严格变小，最坏 30 轮内结束（400 万字符的正文也一样）。
  let keep = Math.min(text.length, room);
  while (keep > 0) {
    const candidate = { ...message, content: text.slice(0, keep) + suffix };
    if (sizeOf(candidate) + 1 <= room) return candidate;
    keep = Math.floor(keep * 0.75);
  }
  return undefined;
}
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

  // ★ 2026-10-21 缩短：旧文案 81 个字节约 225 字节，对 cnb 的 1 MiB 预算不算事，
  // 但它出现在**每一条** system 消息被砍的位置，而 system 是 cnb 上游的检测面；
  // 越短越不容易把真正的指令挤掉。
  const noteContent =
    `[context compaction] 早期消息已按体积上限(${budgetBytes}B)截断。`;
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
  // ★ 2026-10-22：最新那一轮不能消失。
  //
  // 生产形态：最后一条自己就超过预算时，上面两道循环都会跳过它，于是 kept
  // 可能只剩 system、甚至全空，note 打出 `(all messages dropped)`——模型收到
  // 的请求里**没有用户的问题**，所谓压缩变成了清空。
  //
  // 处理：还装得下就整条收（正常路径，行为不变）；装不下就把正文硬截到剩余
  // 空间，至少保留“用户问了什么”的开头。判据是「装进预算**且**还能继续
  // 会话」，只满足前者等于把会话掐死。
  let clippedNewest = false;
  const newestIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (!m || typeof m !== "object" || m.role === "system") continue;
      return i;
    }
    return -1;
  })();
  if (newestIndex >= 0 && !keptIndex.has(newestIndex)) {
    const newest = messages[newestIndex];
    const cost = costOf(newest);
    if (used + cost <= usable) {
      kept.push({ index: newestIndex, message: newest });
      keptIndex.add(newestIndex);
      used += cost;
    } else {
      const clipped = clipToRoom(newest, usable - used - 1);
      if (clipped !== undefined) {
        kept.push({ index: newestIndex, message: clipped });
        keptIndex.add(newestIndex);
        clippedNewest = true;
      }
    }
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
    : clippedNewest
    ? "[compacted via truncation] (newest turn clipped)"
    : "[compacted via truncation]";
  return { changed: true, note, messages: out };
}
