const r = await fetch("http://127.0.0.1:8000/cnb/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "deepseek-v4.1-flash",
    stream: true,
    max_tokens: 64,
    messages: [
      {
        role: "system",
        content:
          "You are Claude Code, Anthropic\u0027s official CLI for Claude.\n\nYou are an interactive CLI tool.",
      },
      {
        role: "user",
        content: "用 read 工具读取 deno.jsonc，然后只回答文件名",
      },
      {
        role: "assistant",
        content: "好的",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "read", arguments: '{"path":"deno.jsonc"}' },
        }],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        name: "read",
        content: '{ "compilerOptions": {} }',
      },
      { role: "user", content: "只回一个字：好" },
    ],
    tools: [{
      type: "function",
      function: {
        name: "read",
        description: "read a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    }],
  }),
});
const t = await r.text();
console.log("status=" + r.status + " 11128=" + t.includes("11128"));
let text = "";
for (const line of t.split("\n")) {
  if (!line.startsWith("data:")) continue;
  const d = line.slice(5).trim();
  if (d === "[DONE]") break;
  try {
    const j = JSON.parse(d);
    if (j?.choices?.[0]?.delta?.content) text += j.choices[0].delta.content;
  } catch {}
}
console.log("text=" + JSON.stringify(text));
console.log("head=" + t.replace(/\s+/g, " ").slice(0, 260));
