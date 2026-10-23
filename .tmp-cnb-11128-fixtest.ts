const d = JSON.parse(await Deno.readTextFile(".tmp-cnb-11128-attempt1.json"));
const raw: any = d.body;
const content: string = raw.messages[0].content;
const start = content.indexOf("gitStatus:");
const toolAt = content.indexOf("=== TOOL CALL PROTOCOL");
const block = content.slice(start, toolAt).replace(/\n+$/, "");
console.log("block:", block.length, "chars; content:", content.length);

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
async function probe(label: string, sys: string) {
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
  const body = {
    ...raw,
    messages: [{ role: "system", content: sys }, {
      role: "user",
      content: "只回一个字：好",
    }],
  };
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
  console.log(
    `[${label}] ${resp.status}${t.includes("11128") ? " 11128" : ""}`,
  );
  await new Promise((r) => setTimeout(r, 900));
}

const head = content.slice(0, start);
const V1 = content.slice(0, start) + content.slice(toolAt); // 整块删
const STUB = "gitStatus: (已由代理省略)。\n";
const V2 = head + STUB + content.slice(toolAt); // 换 stub
const SENT =
  /gitStatus: This is the git status[^.]*\.[^.]*\./.exec(block)?.[0] ?? "";
const V3 = head + block.replace(SENT, "gitStatus: (快照说明已省略)。") +
  content.slice(toolAt); // 只改句子

await probe("V0 原样(应400)", content);
await probe("V1 整块删", V1);
await probe("V2 换stub", V2);
await probe("V3 只改句子", V3);
