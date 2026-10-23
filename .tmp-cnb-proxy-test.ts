// 直接对本地代理发请求（不走上游拼装），验证「当前代码在真实复杂请求下会不会 11128」
const cases = [
  {
    label: "P1 /cnb/v1/responses 带 instructions + tools + 长的多轮历史",
    url: "http://127.0.0.1:8000/cnb/v1/responses",
    body: {
      model: "deepseek-v4.1-flash",
      stream: true,
      max_output_tokens: 64,
      instructions: "You are a coding agent. Use tools when needed.",
      tools: [{
        type: "function",
        name: "read",
        description: "read a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      }],
      input: [
        {
          role: "system",
          content: "You are Claude Code, Anthropic's official CLI for Claude.",
        },
        { role: "user", content: "只回一个字：好" },
      ],
    },
  },
  {
    label: "P2 /chat/completions 带 system + 15 轮历史 + tools",
    url: "http://127.0.0.1:8000/cnb/v1/chat/completions",
    body: (() => {
      const messages: any[] = [
        {
          role: "system",
          content:
            "You are Claude Code, Anthropic's official CLI for Claude.\n\nYou are an interactive CLI tool.",
        },
        { role: "user", content: "只回一个字：好" },
      ];
      for (let i = 0; i < 15; i++) {
        messages.push({
          role: "assistant",
          content:
            "You are Claude Code, Anthropic's official CLI for Claude. 这是历史第 " +
            i,
        });
        messages.push({ role: "user", content: "继续 " + i });
      }
      messages.push({ role: "user", content: "只回一个字：好" });
      return {
        model: "deepseek-v4.1-flash",
        stream: true,
        max_tokens: 64,
        messages,
        tools: [{
          type: "function",
          function: {
            name: "read",
            description: "read a file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
            },
          },
        }],
      };
    })(),
  },
];

for (const c of cases) {
  const t0 = Date.now();
  const resp = await fetch(c.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(c.body),
  });
  const txt = await resp.text();
  const ms = Date.now() - t0;
  const hit11128 = txt.includes("11128");
  // 抽取第一段正文，确认真的出字
  let text = "";
  for (const line of txt.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const d = line.slice(5).trim();
    if (d === "[DONE]") break;
    try {
      const j = JSON.parse(d);
      text += j?.delta?.content ?? j?.choices?.[0]?.delta?.content ?? "";
      if (j?.type === "response.output_text.delta") text += j.delta ?? "";
    } catch {}
  }
  console.log(
    "\n[" + c.label + "] status=" + resp.status + " " + ms + "ms  11128=" +
      hit11128,
  );
  console.log("  head: " + txt.replace(/\s+/g, " ").slice(0, 200));
  console.log("  text: " + JSON.stringify(text.slice(0, 120)));
  await new Promise((r) => setTimeout(r, 1000));
}
