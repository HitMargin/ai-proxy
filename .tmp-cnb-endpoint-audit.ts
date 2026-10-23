// Check whether cnb has added a model-listing endpoint since 2026-10-06
// (AGENTS.md records 5 paths all 404/Next.js "Page not found" then).
// Also probe for alternate routing fields (function/channel/provider) that,
// like TRAE's `function`, might carry the channel instead of `model`.

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
  raw = raw.trim().replace(/^[\"']|[\"']$/g, "");
  if (!raw) return "";
  return raw.split(";").map((s) => s.trim()).filter((s) =>
    s && !/^csrfkey=/i.test(s)
  )
    .join("; ");
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
  return { token: tm[1], csrfkey, html };
}

const creds = await fetchCsrf();
const cookies = await loginCookies();
const authCookie = "csrfkey=" + creds.csrfkey + (cookies ? "; " + cookies : "");

// ── part 1: model-listing endpoints ─────────────────────────────────────────
const MODEL_PATHS = [
  "/ai/models",
  "/ai/v1/models",
  "/api/models",
  "/v1/models",
  "/ai/chat/models",
  "/ai/chat/model",
  "/api/v1/models",
  "/api/ai/models",
  "/ai/config",
  "/ai/chat/config",
  "/api/ai/chat/models",
  "/ai/chat/completions/models",
];

console.log("=== part 1: model listing endpoints ===");
for (const p of MODEL_PATHS) {
  try {
    const r = await fetch("https://cnb.cool" + p, {
      headers: {
        "User-Agent": CNB_UA,
        "Accept": "application/json, text/plain, */*",
        "Referer": "https://cnb.cool/",
        "Cookie": authCookie,
        "Csrftoken": creds.token,
      },
      redirect: "follow",
    });
    const body = await r.text();
    const ct = r.headers.get("content-type") ?? "";
    const isJson = ct.includes("json");
    const snippet = body.replace(/\s+/g, " ").slice(0, 140);
    console.log(
      `  ${String(r.status).padEnd(4)} ${p.padEnd(30)} ${
        isJson ? "[json]" : "[html]"
      } ${snippet}`,
    );
  } catch (e) {
    console.log(`  ERR  ${p} -> ${String(e).slice(0, 100)}`);
  }
}

// ── part 2: alternate routing fields ────────────────────────────────────────
// If any of these actually select a backend, the upstream-reported model changes.
async function probeField(extra: Record<string, unknown>, label: string) {
  const body = {
    model: "deepseek-v4.1-flash",
    messages: [{ role: "user", content: "Reply with exactly: PONG" }],
    max_tokens: 16,
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
    const text = await r.text();
    const models = new Set<string>();
    let err = "";
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const d = line.slice(5).trim();
      if (d === "[DONE]") continue;
      try {
        const j = JSON.parse(d);
        if (j.model) models.add(String(j.model));
        if (j.error) err = JSON.stringify(j.error).slice(0, 120);
      } catch {}
    }
    console.log(
      `  ${String(r.status).padEnd(4)} ${label.padEnd(34)} upstream="${
        [...models].join(",") || "(none)"
      }" ${err ? "err=" + err : ""} ${Date.now() - t0}ms`,
    );
  } catch (e) {
    console.log(`  ERR  ${label} -> ${String(e).slice(0, 100)}`);
  }
}

console.log(
  "\n=== part 2: alternate routing fields (does anything else pick a backend?) ===",
);
await probeField({}, "baseline (no extra field)");
await probeField(
  { function: "solo_agent_remote" },
  "function=solo_agent_remote",
);
await probeField({ channel: "glm" }, "channel=glm");
await probeField({ provider: "glm" }, "provider=glm");
await probeField({ config_name: "glm-5.3" }, "config_name=glm-5.3");
await probeField({ enable_thinking: true }, "enable_thinking=true");
await probeField({ reasoning_effort: "high" }, "reasoning_effort=high");
await probeField({ thinking: { type: "enabled" } }, "thinking.type=enabled");

// ── part 3: what does the chat page itself advertise? ───────────────────────
console.log(
  "\n=== part 3: model names mentioned in the cnb.cool homepage bundle ===",
);
const html = creds.html;
const quoted = html.match(/["']([a-z0-9][a-z0-9.\-_]{2,40})["']/gi) ?? [];
const interesting = [
  ...new Set(
    quoted.map((s) => s.slice(1, -1)).filter((s) =>
      /^(deepseek|glm|qwen|kimi|claude|gpt|doubao|llama|mistral|grok)/i.test(
        s,
      ) &&
      !/\.(js|css|png|svg|woff|json)$/i.test(s)
    ),
  ),
];
console.log(
  `  html bytes=${html.length}, candidate model strings=${interesting.length}`,
);
for (const s of interesting.slice(0, 40)) console.log(`    ${s}`);

// find script srcs and grep them too
const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) =>
  m[1]
);
console.log(`  script tags with src: ${scripts.length}`);
for (const src of scripts.slice(0, 8)) {
  const url = src.startsWith("http")
    ? src
    : "https://cnb.cool" + (src.startsWith("/") ? src : "/" + src);
  try {
    const r = await fetch(url, { headers: { "User-Agent": CNB_UA } });
    const js = await r.text();
    const hits = [
      ...new Set(
        (js.match(/["']([a-z0-9][a-z0-9.\-_]{2,40})["']/gi) ?? [])
          .map((s) => s.slice(1, -1))
          .filter((s) =>
            /^(deepseek|glm|qwen|kimi|claude|gpt|doubao)[a-z0-9.\-_]*$/i.test(s)
          ),
      ),
    ];
    console.log(
      `    ${url.slice(0, 90)} (${js.length}B) -> ${
        hits.length ? hits.slice(0, 15).join(", ") : "no model strings"
      }`,
    );
  } catch (e) {
    console.log(`    ${url.slice(0, 70)} -> ERR ${String(e).slice(0, 60)}`);
  }
}
