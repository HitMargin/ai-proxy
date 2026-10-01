import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyRecord,
  byModel,
  decodeWindow,
  dayKey,
  emptyState,
  heatmap,
  MAX_CREDIBLE_TPS,
  MIN_DECODE_MS,
  StatsStore,
  statsFilePath,
  summarize,
  trend,
} from './stats.mjs';

/** A scratch directory that cleans itself up. */
function scratchDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apx-stats-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const DAY = new Date('2026-10-01T12:00:00Z').getTime();

function call(overrides = {}) {
  return {
    at: DAY,
    model: 'kilo/test',
    effort: 'high',
    ok: true,
    input: 100,
    output: 200,
    reasoning: 0,
    decodeTokens: 200,
    ttftMs: 800,
    decodeMs: 2000,
    origin: 'harness',
    ...overrides,
  };
}

test('decode window rejects a window too short to be a rate', () => {
  const noisy = decodeWindow(MIN_DECODE_MS - 1, 500, true);
  assert.equal(noisy.measurable, false);
  assert.equal(noisy.tps, null);
});

test('decode window rejects an implausible rate', () => {
  const absurd = decodeWindow(250, 10_000, true);
  assert.equal(absurd.measurable, false);
  assert.ok(MAX_CREDIBLE_TPS < 10_000, 'the ceiling must be far below a single-frame burst');
});

test('decode window never credits a failed call', () => {
  const failed = decodeWindow(2000, 200, false);
  assert.equal(failed.measurable, false);
});

test('decode window measures a credible call', () => {
  const good = decodeWindow(2000, 200, true);
  assert.equal(good.measurable, true);
  assert.equal(good.tps, 100);
});

test('a call is folded into the day bucket and the lifetime totals', () => {
  let state = emptyState();
  state = applyRecord(state, call());
  const key = dayKey(DAY);
  assert.equal(state.days[key].total, 300);
  assert.equal(state.days[key].models['kilo/test'].calls, 1);
  assert.equal(state.models['kilo/test'].input, 100);
  assert.equal(state.models['kilo/test'].output, 200);
  assert.equal(state.requests, 1);
});

test('applying a record does not mutate the state it was given', () => {
  const before = emptyState();
  const after = applyRecord(before, call());
  assert.equal(before.requests, 0);
  assert.deepEqual(before.days, {});
  assert.equal(after.requests, 1);
});

test('a failed call is counted as failed but contributes no latency', () => {
  let state = emptyState();
  state = applyRecord(state, call());
  state = applyRecord(state, call({ ok: false, ttftMs: 30_000, output: 0, decodeTokens: 0 }));
  const summary = summarize(state, DAY);
  assert.equal(summary.failed, 1);
  assert.equal(summary.requests, 2);
  // Only the successful call's 800ms counts; the failure's 30s is excluded.
  assert.equal(summary.firstTokenMs, 800);
  assert.equal(summary.latencySamples, 1);
});

test('speed comes from summed windows, not an average of rates', () => {
  let state = emptyState();
  // 100 tokens in 1s = 100 tok/s, then 300 in 3s = 100 tok/s. A mean of rates
  // would also give 100, so use windows that disagree: 100 in 1s (100/s) and
  // 100 in 2s (50/s). Pooled is 200 tokens over 3s = 67/s; the mean of rates
  // would be 75.
  state = applyRecord(state, call({ output: 100, decodeTokens: 100, decodeMs: 1000 }));
  state = applyRecord(state, call({ output: 100, decodeTokens: 100, decodeMs: 2000 }));
  const summary = summarize(state, DAY);
  assert.equal(summary.outputSpeed, 67);
});

test('reasoning tokens are excluded from the decode window', () => {
  let state = emptyState();
  // 1000 output of which 800 is reasoning: only 200 tokens were awaited.
  state = applyRecord(
    state,
    call({ output: 1000, reasoning: 800, decodeTokens: 200, decodeMs: 2000 }),
  );
  const summary = summarize(state, DAY);
  assert.equal(summary.outputTokens, 1000);
  assert.equal(summary.reasoningTokens, 800);
  assert.equal(summary.outputSpeed, 100, 'speed must use awaited tokens only');
});

