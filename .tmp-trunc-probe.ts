import { fallbackTruncate } from "./src/zen-compaction.ts";
const big = "x".repeat(1_100_000);
const messages = [
  { role: "system", content: big },
  { role: "user", content: "hi" },
  { role: "user", content: "只回一个字：好" },
];
const budget = 1015808;
const overhead = JSON.stringify({
  model: "deepseek-v4.1-flash",
  messages: [],
  stream: true,
  max_tokens: 16,
}).length;
const out = fallbackTruncate(messages, budget, overhead);
console.log("overhead", overhead);
console.log("out msgs", out.messages.length, "note:", out.note);
for (const m of out.messages.slice(0, 4)) {
  console.log(
    " -",
    m.role,
    JSON.stringify(String(m.content ?? "").slice(0, 60)),
    "len=",
    String(m.content ?? "").length,
  );
}
console.log(
  "body bytes",
  JSON.stringify({
    model: "deepseek-v4.1-flash",
    messages: out.messages,
    stream: true,
    max_tokens: 16,
  }).length,
);
