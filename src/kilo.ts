// deno-lint-ignore-file no-explicit-any
/**
 * Kilo Gateway Device Flow OAuth (RFC 8628).
 *
 * Sources read from the official Kilo-Org/kilocode repository:
 *   packages/kilo-gateway/src/auth/device.ts  - initiate + poll endpoints
 *   packages/kilo-gateway/src/api/constants.ts - KILO_API_BASE, POLL_INTERVAL_MS
 *   packages/kilo-gateway/src/types.ts - DeviceAuthInitiateResponse/PollResponse
 *
 * Flow:
 *   1. POST {KILO_API_BASE}/api/device-auth/codes  -> { code, verificationUrl, expiresIn }
 *   2. User opens verificationUrl in browser and approves the code
 *   3. GET  {KILO_API_BASE}/api/device-auth/codes/{code} (poll every 3s)
 *      - 202 = still pending
 *      - 403 = user denied
 *      - 410 = code expired
 *      - 200 = { status:"approved", token, userEmail }
 *   4. Use the JWT with the new gateway: ai-gateway.kilo.ai/api/v1
 *      Rate limiting moves from per-IP (old anonymous endpoint) to per-account.
 */

const KILO_API_BASE = "https://api.kilo.ai";
const AI_GATEWAY_BASE = "https://ai-gateway.kilo.ai/api/v1";
const POLL_INTERVAL_MS = 3_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const CREDENTIAL_FILE = "kilo-auth.json";
const MAX_CREDENTIAL_FILE_BYTES = 64 * 1024;

export interface KiloDeviceAuthCode {
  code: string;
  verificationUrl: string;
  expiresIn: number;
}

export interface KiloDeviceAuthPoll {
  status: "pending" | "approved" | "denied" | "expired";
  token?: string;
  userEmail?: string;
}

export interface KiloAuthState {
  token: string;
  userEmail?: string;
  acquiredAt: number;
}

export type KiloLoginStatus =
  | { status: "idle" }
  | { status: "waiting"; verificationUrl: string; code: string; startedAt: number; expiresIn: number }
  | { status: "success"; userEmail?: string; at: number }
  | { status: "error"; message: string; at: number };

let authState: KiloAuthState | undefined;
let authStateLoaded = false;

function runningOnDenoDeploy(): boolean {
  try {
    return Boolean(Deno.env.get("DENO_DEPLOYMENT_ID"));
  } catch {
    return false;
  }
}

function projectRoot(): string {
  try {
    const scriptDir = new URL(".", import.meta.url).pathname.replace(
      /^\/(?:[A-Za-z]:)/,
      (match) => match.slice(1),
    );
    return scriptDir.replace(/\/src\/?$/, "").replace(/\/+$/, "") || ".";
  } catch {
    return ".";
  }
}

function credentialPath(): string {
  const root = projectRoot();
  return root.endsWith("/") || root.endsWith("\\")
    ? `${root}${CREDENTIAL_FILE}`
    : `${root}/${CREDENTIAL_FILE}`;
}

export async function loadKiloAuth(): Promise<KiloAuthState | undefined> {
  if (authStateLoaded && authState) return authState;
  if (runningOnDenoDeploy()) {
    authStateLoaded = true;
    return undefined;
  }
  try {
    const raw = await Deno.readTextFile(credentialPath());
    const parsed = JSON.parse(raw) as Partial<KiloAuthState>;
    if (typeof parsed.token === "string" && parsed.token.length > 10) {
      authState = {
        token: parsed.token,
        ...(typeof parsed.userEmail === "string" ? { userEmail: parsed.userEmail } : {}),
        acquiredAt: typeof parsed.acquiredAt === "number" ? parsed.acquiredAt : Date.now(),
      };
    }
  } catch {
    // No credential file yet - anonymous mode is fine.
  }
  authStateLoaded = true;
  return authState;
}

async function saveKiloAuth(state: KiloAuthState): Promise<void> {
  authState = state;
  authStateLoaded = true;
  if (runningOnDenoDeploy()) return;
  const raw = JSON.stringify(state, null, 2) + "\n";
  await Deno.writeTextFile(credentialPath(), raw);
}

export async function kiloToken(): Promise<string | undefined> {
  const state = await loadKiloAuth();
  return state?.token;
}

export function kiloGatewayBaseUrl(): string {
  return AI_GATEWAY_BASE;
}

