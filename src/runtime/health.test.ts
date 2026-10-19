import {
  aggregateProbeSamples,
  CatalogRegistry,
  classifyProbeStatus,
  HealthRegistry,
  isChannelDormant,
  isRosterDegraded,
} from "./health.ts";

function equal<T>(actual: T, expected: T, message = ""): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      message ||
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("probe status separates availability, degradation, and refusal", () => {
  equal(classifyProbeStatus(200).state, "available");
  equal(classifyProbeStatus(429).state, "degraded");
  equal(classifyProbeStatus(503, "gateway busy").state, "degraded");
  equal(classifyProbeStatus(401).state, "unavailable");
  equal(classifyProbeStatus(404).state, "unavailable");
});

Deno.test("health aggregation does not let unknown empty a provider", () => {
  const snapshot = aggregateProbeSamples([
    { state: "available", checkedAt: 100 },
    { state: "unknown", checkedAt: 100 },
  ], 100);
  equal(snapshot.state, "degraded");
  equal(snapshot.modelCount, 2);
  equal(snapshot.unknownModels, 1);
  equal(snapshot.stale, false);
});

Deno.test("health registry reports stale observations", () => {
  const registry = new HealthRegistry();
  registry.record("kilo", [{ state: "available", checkedAt: 100 }], 100);
  equal(registry.get("kilo", 100).state, "available");
  equal(registry.get("kilo", 1_000_000).stale, true);
  equal(registry.get("unknown").state, "unknown");
  equal(Object.keys(registry.all(100)), ["kilo"]);
});

Deno.test("provider counts alone cannot name a throttled model", () => {
  // The provider snapshot only carries totals, which is exactly why the panel
  // needs the individual samples: two providers can share a summary and hide
  // completely different per-model verdicts.
  const snapshot = aggregateProbeSamples([
    { state: "available", checkedAt: 200 },
    { state: "degraded", checkedAt: 200, reason: "HTTP 429" },
  ], 200);
  equal(snapshot.state, "degraded");
  equal(snapshot.degradedModels, 1);
  equal(snapshot.availableModels, 1);
  equal(snapshot.unavailableModels, 0);
  // `lastReason` keeps the most recent refusal text for a summary view.
  equal(snapshot.lastReason, "HTTP 429");
});

Deno.test("a member listing is recorded with the counts on both sides of the filter", () => {
  const catalog = new CatalogRegistry();
  catalog.ok("kilo", 84, 17);
  equal(catalog.get("kilo"), {
    state: "ok",
    checkedAt: catalog.get("kilo").checkedAt,
    listedModels: 84,
    keptModels: 17,
  });
  equal(catalog.failures(), {});
});

Deno.test("a filter that empties the channel counts as failed, not fine", () => {
  const catalog = new CatalogRegistry();
  catalog.failed(
    "kilo",
    "all 17 listed models were removed by the provider filter",
    5,
    {
      status: 200,
      listedModels: 17,
      keptModels: 0,
    },
  );
  const status = catalog.get("kilo");
  equal(status.state, "failed");
  equal(status.listedModels, 17);
  equal(status.keptModels, 0);
  equal(status.status, 200);
  equal(Object.keys(catalog.failures()), ["kilo"]);
});

Deno.test("an unreachable member is recorded with its reason", () => {
  const catalog = new CatalogRegistry();
  catalog.failed("zen", "listing request failed: connection reset", 7);
  equal(catalog.get("zen").reason, "listing request failed: connection reset");
  equal(catalog.get("zen").status, undefined);
});

Deno.test("an unasked provider reads as fine and empty rather than broken", () => {
  const catalog = new CatalogRegistry();
  equal(catalog.get("never-fetched"), {
    state: "ok",
    checkedAt: null,
    listedModels: 0,
    keptModels: 0,
  });
  equal(catalog.failures(), {});
});

Deno.test("a recovery clears the failure", () => {
  const catalog = new CatalogRegistry();
  catalog.failed("kilo", "listing request failed: boom", 1);
  equal(Object.keys(catalog.failures()), ["kilo"]);
  catalog.ok("kilo", 84, 17, 2);
  equal(catalog.failures(), {});
  equal(catalog.get("kilo").state, "ok");
});

Deno.test("the registry hands out copies so a caller cannot edit the record", () => {
  const catalog = new CatalogRegistry();
  catalog.ok("kilo", 84, 17);
  const status = catalog.get("kilo");
  status.keptModels = 999;
  equal(catalog.get("kilo").keptModels, 17);
});

// ── degraded roster ──
//
// 「短」指的是「本该应答的没应答」。没配 key 的成员是用户自己选的休眠，不是短。
// 混为一谈会让名册永久停在 DEGRADED_TTL：20 倍的重拉频率，和每次启动一条警告。

