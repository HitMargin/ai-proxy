const d = JSON.parse(await Deno.readTextFile(".tmp-cnb-11128-persist.json"));
const c: string = d.body.messages[0].content;
const para = c.slice(9595, 9810);
console.log("原文段:", JSON.stringify(para), "\n");

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
    model: "deepseek-v4.1-flash",
    stream: true,
    max_tokens: 16,
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

const NEUTRAL = "You are a helpful assistant for a code project.";
await probe("F1 WebGUI整段", NEUTRAL + "\n\n" + para);
await probe(
  "F2 DeepSeek Harness Web GUI",
  NEUTRAL +
    "\n\nYou are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names.",
);
await probe(
  "F3 Web GUI 词组",
  NEUTRAL +
    "\n\nYou are interacting with the user through the DeepSeek Harness Web GUI.",
);
await probe(
  "F4 无GUI",
  NEUTRAL +
    "\n\nYou are interacting with the user through the DeepSeek Harness Web whose URL the runtime context names.",
);
await probe(
  "F5 改成 DSH Web GUI",
  NEUTRAL +
    "\n\nYou are interacting with the user through the DSH Web GUI whose URL the runtime context names.",
);
await probe(
  "F6 DeepSeek Harness 短语",
  NEUTRAL +
    "\n\nYou are interacting with the user through the DeepSeek Harness.",
);

console.log("== 组合（screenshot 翻生点） ==");
const d2 = JSON.parse(await Deno.readTextFile(".tmp-cnb-11128-persist.json"));
const c2: string = d2.body.messages[0].content;
console.log("c[9755..9775]:", JSON.stringify(c2.slice(9755, 9775)));
const GUI_PARA =
  'You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names. When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI.';
const SCREEN =
  "The browser provides no implicit DOM, route, or screenshot context.";
const CHECKOUT =
  "The runtime context names the DeepSeek Harness implementation checkout.";
await probe(
  "H1 GUI段+screenshot句",
  NEUTRAL + "\n\n" + GUI_PARA + " " + SCREEN,
);
await probe("H2 screenshot句单独", NEUTRAL + "\n\n" + SCREEN);
await probe("H3 GUI段单独(无screenshot)", NEUTRAL + "\n\n" + GUI_PARA);
await probe(
  "H4 checkout句+GUI段+screenshot",
  NEUTRAL + "\n\n" + CHECKOUT + "\n\n" + GUI_PARA + " " + SCREEN,
);
await probe(
  "H5 checkout句+screenshot",
  NEUTRAL + "\n\n" + CHECKOUT + "\n\n" + SCREEN,
);
await probe(
  "H6 只换一词: DeepSeek Harness→DSH(全组合)",
  NEUTRAL + "\n\n" + CHECKOUT.replaceAll("DeepSeek Harness", "DSH") + "\n\n" +
    GUI_PARA.replaceAll("DeepSeek Harness", "DSH") + " " + SCREEN,
);
