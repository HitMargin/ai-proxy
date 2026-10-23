const d = JSON.parse(await Deno.readTextFile(".tmp-cnb-11128-attempt1.json"));
const c: string = d.body.messages[0].content;
const start = c.indexOf("gitStatus:");
const after = c.slice(start, start + 1400);
console.log("block starts @", start, "of", c.length);
console.log(JSON.stringify(after));
