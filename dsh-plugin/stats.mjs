// Per-call usage accounting for the DSH settings panel.
//
// The harness sees every turn this proxy serves, so it is the only layer that
// can report real token counts, first-token latency and decode speed without
// the proxy having to re-instrument every upstream protocol. Samples live in a
// bounded ring and day buckets are trimmed, so an always-on panel cannot grow
// the store without limit.
//
// The decode-window rules follow zouyuxuan122/dsh-our-free-model (src/store.js):
// a window shorter than MIN_DECODE_MS or a rate above MAX_CREDIBLE_TPS is not
// evidence of speed, so it is excluded rather than averaged in. A model that
// reports reasoning tokens would otherwise dominate the rate with tokens the
// user never waited for.
//
// History is persisted to a file under the harness home for the same reason
// that plugin keeps its own: the settings seam differs between kernel lines and
// the storage domain may not be mounted at all, and usage history is
// high-cardinality telemetry that does not belong in a configuration document.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const STATS_VERSION = 2;
export const MIN_DECODE_MS = 250;
export const MAX_CREDIBLE_TPS = 250;
const MAX_SAMPLES = 400;
const DEFAULT_KEEP_DAYS = 120;

/** Same resolution the harness uses: `$DSH_HOME` else `~/.dsh`. */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
  return path.join(os.homedir(), ".dsh");
}

export function statsFilePath(home = resolveDshHome()) {
  return path.join(home, "ai-proxy-dsh-bridge", "stats.json");
}

/**
 * A JSON file the plugin owns, written through a temp file and renamed.
 *
 * A crash mid-write must not leave a truncated store, and a damaged store must
 * be kept rather than overwritten: the next scheduled flush renames a fresh
 * default over it, and the history is then gone with nothing on disk to recover
 * from and nothing in a log to explain it.
 */
