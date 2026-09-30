// Egress selection for the Zen free tier.
//
// Zen meters anonymous quota per egress address, so a single IP runs out long
// before the models do. Rotating a pool of HTTP/HTTPS/SOCKS5 proxies spreads
// that quota across addresses. The pool is optional: with none configured the
// caller gets a direct connection and nothing else changes.
//
// Ported from YuJunZhiXue/Cline-proxy (internal/app/proxy_pool.go), which pairs
// the rotation with cooldown skipping. The TLS-fingerprint half of that file
// (utls HelloChrome_120) is deliberately not ported: Deno exposes no way to
// shape a ClientHello, so a Deno client cannot impersonate a browser at the
// TLS layer the way a Go program can.

export type ProxyStrategy = "round_robin" | "random" | "fill";

export interface EgressProxy {
  /** Raw proxy URL, e.g. http://user:pass@host:port or socks5://host:port. */
  url: string;
}

export interface EgressPoolOptions {
  proxies?: readonly string[];
  strategy?: ProxyStrategy;
  /** How long a failing exit is skipped before it is tried again. */
  cooldownMs?: number;
}

/** How long a failing exit is skipped when nothing else is configured. */
export const DEFAULT_EGRESS_COOLDOWN_MS = 10 * 60_000;

/** Parse a proxy URL, rejecting anything Deno's connector cannot dial. */
function parseProxy(raw: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (
    scheme !== "http" && scheme !== "https" && scheme !== "socks5" &&
    scheme !== "socks5h"
  ) {
    return undefined;
  }
  if (url.hostname === "") return undefined;
  return url;
}

/** Hide credentials so a proxy URL is safe to log or return over the API. */
export function maskProxyUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username === "" && url.password === "") return raw;
    url.username = "***";
    url.password = "";
    return url.toString();
  } catch {
    return raw;
  }
}

export class EgressPool {
  #proxies: URL[] = [];
  #strategy: ProxyStrategy = "round_robin";
  #cooldownMs = DEFAULT_EGRESS_COOLDOWN_MS;
  #cursor = 0;
  #cooldowns = new Map<number, number>();
  #failures = new Map<number, number>();

  constructor(options: EgressPoolOptions = {}) {
    this.configure(options);
  }

  configure(options: EgressPoolOptions = {}): void {
    const next: URL[] = [];
    for (const raw of options.proxies ?? []) {
      const parsed = parseProxy(String(raw).trim());
      // A bad entry is dropped rather than failing the whole config: one typo
      // must not take every working exit offline.
      if (parsed) next.push(parsed);
    }
    const changed = next.length !== this.#proxies.length ||
      next.some((proxy, index) =>
        proxy.toString() !== this.#proxies[index]?.toString()
      );
    this.#proxies = next;
    const strategy = options.strategy;
    if (
      strategy === "round_robin" || strategy === "random" || strategy === "fill"
    ) {
      this.#strategy = strategy;
    }
    const cooldown = Number(options.cooldownMs);
    if (Number.isFinite(cooldown) && cooldown > 0) this.#cooldownMs = cooldown;
    if (changed) {
      // Indices no longer refer to the same exits, so their cooldowns are void.
      this.#cooldowns.clear();
      this.#failures.clear();
    }
  }

  get size(): number {
    return this.#proxies.length;
  }

  get strategy(): ProxyStrategy {
    return this.#strategy;
  }

  /** Masked proxy URLs, for the settings panel. */
  describe(): string[] {
    return this.#proxies.map((proxy) => maskProxyUrl(proxy.toString()));
  }

  /** Proxy URL plus its pool index, or undefined when the pool is empty. */
  pick(): { proxy: URL; index: number } | undefined {
    const total = this.#proxies.length;
    if (total === 0) return undefined;
    const base = this.#strategy === "fill"
      ? 0
      : this.#strategy === "random"
      ? Math.floor(Math.random() * total)
      : this.#cursor++ % total;
    const now = Date.now();
    let index = base;
    // Linear probe for a usable exit. When every exit is cooling down the
    // first one is returned anyway: refusing the request outright would be
    // worse than trying an exit that will probably recover.
    for (let step = 0; step < total; step += 1) {
      const until = this.#cooldowns.get(index);
      if (until === undefined || until <= now) break;
      index = (index + 1) % total;
    }
    return { proxy: this.#proxies[index], index };
  }

  /** Skip this exit for a while. Called when the upstream blames the address. */
  coolDown(index: number, ms?: number): void {
    if (index < 0 || index >= this.#proxies.length) return;
    const duration = Number.isFinite(ms) && (ms as number) > 0
      ? (ms as number)
      : this.#cooldownMs;
    this.#cooldowns.set(index, Date.now() + duration);
    this.#failures.set(index, (this.#failures.get(index) ?? 0) + 1);
  }

  /** Currently cooling exits, for the panel. */
  cooldowns(): { url: string; until: number; failures: number }[] {
    const now = Date.now();
    const out: { url: string; until: number; failures: number }[] = [];
    for (const [index, until] of this.#cooldowns) {
      const proxy = this.#proxies[index];
      if (!proxy) continue;
      if (until <= now) {
        this.#cooldowns.delete(index);
        continue;
      }
      out.push({
        url: maskProxyUrl(proxy.toString()),
        until,
        failures: this.#failures.get(index) ?? 0,
      });
    }
    return out.sort((a, b) => a.until - b.until);
  }
}

/** Read a pool from an env-style list: `http://a:1, socks5://b:2`. */
export function parseProxyList(value: string | undefined): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}
