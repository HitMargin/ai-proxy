/**
 * Capability metadata for the Zen gateway, read from the models.dev catalog.
 *
 * The Zen API answers `GET /models` with `{ id, object, created, owned_by }` and
 * nothing else — no context window, no output cap, no reasoning ladder. So every
 * number this proxy used to publish for a Zen model was invented here, and
 * invented badly: `ZEN_MODEL_LIMITS` fell back to one fixed pair for all eleven
 * models, overstating the cap on mimo by 2x and understating space-bunny by 8x.
 *
 * models.dev carries the same metadata for the same gateway — its `opencode`
 * entry names `https://opencode.ai/zen/v1` as its api — so the values below are
 * the provider's, not ours. The ladders are per-model and deliberately not
 * uniform: space-bunny publishes five efforts, deepseek-v4-flash publishes three,
 * longcat and ling are toggle-only, and mimo and nemotron expose none at all.
 * Collapsing that into one invented ladder is exactly the error this replaces.
 *
 * The catalog is ~5 MB of JSON, so it is never fetched on the request path: the
 * first lookup schedules a refresh and returns whatever is already cached. Set
 * `ZEN_CATALOG=off` to skip it entirely where that transient cost is unwelcome.
 */

import { ENV } from "./core.ts";

const CATALOG_URL = "https://models.dev/api.json";
const PROVIDER_ID = "opencode";
const TTL_MS = 12 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;

export interface ZenCatalogEntry {
  id: string;
  context: number;
  output: number;
  inputModalities: string[];
  reasoning: boolean;
  /**
   * The effort ids this model publishes, in upstream order. Empty when the model
   * exposes no ladder — either `toggle`-only or not controllable at all. Never
   * pad this with an invented "off": no upstream ladder contains one, because a
   * model that cannot be turned down is not a model with an off switch.
   */
  efforts: string[];
  toggleOnly: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInt(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? value as number
    : 0;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** Read one models.dev model record, or null when it carries nothing usable. */
export function parseZenCatalogEntry(raw: unknown): ZenCatalogEntry | null {
  if (!isPlainObject(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!id) return null;

  const limit = isPlainObject(raw.limit) ? raw.limit : {};
  const context = positiveInt(limit.context);
  const output = positiveInt(limit.output);
  const modalities = isPlainObject(raw.modalities) ? raw.modalities : {};

  // `reasoning_options` has three observed shapes and the difference matters:
  // a list carrying `{type:"effort",values:[…]}`, a bare `{type:"toggle"}`, and
  // an empty list on models that reason but cannot be dialled. Only the first
  // one yields a ladder; treating the empty list as absent would be right here
  // by accident, so it is matched explicitly instead.
  const options = Array.isArray(raw.reasoning_options)
    ? raw.reasoning_options
    : [];
  let efforts: string[] = [];
  let toggleOnly = false;
  for (const option of options) {
    if (!isPlainObject(option)) continue;
    const values = stringList(option.values);
    if (values.length > 0) {
      efforts = values;
      break;
    }
    if (option.type === "toggle") {
      toggleOnly = true;
      break;
    }
  }

  if (context === 0 && output === 0 && efforts.length === 0 && !toggleOnly) {
    return null;
  }
  return {
    id,
    context,
    output,
    inputModalities: stringList(modalities.input),
    reasoning: raw.reasoning === true,
    efforts,
    toggleOnly,
  };
}

/**
 * Index the `opencode` provider out of a models.dev payload.
 *
 * The full catalog is shared by many providers; only this one describes the
 * gateway this proxy fronts, so everything else is dropped at parse time and the
 * rest becomes collectable.
 */
export function parseZenCatalog(
  payload: unknown,
): Map<string, ZenCatalogEntry> {
  const out = new Map<string, ZenCatalogEntry>();
  if (!isPlainObject(payload)) return out;
  const provider = payload[PROVIDER_ID];
  const models = isPlainObject(provider) && isPlainObject(provider.models)
    ? provider.models
    : null;
  if (!models) return out;
  for (const [id, raw] of Object.entries(models)) {
    const entry = parseZenCatalogEntry(raw);
    if (entry) out.set(id, entry);
  }
  return out;
}

let cached: Map<string, ZenCatalogEntry> | null = null;
let cachedAt = 0;
let inFlight: Promise<Map<string, ZenCatalogEntry> | null> | null = null;

function enabled(): boolean {
  return String(ENV.ZEN_CATALOG ?? "").toLowerCase() !== "off";
}

/** Whether the catalog was left enabled, for callers that log about misses. */
export function zenCatalogEnabled(): boolean {
  return enabled();
}

/** The cached entry for a model id, or null when unknown or the catalog is off. */
export function zenCatalogEntry(id: string): ZenCatalogEntry | null {
  if (!enabled() || !cached) return null;
  return cached.get(id) ?? null;
}

export function zenCatalogLoaded(): boolean {
  return cached !== null;
}

/**
 * Refresh the catalog, coalescing concurrent callers onto one request.
 *
 * Never throws: a catalog miss must degrade to the proxy's previous behaviour,
 * not take the model list down with it.
 */
export function refreshZenCatalog(
  now = Date.now(),
): Promise<Map<string, ZenCatalogEntry> | null> {
  if (!enabled()) return Promise.resolve(null);
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const response = await fetch(CATALOG_URL, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        console.warn(
          `[zen] models.dev catalog returned HTTP ${response.status}; using the previous snapshot`,
        );
        return cached;
      }
      const parsed = parseZenCatalog(await response.json());
      if (parsed.size === 0) {
        console.warn(
          "[zen] models.dev catalog had no opencode entries; keeping the previous snapshot",
        );
        return cached;
      }
      cached = parsed;
      cachedAt = now;
      console.log(`[zen] models.dev catalog refreshed: ${parsed.size} models`);
      return parsed;
    } catch (error) {
      console.warn(
        `[zen] models.dev catalog fetch failed (${
          error instanceof Error ? error.message : String(error)
        }); using the previous snapshot`,
      );
      return cached;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * Refresh in the background when the snapshot is stale, and never block.
 *
 * The request path calls this and continues with whatever it already has, which
 * is why a cold cache costs one model list without capabilities rather than a
 * five-megabyte fetch inside a user's turn.
 */
export function ensureZenCatalog(now = Date.now()): void {
  if (!enabled()) return;
  if (cached && now - cachedAt < TTL_MS) return;
  const running = refreshZenCatalog(now);
  const host = globalThis as unknown as {
    EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void };
  };
  const waitUntil = host.EdgeRuntime?.waitUntil;
  if (typeof waitUntil === "function") {
    waitUntil(running);
  } else {
    // No edge runtime to hand it to; the rejection is already handled inside.
    void running;
  }
}

/** Test seam: install a snapshot without going to the network. */
export function __setZenCatalogForTest(
  entries: Map<string, ZenCatalogEntry> | null,
  now = Date.now(),
): void {
  cached = entries;
  cachedAt = entries ? now : 0;
}