export class StatsStore {
  constructor(file = statsFilePath(), initial = emptyState()) {
    this.file = file;
    this.value = initial;
    this.dirty = false;
    this.timer = undefined;
    this.disposed = false;
    this.load();
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch {
      // Absent is the normal first-run case.
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (isPlainObject(parsed)) this.value = normalizeState(parsed, this.value);
    } catch {
      try {
        if (fs.existsSync(this.file)) {
          fs.copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`);
        }
      } catch {
        // A home we cannot write to is not this file's problem.
      }
    }
  }

  get() {
    return this.value;
  }

  /** Replace the state and schedule a write. */
  set(next) {
    if (this.disposed) return this.value;
    this.value = next;
    this.schedule();
    return this.value;
  }

  schedule(delayMs = 800) {
    if (this.disposed) return;
    this.dirty = true;
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, delayMs);
    // Telemetry must never hold the process open.
    this.timer.unref?.();
  }

  flush() {
    if (!this.dirty || this.disposed) return;
    this.dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(this.value, undefined, 2), { mode: 0o600 });
      fs.renameSync(temp, this.file);
    } catch {
      // Fail-soft: the next mutation retries and nothing depends on this.
    }
  }

  dispose() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    // Persist first, then lock: a late callback from a disposed generation must
    // never write over its successor's state.
    this.flush();
    this.disposed = true;
    this.dirty = false;
  }
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Accept a stored document only in the shape this version understands.
 *
 * A file written by a different build, or hand-edited into something else, is
 * dropped back to the default rather than merged field by field: a partially
 * recognised day bucket would report a total that no longer matches its rows.
 */
function normalizeState(parsed, fallback) {
  if (parsed.version !== STATS_VERSION) return fallback;
  if (!isPlainObject(parsed.days) || !Array.isArray(parsed.samples)) return fallback;
  return {
    version: STATS_VERSION,
    days: parsed.days,
    models: isPlainObject(parsed.models) ? parsed.models : {},
    requests: Number.isFinite(parsed.requests) ? parsed.requests : 0,
    samples: parsed.samples,
  };
}

/**
 * Classify one call's decode window.
 *
 * Short windows and impossible rates are measurement noise, not speed: a
 * one-token answer that arrives in a single frame would otherwise report
 * thousands of tokens per second.
 */
export function decodeWindow(decodeMs, tokens, ok) {
  const ms = Number.isFinite(decodeMs) && decodeMs > 0 ? decodeMs : 0;
  const count = Number.isFinite(tokens) ? tokens : 0;
  if (ok !== true || count <= 0 || ms < MIN_DECODE_MS) {
    return { measurable: false, decodeMs: 0, tps: null };
  }
  const tps = (count / ms) * 1000;
  if (!Number.isFinite(tps) || tps > MAX_CREDIBLE_TPS) {
    return { measurable: false, decodeMs: 0, tps: null };
  }
  return { measurable: true, decodeMs: ms, tps: Math.round(tps) };
}

export function dayKey(at) {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function emptyState() {
  return { version: STATS_VERSION, days: {}, models: {}, requests: 0, samples: [] };
}

/** Fold one call into the state. Pure, so the panel and the API agree. */
export function applyRecord(state, record, keepDays = DEFAULT_KEEP_DAYS) {
  const day = dayKey(record.at);
  const days = { ...state.days };
  const bucket = days[day] ?? { total: 0, models: {} };
  const perModel = { ...bucket.models };
  const previous = perModel[record.model] ?? {
    input: 0,
    output: 0,
    reasoning: 0,
    calls: 0,
    failed: 0,
    ttftMs: 0,
    ttftSamples: 0,
    decodeMs: 0,
    decodeTokens: 0,
  };
  const measured = decodeWindow(record.decodeMs, record.decodeTokens, record.ok);
  // A failed call's wall-clock latency is not a time-to-first-token, so it is
  // never allowed into the latency average.
  const ttftMs = Number.isFinite(record.ttftMs) && record.ok === true
    ? record.ttftMs
    : undefined;
  perModel[record.model] = {
    input: previous.input + record.input,
    output: previous.output + record.output,
    reasoning: previous.reasoning + record.reasoning,
    calls: previous.calls + 1,
    failed: previous.failed + (record.ok ? 0 : 1),
    ttftMs: previous.ttftMs + (ttftMs ?? 0),
    ttftSamples: previous.ttftSamples + (ttftMs === undefined ? 0 : 1),
    decodeMs: previous.decodeMs + measured.decodeMs,
    decodeTokens: previous.decodeTokens +
      (measured.measurable ? (record.decodeTokens ?? 0) : 0),
  };
  days[day] = {
    ...bucket,
    models: perModel,
    total: bucket.total + record.input + record.output,
  };

  const models = { ...state.models };
  const lifetime = models[record.model] ?? { input: 0, output: 0, calls: 0 };
  models[record.model] = {
    input: lifetime.input + record.input,
    output: lifetime.output + record.output,
    calls: lifetime.calls + 1,
  };

  const samples = [...state.samples, {
    at: record.at,
    model: record.model,
    ok: record.ok === true,
    input: record.input,
    output: record.output,
    ttftMs: ttftMs === undefined ? null : Math.round(ttftMs),
    tps: measured.tps,
    decodeMs: measured.decodeMs,
    decodeTokens: measured.measurable ? (record.decodeTokens ?? 0) : 0,
    truncated: record.truncated === true,
    noUsage: record.noUsage === true,
  }].slice(-MAX_SAMPLES);

  return pruneDays({
    version: STATS_VERSION,
    days,
    models,
    requests: state.requests + 1,
    samples,
  }, keepDays);
}

export function pruneDays(state, keepDays = DEFAULT_KEEP_DAYS) {
  const keys = Object.keys(state.days).sort();
  if (keys.length <= keepDays) return state;
  const drop = new Set(keys.slice(0, keys.length - keepDays));
  const days = {};
  for (const key of keys) if (!drop.has(key)) days[key] = state.days[key];
  return { ...state, days };
}

/**
 * Roll the state up into the numbers the panel headline shows.
 *
 * Speed and latency are derived from summed windows rather than from a mean of
 * per-call rates, so one long call cannot outweigh a hundred short ones.
 */
export function summarize(state, now = Date.now()) {
  let totalTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let requests = 0;
  let failed = 0;
  let decodeMs = 0;
  let decodeTokens = 0;
  let ttftMs = 0;
  let ttftSamples = 0;
  let measuredCalls = 0;
  let answerTokens = 0;

  for (const sample of state.samples) {
    requests += 1;
    totalTokens += sample.input + sample.output;
    outputTokens += sample.output;
    if (sample.ok === false) failed += 1;
    decodeMs += sample.decodeMs;
    decodeTokens += sample.decodeTokens;
    if (sample.ttftMs !== null) {
      ttftMs += sample.ttftMs;
      ttftSamples += 1;
    }
    if (sample.ok === true && sample.output > 0) {
      answerTokens += sample.output;
      measuredCalls += 1;
    }
  }
  // Reasoning tokens live in the day buckets rather than the sample ring: the
  // ring is bounded, so summing it would under-report a long session.
  for (const bucket of Object.values(state.days)) {
    for (const row of Object.values(bucket.models)) {
      reasoningTokens += row.reasoning;
    }
  }

  return {
    totalTokens,
    outputTokens,
    reasoningTokens,
    requests,
    failed,
    outputSpeed: decodeMs > 0 ? Math.round((decodeTokens / decodeMs) * 1000) : null,
    firstTokenMs: ttftSamples > 0 ? Math.round(ttftMs / ttftSamples) : null,
    speedSamples: decodeMs > 0 && decodeTokens > 0 ? 1 : 0,
    latencySamples: ttftSamples,
    avgOutputTokens: measuredCalls > 0 ? Math.round(answerTokens / measuredCalls) : 0,
    today: state.days[dayKey(now)]?.total ?? 0,
  };
}

/**
 * Per-model rollup across every retained day, for the panel's model table.
 *
 * `labels` maps a model id to its display name. Zen publishes only an id, so
 * without it the table would read `space-bunny-free` where the catalog knows
 * the model as "Space Bunny".
 */
export function byModel(state, labels) {
  const nameOf = (id) =>
    labels && typeof labels.get === "function" ? labels.get(id) ?? id : id;
  const acc = new Map();
  for (const bucket of Object.values(state.days)) {
    for (const [model, row] of Object.entries(bucket.models)) {
      const existing = acc.get(model) ?? {
        model,
        calls: 0,
        failed: 0,
        input: 0,
        output: 0,
        reasoning: 0,
        decodeMs: 0,
        decodeTokens: 0,
        ttftMs: 0,
        latencySamples: 0,
      };
      existing.calls += row.calls;
      existing.failed += row.failed;
      existing.input += row.input;
      existing.output += row.output;
      existing.reasoning += row.reasoning;
      // Speed and latency are recomputed from summed windows, never averaged
      // across days: averaging rates would weight a single slow day equally
      // with a hundred fast calls.
      existing.decodeMs += row.decodeMs;
      existing.decodeTokens += row.decodeTokens;
      existing.ttftMs += row.ttftMs;
      existing.latencySamples += row.ttftSamples;
      acc.set(model, existing);
    }
  }
  return [...acc.values()]
    .map((row) => ({
      model: row.model,
      name: nameOf(row.model),
      calls: row.calls,
      failed: row.failed,
      input: row.input,
      output: row.output,
      reasoning: row.reasoning,
      speed: row.decodeMs > 0
        ? Math.round((row.decodeTokens / row.decodeMs) * 1000)
        : null,
      firstTokenMs: row.latencySamples > 0
        ? Math.round(row.ttftMs / row.latencySamples)
        : null,
      latencySamples: row.latencySamples,
    }))
    .sort((a, b) => b.calls - a.calls);
}

/** Daily token totals, oldest first, for the heatmap grid. */
export function heatmap(state, days, now = Date.now()) {
  const out = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const stamp = new Date(now);
    stamp.setHours(12, 0, 0, 0);
    stamp.setDate(stamp.getDate() - offset);
    const key = dayKey(stamp.getTime());
    out.push({ day: key, tokens: state.days[key]?.total ?? 0 });
  }
  return out;
}

/** Cumulative tokens over time, one point per sample, for the area chart. */
export function trend(state, limit = 120) {
  const recent = state.samples.slice(-limit);
  const dropped = state.samples.length - recent.length;
  let running = 0;
  for (const sample of state.samples.slice(0, dropped)) {
    running += sample.input + sample.output;
  }
  return recent.map((sample) => {
    running += sample.input + sample.output;
    return { at: sample.at, model: sample.model, tokens: running };
  });
}
