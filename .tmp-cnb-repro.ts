import { cnbBuildUpstream } from "./src/cnb.ts";
const FP = "You are Claude Code, Anthropic\u0027s official CLI for Claude.";
const tools = [{
  type: "function",
  function: {
    name: "read",
    description: "r",
    parameters: { type: "object", properties: { path: { type: "string" } } },
  },
}];
const cases: any[] = [
  ["R1 正常 DSH 形状（system 开头是指纹）", [{
    role: "system",
    content: FP + "\n\nYou are an interactive CLI tool.",
  }, { role: "user", content: "只回一个字：好" }]],
  ["R2 第一条 system 正常、第二条 system 是指纹", [
    { role: "system", content: "be helpful" },
    { role: "system", content: FP },
    { role: "user", content: "只回一个字：好" },
  ]],
  ["R3 assistant 历史开头是指纹", [{ role: "assistant", content: FP }, {
    role: "user",
    content: "只回一个字：好",
  }]],
];
for (const [label, msgs] of cases) {
  const built: any = cnbBuildUpstream({
    model: "deepseek-v4.1-flash",
    stream: true,
    max_tokens: 32,
    messages: msgs,
    tools,
  });
  const up = built.upstream ?? built;
  await Deno.writeTextFile(
    ".tmp-case-body.json",
    JSON.stringify({ label, body: up }),
  );
  const resp = await fetch("http://127.0.0.1:8000/cnb/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4.1-flash",
      stream: true,
      max_tokens: 32,
      messages: msgs,
      tools,
    }),
  });
  const t = await resp.text();
  console.log(
    "[" + label + "] " + resp.status + "  11128=" + t.includes("11128"),
  );
  if (t.includes("11128")) {
    console.log("   " + t.replace(/\s+/g, " ").slice(0, 140));
  }
  await new Promise((r) => setTimeout(r, 900));
}
