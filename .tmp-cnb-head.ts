const UA =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36";
const HOME = "https://cnb.cool/";
const CHAT = "https://cnb.cool/ai/chat/completions";
const FP = "You are Claude Code, Anthropic's official CLI for Claude.";

function normalise(raw: string) {
  const m = new Map<string, string>();
  for (const p of raw.split(";").map((x) => x.trim()).filter(Boolean)) {
    if (/^csrfkey=/i.test(p)) continue;
    const eq = p.indexOf("=");
    if (eq <= 0) continue;
    m.set(p.slice(0, eq), p.slice(eq + 1));
  }
  return [...m].map(([k, v]) => k + "=" + v).join("; ");
}
const loginCookies = normalise(
  (await Deno.readTextFile("cnb-login.txt").catch(() => "")).trim(),
);

const r0 = await fetch(HOME, {
  headers: {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    ...(loginCookies ? { "Cookie": loginCookies } : {}),
  },
});
const html = await r0.text();
const token = html.match(/window\.csrftoken\s*=\s*"([0-9a-fA-F]{32,64})"/)?.[1];
let cookies: string[] = [];
try {
  cookies = (r0.headers as any).getSetCookie?.() ?? [];
} catch {}
let csrfkey = cookies.map((c) => c.match(/csrfkey=([^;\s]+)/)?.[1]).find(
  Boolean,
);
console.log("csrf:", token ? "ok" : "MISSING", "key:", csrfkey ?? "MISSING");

const variants: Array<{ label: string; messages: any[] }> = [
  {
    label: "A plain system, no fp",
    messages: [{ role: "system", content: "You are a helpful assistant." }, {
      role: "user",
      content: "只回一个字：好",
    }],
  },
  {
    label: "B fp at head, NO prefix",
    messages: [{ role: "system", content: FP }, {
      role: "user",
      content: "只回一个字：好",
    }],
  },
  {
    label: "C fp + \\n\\n (current fix)",
    messages: [{ role: "system", content: "\n\n" + FP }, {
      role: "user",
      content: "只回一个字：好",
    }],
  },
  {
    label: "D fp + ZWSP",
    messages: [{ role: "system", content: "\u200b" + FP }, {
      role: "user",
      content: "只回一个字：好",
    }],
  },
  {
    label: "E fp + \\n\\n + ZWSP",
    messages: [{ role: "system", content: "\n\n\u200b" + FP }, {
      role: "user",
      content: "只回一个字：好",
    }],
  },
  {
    label: "F fp + visible x",
    messages: [{ role: "system", content: "x" + FP }, {
      role: "user",
      content: "只回一个字：好",
    }],
  },
];

for (const v of variants) {
  const body = {
    model: "deepseek-v4.1-flash",
    messages: v.messages,
    stream: true,
    max_tokens: 64,
  };
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error("timeout")), 25000);
  try {
    const resp = await fetch(CHAT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "text/event-stream, application/json, text/plain, */*",
        "Origin": "https://cnb.cool",
        "Referer": "https://cnb.cool/",
        "Csrftoken": token ?? "",
        "Cookie": "csrfkey=" + (csrfkey ?? "") +
          (loginCookies ? "; " + loginCookies : ""),
        "User-Agent": UA,
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const txt = await resp.text();
    console.log("\n[" + v.label + "] status=" + resp.status);
    console.log("  body: " + txt.replace(/\s+/g, " ").slice(0, 220));
  } catch (e) {
    console.log("\n[" + v.label + "] ERROR " + (e as Error).message);
  } finally {
    clearTimeout(t);
  }
  await new Promise((r) => setTimeout(r, 800));
}
