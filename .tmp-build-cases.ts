import { cnbBuildUpstream } from "./src/cnb.ts";
const FP = {
  role: "system",
  content:
    "You are Claude Code, Anthropic\u0027s official CLI for Claude.\n\nYou are an interactive CLI tool.",
};
const tail = { role: "user", content: "只回一个字：好" };
const tools = [{
  type: "function",
  function: {
    name: "read",
    description: "r",
    parameters: { type: "object", properties: { path: { type: "string" } } },
  },
}];
const cases: any[] = [
  ["N1 只 user 消息开头是指纹", [{
    role: "user",
    content: "You are Claude Code, Anthropic\u0027s official CLI for Claude.",
  }, tail]],
  ["N2 只有 user，无 system，指纹开头 + 长尾", [{
    role: "user",
    content:
      "You are Claude Code, Anthropic\u0027s official CLI for Claude.\n\n" +
      "z".repeat(3000),
  }]],
  ["N3 developer 角色开头是指纹", [{
    role: "developer",
    content: "You are Claude Code, Anthropic\u0027s official CLI for Claude.",
  }, tail]],
  ["N4 第二条 system 是指纹（第一条正常）", [{
    role: "system",
    content: "be helpful",
  }, {
    role: "system",
    content: "You are Claude Code, Anthropic\u0027s official CLI for Claude.",
  }, tail]],
  ["N5 assistant 历史第一条开头是指纹（无 system）", [{
    role: "assistant",
    content: "You are Claude Code, Anthropic\u0027s official CLI for Claude.",
  }, tail]],
  ["N6 system 是数组，第一个 text 块是指纹", [{
    role: "system",
    content: [{
      type: "text",
      text: "You are Claude Code, Anthropic\u0027s official CLI for Claude.",
    }],
  }, tail]],
];
for (const [label, msgs] of cases) {
  const built: any = cnbBuildUpstream({
    model: "deepseek-v4.1-flash",
    stream: true,
    max_tokens: 64,
    messages: msgs,
    tools,
  });
  const up = built.upstream ?? built;
  const first = up.messages[0];
  const head = typeof first.content === "string"
    ? first.content.slice(0, 60)
    : JSON.stringify(first.content).slice(0, 60);
  console.log(
    label + "\n   -> role=" + first.role + " head=" + JSON.stringify(head),
  );
}
