const MIN_REQUEST_INTERVAL_MS = 2_000;
const MAX_REQUEST_INTERVAL_MS = 4_000;
const LONG_RUN_THRESHOLD = 15;
const LONG_RUN_BREAK_MIN_MS = 60_000;
const LONG_RUN_BREAK_MAX_MS = 180_000;
const IDLE_RESET_MS = 10 * 60_000;

let running = false;
let lastFinishedAt = 0;
let consecutiveRequests = 0;
const waiters: Array<() => void> = [];

function randomDelay(min: number, max: number): number {
  return Math.round(min + Math.random() * Math.max(0, max - min));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serializes requests for the single DeepSeek web account.
 * The lease is held until the response stream is fully consumed.
 */
export async function acquireDeepseekGate(): Promise<() => void> {
  while (running) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  running = true;

  const now = Date.now();
  let waitMs = 0;
  if (lastFinishedAt > 0) {
    if (now - lastFinishedAt > IDLE_RESET_MS) consecutiveRequests = 0;
    const gap = randomDelay(MIN_REQUEST_INTERVAL_MS, MAX_REQUEST_INTERVAL_MS);
    waitMs = Math.max(0, lastFinishedAt + gap - now);
  }
  if (consecutiveRequests >= LONG_RUN_THRESHOLD) {
    consecutiveRequests = 0;
    waitMs = Math.max(
      waitMs,
      randomDelay(LONG_RUN_BREAK_MIN_MS, LONG_RUN_BREAK_MAX_MS),
    );
    console.warn(
      `[deepseek-gate] long-run protection: pausing ${
        Math.round(waitMs / 1000)
      }s`,
    );
  }
  if (waitMs > 0) await sleep(waitMs);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    consecutiveRequests += 1;
    lastFinishedAt = Date.now();
    running = false;
    waiters.shift()?.();
  };
}
