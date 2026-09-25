/**
 * Derived from dsh-cmdgo-provider 0.9.1 (MIT, Copyright (c) 2026 Ajwyunsx).
 * Adapted from Node http to Deno's local listener API.
 * Upstream: https://github.com/Ajwyunsx/dsh-cmdgo-provider
 */

export const COMMANDCODE_STUDIO_BASE = "https://commandcode.ai";
const PORT_START = 5959;
const PORT_END = 5968;
const CALLBACK_TIMEOUT_MS = 10 * 60_000;
const MAX_CALLBACK_BYTES = 64 * 1024;

export interface CommandCodeLoginSuccess {
  apiKey: string;
  userId?: string;
  userName?: string;
  keyName?: string;
}

export type CommandCodeLoginStatus =
  | { status: "idle" }
  | {
    status: "waiting";
    authUrl: string;
    callbackUrl: string;
    startedAt: number;
  }
  | { status: "success"; userName?: string; keyName?: string; at: number }
  | { status: "error"; message: string; at: number };

interface CallbackPayload {
  apiKey?: unknown;
  state?: unknown;
  userId?: unknown;
  userName?: unknown;
  keyName?: unknown;
}

interface LocalServer {
  shutdown(): void;
  finished: Promise<void>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function randomBase64Url(bytes = 32): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of raw) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/g,
    "",
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": COMMANDCODE_STUDIO_BASE,
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "Content-Type",
      "access-control-allow-private-network": "true",
    },
  });
}

async function readLimitedText(
  request: Request,
  maximumBytes: number,
): Promise<string | undefined> {
  const declared = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > maximumBytes) return undefined;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      total += value.byteLength;
      if (total > maximumBytes) {
        try {
          await reader.cancel();
        } catch { /* already closed */ }
        return undefined;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    try {
      reader.releaseLock();
    } catch { /* already released */ }
  }
}

function runningOnDenoDeploy(): boolean {
  try {
    return Boolean(Deno.env.get("DENO_DEPLOYMENT_ID"));
  } catch {
    return false;
  }
}

/** One-shot local OAuth callback listener used by the CommandCode CLI login flow. */
export class CommandCodeLoginManager {
  private server?: LocalServer;
  private abort?: AbortController;
  private state?: string;
  private authUrl?: string;
  private callbackUrl?: string;
  private startedAt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private lastResult: CommandCodeLoginStatus = { status: "idle" };
  private pending?: {
    resolve: (value: CommandCodeLoginSuccess) => void;
    reject: (reason: Error) => void;
  };

  constructor(private readonly log: (message: string) => void = () => {}) {}

  get status(): CommandCodeLoginStatus {
    if (this.server && this.authUrl && this.callbackUrl) {
      return {
        status: "waiting",
        authUrl: this.authUrl,
        callbackUrl: this.callbackUrl,
        startedAt: this.startedAt,
      };
    }
    return this.lastResult;
  }

  isWaiting(): boolean {
    return Boolean(this.server && this.pending);
  }

  async start(): Promise<{ authUrl: string; callbackUrl: string }> {
    if (this.isWaiting() && this.authUrl && this.callbackUrl) {
      return { authUrl: this.authUrl, callbackUrl: this.callbackUrl };
    }
    if (typeof Deno === "undefined") {
      throw new Error(
        "Command Code local login is unavailable in this runtime",
      );
    }
    if (runningOnDenoDeploy()) {
      throw new Error("Command Code local login is unavailable on Deno Deploy");
    }
    await this.stop("new login requested");

    const { server, abort, port } = await this.bind();
    this.server = server;
    this.abort = abort;
    this.state = randomBase64Url();
    this.startedAt = Date.now();
    this.callbackUrl = `http://localhost:${port}/callback`;
    this.authUrl = `${COMMANDCODE_STUDIO_BASE}/studio/auth/cli?callback=${
      encodeURIComponent(this.callbackUrl)
    }&state=${encodeURIComponent(this.state)}`;
    this.timer = setTimeout(() => {
      this.finish({
        status: "error",
        message: "Command Code OAuth login timed out after 10 minutes",
        at: Date.now(),
      });
    }, CALLBACK_TIMEOUT_MS);

    this.log(`[commandcode] waiting for OAuth callback on ${this.callbackUrl}`);
    return { authUrl: this.authUrl, callbackUrl: this.callbackUrl };
  }

  waitForCallback(): Promise<CommandCodeLoginSuccess> {
    if (!this.server) {
      return Promise.reject(new Error("Command Code login was not started"));
    }
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }

  async stop(reason = "cancelled"): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.failPending(new Error(`Command Code login cancelled: ${reason}`));
    this.state = undefined;
    const server = this.server;
    this.server = undefined;
    this.abort?.abort();
    this.abort = undefined;
    if (server) {
      try {
        server.shutdown();
        await server.finished;
      } catch { /* already stopped */ }
    }
  }

  private failPending(error: Error): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(error);
  }

  private finish(
    result: CommandCodeLoginStatus,
    success?: CommandCodeLoginSuccess,
  ): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.lastResult = result;
    const pending = this.pending;
    this.pending = undefined;
    this.state = undefined;
    const server = this.server;
    this.server = undefined;
    this.abort?.abort();
    this.abort = undefined;
    try {
      server?.shutdown();
    } catch { /* already stopped */ }
    if (!pending) return;
    if (result.status === "success" && success) pending.resolve(success);
    else {
      pending.reject(
        new Error(
          result.status === "error"
            ? result.message
            : "Command Code login failed",
        ),
      );
    }
  }

  private async bind(): Promise<
    { server: LocalServer; abort: AbortController; port: number }
  > {
    let lastError: unknown;
    for (let port = PORT_START; port <= PORT_END; port++) {
      const abort = new AbortController();
      try {
        const server = await new Promise<LocalServer>((resolve, reject) => {
          let settled = false;
          const timeout = setTimeout(() => {
            if (!settled) {
              settled = true;
              abort.abort();
              reject(
                new Error(`Timed out binding OAuth callback port ${port}`),
              );
            }
          }, 3_000);
          let httpServer: LocalServer | undefined;
          try {
            httpServer = Deno.serve({
              hostname: "127.0.0.1",
              port,
              signal: abort.signal,
              onListen: () => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                // Deno may invoke onListen synchronously before Deno.serve returns.
                // Defer resolution until httpServer has been assigned.
                queueMicrotask(() => {
                  if (httpServer === undefined) {
                    reject(
                      new Error("OAuth callback server did not initialize"),
                    );
                    return;
                  }
                  resolve(httpServer);
                });
              },
            }, (request) => this.handleCallback(request));
          } catch (error) {
            settled = true;
            clearTimeout(timeout);
            reject(error);
            return;
          }
        });
        return { server, abort, port };
      } catch (error) {
        lastError = error;
        abort.abort();
        if (error instanceof Deno.errors.AddrInUse) continue;
        throw error;
      }
    }
    throw new Error(
      `No Command Code OAuth callback port available (${PORT_START}-${PORT_END}): ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }

  private async handleCallback(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/callback") {
      return jsonResponse({ success: false, error: "not found" }, 404);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: jsonResponse({}).headers,
      });
    }
    const origin = request.headers.get("origin");
    if (origin && origin !== COMMANDCODE_STUDIO_BASE) {
      return jsonResponse({ success: false, error: "origin rejected" }, 403);
    }
    const error = url.searchParams.get("error");
    if (error) {
      const returnedState = url.searchParams.get("state");
      if (!this.state || returnedState !== this.state) {
        return jsonResponse({ success: false, error: "state mismatch" }, 400);
      }
      this.finish({
        status: "error",
        message: `Command Code authorization failed: ${error}`,
        at: Date.now(),
      });
      return jsonResponse({ success: true });
    }
    if (request.method !== "POST") {
      return jsonResponse({ success: false, error: "method not allowed" }, 405);
    }

    const raw = await readLimitedText(request, MAX_CALLBACK_BYTES);
    if (raw === undefined) {
      return jsonResponse(
        { success: false, error: "callback body too large" },
        413,
      );
    }
    let payload: CallbackPayload;
    try {
      payload = JSON.parse(raw) as CallbackPayload;
    } catch {
      return jsonResponse({ success: false, error: "invalid JSON" }, 400);
    }
    const apiKey = optionalString(payload.apiKey);
    const state = optionalString(payload.state);
    if (!apiKey || !state) {
      return jsonResponse(
        { success: false, error: "missing apiKey or state" },
        400,
      );
    }
    if (!this.state || state !== this.state) {
      return jsonResponse({ success: false, error: "state mismatch" }, 400);
    }

    const userId = optionalString(payload.userId);
    const userName = optionalString(payload.userName);
    const keyName = optionalString(payload.keyName);
    const success: CommandCodeLoginSuccess = {
      apiKey,
      ...(userId !== undefined ? { userId } : {}),
      ...(userName !== undefined ? { userName } : {}),
      ...(keyName !== undefined ? { keyName } : {}),
    };
    this.log(
      `[commandcode] OAuth succeeded for ${success.userName ?? "unknown user"}`,
    );
    this.finish(
      {
        status: "success",
        ...(success.userName !== undefined
          ? { userName: success.userName }
          : {}),
        ...(success.keyName !== undefined ? { keyName: success.keyName } : {}),
        at: Date.now(),
      },
      success,
    );
    return jsonResponse({ success: true });
  }
}