test('the summary is empty and honest before any call', () => {
  const summary = summarize(emptyState(), DAY);
  assert.equal(summary.requests, 0);
  assert.equal(summary.outputSpeed, null);
  assert.equal(summary.firstTokenMs, null);
  assert.equal(summary.avgOutputTokens, 0);
});

test('today reflects only the given day', () => {
  let state = emptyState();
  state = applyRecord(state, call({ at: new Date('2026-09-01T12:00:00Z').getTime() }));
  assert.equal(summarize(state, DAY).today, 0);
  state = applyRecord(state, call());
  assert.equal(summarize(state, DAY).today, 300);
});

test('per-model rows carry speed and latency only when measured', () => {
  let state = emptyState();
  state = applyRecord(state, call({ model: 'kilo/fast' }));
  state = applyRecord(state, call({ model: 'kilo/silent', ok: false, output: 0, decodeTokens: 0, ttftMs: undefined }));
  const rows = byModel(state);
  const fast = rows.find((row) => row.model === 'kilo/fast');
  const silent = rows.find((row) => row.model === 'kilo/silent');
  assert.equal(fast.speed, 100);
  assert.equal(fast.firstTokenMs, 800);
  assert.equal(silent.speed, null);
  assert.equal(silent.firstTokenMs, null);
  assert.equal(silent.failed, 1);
});

test('per-model rows merge days without averaging rates', () => {
  let state = emptyState();
  state = applyRecord(state, call({ at: new Date('2026-09-30T12:00:00Z').getTime(), output: 100, decodeTokens: 100, decodeMs: 1000 }));
  state = applyRecord(state, call({ at: new Date('2026-10-01T12:00:00Z').getTime(), output: 100, decodeTokens: 100, decodeMs: 1000 }));
  const [row] = byModel(state);
  assert.equal(row.calls, 2);
  assert.equal(row.speed, 100, '200 tokens over 2s');
});

test('the heatmap spans the requested days and ends today', () => {
  const state = applyRecord(emptyState(), call());
  const cells = heatmap(state, 7, DAY);
  assert.equal(cells.length, 7);
  assert.equal(cells.at(-1).day, dayKey(DAY));
  assert.equal(cells.at(-1).tokens, 300);
  assert.equal(cells[0].tokens, 0, 'a day with no calls is zero, not missing');
});

test('the trend starts from the samples the window excludes, not from zero', () => {
  let state = emptyState();
  for (let i = 0; i < 10; i += 1) {
    state = applyRecord(state, call({ input: 10, output: 20 }));
  }
  const points = trend(state, 4);
  assert.equal(points.length, 4);
  // Ten calls of 30 tokens each. The window keeps the last four, so the
  // first plotted point must already include the six before it: 6*30 + 30.
  assert.equal(points[0].tokens, 210);
  assert.equal(points.at(-1).tokens, 10 * 30);
});

test('the sample ring is bounded', () => {
  let state = emptyState();
  for (let i = 0; i < 500; i += 1) state = applyRecord(state, call());
  assert.ok(state.samples.length <= 400, `ring should stay bounded, got ${state.samples.length}`);
  assert.equal(state.requests, 500, 'the lifetime counter must not be bounded');
});

test('old day buckets are pruned', () => {
  let state = emptyState();
  for (let i = 0; i < 200; i += 1) {
    const at = DAY + i * 86_400_000;
    state = applyRecord(state, call({ at }), 10);
  }
  assert.ok(Object.keys(state.days).length <= 10, `buckets should be trimmed, got ${Object.keys(state.days).length}`);
});

