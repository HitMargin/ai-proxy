const d = JSON.parse(await Deno.readTextFile(".tmp-cnb-11128-persist.json"));
const c: string = d.body.messages[0].content;
console.log(JSON.stringify(c.slice(9300, 9830)));
console.log("\n--- 全文里 DeepSeek/Harness/DSH 出现位置（前 9772 字符内） ---");
for (const n of ["DeepSeek Harness", "DSH", "Harness", "deepseek-v4"]) {
  let from = 0;
  while (true) {
    const at = c.indexOf(n, from);
    if (at < 0 || at > 9772) break;
    console.log(
      `"${n}" @${at}: ${
        JSON.stringify(c.slice(Math.max(0, at - 40), at + 50))
      }`,
    );
    from = at + 1;
  }
}
