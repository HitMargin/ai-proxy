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

export const STATS_VERSION = 2;
export const MIN_DECODE_MS = 250;
export const MAX_CREDIBLE_TPS = 250;
const MAX_SAMPLES = 400;
const DEFAULT_KEEP_DAYS = 120;

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

/** Per-model rollup across every retained day, for the panel's model table. */
export function byModel(state) {
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
