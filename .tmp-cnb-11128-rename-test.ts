const d = JSON.parse(await Deno.readTextFile(".tmp-cnb-11128-persist.json"));
const raw: any = d.body;
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
async function probe(label: string, messages: any[]) {
  const r0 = await fetch("https://cnb.cool/", {
    headers: { "User-Agent": UA, Cookie: login },
  });
  const html = await r0.text();
  const token = html.match(/window\.csrftoken\s*=\s*"([0-9a-fA-F]{32,64})"/)
    ?.[1];
  let cs: string[] = [];
  try {
    cs = (r0.headers as any).getSetCookie?.() ?? [];
  } catch {}
  const csrfkey = cs.map((c) => c.match(/csrfkey=([^;\s]+)/)?.[1]).find(
    Boolean,
  );
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
    body: JSON.stringify({ ...raw, messages }),
  });
  const t = await resp.text();
  console.log(
    `[${label}] ${resp.status}${t.includes("11128") ? " 11128" : ""}`,
  );
  await new Promise((r) => setTimeout(r, 900));
}
const renamed = (m: any) => ({
  ...m,
  content: typeof m.content === "string"
    ? m.content.replaceAll("DeepSeek Harness", "DSH")
    : m.content,
});
await probe("R0 persist原样(应400)", raw.messages);
await probe("R1 全文改名 DeepSeek Harness→DSH", raw.messages.map(renamed));
// 各消息单独（改名后）
for (let i = 1; i < raw.messages.length; i++) {
  await probe(`R2 只留[0]和[${i}](改名后)`, [
    renamed(raw.messages[0]),
    renamed(raw.messages[i]),
  ]);
}
