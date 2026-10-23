import { cnbBuildUpstream } from "./src/cnb.ts";
const UA =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36";
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
const login = normalise(
  (await Deno.readTextFile("cnb-login.txt").catch(() => "")).trim(),
);
const r0 = await fetch("https://cnb.cool/", {
  headers: { "User-Agent": UA, ...(login ? { "Cookie": login } : {}) },
});
const html = await r0.text();
const token = html.match(/window\.csrftoken\s*=\s*"([0-9a-fA-F]{32,64})"/)?.[1];
let cs: string[] = [];
try {
  cs = (r0.headers as any).getSetCookie?.() ?? [];
} catch {}
const csrfkey = cs.map((c) => c.match(/csrfkey=([^;\s]+)/)?.[1]).find(Boolean);
async function send(label: string, msgs: any[]) {
  const b: any = cnbBuildUpstream({
    model: "deepseek-v4.1-flash",
    messages: msgs,
    stream: true,
    max_tokens: 32,
  });
  const body = b.upstream ?? b;
  const head = String(body.messages[0].content);
  const resp = await fetch("https://cnb.cool/ai/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "text/event-stream, */*",
      "Origin": "https://cnb.cool",
      "Referer": "https://cnb.cool/",
      "Csrftoken": token ?? "",
      "Cookie": "csrfkey=" + (csrfkey ?? "") + "; " + login,
      "User-Agent": UA,
    },
    body: JSON.stringify(body),
  });
  const t = await resp.text();
  const code = t.match(/"code":(\d+)/)?.[1] ?? "";
  const visible = head.replace(/\s/g, "");
  console.log(
    "  [" + label + "] " + resp.status + (code ? " code=" + code : "") +
      "  可见开头=" + JSON.stringify(visible.slice(0, 40)),
  );
  await new Promise((r) => setTimeout(r, 900));
}
const FP = "You are Claude Code, Anthropic\u0027s official CLI for Claude.";
const user = { role: "user", content: "只回一个字：好" };
const sys = {
  role: "system",
  content: "You are an AI agent powered by DeepSeek Harness.",
};
const summary = {
  role: "system",
  content: "[Conversation Summary]\n## Objective\n- Fix Spectrum stuff",
};
console.log("== 对照 ==");
await send(
  "纯指纹",
  [sys, user].map((m) => m === sys ? { role: "system", content: FP } : m),
);
console.log("== 真实形状 1：DSH system 首条（会 400 的那个）==");
await send("DSH system", [sys, user]);
await send("DSH system + \n\n", [{
  role: "system",
  content: "\n\n" + sys.content,
}, user]);
await send("DSH system + > ", [{
  role: "system",
  content: "> \n\n" + sys.content,
}, user]);
console.log("== 真实形状 2：截短摘要首条 ==");
await send("summary", [summary, user]);
await send("summary + \n\n", [{
  role: "system",
  content: "\n\n" + summary.content,
}, user]);
await send("summary + > ", [{
  role: "system",
  content: "> \n\n" + summary.content,
}, user]);
console.log("== 真实形状 3：空白填充 + DSH system ==");
await send("pad48k + system", [{
  role: "system",
  content: " ".repeat(48000) + sys.content,
}, user]);
await send("pad48k + \n\n + system", [{
  role: "system",
  content: " ".repeat(48000) + "\n\n" + sys.content,
}, user]);
