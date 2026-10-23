const d = JSON.parse(await Deno.readTextFile(".tmp-cnb-11128-attempt1.json"));
const msgs = d.body.messages;
console.log("attempt1 msgs:", msgs.length);
for (let i = 0; i < msgs.length; i++) {
  const m = msgs[i];
  const c = typeof m.content === "string"
    ? m.content
    : JSON.stringify(m.content);
  const size = new TextEncoder().encode(JSON.stringify(m)).length;
  console.log(`[${i}] ${m.role} ${size}B ${JSON.stringify(c.slice(0, 110))}`);
}
