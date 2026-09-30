import {
  aggregateProbeSamples,
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
