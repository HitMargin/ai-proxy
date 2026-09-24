export class AdapterLlmError extends Error {
  code: string;
  status?: number;
  retryAfterMs?: number;

  constructor(message: string, code = "PROVIDER_ERROR", options: { status?: number; retryAfterMs?: number; cause?: unknown } = {}) {
    super(message);
    this.name = "AdapterLlmError";
    this.code = code;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    if (options.cause !== undefined) (this as any).cause = options.cause;
  }
}
