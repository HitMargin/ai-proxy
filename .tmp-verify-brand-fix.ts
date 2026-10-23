// 真实 DSH 落盘 body 直打本地代理：品牌词改写后应一次过（无 11128）。
const d = JSON.parse(await Deno.readTextFile(".tmp-cnb-11128-persist.json"));
const up: any = d.body;
const body = { ...up, stream: false, max_tokens: 16 };
const resp = await fetch("http://127.0.0.1:8000/cnb/v1/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const t = await resp.text();
console.log("HTTP", resp.status, "11128=" + t.includes("11128"));
console.log(t.replace(/\s+/g, " ").slice(0, 160));
