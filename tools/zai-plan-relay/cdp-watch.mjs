// cdp-watch.mjs — 挂 ZCode 的 CDP，监听所有 target 的 zcode.z.ai 请求（含头）
// 输出：.tmp-cdp/requests.jsonl
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(process.cwd(), ".tmp-cdp");
mkdirSync(OUT, { recursive: true });
const JSONL = join(OUT, "requests.jsonl");
const PORT = Number(process.env.CDP_PORT || 9340);

const seen = new Map(); // targetId -> ws
const attached = new Set();

async function listTargets() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(3000) });
    return r.json();
  } catch { return []; }
}

async function attach(target) {
  if (seen.has(target.id) || attached.has(target.id)) return;
  attached.add(target.id);
  let ws;
  try {
    ws = new WebSocket(target.webSocketDebuggerUrl);
  } catch (e) { attached.delete(target.id); return; }
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === "Network.requestWillBeSent") {
      const r = m.params.request;
      if (r.url.includes("zcode.z.ai") || r.url.includes("127.0.0.1:9999")) {
        const rec = {
          t: new Date().toISOString(), target: target.type + ":" + (target.title || "").slice(0, 30),
          url: r.url, method: r.method, headers: r.headers,
        };
        appendFileSync(JSONL, JSON.stringify(rec) + "\n");
        console.log(`[${rec.target}] ${r.method} ${r.url.slice(0, 100)}`);
      }
    }
    if (m.method === "Network.requestWillBeSentExtraInfo") {
      // 附加信息头（含 cookie），按 requestid 关联
      appendFileSync(join(OUT, "extrainfo.jsonl"), JSON.stringify({ t: new Date().toISOString(), requestId: m.params.requestId, headers: m.params.headers }) + "\n");
    }
  };
  ws.onopen = async () => {
    seen.set(target.id, ws);
    try {
      await send("Network.enable", { maxTotalBufferSize: 10_000_000, maxResourceBufferSize: 5_000_000 });
      console.log(`[attached] ${target.type} ${target.url.slice(0, 80)}`);
    } catch (e) { console.log(`[attach-fail] ${target.url.slice(0, 60)} ${e.message}`); }
  };
  ws.onclose = () => { seen.delete(target.id); attached.delete(target.id); };
  ws.onerror = () => {};
}

console.log(`[watch] polling CDP :${PORT}, out=${JSONL}`);
setInterval(async () => {
  for (const t of await listTargets()) attach(t);
}, 2000);
