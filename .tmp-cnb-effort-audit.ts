// Do the newly-discovered "-max" / "-high" suffixes actually change behavior?
// All model names return the same upstream "model" string, so the ONLY
// discriminator is observable behavior. Use a prompt that reliably elicits
// reasoning, and compare reasoning volume + latency across variants and across
// reasoning_effort values. Multiple samples to separate signal from noise.

const LOGIN_FILE = "./cnb-login.txt";
const CNB_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const CNB_HOME = "https://cnb.cool/";
const CNB_CHAT = "https://cnb.cool/ai/chat/completions";

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
  return raw.split(";").map((s) => s.trim())
    .filter((s) => s && !/^csrfkey=/i.test(s)).join("; ");
}

async function fetchCsrf() {
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
  if (!csrfkey) throw new Error("csrfkey not found");
  return { token: tm[1], csrfkey };
}

const creds = await fetchCsrf();
const cookies = await loginCookies();
const authCookie = "csrfkey=" + creds.csrfkey + (cookies ? "; " + cookies : "");

// A prompt that reliably triggers chain-of-thought in a reasoning model.
const PROMPT =
  "A farmer has 17 sheep. All but 9 die. Then he buys 3 more, and half of the " +
  "total wander off. How many sheep remain? Show your reasoning step by step, " +
  "then give the final number.";

type Result = {
  label: string;
  model: string;
  effort?: string;
  ms: number;
  reasoningChars: number;
  contentChars: number;
  content: string;
  upstreamModel: string;
  err?: string;
};

async function probe(
  label: string,
  model: string,
  extra: Record<string, unknown> = {},
  effort?: string,
): Promise<Result> {
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: PROMPT }],
    max_tokens: 900,
    stream: true,
    ...extra,
  };
  const t0 = Date.now();
  try {
    const r = await fetch(CNB_CHAT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "text/event-stream, application/json, text/plain, */*",
        "Origin": "https://cnb.cool",
        "Referer": "https://cnb.cool/",
        "Csrftoken": creds.token,
        "Cookie": authCookie,
        "User-Agent": CNB_UA,
      },
      body: JSON.stringify(body),
    });
    if (r.status !== 200) {
      const t = await r.text().catch(() => "");
      return {
        label,
        model,
        effort,
        ms: Date.now() - t0,
        reasoningChars: 0,
        contentChars: 0,
        content: "",
        upstreamModel: "",
        err: `${r.status} ${t.slice(0, 120)}`,
      };
    }
    const text = await r.text();
    let reasoning = 0, content = "", upstreamModel = "", err = "";
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const d = line.slice(5).trim();
      if (d === "[DONE]") continue;
      try {
        const j = JSON.parse(d);
        if (j.model) upstreamModel = String(j.model);
        if (j.error) err = JSON.stringify(j.error).slice(0, 120);
        const ch = j.choices?.[0]?.delta;
        if (ch?.reasoning_content) {
          reasoning += String(ch.reasoning_content).length;
        }
        if (ch?.content) content += String(ch.content);
      } catch {}
    }
    return {
      label,
      model,
      effort,
      ms: Date.now() - t0,
      reasoningChars: reasoning,
      contentChars: content.length,
      content: content.replace(/\s+/g, " ").slice(0, 70),
      upstreamModel,
      err,
    };
  } catch (e) {
    return {
      label,
      model,
      effort,
      ms: Date.now() - t0,
      reasoningChars: 0,
      contentChars: 0,
      content: "",
      upstreamModel: "",
      err: String(e).slice(0, 100),
    };
  }
}

const CASES: Array<[string, string, Record<string, unknown>, string?]> = [
  ["plain              ", "deepseek-v4.1-flash", {}, undefined],
  ["name -high         ", "deepseek-v4.1-flash-high", {}, undefined],
  ["name -max          ", "deepseek-v4.1-flash-max", {}, undefined],
  [
    "effort=low         ",
    "deepseek-v4.1-flash",
    { reasoning_effort: "low" },
    "low",
  ],
  [
    "effort=high        ",
    "deepseek-v4.1-flash",
    { reasoning_effort: "high" },
    "high",
  ],
  [
    "effort=max         ",
    "deepseek-v4.1-flash",
    { reasoning_effort: "max" },
    "max",
  ],
  [
    "effort=medium      ",
    "deepseek-v4.1-flash",
    { reasoning_effort: "medium" },
    "medium",
  ],
  [
    "effort=none        ",
    "deepseek-v4.1-flash",
    { reasoning_effort: "none" },
    "none",
  ],
  [
    "thinking disabled  ",
    "deepseek-v4.1-flash",
    { enable_thinking: false },
    "off",
  ],
];

const ROUNDS = 2;
const all: Result[] = [];
for (let round = 1; round <= ROUNDS; round++) {
  console.log(`\n===== round ${round} =====`);
  for (const [label, model, extra, effort] of CASES) {
    const res = await probe(label.trim(), model, extra, effort);
    all.push(res);
    if (res.err) {
      console.log(`  ${label} ERR ${res.err}`);
      continue;
    }
    console.log(
      `  ${label} ${String(res.ms).padStart(6)}ms  reason=${
        String(res.reasoningChars).padStart(5)
      }  content=${
        String(res.contentChars).padStart(4)
      }  upstream=${res.upstreamModel}`,
    );
  }
}

console.log("\n===== averages across rounds =====");
const byLabel = new Map<string, Result[]>();
for (const r of all) byLabel.set(r.label, [...(byLabel.get(r.label) ?? []), r]);
const summary: Array<
  { label: string; ms: number; reason: number; content: number }
> = [];
for (const [label, rs] of byLabel) {
  const ok = rs.filter((r) => !r.err);
  if (!ok.length) {
    console.log(`  ${label} all failed`);
    continue;
  }
  const avg = (f: (r: Result) => number) =>
    Math.round(ok.reduce((s, r) => s + f(r), 0) / ok.length);
  summary.push({
    label: label.trim(),
    ms: avg((r) => r.ms),
    reason: avg((r) => r.reasoningChars),
    content: avg((r) => r.contentChars),
  });
}
summary.sort((a, b) => b.reason - a.reason);
console.log("  label                  avg_ms  avg_reasoning  avg_content");
for (const s of summary) {
  console.log(
    `  ${s.label.padEnd(20)} ${String(s.ms).padStart(6)}  ${
      String(s.reason).padStart(13)
    }  ${String(s.content).padStart(11)}`,
  );
}

console.log("\n===== sample answers (do they agree?) =====");
for (const r of all.filter((r) => !r.err).slice(0, 9)) {
  console.log(`  ${r.label.trim().padEnd(20)} "${r.content}"`);
}
