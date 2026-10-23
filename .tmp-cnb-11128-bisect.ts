// 11128 离线二分：加载 .tmp-cnb-11128-persist.json（削头后仍被拦的那具 body），
// 先本地扫消息头找可疑串，再对上游做前缀二分，定位触发 11128 的那条消息。
//   deno run -A .tmp-cnb-11128-bisect.ts scan     # 只本地扫描，不发请求
//   deno run -A .tmp-cnb-11128-bisect.ts bisect   # 前缀二分（会打真上游）
import { cnbBuildUpstream } from "./src/cnb.ts";

const FILE = ".tmp-cnb-11128-persist.json";
const mode = Deno.args[0] ?? "scan";

const dumped = JSON.parse(await Deno.readTextFile(FILE));
const rawBody: any = dumped.body;
console.log("dumpedAt:", dumped.dumpedAt, "headSample:", dumped.headSample);
console.log("messages:", rawBody.messages?.length);

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

async function probe(msgs: any[]): Promise<{ status: number; code: string }> {
  // 落盘的是**已构建的上游 body**（XYML / 工具说明都已注入），只换 messages，
  // 绝不能再过一遍 cnbBuildUpstream（会把工具说明重复追加到第一条消息上）。
  const body = { ...rawBody, messages: msgs };
  const r0 = await fetch("https://cnb.cool/", {
    headers: { "User-Agent": UA, Cookie: login },
  });
  const html = await r0.text();
  const token = html.match(/window\.csrftoken\s*=\s*"([0-9a-fA-F]{32,64})"/)
    ?.[1];
  let cs: string[] = [];
  try {
    cs = (r0.headers as any).getSetCookie?.() ?? [];
  } catch {}
  const csrfkey = cs.map((c) => c.match(/csrfkey=([^;\s]+)/)?.[1]).find(
    Boolean,
  );
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
  await new Promise((r) => setTimeout(r, 900));
  return { status: resp.status, code: t.match(/"code":(\d+)/)?.[1] ?? "" };
}

const msgs: any[] = rawBody.messages;
const SUSPECTS = [
  "Claude Code",
  "DeepSeek Harness",
  "official CLI",
  "You are Claude",
  "You are an AI agent",
  "You are ZCode",
  "Anthropic",
  "zai-start",
  "[body too large",
  "environment_context",
  "<env>",
  "system-reminder",
];

function head(m: any): string {
  const c = m?.content;
  const text = typeof c === "string"
    ? c
    : Array.isArray(c)
    ? c.map((p: any) => typeof p?.text === "string" ? p.text : "").join("")
    : "";
  return text;
}

if (mode === "scan") {
  for (let i = 0; i < msgs.length; i++) {
    const h = head(msgs[i]);
    if (h.trim() === "") continue;
    const firstLine = h.trimStart().split("\n")[0].slice(0, 100);
    const hit = SUSPECTS.filter((s) => h.slice(0, 400).includes(s));
    const flag = hit.length ? "  ★ " + hit.join(",") : "";
    if (i < 6 || hit.length) {
      console.log(`[${i}] ${msgs[i].role} ${JSON.stringify(firstLine)}${flag}`);
    }
  }
  Deno.exit(0);
}

// bisect：先整包确认，再前缀二分「最小的触发前缀」。
console.log("== 整包确认 ==");
const full = await probe(msgs);
console.log("full body:", full.status, full.code);

let lo = 1, hi = msgs.length; // [0,lo) 不触发；[0,hi] 触发（前缀含下标 hi-1）
if (full.status !== 400) {
  console.log(
    "full body did not reproduce 400 — trigger may depend on组合/上游状态",
  );
  Deno.exit(1);
}
const prefixProbe = async (k: number) => {
  const r = await probe(msgs.slice(0, k));
  return r.status === 400;
};
// 先看纯头部（1 条 / 2 条）
console.log("head only:", await prefixProbe(1) ? "400" : "200");
while (lo < hi) {
  const mid = Math.floor((lo + hi) / 2);
  const bad = await prefixProbe(mid + 1);
  console.log(`prefix [0..${mid}] (${mid + 1} msgs): ${bad ? "400" : "200"}`);
  if (bad) hi = mid;
  else lo = mid + 1;
}
const offender = msgs[lo];
console.log("\n== 最小触发前缀 ==", lo + 1, "条；最后一条 =");
console.log(`[${lo}] role=${offender?.role}`);
const h = head(offender);
console.log("head:", JSON.stringify(h.slice(0, 200)));
console.log(
  "size:",
  new TextEncoder().encode(JSON.stringify(offender)).length,
  "B",
);
