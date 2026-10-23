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
  console.log(
    "  [" + label + "] " + resp.status + (code ? " code=" + code : "") + "  " +
      t.replace(/\s+/g, " ").slice(0, 90),
  );
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
const FP = "You are Claude Code, Anthropic\u0027s official CLI for Claude.";
const user = { role: "user", content: "只回一个字：好" };
console.log("== 前面补 2000 空白 ==");
await send("no-pad", mk([{ role: "system", content: FP }, user]));
await send(
  "pad2000",
  mk([{ role: "system", content: " ".repeat(2000) + FP }, user]),
);
await send(
  "pad8000",
  mk([{ role: "system", content: " ".repeat(8000) + FP }, user]),
);
await send(
  "pad30000",
  mk([{ role: "system", content: " ".repeat(30000) + FP }, user]),
);
await send(
  "pad48000",
  mk([{ role: "system", content: " ".repeat(48000) + FP }, user]),
);
console.log("== 自愈的两段前缀（无额外空白）==");
await send("\n\n", mk([{ role: "system", content: "\n\n" + FP }, user]));
await send("> \n\n", mk([{ role: "system", content: "> \n\n" + FP }, user]));
