const d = JSON.parse(await Deno.readTextFile(".tmp-cnb-11128-persist.json"));
const raw: any = d.body;
const content: string = raw.messages[0].content;
console.log("persist messages[0].content chars:", content.length);

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
async function probeSystem(text: string): Promise<string> {
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
    messages: [{ role: "system", content: text }, {
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
  await new Promise((r) => setTimeout(r, 900));
  return resp.status + (t.includes("11128") ? "/11128" : "");
}

// 工具说明块单独
const toolStart = content.indexOf("=== TOOL CALL PROTOCOL");
const toolEnd = content.indexOf("=== END TOOL CALL PROTOCOL ===");
const toolBlock = content.slice(
  toolStart,
  toolEnd + "=== END TOOL CALL PROTOCOL ===".length,
);
console.log(
  "工具说明块:",
  toolBlock.length,
  "chars →",
  await probeSystem(toolBlock),
);

console.log("full:", await probeSystem(content));
const bad = async (n: number) =>
  (await probeSystem(content.slice(0, n))).startsWith("400");
let lo = 1, hi = content.length;
while (lo < hi) {
  const mid = Math.floor((lo + hi) / 2);
  const b = await bad(mid);
  console.log(`prefix ${mid}: ${b ? "400" : "200"}`);
  if (b) hi = mid;
  else lo = mid + 1;
}
console.log("\n== 最小触发前缀 ==", lo);
console.log(JSON.stringify(content.slice(Math.max(0, lo - 300), lo + 80)));
