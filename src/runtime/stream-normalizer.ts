export type ResponseShape = "sse" | "json" | "empty" | "unknown";

export interface InspectedBody {
  shape: ResponseShape;
  head: Uint8Array;
  body: ReadableStream<Uint8Array> | null;
  timedOut?: boolean;
}

export interface StreamFailureOptions {
  /** Signals that mean the caller deliberately cancelled the request. */
  abortedSignals?: Array<AbortSignal | undefined>;
  /** Signal owned by the proxy's deadline. */
  timeoutSignal?: AbortSignal;
  /** Whether any response bytes were already delivered to the client. */
  deliveredOutput?: boolean;
}

export type StreamFailureKind =
  | "aborted"
  | "timeout"
  | "stream_cut"
  | "transport";

const DEFAULT_SNIFF_BYTES = 4096;
const DEFAULT_SNIFF_TIMEOUT_MS = 15_000;

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** Classify a response body by its bytes, not only by its Content-Type. */
export function classifyResponseShape(bytes: Uint8Array): ResponseShape {
  if (bytes.length === 0) return "empty";
  const text = new TextDecoder().decode(bytes).replace(/^\uFEFF/, "").trim();
  if (text.length === 0) return "empty";
  if (/(?:^|\n)\s*(?:event|data|id|retry):/m.test(text)) return "sse";
  if (text.startsWith("{") || text.startsWith("[")) return "json";
  return "unknown";
}

/**
 * Read a bounded prefix while retaining the complete body for the caller.
 * The returned stream replays the prefix before continuing the reader.
 */
export async function inspectResponseBody(
  response: Response,
  maximumBytes = DEFAULT_SNIFF_BYTES,
  timeoutMs = DEFAULT_SNIFF_TIMEOUT_MS,
): Promise<InspectedBody> {
  const limit = Number.isSafeInteger(maximumBytes) && maximumBytes > 0
    ? maximumBytes
    : DEFAULT_SNIFF_BYTES;
  const deadline = Number.isFinite(timeoutMs)
    ? Math.max(1, timeoutMs)
    : DEFAULT_SNIFF_TIMEOUT_MS;
  if (!response.body) {
    return { shape: "empty", head: new Uint8Array(), body: null };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let done = false;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel(new Error("response body sniff timed out")).catch(
      () => {},
    );
  }, deadline);
  try {
    while (total < limit && !timedOut) {
      const result = await reader.read();
      if (result.done) {
        done = true;
        break;
      }
      chunks.push(result.value);
      total += result.value.byteLength;
    }
  } catch (error) {
    clearTimeout(timer);
    try {
      await reader.cancel(error);
    } catch { /* already closed */ }
    try {
      reader.releaseLock();
    } catch { /* already released */ }
    throw error;
  }
  clearTimeout(timer);
  if (timedOut) done = true;

  const head = concatBytes(chunks, total);
  const shape = classifyResponseShape(head);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (head.length > 0) controller.enqueue(head);
      if (done) {
        try {
          reader.releaseLock();
        } catch { /* already released */ }
        controller.close();
        return;
      }
      void (async () => {
        try {
          while (true) {
            const result = await reader.read();
            if (result.done) break;
            controller.enqueue(result.value);
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        } finally {
          try {
            reader.releaseLock();
          } catch { /* already released */ }
        }
      })();
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { shape, head, body, timedOut };
}

/** Rebuild a Response after body inspection, optionally correcting Content-Type. */
export function replayResponse(
  response: Response,
  inspected: InspectedBody,
  contentType?: string,
): Response {
  const headers = new Headers(response.headers);
  if (contentType) headers.set("Content-Type", contentType);
  return new Response(inspected.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Read the inspected body as text without losing the replay prefix. */
export async function readInspectedText(
  inspected: InspectedBody,
): Promise<string> {
  if (!inspected.body) return "";
  return await new Response(inspected.body).text();
}

function isAbortedError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { name?: unknown; code?: unknown; message?: unknown };
  return value.name === "AbortError" ||
    value.code === 20 ||
    (typeof value.message === "string" && /abort/i.test(value.message));
}

/**
 * Classify a stream failure so user cancellation is never mistaken for a
 * retryable transport error, and an already-delivered cut is never replayed.
 */
export function classifyStreamFailure(
  error: unknown,
  options: StreamFailureOptions = {},
): StreamFailureKind {
  if (options.abortedSignals?.some((signal) => signal?.aborted)) {
    return "aborted";
  }
  if (options.timeoutSignal?.aborted) return "timeout";
  if (isAbortedError(error)) return "aborted";
  if (options.deliveredOutput === true) return "stream_cut";
  return "transport";
}
