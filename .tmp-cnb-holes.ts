const UA =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36";
const FP = "You are Claude Code, Anthropic\u0027s official CLI for Claude.";
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
  headers: {
    "User-Agent": UA,
    "Accept": "text/html",
    ...(login ? { "Cookie": login } : {}),
  },
});
const html = await r0.text();
const token = html.match(/window\.csrftoken\s*=\s*"([0-9a-fA-F]{32,64})"/)?.[1];
let cs: string[] = [];
try {
  cs = (r0.headers as any).getSetCookie?.() ?? [];
} catch {}
const csrfkey = cs.map((c) => c.match(/csrfkey=([^;\s]+)/)?.[1]).find(Boolean);
async function send(label: string, messages: any[], tools?: any[]) {
  const body: any = {
    model: "deepseek-v4.1-flash",
    messages,
    stream: true,
    max_tokens: 32,
  };
  if (tools) body.tools = tools;
  const resp = await fetch("https://cnb.cool/ai/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "text/event-stream, application/json, */*",
      "Origin": "https://cnb.cool",
      "Referer": "https://cnb.cool/",
      "Csrftoken": token ?? "",
      "Cookie": "csrfkey=" + (csrfkey ?? "") + (login ? "; " + login : ""),
      "User-Agent": UA,
    },
    body: JSON.stringify(body),
  });
  const t = await resp.text();
  const codes = [...t.matchAll(/"code":(\d+)/g)].map((m) => m[1]).join(",");
  console.log(
    "[" + label + "] " + resp.status + (codes ? " code=" + codes : "") + "  " +
      t.replace(/\s+/g, " ").slice(0, 150),
  );
  await new Promise((r) => setTimeout(r, 700));
}
console.log("csrf:", token ? "ok" : "MISSING");
const tail = { role: "user", content: "只回一个字：好" };
await send("U1 只 user 消息，指纹开头", [{ role: "user", content: FP }, tail]);
await send("U2 developer 角色，指纹开头", [
  { role: "developer", content: FP },
  tail,
]);
await send("U3 第二条 system 是指纹", [
  { role: "system", content: "be helpful" },
  { role: "system", content: FP },
  tail,
]);
await send("U5 assistant 指开头无 system", [
  { role: "assistant", content: FP },
  tail,
]);
await send("U8 指纹前加 \n\n 且带 native tools", [{
  role: "system",
  content: "\n\n" + FP,
}, tail], [{
  type: "function",
  function: {
    name: "read",
    description: "r",
    parameters: { type: "object", properties: {} },
  },
}]);
