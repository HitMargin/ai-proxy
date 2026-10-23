// 在真实 body 里定位已知指纹串的位置（哪条消息、距头部多远）。
const d = JSON.parse(await Deno.readTextFile(".tmp-cnb-11128-attempt1.json"));
const msgs = d.body.messages;
const NEEDLES = [
  "Claude Code",
  "Anthropic",
  "DeepSeek Harness",
  "official CLI",
  "You are Claude",
  "zai-start",
  "Z.ai",
];
for (let i = 0; i < msgs.length; i++) {
  const m = msgs[i];
  const text = typeof m.content === "string"
    ? m.content
    : JSON.stringify(m.content);
  for (const n of NEEDLES) {
    let from = 0;
    while (true) {
      const at = text.indexOf(n, from);
      if (at < 0) break;
      console.log(
        `[${i}] ${m.role} "${n}" @${at}${at < 60 ? "  ← 消息开头!" : ""}  ctx=${
          JSON.stringify(text.slice(Math.max(0, at - 30), at + 40))
        }`,
      );
      from = at + 1;
      if (from > text.length) break;
    }
  }
}
console.log("---- tool prompt in msgs[0]? ----");
const t = msgs[0].content;
const at = t.indexOf("=== TOOL CALL PROTOCOL");
console.log("tool prompt @", at, "of", t.length);
