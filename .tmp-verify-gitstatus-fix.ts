// 用落盘的真实 body 验证：gitStatus 块剥离后应一次过（无 11128）。
const d = JSON.parse(await Deno.readTextFile(".tmp-cnb-11128-attempt1.json"));
const up: any = d.body;
const toolAt = up.messages[0].content.indexOf("=== TOOL CALL PROTOCOL");
const clientBody = {
  model: up.model,
  stream: false,
  max_tokens: 16,
  tools: [{
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  }],
  messages: up.messages.map((m: any, i: number) =>
    i === 0 ? { ...m, content: m.content.slice(0, toolAt) } : m
  ),
};
const resp = await fetch("http://127.0.0.1:8000/cnb/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(clientBody),
});
const t = await resp.text();
console.log("HTTP", resp.status, "11128=" + t.includes("11128"));
console.log(t.replace(/\s+/g, " ").slice(0, 200));
