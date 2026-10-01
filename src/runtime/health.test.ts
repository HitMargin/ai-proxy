import {
  aggregateProbeSamples,
  CatalogRegistry,
  classifyProbeStatus,
  HealthRegistry,
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
