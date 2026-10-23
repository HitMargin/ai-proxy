const d = JSON.parse(await Deno.readTextFile(".tmp-cnb-11128-attempt1.json"));
const msgs = d.body.messages;
console.log("attempt1 msgs:", msgs.length, "headSample:", d.headSample);
for (let i = 0; i < msgs.length; i++) {
  const m = msgs[i];
  const c = typeof m.content === "string"
    ? m.content
    : JSON.stringify(m.content);
  const size = new TextEncoder().encode(JSON.stringify(m)).length;
  console.log(`[${i}] ${m.role} ${size}B ${JSON.stringify(c.slice(0, 100))}`);
}
console.log("--- msgs[0] 剩余的 harness 段落（# / === 开头的行） ---");
const c0: string = msgs[0].content;
const lines = c0.split("\n");
lines.forEach((l: string, i: number) => {
  if (/^(#|===)/.test(l)) console.log(`  line ${i}: ${l.slice(0, 80)}`);
});
console.log("--- gitStatus 残留? ---");
console.log(
  "gitStatus anchor:",
  c0.includes("gitStatus: This is the git status"),
);
console.log(
  "Current branch:",
  c0.includes("Current branch"),
  "@",
  c0.indexOf("Current branch"),
);
