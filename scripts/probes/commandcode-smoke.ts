#!/usr/bin/env -S deno run --allow-env --allow-net
/**
 * Manual, opt-in smoke probe for a locally running ai-proxy.
 *
 * This never reads COMMANDCODE_API_KEY, OAuth files, or session files. It only
 * calls the local proxy, so the proxy's existing credential and account policy
 * remains the source of truth. Live calls are deliberately gated to avoid
 * spending upstream quota from an accidental CI run.
 */

interface Options {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  stream: boolean;
  confirm: boolean;
}

function usage(): string {
  return [
    "Usage:",
    "  deno run --allow-env --allow-net scripts/probes/commandcode-smoke.ts \\",
    "    --base-url http://127.0.0.1:8000 \\",
    "    --model deepseek/deepseek-v4-flash \\",
    "    --confirm-live",
    "",
    "Set AI_PROXY_API_KEY or API_KEYS when the local proxy requires auth.",
    "The probe prints metadata only; it does not print model output or secrets.",
  ].join("\n");
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    baseUrl: "http://127.0.0.1:8000",
    model: "deepseek/deepseek-v4-flash",
    timeoutMs: 120_000,
    stream: false,
    confirm: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = () => {
      const value = args[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };
    switch (arg) {
      case "--base-url":
        options.baseUrl = next();
        break;
      case "--model":
        options.model = next();
        break;
      case "--timeout-ms":
        options.timeoutMs = Number(next());
        break;
      case "--stream":
        options.stream = true;
        break;
      case "--confirm-live":
        options.confirm = true;
        break;
      case "--help":
      case "-h":
        console.log(usage());
        Deno.exit(0);
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1000) {
    throw new Error("--timeout-ms must be an integer >= 1000");
  }
  const url = new URL(options.baseUrl);
  const loopback = url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" || url.hostname === "[::1]" ||
    url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("--base-url must use HTTPS unless it is loopback HTTP");
  }
  return options;
}

function clientHeaders(): Headers {
  const headers = new Headers({ "content-type": "application/json" });
  const key = Deno.env.get("AI_PROXY_API_KEY") ||
    (Deno.env.get("API_KEYS") || "").split(",").map((v) => v.trim()).find(
      Boolean,
    );
  if (key) headers.set("authorization", `Bearer ${key}`);
  return headers;
}

function summarizeJson(payload: unknown): Record<string, unknown> {
  const body = payload as Record<string, any>;
  const choice = body?.choices?.[0];
  const content = typeof choice?.message?.content === "string"
    ? choice.message.content
    : "";
  return {
    id: typeof body?.id === "string" ? body.id : undefined,
    model: typeof body?.model === "string" ? body.model : undefined,
    finishReason: choice?.finish_reason ?? null,
    contentChars: content.length,
    usage: body?.usage ?? null,
  };
}

function summarizeStream(text: string): Record<string, unknown> {
  let frames = 0;
  let done = false;
  let contentChars = 0;
  let finishReason: unknown = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") {
      done = true;
      continue;
    }
    frames++;
    try {
      const chunk = JSON.parse(data);
      const choice = chunk?.choices?.[0];
      if (typeof choice?.delta?.content === "string") {
        contentChars += choice.delta.content.length;
      }
      if (choice?.finish_reason != null) finishReason = choice.finish_reason;
    } catch {
      // Ignore an incomplete/annotation frame; the HTTP status is reported too.
    }
  }
  return { frames, done, contentChars, finishReason };
}

if (import.meta.main) {
  try {
    const options = parseArgs(Deno.args);
    if (!options.confirm) {
      console.error("Refusing a live call without --confirm-live.");
      console.error(usage());
      Deno.exit(2);
    }
    const endpoint = new URL(
      "/commandcode/v1/chat/completions",
      options.baseUrl,
    );
    const response = await fetch(endpoint, {
      method: "POST",
      headers: clientHeaders(),
      body: JSON.stringify({
        model: options.model,
        messages: [{
          role: "user",
          content: "Reply with the single word: pong",
        }],
        max_tokens: 32,
        stream: options.stream,
      }),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    const text = await response.text();
    let summary: Record<string, unknown>;
    if (options.stream) {
      summary = summarizeStream(text);
    } else {
      try {
        summary = summarizeJson(JSON.parse(text));
      } catch {
        summary = { bodyChars: text.length };
      }
    }
    console.log(JSON.stringify(
      {
        status: response.status,
        ok: response.ok,
        model: options.model,
        stream: options.stream,
        ...summary,
      },
      null,
      2,
    ));
    if (!response.ok) Deno.exit(1);
  } catch (error) {
    console.error(
      `smoke probe failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    Deno.exit(1);
  }
}