test('history survives a restart', (t) => {
  const file = path.join(scratchDir(t), 'stats.json');
  const first = new StatsStore(file);
  first.set(applyRecord(first.get(), call({ model: 'kilo/alpha' })));
  first.set(applyRecord(first.get(), call({ model: 'kilo/alpha' })));
  first.flush();
  first.dispose();

  // A fresh store is what the next DSH launch constructs. Without the file the
  // dashboard came back empty after every restart, which read as "the counter
  // is broken" rather than "the history was in memory".
  const second = new StatsStore(file);
  const summary = summarize(second.get(), DAY);
  assert.equal(summary.requests, 2);
  assert.equal(summary.totalTokens, 600);
  assert.equal(byModel(second.get())[0].model, 'kilo/alpha');
  second.dispose();
});

test('a missing file is a normal first run', (t) => {
  const store = new StatsStore(path.join(scratchDir(t), 'nested', 'stats.json'));
  assert.equal(store.get().requests, 0);
  store.dispose();
});

test('a damaged file is kept, not overwritten', (t) => {
  const dir = scratchDir(t);
  const file = path.join(dir, 'stats.json');
  fs.writeFileSync(file, '{ this is not json');
  const store = new StatsStore(file);
  assert.equal(store.get().requests, 0, 'a damaged file falls back to the default');
  store.set(applyRecord(store.get(), call()));
  store.flush();
  // The next flush renames a fresh document over the file, so the damaged one is
  // only recoverable if a copy was kept at load time.
  const backups = fs.readdirSync(dir).filter((name) => name.includes('.corrupt-'));
  assert.equal(backups.length, 1, `expected one backup, got ${JSON.stringify(backups)}`);
  store.dispose();
});

test('a file from another stats version is refused wholesale', (t) => {
  const file = path.join(scratchDir(t), 'stats.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    days: { '2026-10-01': { total: 999999, models: {} } },
    requests: 4242,
    samples: [],
  }));
  const store = new StatsStore(file);
  // Merging a day bucket whose meaning changed would report a total that no
  // longer matches its rows, so an unrecognised version is dropped whole.
  assert.equal(store.get().requests, 0);
  assert.deepEqual(store.get().days, {});
  store.dispose();
});

test('writes are coalesced and leave no temp file behind', (t) => {
  const dir = scratchDir(t);
  const file = path.join(dir, 'stats.json');
  const store = new StatsStore(file);
  let state = store.get();
  for (let i = 0; i < 5; i += 1) state = applyRecord(state, call());
  store.set(state);
  assert.equal(fs.existsSync(file), false, 'the write is deferred, not immediate');
  store.flush();
  assert.equal(fs.existsSync(file), true);
  assert.equal(
    fs.readdirSync(dir).some((name) => name.includes('.tmp')),
    false,
    'a temp file must not survive a completed write',
  );
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).requests, 5);
  store.dispose();
});

test('dispose flushes what the timer had not written yet', (t) => {
  const file = path.join(scratchDir(t), 'stats.json');
  const store = new StatsStore(file);
  store.set(applyRecord(store.get(), call()));
  // A teardown right after a turn must not drop the last 800ms of history.
  store.dispose();
  const reopened = new StatsStore(file);
  assert.equal(reopened.get().requests, 1);
  reopened.dispose();
});

test('usage rows carry a display name when the catalog knows one', () => {
  let state = emptyState();
  state = applyRecord(state, call({ model: 'zen/space-bunny-free' }));
  const labels = new Map([['zen/space-bunny-free', 'Space Bunny']]);
  const [named] = byModel(state, labels);
  assert.equal(named.name, 'Space Bunny');
  const [bare] = byModel(state);
  assert.equal(bare.name, 'zen/space-bunny-free', 'an unknown model falls back to its id');
});

test('the stats file lives under the harness home', () => {
  const file = statsFilePath('/tmp/dsh-home');
  assert.equal(file, path.join('/tmp/dsh-home', 'ai-proxy-dsh-bridge', 'stats.json'));
});
