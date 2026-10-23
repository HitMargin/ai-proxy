// 在 messages[0] 的 36 KB content 内部二分：找出最小触发前缀。
// 对照组：等体积的中性内容（区分「内容触发」与「体积触发」）。
const d = JSON.parse(await Deno.readTextFile(".tmp-cnb-11128-attempt1.json"));
const rawBody: any = d.body;
const content: string = rawBody.messages[0].content;
console.log("messages[0].content chars:", content.length);

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
    ...rawBody,
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

const GIBBERISH = "这是一段完全中性的测试文本，用于对照体积效应。".repeat(600);
console.log(
  "== 对照：等体积中性内容 ==",
  await probeSystem(GIBBERISH.slice(0, content.length)),
);

// 工具说明块单独发
const toolStart = content.indexOf("=== TOOL CALL PROTOCOL");
const toolEnd = content.indexOf("=== END TOOL CALL PROTOCOL ===");
if (toolStart >= 0 && toolEnd > toolStart) {
  const toolBlock = content.slice(
    toolStart,
    toolEnd + "=== END TOOL CALL PROTOCOL ===".length,
  );
  console.log(
    "== 工具说明块单独 ==",
    toolBlock.length,
    "chars:",
    await probeSystem(toolBlock),
  );
}

// 前缀二分：最小触发前缀（默认 1 条消息的 content）
console.log("== 前缀二分 ==");
const bad = (n: number) =>
  probeSystem(content.slice(0, n)).then((s) => s.startsWith("400"));
console.log("full:", await probeSystem(content));
let lo = 1, hi = content.length;
if (!await bad(hi)) {
  console.log("full content did not reproduce");
  Deno.exit(1);
}
while (lo < hi) {
  const mid = Math.floor((lo + hi) / 2);
  const b = await bad(mid);
  console.log(`prefix ${mid} chars: ${b ? "400" : "200"}`);
  if (b) hi = mid;
  else lo = mid + 1;
}
console.log("\n== 最小触发前缀 ==", lo, "chars");
console.log(JSON.stringify(content.slice(Math.max(0, lo - 260), lo + 60)));
