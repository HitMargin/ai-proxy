export type CatalogState = "ok" | "failed";

/**
 * What the aggregate roster knows about one channel's ability to answer.
 *
 * These are the only three things that can make a member legitimately silent,
 * and they are passed in rather than looked up so the dormant decision can be
 * tested without booting the server or reading the environment.
 */
export interface ChannelPresenceFacts {
  /** The channel's own auth block is satisfied (env var / default token). */
  hasCredential: boolean;
  /** WorkBuddy's credential is a login session file, not an env var. */
  workBuddyLoggedIn: boolean;
  /** How many user-defined upstreams exist under the `custom` channel. */
  customProviderCount: number;
}

/**
 * Whether a member is dormant - silent because it was never set up, not broken.
 *
 * The distinction matters because the roster's degraded verdict drives the cache
 * TTL: a member that SHOULD answer but came back empty means "retry in 15s", and
 * a dormant member means nothing at all. Every channel defaults to carrying its
 * own credential, so `auth: {type: "none"}` is not evidence that a channel can
 * answer - for WorkBuddy and `custom` it means the opposite: the real credential
 * lives somewhere the shared env check cannot see.
 *
 * Getting this wrong is not cosmetic. `custom` with no user-defined upstreams
 * always lists zero models, so treating it as "should answer" pinned the roster
 * to DEGRADED_TTL **forever**: measured over seven minutes, `/v1/models` was
 * fetched 21 times instead of ~2, and the trae/workbuddy catalogs were re-pulled
 * and re-logged four times over.
 */
export function isChannelDormant(
  key: string,
  facts: ChannelPresenceFacts,
): boolean {
  if (!facts.hasCredential) return true;
  if (key === "workbuddy" && !facts.workBuddyLoggedIn) return true;
  if (key === "custom" && facts.customProviderCount === 0) return true;
  return false;
}

/**
 * Whether a freshly fetched aggregate roster counts as degraded.
 *
 * "Degraded" means "shorter than it should be", so the real question is not
 * whether a member is missing but whether it was ever expected to answer. A
 * member with no credential is dormant by the user's own choice; counting it as
 * degraded pinned the roster to DEGRADED_TTL permanently - a 20x refetch rate
 * and a warning on every start, for a channel that would not answer until a key
 * was pasted. See {@link isChannelDormant} for the per-channel cases.
 */
export function isRosterDegraded(
  keys: readonly string[],
  members: Record<string, unknown[] | undefined>,
  isDormant: (key: string) => boolean,
): boolean {
  return keys.some((key) => {
    if (isDormant(key)) return false;
    const rows = members[key];
    return !Array.isArray(rows) || rows.length === 0;
  });
}

/**

 * What happened when the aggregate went to a member for its model list.

 *

 * This is separate from {@link ProviderHealthSnapshot} on purpose. A probe answers

 * "can this gateway serve a turn", and it only runs when someone asks for one. A

 * listing failure answers something else and more urgent — "this channel is missing

 * from the picker right now" — and it used to leave no trace at all: the member was

 * dropped from the response, so a roster quietly lost a channel with no error, no

 * log line and nothing in the health snapshot to explain it.

 */

export interface CatalogStatus {
  state: CatalogState;

  checkedAt: number | null;

  /** Rows the upstream returned, before the provider filter ran. */

  listedModels: number;

  /** Rows that survived the filter, which is what a picker can actually use. */

  keptModels: number;

  reason?: string;

  status?: number;
}

const EMPTY_CATALOG: CatalogStatus = {
  state: "ok",

  checkedAt: null,

  listedModels: 0,

  keptModels: 0,
};

/** Records one member listing outcome per aggregate request. */

export class CatalogRegistry {
  private readonly records = new Map<string, CatalogStatus>();

  ok(
    provider: string,
    listedModels: number,
    keptModels: number,
    now = Date.now(),
  ): void {
    this.records.set(provider, {
      state: "ok",

      checkedAt: now,

      listedModels,

      keptModels,
    });
  }

  failed(
    provider: string,
    reason: string,
    now = Date.now(),
    extra: { status?: number; listedModels?: number; keptModels?: number } = {},
  ): void {
    this.records.set(provider, {
      state: "failed",

      checkedAt: now,

      listedModels: extra.listedModels ?? 0,

      keptModels: extra.keptModels ?? 0,

      reason,

      ...(extra.status === undefined ? {} : { status: extra.status }),
    });
  }

  get(provider: string): CatalogStatus {
    // A copy, like HealthRegistry.get: a caller that kept the reference could edit
    // the record, and a panel row reading its verdict would rewrite the snapshot.
    const status = this.records.get(provider);
    return status ? { ...status } : { ...EMPTY_CATALOG };
  }

  all(): Record<string, CatalogStatus> {
    const result: Record<string, CatalogStatus> = {};

    for (const [provider, status] of this.records) {
      result[provider] = { ...status };
    }

    return result;
  }

  /** Providers whose last listing did not come back whole. */

  failures(): Record<string, CatalogStatus> {
    const result: Record<string, CatalogStatus> = {};

    for (const [provider, status] of this.records) {
      if (status.state === "failed") result[provider] = { ...status };
    }

    return result;
  }
}
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
