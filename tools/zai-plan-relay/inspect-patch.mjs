// inspect-patch.mjs — 连接所有 Node inspector（9229+），在每个进程里 patch fetch/https，
// 把发往 zcode 的真实请求头（JS 层构造时的原样）落到 .tmp-inspect.log
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(process.cwd(), ".tmp-cdp");
const LOG = join(OUT, ".tmp-inspect.log");
const BASE = Number(process.env.INSPECT_BASE || 9229);
const MAX = 24;

const PATCH = `(function(){
  try {
    if (globalThis.__zcode_patched) return 'already';
    globalThis.__zcode_patched = true;
    const fs = require('fs');
    const LOG = 'D:/Projects/ai-proxy/tools/zai-plan-relay/.tmp-cdp/.tmp-inspect.log';
    const w = (s) => { try { fs.appendFileSync(LOG, s + '\\n'); } catch {} };
    try {
      const of = globalThis.fetch;
      if (of) globalThis.fetch = function(...a) {
        try {
          const u = String(a[0] && a[0].url ? a[0].url : a[0]);
          if (u.includes('zcode')) {
            const init = a[1] || {};
            let hs = init.headers;
            if (hs && typeof hs === 'object' && !(hs instanceof Array) && typeof hs.forEach !== 'function') hs = Object.fromEntries([...hs]);
            w('--- FETCH ' + new Date().toISOString() + ' pid=' + process.pid + ' ' + u + '\\nHDRS ' + JSON.stringify(hs || null) + '\\nBODY ' + String(init.body || '').slice(0, 500));
          }
        } catch {}
        return of.apply(this, a);
      };
    } catch (e) { w('fetch patch ERR ' + e.message); }
    try {
      const https = require('https');
      const orig = https.request;
      https.request = function(...args) {
        try {
          const o = args[0];
          if (o && typeof o === 'object') {
            const full = (o.protocol||'https:') + '//' + (o.hostname||o.host) + (o.path||'');
            if (full.includes('zcode')) {
              w('--- HTTPS.req ' + new Date().toISOString() + ' pid=' + process.pid + ' ' + o.method + ' ' + full + '\\nHDRS ' + JSON.stringify(o.headers || null) + '\\nBODY ' + String(o.body || '').slice(0, 500));
            }
          }
        } catch {}
        return orig.apply(this, args);
      };
    } catch (e) { w('https patch ERR ' + e.message); }
    return 'patched pid=' + process.pid;
  } catch (e) { return 'ERR ' + e.message; }
})()`;

const done = [];
for (let port = BASE; port < BASE + MAX; port++) {
  try {
    const meta = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(800) }).then(r => r.json());
    const wsUrl = meta.webSocketDebuggerUrl;
    if (!wsUrl) continue;
    const ws = new WebSocket(wsUrl);
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 5000);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: PATCH, returnByValue: true } }));
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id === 1) { clearTimeout(timer); resolve(m.result?.result?.value ?? JSON.stringify(m.result)); }
      };
      ws.onerror = () => { clearTimeout(timer); resolve('ws-error'); };
    });
    done.push(`:${port} ${meta.V8 || meta.Browser || ''} -> ${result}`);
    ws.close();
  } catch { /* port not open */ }
}
writeFileSync(join(OUT, "patch-status.txt"), new Date().toISOString() + "\n" + done.join("\n") + "\n");
console.log(done.join("\n") || "no inspectors found");
