/**
 * Derived from dsh-cmdgo-provider 0.9.1 (MIT, Copyright (c) 2026 Ajwyunsx).
 * Adapted from DSH credential storage to ai-proxy's Deno/edge runtime.
 * Upstream: https://github.com/Ajwyunsx/dsh-cmdgo-provider
 */

export interface CommandCodeAccount {
  id: string;
  apiKey: string;
  userId?: string;
  userName?: string;
  keyName?: string;
  addedAt: number;
  enabled: boolean;
  failCount: number;
  cooldownUntil?: number;
  lastError?: string;
  lastUsedAt?: number;
  source: "file" | "env";
}

export interface PublicCommandCodeAccount {
  id: string;
  userId?: string;
  userName?: string;
  keyName?: string;
  addedAt: number;
  enabled: boolean;
  failCount: number;
  cooldownUntil?: number;
  lastError?: string;
  lastUsedAt?: number;
  inFlight: number;
  source: "file" | "env";
}

interface Manifest {
  version: 1;
  accounts: CommandCodeAccount[];
}

export interface CommandCodePoolOptions {
  /** 0 means unlimited in-flight requests per account. */
  maxConcurrent?: number;
  /** Minimum spacing between request starts for one account. */
  minIntervalMs?: number;
}

function runningOnDenoDeploy(): boolean {
  try {
    return Boolean(Deno.env.get("DENO_DEPLOYMENT_ID"));
  } catch {
    return false;
  }
}

const COOLDOWN_BASE_MS = 30_000;
const COOLDOWN_MAX_MS = 15 * 60_000;

