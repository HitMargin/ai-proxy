// Direct upstream probe for cnb: bypasses the proxy's model echo.
// Replicates src/cnb.ts's header construction (CSRF token + csrfkey cookie pair,
// fetched from the homepage WITH the login cookies so both come from one session).
//
// Run: deno run -A .tmp-cnb-model-audit.ts

const CNB_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const CNB_HOME = "https://cnb.cool/";
const CNB_CHAT = "https://cnb.cool/ai/chat/completions";
const LOGIN_FILE = "./cnb-login.txt";

async function loginCookies(): Promise<string> {
  let raw = "";
  try {
    raw = Deno.env.get("CNB_LOGIN_COOKIES") ?? "";
  } catch {}
  if (!raw.trim()) {
    try {
      raw = await Deno.readTextFile(LOGIN_FILE);
    } catch {}
  }
  raw = raw.trim().replace(/^["']|["']$/g, "");
  if (!raw) return "";
  // strip any csrfkey the user pasted: we pair a fresh token+key ourselves
  return raw
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s && !/^csrfkey=/i.test(s))
    .join("; ");
}

async function fetchCsrf(): Promise<{ token: string; csrfkey: string }> {
  const cookies = await loginCookies();
  const r = await fetch(CNB_HOME, {
    headers: {
      "User-Agent": CNB_UA,
      "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      ...(cookies ? { Cookie: cookies } : {}),
    },
  });
  const html = await r.text();
  const tm = html.match(/window\.csrftoken\s*=\s*"([0-9a-fA-F]{32,64})"/);
  if (!tm) throw new Error("csrftoken not found");
  let setCookies: string[] = [];
  try {
    if (typeof (r.headers as any).getSetCookie === "function") {
      setCookies = (r.headers as any).getSetCookie();
    }
  } catch {}
  if (!setCookies.length) {
    const rawH = r.headers.get("set-cookie") || "";
    if (rawH) setCookies = rawH.split(/,(?=\s*[A-Za-z0-9_-]+=)/);
  }
  let csrfkey: string | null = null;
  for (const c of setCookies) {
    const m = c.match(/csrfkey=([^;\s]+)/);
    if (m) {
      csrfkey = m[1];
      break;
    }
  }
  if (!csrfkey) throw new Error("csrfkey not found in Set-Cookie");
  return { token: tm[1], csrfkey };
}

async function rawChat(
  creds: { token: string; csrfkey: string },
  body: unknown,
): Promise<Response> {
  const cookies = await loginCookies();
  return await fetch(CNB_CHAT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "text/event-stream, application/json, text/plain, */*",
      "Origin": "https://cnb.cool",
      "Referer": "https://cnb.cool/",
      "Csrftoken": creds.token,
      Cookie: "csrfkey=" + creds.csrfkey + (cookies ? "; " + cookies : ""),
      "User-Agent": CNB_UA,
    },
    body: JSON.stringify(body),
  });
}

function makeBody(model: string) {
  return {
    model,
    messages: [{ role: "user", content: "Reply with exactly: PONG" }],
    max_tokens: 24,
    stream: true,
  };
}

// Collect the raw SSE frames; report every distinct "model" (and id) the
// UPSTREAM itself puts on the wire, plus any error envelope.
async function probe(
  creds: { token: string; csrfkey: string },
  model: string,
): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  let r: Response;
  try {
    r = await rawChat(creds, makeBody(model));
  } catch (e) {
    return { model, transportError: String(e).slice(0, 160) };
  }
  if (r.status !== 200) {
    const text = await r.text().catch(() => "");
    return {
      model,
      status: r.status,
      ms: Date.now() - t0,
      errorBody: text.slice(0, 400),
    };
  }
  const text = await r.text();
  const ms = Date.now() - t0;
  const models = new Set<string>();
  const ids = new Set<string>();
  let content = "";
  let reasoning = 0;
  let frameCount = 0;
  let done = false;
  let errFrame: string | null = null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const d = line.slice(5).trim();
    if (d === "[DONE]") {
      done = true;
      continue;
    }
    frameCount++;
    try {
      const j = JSON.parse(d);
      if (j.model) models.add(String(j.model));
      if (j.id) ids.add(String(j.id));
      if (j.error) errFrame = JSON.stringify(j.error).slice(0, 300);
      const ch = j.choices?.[0];
      if (ch?.delta?.content) content += ch.delta.content;
      if (ch?.delta?.reasoning_content) {
        reasoning += ch.delta.reasoning_content.length;
      }
    } catch {
      /* keep going */
    }
  }
  return {
    model,
    status: r.status,
    ms,
    upstreamReportedModels: [...models],
    upstreamIds: [...ids].slice(0, 2),
    content: content.replace(/\s+/g, " ").slice(0, 40),
    reasoningChars: reasoning,
    frames: frameCount,
    sawDone: done,
    errFrame,
    ssePreview: text.slice(0, 300).replace(/\n/g, "\\n"),
  };
}

const creds = await fetchCsrf();
console.log(
  `CSRF ok: token=${creds.token.slice(0, 8)}… csrfkey=${creds.csrfkey}\n`,
);

const CASES = [
  "deepseek-v4.1-flash",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "deepseek-v4.1-pro",
  "deepseek-v4",
  "deepseek-chat",
  "deepseek-reasoner",
  "deepseek-v3.2",
  "deepseek-v3.1",
  "glm-5.3",
  "glm-5.3-flash",
  "qwen3.8-max",
  "qwen3.8-flash",
  "kimi-k3",
  "Doubao-Seed-Code",
  "claude-sonnet-4.5",
  "gpt-5.1",
  "definitely-not-a-model-xyz-123",
];

const rows: Record<string, unknown>[] = [];
for (const m of CASES) {
  const row = await probe(creds, m);
  rows.push(row);
  if (row.transportError) {
    console.log(`[ERR ] ${m} -> ${row.transportError}`);
    continue;
  }
  if (row.status !== 200) {
    console.log(`[HTTP] ${m} -> ${row.status} ${row.errorBody}`);
    continue;
  }
  const models = (row.upstreamReportedModels as string[]).join(",") || "(none)";
  const flag = row.reasoningChars ? "think" : "plain";
  console.log(
    `[ ok ] ${m.padEnd(26)} ${
      String(row.ms).padStart(5)
    }ms upstream="${models}" ` +
      `content="${row.content}" reasoning=${row.reasoningChars} frames=${row.frames} done=${row.sawDone} ${flag}`,
  );
  if (row.errFrame) console.log(`       error frame: ${row.errFrame}`);
}

console.log("\n=== grouping by UPSTREAM-reported model ===");
const groups = new Map<string, string[]>();
for (const r of rows) {
  if (r.status !== 200) continue;
  const ms = (r.upstreamReportedModels as string[]) ?? [];
  const key = ms.length ? ms.join(",") : "(none)";
  groups.set(key, [...(groups.get(key) ?? []), String(r.model)]);
}
for (const [k, v] of groups) console.log(`  "${k}" <- ${v.join(", ")}`);
