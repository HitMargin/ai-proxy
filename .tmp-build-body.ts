import { cnbBuildUpstream } from "./src/cnb.ts";

// 造一个「像 DSH 一轮真实请求」的 body：大 system + 大量历史 + tools + 图片占位
const messages: any[] = [];
messages.push({
  role: "system",
  content:
    "You are Claude Code, Anthropic\u0027s official CLI for Claude.\n\nYou are an interactive agent operating in a terminal.\n"
      .padEnd(20000, "x"),
});
for (let i = 0; i < 60; i++) {
  messages.push({ role: "user", content: "第 " + i + " 步：请继续。" });
  messages.push({
    role: "assistant",
    content: "好的，我来处理第 " + i + " 步。".padEnd(400, "y"),
  });
}
messages.push({ role: "user", content: "只回一个字：好" });
const body = {
  model: "deepseek-v4.1-flash",
  stream: true,
  max_tokens: 4096,
  reasoning_effort: "high",
  messages,
  tools: [{
    type: "function",
    function: {
      name: "read",
      description: "read",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
  }],
};
const built: any = cnbBuildUpstream(body);
const up = built.upstream ?? built;
let out = JSON.stringify(up);
console.log(
  "system head:",
  JSON.stringify((up.messages[0].content || "").slice(0, 80)),
);
console.log("bytes:", out.length);
console.log("head 64 bytes of body:", JSON.stringify(out.slice(0, 64)));
// 定位 "messages" 之后第一个字符串的开头
const i = out.indexOf('"messages"');
console.log("after messages key:", JSON.stringify(out.slice(i, i + 120)));
await Deno.writeTextFile(".tmp-outbound-body.json", out);
