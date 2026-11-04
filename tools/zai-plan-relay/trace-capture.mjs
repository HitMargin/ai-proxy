// trace-capture.mjs — 浏览器级 Tracing（devtools.network）抓所有网络上下文请求头
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT = join(process.cwd(), ".tmp-cdp");
mkdirSync(OUT, { recursive: true });
const PORT = 9340;
const DURATION_MS = Number(process.env.TRACE_MS || 45000);

const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((resolve) => {
  const mid = ++id;
  pending.set(mid, resolve);
  ws.send(JSON.stringify({ id: mid, method, params }));
});

const started = await send("Tracing.start", {
  transferMode: "ReturnAsStream",
  traceConfig: {
    recordMode: "recordAsMuchAsPossible",
    includedCategories: ["devtools.network", "net"],
    excludedCategories: ["*"],
  },
});
console.log("[trace] started - recording", DURATION_MS, "ms");
await new Promise((r) => setTimeout(r, DURATION_MS));
await send("Tracing.end", {});
console.log("[trace] end sent");

// tracingComplete 事件会带 stream handle
const complete = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), 30000);
  const h = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === "Tracing.tracingComplete") { clearTimeout(timer); ws.removeEventListener("message", h); resolve(m.params.stream ?? null); }
  };
  ws.addEventListener("message", h);
});

if (!complete) { console.log("[trace] no stream (empty trace?)"); process.exit(0); }

const chunks = [];
let eof = false;
while (!eof) {
  const r = await send("IO.read", { handle: complete });
  const d = r.result?.data ?? "";
  if (d) chunks.push(d);
  eof = r.result?.eof === true;
}
const data = chunks.join("");
writeFileSync(join(OUT, "trace.json"), data);
console.log("[trace] saved", data.length, "bytes");
ws.close();
