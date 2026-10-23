// 11128 结构性假设（2026-10-24 晚）：削头重发仍 400，但两行指纹削一行能过、
// You are ZCode 本身不是触发点。测真实 rebuilt transcript 的结构要素：
// tool_call 历史、[Tool Result] 包装、消息条数、体积。
import { cnbBuildUpstream } from "./src/cnb.ts";

const UA =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36";
function normalise(raw: string) {
  const m = new Map<string, string>();
  for (const p of raw.split(";").map((x) => x.trim()).filter(Boolean)) {
    if (/^csrfkey=/i.test(p)) continue;
    const eq = p.indexOf("=");
    if (eq <= 0) continue;
    m.set(p.slice(0, eq), p.slice(eq + 1));
  }
  return [...m].map(([k, v]) => k + "=" + v).join("; ");
}
const login = normalise(
  (await Deno.readTextFile("cnb-login.txt").catch(() => "")).trim(),
);
const r0 = await fetch("https://cnb.cool/", {
  headers: { "User-Agent": UA, ...(login ? { "Cookie": login } : {}) },
});
const html = await r0.text();
const token = html.match(/window\.csrftoken\s*=\s*"([0-9a-fA-F]{32,64})"/)?.[1];
let cs: string[] = [];
try {
  cs = (r0.headers as any).getSetCookie?.() ?? [];
} catch {}
const csrfkey = cs.map((c) => c.match(/csrfkey=([^;\s]+)/)?.[1]).find(Boolean);

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

async function send(
  label: string,
  msgs: any[],
  withTools = true,
  model = "deepseek-v4.1-flash",
) {
  const b: any = cnbBuildUpstream({
    model,
    messages: msgs,
    stream: true,
    max_tokens: 16,
    ...(withTools ? { tools } : {}),
  });
  const body = b.upstream ?? b;
  const bytes = new TextEncoder().encode(JSON.stringify(body)).length;
  const resp = await fetch("https://cnb.cool/ai/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "text/event-stream, */*",
      "Origin": "https://cnb.cool",
      "Referer": "https://cnb.cool/",
      "Csrftoken": token ?? "",
      "Cookie": "csrfkey=" + (csrfkey ?? "") + "; " + login,
      "User-Agent": UA,
    },
    body: JSON.stringify(body),
  });
  const t = await resp.text();
  const code = t.match(/"code":(\d+)/)?.[1] ?? "";
  console.log(
    `[${label}] HTTP ${resp.status}${
      code ? " code=" + code : ""
    } bytes=${bytes} msgs=${body.messages.length}`,
  );
  await new Promise((r) => setTimeout(r, 900));
  return resp.status;
}

const user = { role: "user", content: "只回一个字：好" };

// P0：小体积真实形状——带 tool_calls 历史与 [Tool Result] 包装（经 cnbBuildUpstream
// 序列化成 XYML / [Tool Result id=…]），头部干净。
function turns(n: number, filler: string) {
  const msgs: any[] = [{ role: "system", content: "你是编码助手。" }];
  for (let i = 0; i < n; i++) {
    msgs.push({
      role: "assistant",
      content: `第 ${i} 步：先读取文件。`,
      tool_calls: [{
        id: "c" + i,
        type: "function",
        function: {
          name: "read_file",
          arguments: JSON.stringify({ path: "src/a" + i + ".ts" }),
        },
      }],
    });
    msgs.push({
      role: "tool",
      tool_call_id: "c" + i,
      name: "read_file",
      content: filler,
    });
    msgs.push({ role: "user", content: "继续。" });
  }
  return msgs;
}
const FILLER = "文件内容行。".repeat(120); // ~1.8 KB 每条工具结果

console.log("== 结构假设 ==");
await send("P0 小体积(4轮tool历史)", turns(4, FILLER));
await send("P1 中体积(60轮≈350KB)", turns(60, FILLER));
await send("P2 大体积(170轮≈1MB)", turns(170, FILLER));
