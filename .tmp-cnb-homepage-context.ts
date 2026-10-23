// Extract the CONTEXT around the model-name strings found in the cnb.cool
// homepage HTML. If they come from a __NEXT_DATA__ JSON blob or a model-picker
// array, that is the authoritative "what does cnb offer" list — far better
// evidence than guessing names and checking whether they 200 (they always do).

const LOGIN_FILE = "./cnb-login.txt";
const CNB_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const CNB_HOME = "https://cnb.cool/";

async function loginCookies(): Promise<string> {
  let raw = "";
  try {
    raw = Deno.env.get("CNB_LOGIN_COOKIES") ?? "";
  } catch {}
  if (!raw.trim()) {
    try {
      raw = await Deno.readTextFile(LOGIN_FILE);
    } catch {}
  }
  raw = raw.trim().replace(/^["']|["']$/g, "");
  if (!raw) return "";
  return raw.split(";").map((s) => s.trim())
    .filter((s) => s && !/^csrfkey=/i.test(s)).join("; ");
}

const cookies = await loginCookies();
const r = await fetch(CNB_HOME, {
  headers: {
    "User-Agent": CNB_UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    ...(cookies ? { Cookie: cookies } : {}),
  },
});
const html = await r.text();
console.log(`homepage: http=${r.status} bytes=${html.length}\n`);

const NEEDLES = [
  "deepseek-v4.1-flash-max",
  "deepseek-v4.1-flash-high",
  "deepseek-v4.1-flash",
  "glm-5.3-flash",
  "kimi-k3",
  "deepseek-v4-pro",
];

for (const needle of NEEDLES) {
  console.log(`\n########## context for "${needle}" ##########`);
  let idx = -1;
  let shown = 0;
  while ((idx = html.indexOf(needle, idx + 1)) >= 0 && shown < 3) {
    // skip the occurrence if it is part of a longer identifier
    const before = html.slice(Math.max(0, idx - 220), idx);
    const after = html.slice(idx + needle.length, idx + needle.length + 220);
    console.log(`-- occurrence ${shown + 1} at ${idx} --`);
    console.log(
      `   ...${before.replace(/\s+/g, " ")}[${needle}]${
        after.replace(/\s+/g, " ")
      }...`,
    );
    shown++;
  }
  if (shown === 0) console.log("   (not found)");
}

// Is there a __NEXT_DATA__ blob? That is where Next.js puts server props,
// and a model list would live there.
console.log("\n########## __NEXT_DATA__ ##########");
const nd = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
if (!nd) {
  console.log("  no __NEXT_DATA__ blob");
} else {
  const blob = nd[1];
  console.log(`  found, ${blob.length} bytes`);
  let parsed: any = null;
  try {
    parsed = JSON.parse(blob);
  } catch (e) {
    console.log(`  parse failed: ${String(e).slice(0, 120)}`);
  }
  if (parsed) {
    const json = JSON.stringify(parsed);
    // harvest every string that looks like a model id
    const found = [
      ...new Set(
        (json.match(/"([a-z0-9][a-z0-9.\-_]{2,44})"/gi) ?? [])
          .map((s) => s.slice(1, -1))
          .filter((s) =>
            /^(deepseek|glm|qwen|kimi|claude|gpt|doubao|llama|mistral|grok|step|minimax)/i
              .test(s) &&
            !/\.(js|css|png|svg|woff2?|json|ico)$/i.test(s)
          ),
      ),
    ];
    console.log(`  model-like strings inside __NEXT_DATA__: ${found.length}`);
    for (const f of found.sort()) console.log(`    ${f}`);
    // also dump top-level keys to see the shape
    console.log(`  top-level keys: ${Object.keys(parsed).join(", ")}`);
  }
}

// Look for an explicit model/menu array in the HTML (React props often inline it)
console.log("\n########## any array containing several model ids? ##########");
const arrRe = /\[(?:\s*\{[^\]]{0,400}?\}\s*,?){2,}\]/g;
let m: RegExpExecArray | null;
let n = 0;
while ((m = arrRe.exec(html)) !== null && n < 6) {
  const chunk = m[0];
  const models = [
    ...new Set(
      (chunk.match(/"(?:name|id|model|value)"\s*:\s*"([^"]{3,44})"/g) ?? [])
        .map((s) => s.replace(/^"[^"]+"\s*:\s*"|"$/g, "")),
    ),
  ];
  if (models.length >= 2) {
    console.log(
      `  array #${n + 1} (${chunk.length}B) candidates: ${
        models.slice(0, 12).join(", ")
      }`,
    );
    n++;
  }
}
if (n === 0) console.log("  none found");
