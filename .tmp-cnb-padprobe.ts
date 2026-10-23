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
async function send(label: string, body: any) {
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
  console.log("[" + label + "] " + resp.status + (code ? " code=" + code : ""));
  await new Promise((r) => setTimeout(r, 900));
}
const mk = (msgs: any[]) => {
  const b: any = cnbBuildUpstream({
    model: "deepseek-v4.1-flash",
    messages: msgs,
    stream: true,
    max_tokens: 32,
  });
  return b.upstream ?? b;
};
// A 现状：补空白的头部，指纹是"可见开头"
const pad = " ".repeat(2000);
await send(
  "A 空白填充 + 指纹(可见开头)",
  mk([{
    role: "system",
    content: pad +
      "You are Claude Code, Anthropic\u0027s official CLI for Claude.",
  }, { role: "user", content: "只回一个字：好" }]),
);
// B 补空白 + 真实 system 文本 + 指纹（模拟 DSH：system 在中段）
await send(
  "B 空白 + 真 system 文本(可见开头非指纹)",
  mk([{
    role: "system",
    content: pad + "You are an AI agent powered by DeepSeek Harness.",
  }, { role: "user", content: "只回一个字：好" }]),
);
// C 自愈结果：空白 + \n\n + 指纹
await send(
  "C 空白 + \n\n + 指纹",
  mk([{
    role: "system",
    content: pad + "\n\n" +
      "You are Claude Code, Anthropic\u0027s official CLI for Claude.",
  }, { role: "user", content: "只回一个字：好" }]),
);
// D 自愈失败情形：48KB 空白 + 指纹（旧 bug：前缀加在最前面）
const pad48 = " ".repeat(48000);
await send(
  "D 48KB 空白 + 指纹(旧加固 bug)",
  mk([{
    role: "system",
    content: pad48 +
      "You are Claude Code, Anthropic\u0027s official CLI for Claude.",
  }, { role: "user", content: "只回一个字：好" }]),
);
await send(
  "E 48KB 空白 + > + 指纹(新第二段)",
  mk([{
    role: "system",
    content: pad48 + "> \n\n" +
      "You are Claude Code, Anthropic\u0027s official CLI for Claude.",
  }, { role: "user", content: "只回一个字：好" }]),
);
