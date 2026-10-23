// 11128 边界重测（2026-10-24）：10-21 定的「检测锚定消息字面开头」判据被
// f05811ec 会话打破——削掉压缩 note 那句后重发仍 11128。逐条只改一个变量，
// 找出上游现在锚定什么。
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
if (!login) {
  console.error("no cnb-login.txt");
  Deno.exit(1);
}
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
console.log("csrf ok:", !!token, !!csrfkey);

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

async function send(label: string, msgs: any[], withTools: boolean) {
  const b: any = cnbBuildUpstream({
    model: "deepseek-v4.1-flash",
    messages: msgs,
    stream: true,
    max_tokens: 16,
    ...(withTools ? { tools } : {}),
  });
  const body = b.upstream ?? b;
  const head = String(body.messages?.[0]?.content ?? "");
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
  const headVisible = head.replace(/^\s+/, "").slice(0, 40);
  console.log(
    `[${label}] HTTP ${resp.status}${code ? " code=" + code : ""} tools=${
      withTools ? "y" : "n"
    } 开头=${JSON.stringify(headVisible)}`,
  );
  await new Promise((r) => setTimeout(r, 900));
}

const FP = "You are an AI agent powered by DeepSeek Harness.";
const TOOLPROMPT_HEAD =
  "=== TOOL CALL PROTOCOL (JSON) ===\nYou have access to these tools:";
const NOTE = "[context compaction] 早期消息已按体积上限(609484B)截断。";
const user = { role: "user", content: "只回一个字：好" };

console.log("== 基线（旧判据应 400 → 修复形状应 200） ==");
await send("1 纯指纹+工具", [{
  role: "system",
  content: FP + "\n\n" + TOOLPROMPT_HEAD,
}, user], true);
await send("2 削头后（\\n\\n=== 工具说明）", [{
  role: "system",
  content: "\n\n" + TOOLPROMPT_HEAD,
}, user], true);
await send("3 工具说明单发", [
  { role: "system", content: TOOLPROMPT_HEAD },
  user,
], true);

console.log("== 现场复现（note 开头） ==");
await send("4 note+工具说明", [{
  role: "system",
  content: NOTE + "\n\n" + TOOLPROMPT_HEAD,
}, user], true);
await send("5 note 单发（无工具说明）", [
  { role: "system", content: NOTE },
  user,
], true);
await send("6 note 无工具", [{ role: "system", content: NOTE }, user], false);
await send("7 指纹无工具", [{ role: "system", content: FP }, user], false);

console.log("== 假设：指纹在第二条 system 消息开头 ==");
await send("8 note + 指纹第二条", [
  { role: "system", content: NOTE + "\n\n" + TOOLPROMPT_HEAD },
  { role: "system", content: FP },
  user,
], true);
await send("9 note + 指纹在第二条中部", [
  { role: "system", content: NOTE + "\n\n" + TOOLPROMPT_HEAD },
  {
    role: "system",
    content: "前面有一段普通文字。\n\n" + FP + "\n后面还有内容。",
  },
  user,
], true);
await send("10 无note + 指纹第二条", [
  { role: "system", content: "你是编码助手。" },
  { role: "system", content: FP },
  user,
], true);
await send("11 指纹在assistant历史开头", [
  { role: "system", content: "你是编码助手。" },
  { role: "assistant", content: FP },
  user,
], true);
await send("12 指纹在user消息开头", [
  { role: "system", content: "你是编码助手。" },
  { role: "user", content: FP },
  user,
], true);

console.log("== 多行指纹：削一句够不够 ==");
const FP2 =
  "You are an interactive ZCode agent that helps users with software engineering tasks.";
const BODY = "# Harness\nYou are powered by the GLM model trained by Z.ai.";
await send("13 双行You are开头", [{
  role: "system",
  content: FP + "\n" + FP2 + "\n\n" + BODY,
}, user], false);
await send("14 削第一行(剩第二行You are)", [{
  role: "system",
  content: "\n" + FP2 + "\n\n" + BODY,
}, user], false);
await send("15 削到空行(两行都删)", [
  { role: "system", content: "\n\n" + BODY },
  user,
], false);
await send("16 削两句留第三行正文", [{
  role: "system",
  content: "\n" + FP2.replace("ZCode agent", "helpful assistant") + "\n\n" +
    BODY,
}, user], false);

console.log("== 假设：两行身份块削一行不够（重发仍 400 的解释） ==");
const CC1 = "You are Claude Code, Anthropic's official CLI for Claude.";
const CC2 =
  "You are an interactive CLI tool that helps users with software engineering tasks.";
const REST = "\n\n# Plain instructions follow here.\nDo the task.";
await send("17 CC两行完整", [{
  role: "system",
  content: CC1 + "\n" + CC2 + REST,
}, user], false);
await send("18 CC削第一行(剩CC2)", [{
  role: "system",
  content: "\n" + CC2 + REST,
}, user], false);
const Z1 = "You are ZCode, an interactive coding agent";
const Z2 =
  "You are an interactive coding agent that helps users with software engineering tasks.";
await send("19 ZC两行完整", [
  { role: "system", content: Z1 + "\n" + Z2 + REST },
  user,
], false);
await send("20 ZC削第一行(剩Z2)", [{
  role: "system",
  content: "\n" + Z2 + REST,
}, user], false);
await send("21 ZC削到空行", [{ role: "system", content: REST }, user], false);

console.log("== 削头后新生成的头部形状 ==");
await send("22 削后的摘要消息(## 开头)", [{
  role: "system",
  content:
    "\n## Objective\n- Fix stuff\n\n## Work State\n### Active\n- 压缩验证",
}, user], true);
await send("23 完整摘要消息", [{
  role: "system",
  content: "[Conversation Summary]\n## Objective\n- Fix stuff",
}, user], true);
await send("24 ## 一级标题开头", [{
  role: "system",
  content: "## System Rules\nBe brief.",
}, user], true);
await send("25 削后的ZC整段(第二行+工具说明)", [{
  role: "system",
  content:
    "\nYou are an interactive coding agent that helps users with software engineering tasks.\n\n=== TOOL CALL PROTOCOL (JSON) ===",
}, user], true);
