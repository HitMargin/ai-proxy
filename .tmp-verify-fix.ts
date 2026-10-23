// 端到端验证（2026-10-24 修复后）：f05811ec 会话的失败形状——
// 第一条 system 是压缩 note、第二条 system 开头是客户端指纹、带工具。
// 期望：本地代理首包吃一次 400/11128，自愈把**每条**检测面消息的开头削掉后
// 重发成功（修复前：只削第一条 note，重发仍被拦，11128 原样透传给客户端）。
const tools = [{
  type: "function",
  function: {
    name: "read_file",
    description: "Read a file from disk.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
}];
const body = {
  model: "deepseek-v4.1-flash",
  stream: false,
  max_tokens: 16,
  tools,
  messages: [
    {
      role: "system",
      content: "[context compaction] 早期消息已按体积上限(609484B)截断。",
    },
    {
      role: "system",
      content:
        "You are ZCode, an interactive coding agent\nYou are an interactive coding agent that helps users with software engineering tasks.",
    },
    { role: "user", content: "只回一个字：好" },
  ],
};
const resp = await fetch("http://127.0.0.1:8000/cnb/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const text = await resp.text();
console.log("HTTP", resp.status, "11128=" + text.includes("11128"));
console.log(text.replace(/\s+/g, " ").slice(0, 300));
