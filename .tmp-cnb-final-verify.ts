const LOGIN_FILE = "./cnb-login.txt";
const CNB_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

let cookies = "";
try {
  cookies = (Deno.env.get("CNB_LOGIN_COOKIES") ?? "").trim();
} catch {}
if (!cookies) {
  try {
    cookies = (await Deno.readTextFile(LOGIN_FILE)).trim();
  } catch {}
}
cookies = cookies.replace(/^["']|["']$/g, "");
cookies = cookies.split(";").map((s) => s.trim()).filter((s) =>
  s && !/^csrfkey=/i.test(s)
).join("; ");

const r = await fetch("https://cnb.cool/", {
  headers: {
    "User-Agent": CNB_UA,
    "Accept": "text/html",
    ...(cookies ? { Cookie: cookies } : {}),
  },
});
const html = await r.text();
const nd = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
const parsed = JSON.parse(nd![1]);

// Walk the tree to find every object that has a "models" array of {model,...}
const modelGroups: any[] = [];
(function walk(node: any, path: string) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => walk(v, `${path}[${i}]`));
    return;
  }
  if (
    Array.isArray(node.models) && node.models.length &&
    node.models.every((m: any) => m && typeof m === "object" && "model" in m)
  ) {
    modelGroups.push({
      path,
      defaultModel: node.defaultModel,
      models: node.models,
    });
  }
  for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
})(parsed, "$");

console.log("=== every {models:[{model,...}]} group in the page config ===");
for (const g of modelGroups) {
  console.log(`\npath: ${g.path}`);
  console.log(`defaultModel: ${g.defaultModel}`);
  console.log(`models (${g.models.length}):`);
  for (const m of g.models) {
    console.log(`  ${JSON.stringify(m)}`);
  }
}

console.log(
  "\n=== cross-check: are -high/-max real models or NPC entries? ===",
);
const json = JSON.stringify(parsed);
for (const name of ["deepseek-v4.1-flash-high", "deepseek-v4.1-flash-max"]) {
  const asModel = modelGroups.some((g) =>
    g.models.some((m: any) => m.model === name)
  );
  const asNpc = json.includes(`"npc_name":"[${name}]"`) ||
    json.includes(`"npc_name":"${name}"`);
  console.log(
    `  ${
      name.padEnd(26)
    } declared_as_model=${asModel}  appears_as_npc_name=${asNpc}`,
  );
}