async function initiateDeviceAuth(): Promise<KiloDeviceAuthCode> {
  const response = await fetch(`${KILO_API_BASE}/api/device-auth/codes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!response.ok) {
    if (response.status === 429) {
      throw new Error("Too many pending authorization requests. Please try again later.");
    }
    throw new Error(`Failed to initiate device authorization: ${response.status}`);
  }
  const data = await response.json() as KiloDeviceAuthCode;
  if (!data?.code || !data?.verificationUrl) {
    throw new Error("Device authorization response missing code or verificationUrl");
  }
  return data;
}

async function pollDeviceAuth(code: string): Promise<KiloDeviceAuthPoll> {
  const response = await fetch(`${KILO_API_BASE}/api/device-auth/codes/${encodeURIComponent(code)}`);
  if (response.status === 202) return { status: "pending" };
  if (response.status === 403) return { status: "denied" };
  if (response.status === 410) return { status: "expired" };
  if (!response.ok) {
    throw new Error(`Failed to poll device authorization: ${response.status}`);
  }
  return await response.json() as KiloDeviceAuthPoll;
}

/** One Kilo Device Flow login session, mirroring the official CLI's pattern. */
export class KiloLoginManager {
  private verificationUrl?: string;
  private deviceCode?: string;
  private startedAt = 0;
  private expiresIn = 0;
  private lastResult: KiloLoginStatus = { status: "idle" };
  private pending?: {
    resolve: (state: KiloAuthState) => void;
    reject: (reason: Error) => void;
  };
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly log: (message: string) => void = () => {}) {}

  get status(): KiloLoginStatus {
    if (this.deviceCode && this.verificationUrl && this.pending) {
      return {
        status: "waiting",
        verificationUrl: this.verificationUrl,
        code: this.deviceCode,
        startedAt: this.startedAt,
        expiresIn: this.expiresIn,
      };
    }
    return this.lastResult;
  }

  isWaiting(): boolean {
    return Boolean(this.pending && this.deviceCode);
  }

  async start(): Promise<{ verificationUrl: string; code: string; expiresIn: number }> {
    if (this.isWaiting() && this.verificationUrl && this.deviceCode) {
      return { verificationUrl: this.verificationUrl, code: this.deviceCode, expiresIn: this.expiresIn };
    }
    if (runningOnDenoDeploy()) {
      throw new Error("Kilo device login is unavailable on Deno Deploy (no browser interaction)");
    }
    await this.stop("new login requested");
    const initiated = await initiateDeviceAuth();
    this.deviceCode = initiated.code;
    this.verificationUrl = initiated.verificationUrl;
    this.expiresIn = initiated.expiresIn;
    this.startedAt = Date.now();

    const promise = new Promise<KiloAuthState>((resolve, reject) => {
      this.pending = { resolve, reject };
    });
    this.timer = setTimeout(() => {
      this.finish({ status: "error", message: "Kilo device login timed out", at: Date.now() });
    }, LOGIN_TIMEOUT_MS);
    this.pollLoop(promise).catch(() => {});

    this.log(
      `[kilo] device auth initiated; open ${initiated.verificationUrl} and enter code ${initiated.code}`,
    );
    return { verificationUrl: initiated.verificationUrl, code: initiated.code, expiresIn: initiated.expiresIn };
  }

  waitForApproval(): Promise<KiloAuthState> {
    if (!this.pending) {
      return Promise.reject(new Error("Kilo login was not started"));
    }
    return this.waitForApprovalInner();
  }

  private waitForApprovalInner(): Promise<KiloAuthState> {
    const existing = this.pending;
    if (!existing) return Promise.reject(new Error("Kilo login was not started"));
    return new Promise((resolve, reject) => {
      const originalResolve = existing.resolve;
      const originalReject = existing.reject;
      existing.resolve = (state) => { resolve(state); };
      existing.reject = (error) => { reject(error); };
      void originalResolve;
      void originalReject;
    });
  }

  async stop(reason = "cancelled"): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.failPending(new Error(`Kilo login cancelled: ${reason}`));
    this.deviceCode = undefined;
    this.verificationUrl = undefined;
  }

  private failPending(error: Error): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(error);
  }

  private finish(result: KiloLoginStatus, success?: KiloAuthState): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.lastResult = result;
    const pending = this.pending;
    this.pending = undefined;
    this.deviceCode = undefined;
    this.verificationUrl = undefined;
    if (!pending) return;
    if (result.status === "success" && success) pending.resolve(success);
    else {
      pending.reject(
        new Error(
          result.status === "error" ? result.message : "Kilo login failed",
        ),
      );
    }
  }

  private async pollLoop(promise: Promise<KiloAuthState>): Promise<void> {
    const code = this.deviceCode;
    if (!code) return;
    // Small initial wait so the user has a moment to open the page.
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    while (this.isWaiting() && this.deviceCode === code) {
      try {
        const poll = await pollDeviceAuth(code);
        if (poll.status === "approved" && poll.token) {
          const state: KiloAuthState = {
            token: poll.token,
            ...(poll.userEmail !== undefined ? { userEmail: poll.userEmail } : {}),
            acquiredAt: Date.now(),
          };
          await saveKiloAuth(state);
          this.log(
            `[kilo] device auth approved${poll.userEmail ? ` for ${poll.userEmail}` : ""}`,
          );
          this.finish({ status: "success", ...(poll.userEmail !== undefined ? { userEmail: poll.userEmail } : {}), at: Date.now() }, state);
          return;
        }
        if (poll.status === "denied") {
          this.finish({ status: "error", message: "User denied the Kilo authorization", at: Date.now() });
          return;
        }
        if (poll.status === "expired") {
          this.finish({ status: "error", message: "Kilo device code expired; run login again", at: Date.now() });
          return;
        }
      } catch (error) {
        this.log(
          `[kilo] poll error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }
}

export const kiloLoginManager = new KiloLoginManager((message) => console.info(message));

export async function kiloStatusSummary(): Promise<{
  configured: boolean;
  userEmail?: string;
  gatewayBaseUrl: string;
}> {
  const state = await loadKiloAuth();
  return {
    configured: state !== undefined,
    ...(state?.userEmail !== undefined ? { userEmail: state.userEmail } : {}),
    gatewayBaseUrl: AI_GATEWAY_BASE,
  };
}
