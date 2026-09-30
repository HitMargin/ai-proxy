export type HealthState =
  | "available"
  | "degraded"
  | "unavailable"
  | "unknown";

export interface ProbeSample {
  state: HealthState;
  status?: number;
  latencyMs?: number;
  reason?: string;
  checkedAt?: number;
}

export interface ProviderHealthSnapshot {
  state: HealthState;
  checkedAt: number | null;
  modelCount: number;
  availableModels: number;
  degradedModels: number;
  unavailableModels: number;
  unknownModels: number;
  lastStatus?: number;
  lastReason?: string;
  stale: boolean;
}

/**
 * Turn one HTTP probe into a state.  A gateway 5xx is not proof that a model is
 * gone, so it is degraded; only explicit refusal/credential errors are
 * unavailable. Network failures remain unknown and never empty a picker.
 */
export function classifyProbeStatus(
  status: number,
  reason?: string,
): ProbeSample {
  if (status >= 200 && status < 300) {
    return { state: "available", status };
  }
  if (status === 429 || status === 408 || status === 425 || status >= 500) {
    return {
      state: "degraded",
      status,
      ...(reason ? { reason } : {}),
    };
  }
  if (status === 401 || status === 403 || status === 407) {
    return {
      state: "unavailable",
      status,
      reason: reason ?? "upstream credentials rejected",
    };
  }
  return {
    state: "unavailable",
    status,
    reason: reason ?? `upstream returned HTTP ${status}`,
  };
}

/** Aggregate per-model probes without treating unknown as unavailable. */
export function aggregateProbeSamples(
  samples: readonly ProbeSample[],
  now = Date.now(),
  staleAfterMs = 15 * 60_000,
): ProviderHealthSnapshot {
  const checkedAt = samples.length === 0
    ? null
    : Math.max(...samples.map((sample) => sample.checkedAt ?? now));
  const counts = { available: 0, degraded: 0, unavailable: 0, unknown: 0 };
  let lastStatus: number | undefined;
  let lastReason: string | undefined;
  for (const sample of samples) {
    counts[sample.state]++;
    if (sample.status !== undefined) lastStatus = sample.status;
    if (sample.reason) lastReason = sample.reason;
  }
  const state: HealthState = samples.length === 0
    ? "unknown"
    : counts.available === samples.length
    ? "available"
    : counts.unavailable === samples.length
    ? "unavailable"
    : "degraded";
  return {
    state,
    checkedAt,
    modelCount: samples.length,
    availableModels: counts.available,
    degradedModels: counts.degraded,
    unavailableModels: counts.unavailable,
    unknownModels: counts.unknown,
    ...(lastStatus === undefined ? {} : { lastStatus }),
    ...(lastReason === undefined ? {} : { lastReason }),
    stale: checkedAt !== null && now - checkedAt > staleAfterMs,
  };
}

/** Small in-memory registry; safe to use in Deno, Workers, and tests. */
export class HealthRegistry {
  private readonly records = new Map<string, ProviderHealthSnapshot>();

  record(
    provider: string,
    samples: readonly ProbeSample[],
    now = Date.now(),
  ): ProviderHealthSnapshot {
    const snapshot = aggregateProbeSamples(samples, now);
    this.records.set(provider, snapshot);
    return { ...snapshot };
  }

  get(provider: string, now = Date.now()): ProviderHealthSnapshot {
    const snapshot = this.records.get(provider);
    if (!snapshot) {
      return aggregateProbeSamples([], now);
    }
    return {
      ...snapshot,
      stale: snapshot.checkedAt !== null &&
        now - snapshot.checkedAt > 15 * 60_000,
    };
  }

  all(now = Date.now()): Record<string, ProviderHealthSnapshot> {
    const result: Record<string, ProviderHealthSnapshot> = {};
    for (const provider of this.records.keys()) {
      result[provider] = this.get(provider, now);
    }
    return result;
  }
}
