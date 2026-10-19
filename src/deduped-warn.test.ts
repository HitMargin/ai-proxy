import { assert, assertEquals } from "jsr:@std/assert@1";
import { DedupedWarn } from "./deduped-warn.ts";

/**
 * 这批用例盯的是一段真实生产日志：`[v1] custom: no custom providers are
 * configured yet` 连续刷了约 60 行，把渠道报错、额度、上游 5xx 挤出了环形缓冲。
 *
 * 判据必须同时守住两端，缺一条就退回某种旧故障：
 *   ① 同一原因连续多次 → 只输出 1 行（防刷屏）
 *   ② 原因变化 / 恢复后再次变坏 → 必须输出（防「静默零」）
 */

Deno.test("a repeated reason is only reported once", () => {
  const seen: string[] = [];
  const warn = new DedupedWarn((m) => seen.push(m));
  for (let i = 0; i < 60; i += 1) {
    warn.warn("no custom providers are configured yet");
  }
  assertEquals(
    seen.length,
    1,
    `60 identical polls must produce one line, got ${seen.length}`,
  );
});

Deno.test("a changed reason is reported immediately", () => {
  const seen: string[] = [];
  const warn = new DedupedWarn((m) => seen.push(m));
  warn.warn("no custom providers are configured yet");
  warn.warn("the configured custom providers listed no models");
  assertEquals(
    seen,
    [
      "no custom providers are configured yet",
      "the configured custom providers listed no models",
    ],
    "a state change from 'not configured' to 'configured but empty' is exactly what the user needs to see",
  );
});

Deno.test("recovery re-arms the warning", () => {
  const seen: string[] = [];
  const warn = new DedupedWarn((m) => seen.push(m));
  warn.warn("boom"); // 第一次坏：报
  warn.reset(); // 恢复好
  warn.warn("boom"); // 又坏：必须再报一次
  assertEquals(
    seen.length,
    2,
    "after a recovery the same failure must be visible again, not silently swallowed",
  );
});

Deno.test("warn reports whether it emitted", () => {
  const warn = new DedupedWarn(() => {});
  assert(warn.warn("x"), "the first occurrence emits");
  assert(!warn.warn("x"), "the duplicate does not emit");
  assert(warn.warn("y"), "a new reason emits");
});

Deno.test("the last reason is readable for diagnostics", () => {
  const warn = new DedupedWarn(() => {});
  assertEquals(warn.lastReason, "");
  warn.warn("alpha");
  assertEquals(warn.lastReason, "alpha");
});