function slug(value: string | undefined): string {
  const cleaned = (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned ? cleaned.slice(0, 20) : "acct";
}

function randomSuffix(bytes = 3): string {
  const random = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function directoryOf(file: string): string {
  const normalized = file.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index < 0) return ".";
  if (index === 0) return "/";
  if (index === 2 && normalized[1] === ":") return normalized.slice(0, 3);
  return normalized.slice(0, index);
}

function publicAccount(
  account: CommandCodeAccount,
  inFlight = 0,
): PublicCommandCodeAccount {
  return {
    id: account.id,
    ...(account.userId === undefined ? {} : { userId: account.userId }),
    ...(account.userName === undefined ? {} : { userName: account.userName }),
    ...(account.keyName === undefined ? {} : { keyName: account.keyName }),
    addedAt: account.addedAt,
    enabled: account.enabled,
    failCount: account.failCount,
    ...(account.cooldownUntil === undefined
      ? {}
      : { cooldownUntil: account.cooldownUntil }),
    ...(account.lastError === undefined
      ? {}
      : { lastError: account.lastError }),
    ...(account.lastUsedAt === undefined
      ? {}
      : { lastUsedAt: account.lastUsedAt }),
    inFlight,
    source: account.source,
  };
}

function isStoredAccount(value: unknown): value is CommandCodeAccount {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" &&
    typeof record.apiKey === "string" &&
    typeof record.addedAt === "number" &&
    typeof record.enabled === "boolean" &&
    typeof record.failCount === "number";
}

/** Round-robin account pool persisted in a gitignored local JSON file. */
export class CommandCodeAccountPool {
  private accounts: CommandCodeAccount[] = [];
  private loaded = false;
  private loading: Promise<void> | undefined;
  private cursor = 0;
  private envFailCount = 0;
  private envCooldownUntil = 0;
  private envLastError: string | undefined;
  private readonly file: string;
  private readonly envApiKey: string | (() => string);
  private readonly log: (message: string) => void;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly maxConcurrent: number;
  private readonly minIntervalMs: number;
  private readonly inFlight = new Map<string, number>();
  private readonly nextStartAt = new Map<string, number>();
  private persist = (): Promise<void> => {
    this.writeChain = this.writeChain.then(
      () => this.writeNow(),
      () => this.writeNow(),
    );
    return this.writeChain;
  };

  private async writeNow(): Promise<void> {
    if (
      typeof Deno === "undefined" || !this.file ||
      runningOnDenoDeploy()
    ) return;
    const temporary = `${this.file}.${randomSuffix(4)}.tmp`;
    const payload: Manifest = { version: 1, accounts: this.accounts };
    try {
      await Deno.mkdir(directoryOf(this.file), {
        recursive: true,
        mode: 0o700,
      });
      await Deno.writeTextFile(temporary, JSON.stringify(payload, null, 2), {
        mode: 0o600,
      });
      await Deno.rename(temporary, this.file);
      try {
        await Deno.chmod(this.file, 0o600);
      } catch {
        // Windows may not implement POSIX modes; the file remains gitignored.
      }
    } catch (error) {
      try {
        await Deno.remove(temporary);
      } catch {
        // The temporary file may already be gone.
      }
      this.log(
        `[commandcode] account manifest write failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  constructor(
    file: string,
    envApiKey: string | (() => string),
    log?: (message: string) => void,
    options: CommandCodePoolOptions = {},
  ) {
    this.file = file;
    this.envApiKey = envApiKey;
    this.log = log ?? (() => {});
    this.maxConcurrent = Math.max(0, Math.floor(options.maxConcurrent ?? 0));
    this.minIntervalMs = Math.max(0, Math.floor(options.minIntervalMs ?? 0));
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.loading !== undefined) return this.loading;
    this.loading = this.load();
    await this.loading;
  }

  private async load(): Promise<void> {
    if (
      typeof Deno !== "undefined" && this.file &&
      !runningOnDenoDeploy()
    ) {
      try {
        const parsed = JSON.parse(
          await Deno.readTextFile(this.file),
        ) as Partial<Manifest>;
        if (Array.isArray(parsed.accounts)) {
          this.accounts = parsed.accounts.filter(isStoredAccount).map((
            account,
          ) => ({
            ...account,
            source: "file",
          }));
        }
      } catch (error) {
        const missing = error instanceof Deno.errors.NotFound;
        const denied = error instanceof Deno.errors.PermissionDenied;
        if (!missing && !denied) {
          this.log(
            `[commandcode] account manifest load failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        this.accounts = [];
      }
    }
    this.loaded = true;
    this.loading = undefined;
  }

  private envAccount(): CommandCodeAccount | undefined {
    const apiKey =
      (typeof this.envApiKey === "function" ? this.envApiKey() : this.envApiKey)
        .trim();
    if (!apiKey) return undefined;
    return {
      id: "env",
      apiKey,
      addedAt: 0,
      enabled: true,
      failCount: this.envFailCount,
      cooldownUntil: this.envCooldownUntil || undefined,
      lastError: this.envLastError,
      source: "env",
    };
  }

  async initialize(): Promise<void> {
    await this.ensureLoaded();
  }

  async list(): Promise<PublicCommandCodeAccount[]> {
    await this.ensureLoaded();
    if (this.accounts.length > 0) {
      return this.accounts.map((account) =>
        publicAccount(account, this.inFlight.get(account.id) ?? 0)
      );
    }
    const env = this.envAccount();
    return env ? [publicAccount(env, this.inFlight.get(env.id) ?? 0)] : [];
  }

  async size(): Promise<number> {
    await this.ensureLoaded();
    if (this.accounts.length > 0) return this.accounts.length;
    return this.envAccount() ? 1 : 0;
  }

  async schedulableCount(): Promise<number> {
    await this.ensureLoaded();
    if (this.accounts.length === 0) return this.envAccount() ? 1 : 0;
    return this.accounts.filter((account) => account.enabled).length;
  }

  async activeCount(now = Date.now()): Promise<number> {
    await this.ensureLoaded();
    if (this.accounts.length === 0) {
      const env = this.envAccount();
      return env && (env.cooldownUntil ?? 0) <= now ? 1 : 0;
    }
    return this.accounts.filter((account) =>
      account.enabled && (account.cooldownUntil ?? 0) <= now
    ).length;
  }

  async pick(
    exclude: ReadonlySet<string> = new Set(),
    now = Date.now(),
  ): Promise<CommandCodeAccount | undefined> {
    await this.ensureLoaded();
    if (this.accounts.length === 0) {
      const env = this.envAccount();
      return env && (env.cooldownUntil ?? 0) <= now ? env : undefined;
    }
    const enabled = this.accounts.filter((account) => account.enabled);
    if (enabled.length === 0) return undefined;
    const usable = enabled.filter((account) =>
      !exclude.has(account.id) && (account.cooldownUntil ?? 0) <= now
    );
    if (usable.length > 0) {
      const account = usable[this.cursor % usable.length];
      this.cursor = (this.cursor + 1) % usable.length;
      account.lastUsedAt = now;
      return account;
    }
    return undefined;
  }

  private canReserve(id: string, now: number): boolean {
    if (
      this.maxConcurrent > 0 &&
      (this.inFlight.get(id) ?? 0) >= this.maxConcurrent
    ) {
      return false;
    }
    return (this.nextStartAt.get(id) ?? 0) <= now;
  }

  private reserve(id: string, now: number): void {
    this.inFlight.set(id, (this.inFlight.get(id) ?? 0) + 1);
    if (this.minIntervalMs > 0) {
      this.nextStartAt.set(id, now + this.minIntervalMs);
    }
  }

  /** Pick and reserve an account for one request/continuation exchange. */
  async acquire(
    exclude: ReadonlySet<string> = new Set(),
    now = Date.now(),
  ): Promise<CommandCodeAccount | undefined> {
    await this.ensureLoaded();
    if (this.accounts.length === 0) {
      const env = this.envAccount();
      if (
        !env || (env.cooldownUntil ?? 0) > now || !this.canReserve(env.id, now)
      ) {
        return undefined;
      }
      env.lastUsedAt = now;
      this.reserve(env.id, now);
      return env;
    }
    const usable = this.accounts.filter((account) =>
      account.enabled && !exclude.has(account.id) &&
      (account.cooldownUntil ?? 0) <= now
    );
    for (let offset = 0; offset < usable.length; offset++) {
      const index = (this.cursor + offset) % usable.length;
      const account = usable[index];
      if (!this.canReserve(account.id, now)) continue;
      this.cursor = (index + 1) % usable.length;
      account.lastUsedAt = now;
      this.reserve(account.id, now);
      return account;
    }
    return undefined;
  }

  /** Release a reservation made by acquire. Safe to call once per request. */
  release(account: Pick<CommandCodeAccount, "id">): void {
    const current = this.inFlight.get(account.id) ?? 0;
    if (current <= 1) this.inFlight.delete(account.id);
    else this.inFlight.set(account.id, current - 1);
  }

  inFlightCount(): number {
    let total = 0;
    for (const value of this.inFlight.values()) total += value;
    return total;
  }

  async nextAvailableAt(now = Date.now()): Promise<number | undefined> {
    await this.ensureLoaded();
    if (this.accounts.length === 0) {
      const env = this.envAccount();
      if (!env) return undefined;
      return (env.cooldownUntil ?? 0) > now ? env.cooldownUntil : now;
    }
    const cooldowns = this.accounts
      .filter((account) =>
        account.enabled && (account.cooldownUntil ?? 0) > now
      )
      .map((account) => account.cooldownUntil!);
    return cooldowns.length > 0 ? Math.min(...cooldowns) : undefined;
  }

  async findById(id: string): Promise<CommandCodeAccount | undefined> {
    await this.ensureLoaded();
    if (this.accounts.length === 0 && id === "env") return this.envAccount();
    return this.accounts.find((account) => account.id === id);
  }

  async findByKey(apiKey: string): Promise<CommandCodeAccount | undefined> {
    await this.ensureLoaded();
    return this.accounts.find((account) => account.apiKey === apiKey);
  }

  async add(
    info: {
      apiKey: string;
      userId?: string;
      userName?: string;
      keyName?: string;
    },
  ): Promise<CommandCodeAccount> {
    await this.ensureLoaded();
    const existing = await this.findByKey(info.apiKey) ??
      (info.userId === undefined
        ? undefined
        : this.accounts.find((account) => account.userId === info.userId));
    if (existing !== undefined) {
      if (info.userId !== undefined) existing.userId = info.userId;
      if (info.apiKey) existing.apiKey = info.apiKey;
      if (info.userName !== undefined) existing.userName = info.userName;
      if (info.keyName !== undefined) existing.keyName = info.keyName;
      await this.persist();
      return existing;
    }
    const taken = new Set(this.accounts.map((account) => account.id));
    let id = slug(info.userName ?? info.keyName);
    if (id === "env" || taken.has(id)) id = `${id}-${randomSuffix()}`;
    while (taken.has(id)) id += randomSuffix(1);
    const account: CommandCodeAccount = {
      id,
      apiKey: info.apiKey,
      ...(info.userId === undefined ? {} : { userId: info.userId }),
      ...(info.userName === undefined ? {} : { userName: info.userName }),
      ...(info.keyName === undefined ? {} : { keyName: info.keyName }),
      addedAt: Date.now(),
      enabled: true,
      failCount: 0,
      source: "file",
    };
    this.accounts.push(account);
    await this.persist();
    return account;
  }

  async reportSuccess(account: CommandCodeAccount): Promise<void> {
    if (account.source === "env") {
      this.envFailCount = 0;
      this.envCooldownUntil = 0;
      this.envLastError = undefined;
      return;
    }
    if (
      account.failCount === 0 && account.cooldownUntil === undefined &&
      account.lastError === undefined
    ) return;
    account.failCount = 0;
    account.cooldownUntil = undefined;
    account.lastError = undefined;
    await this.persist();
  }

  async reportFailure(
    account: CommandCodeAccount,
    message: string,
    minimumCooldownMs = 0,
    now = Date.now(),
  ): Promise<void> {
    if (account.source === "env") {
      this.envFailCount += 1;
      const exponential = COOLDOWN_BASE_MS * 2 **
          Math.min(10, this.envFailCount - 1);
      this.envCooldownUntil = now + Math.max(
        Math.min(COOLDOWN_MAX_MS, exponential),
        minimumCooldownMs,
      );
      this.envLastError = message
        .replaceAll(account.apiKey, "[redacted]")
        .slice(0, 200);
      this.log(
        `[commandcode] env account failed; cooling for ${
          Math.round((this.envCooldownUntil - now) / 1000)
        }s: ${this.envLastError}`,
      );
      return;
    }
    account.failCount += 1;
    const exponential = COOLDOWN_BASE_MS * 2 **
        Math.min(10, account.failCount - 1);
    const cooldown = Math.max(
      Math.min(COOLDOWN_MAX_MS, exponential),
      minimumCooldownMs,
    );
    account.cooldownUntil = now + cooldown;
    account.lastError = message
      .replaceAll(account.apiKey, "[redacted]")
      .slice(0, 200);
    await this.persist();
    this.log(
      `[commandcode] account ${account.id} failed; cooling for ${
        Math.round(cooldown / 1000)
      }s: ${account.lastError}`,
    );
  }

  async toggle(id: string, enabled: boolean): Promise<boolean> {
    await this.ensureLoaded();
    const account = this.accounts.find((entry) => entry.id === id);
    if (account === undefined || account.enabled === enabled) return false;
    account.enabled = enabled;
    if (!enabled) account.cooldownUntil = undefined;
    await this.persist();
    return true;
  }

  async remove(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const index = this.accounts.findIndex((account) => account.id === id);
    if (index < 0) return false;
    this.accounts.splice(index, 1);
    this.cursor = 0;
    await this.persist();
    return true;
  }

  async clear(): Promise<number> {
    await this.ensureLoaded();
    const removed = this.accounts.length;
    this.accounts = [];
    this.cursor = 0;
    this.envFailCount = 0;
    this.envCooldownUntil = 0;
    this.envLastError = undefined;
    await this.persist();
    return removed;
  }
}