Deno.test("a member with no credential cannot mark the roster degraded", () => {
  // openrouter 有 key 才可能应答，没 key 时聚合**根本不写这一项**。
  equal(
    isRosterDegraded(
      ["kilo", "openrouter"],
      { kilo: [{ id: "a" }] },
      (key) => key === "openrouter",
    ),
    false,
    "a dormant channel is not a short roster",
  );
});

Deno.test("a configured member that answered nothing still degrades the roster", () => {
  equal(
    isRosterDegraded(
      ["kilo", "zen"],
      { kilo: [{ id: "a" }], zen: [] },
      () => false,
    ),
    true,
  );
  equal(
    isRosterDegraded(["kilo", "zen"], { kilo: [{ id: "a" }] }, () => false),
    true,
    "an unset entry is a failed member, and must be counted",
  );
});

Deno.test("a roster nobody is missing is not degraded", () => {
  equal(
    isRosterDegraded(["kilo"], { kilo: [{ id: "a" }] }, () => false),
    false,
  );
  // 全休眠 = 全都不会应答 = 无从变短。这条是上面那条的反面，防止把
  // isDormant 写成「只要有一个休眠就返回 false」以外的东西。
  equal(isRosterDegraded(["a", "b"], {}, () => true), false);
});

// ---------- 2026-10-20：dormant 判错会把 TTL 永久压到 15 秒 ----------
//
// 这条 bug 之所以能活到今天，是因为「哪些成员该沉默」这个决定写在 main.ts
// 的调用点里，而 main.ts 一 import 就起服务器——测不了。判据搬出来之后，
// 每个渠道的沉默理由都可以单独钉住。
Deno.test("a channel is dormant for the reason that actually applies to it", () => {
  const facts = {
    hasCredential: true,
    workBuddyLoggedIn: true,
    customProviderCount: 1,
  };

  // 没有凭据的渠道：用户没配 key，沉默是选择。
  equal(
    isChannelDormant("openrouter", { ...facts, hasCredential: false }),
    true,
  );

  // WorkBuddy 的凭据是登录态文件，env 检查看不见它。
  equal(
    isChannelDormant("workbuddy", { ...facts, workBuddyLoggedIn: false }),
    true,
    "workbuddy without a login session must be dormant even though auth is 'none'",
  );
  equal(isChannelDormant("workbuddy", facts), false);

  // ★ 真正的坑：custom 的 auth 是 'none'（每个自定义上游自带 key），所以
  // hasCredential 恒真。没配上游时它必然空列表——必须当休眠，否则名册
  // 永久 degraded。这一条是本轮 bug 的回归测试。
  equal(
    isChannelDormant("custom", { ...facts, customProviderCount: 0 }),
    true,
    "custom with no upstreams configured must be dormant, not 'should answer but empty'",
  );
  equal(
    isChannelDormant("custom", facts),
    false,
    "custom with a configured upstream must be expected to answer",
  );

  // custom 的特殊性不能蔓延到别的渠道：它们没有「数量为 0」这种状态。
  equal(
    isChannelDormant("kilo", { ...facts, customProviderCount: 0 }),
    false,
    "customProviderCount must only affect the custom channel",
  );
});

Deno.test("an unconfigured custom channel does not pin the roster to degraded", () => {
  // 真实名册形状（2026-10-20 实测 153 个模型）：除 custom 外全部有行。
  const members: Record<string, unknown[]> = {
    kilo: [{}],
    zen: [{}],
    cnb: [{}],
    commandcode: [{}],
    "deepseek-web": [{}],
    workbuddy: [{}],
    trae: [{}],
    openrouter: [],
    zlkpro: [],
    custom: [],
  };
  const keys = Object.keys(members);
  const factsFor = (key: string) => ({
    hasCredential: key !== "openrouter" && key !== "zlkpro",
    workBuddyLoggedIn: true,
    customProviderCount: 0,
  });

  equal(
    isRosterDegraded(keys, members, (k) => isChannelDormant(k, factsFor(k))),
    false,
    "an unconfigured custom channel plus keyless channels is a healthy roster",
  );

  // 反过来：一个真该答的渠道回空，必须仍然判 degraded——别把判据放宽到失效。
  const broken = { ...members, trae: [] };
  equal(
    isRosterDegraded(keys, broken, (k) => isChannelDormant(k, factsFor(k))),
    true,
    "a credentialed channel returning nothing must still degrade the roster",
  );

  // custom 配了上游却回空，同样是坏的。
  equal(
    isRosterDegraded(
      keys,
      members,
      (k) => isChannelDormant(k, { ...factsFor(k), customProviderCount: 2 }),
    ),
    true,
    "custom with upstreams configured but no rows is a real failure",
  );
});
