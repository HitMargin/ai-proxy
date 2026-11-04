// probe-cdp8.mjs — 逐字节重放真实请求头（model-io 捕获的形状）
import { spawn } from "node:child_process";
import { createDecipheriv, createHash } from "node:crypto";
import { homedir, platform, userInfo } from "node:os";
import { readFileSync, mkdtempSync, rmSync, mkdirSync, copyFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

const secret =
  process.env.ZCODE_CREDENTIAL_SECRET ||
  `zcode-credential-fallback:${platform()}:${homedir()}:${userInfo().username}`;
const key = createHash("sha256").update(secret).digest();
const store = JSON.parse(readFileSync(String.raw`C:\Users\22282\.zcode\v2\credentials.json`, "utf8"));
function decrypt(v) {
  if (typeof v !== "string" || !v.startsWith("enc:v1:")) return v;
  const [ivB, tagB, ctB] = v.slice(7).split(".");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB, "base64url"));
  d.setAuthTag(Buffer.from(tagB, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ctB, "base64url")), d.final()]).toString("utf8");
}
const zjwt = decrypt(store["zcodejwttoken"]).trim();
const oauthRaw = decrypt(store["oauth:zai:access_token"]).trim();
const oauth = (() => { try { const j = JSON.parse(oauthRaw); return j.accessToken || j.access_token || oauthRaw; } catch { return oauthRaw; } })();

function copyLocked(src, dst) {
  try { copyFileSync(src, dst); } catch {
    const ps = `$src=[IO.File]::Open('${src.replace(/\\/g, "\\\\")}','Open','Read','ReadWrite');$dst=[IO.File]::Create('${dst.replace(/\\/g, "\\\\")}');$src.CopyTo($dst);$src.Close();$dst.Close()`;
    execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { stdio: "pipe" });
  }
}

const profile = mkdtempSync(join(tmpdir(), "edge-replay-"));
const netDir = join(profile, "Default", "Network");
mkdirSync(netDir, { recursive: true });
for (const src of [
  String.raw`C:\Users\22282\AppData\Roaming\ZCode\session\Network`,
  String.raw`C:\Users\22282\AppData\Roaming\ZCode\session\Partitions\zcode-coding-plan\Network`,
]) {
  if (!existsSync(src)) continue;
  for (const f of readdirSync(src)) {
    if (f === "Cookies" || f.startsWith("Cookies-")) copyLocked(join(src, f), join(netDir, f));
  }
}

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9344;
const edge = spawn(EDGE, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--disable-extensions", "about:blank",
], { stdio: "ignore" });

async function cdpCall(ws, id, method, params = {}, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`cdp ${method} timeout`)), timeoutMs);
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === id) {
        clearTimeout(timer);
        ws.removeEventListener("message", onMsg);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

try {
  await new Promise((r) => setTimeout(r, 2500));
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  let page = targets.find((t) => t.type === "page");
  if (!page) page = await (await fetch(`http://127.0.0.1:${PORT}/json/new?https://zcode.z.ai/`, { method: "PUT" })).json();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  await cdpCall(ws, 1, "Page.enable");
  await cdpCall(ws, 2, "Page.navigate", { url: "https://zcode.z.ai/cn" });
  await new Promise((r) => setTimeout(r, 5000));

  const SESSION = "0966faf8-3073-40f1-8541-c0d058032e6c";
  // 先把 token 注入页面全局，再跑主表达式
  await cdpCall(ws, 21, "Runtime.evaluate", { expression: `window.__ZJWT = ${JSON.stringify(zjwt)}; window.__OAUTH = ${JSON.stringify(oauth)};` });
  const expr = `
    (async () => {
      const out = [];
      const OAUTH = "" || window.__OAUTH; const ZJWT = window.__ZJWT;
      const base = {
        "http-referer": "https://zcode.z.ai",
        "user-agent": "ZCode/3.17.2",
        "x-zcode-app-version": "3.17.2",
        "x-title": "Z Code@electron",
        "x-release-channel": "production",
        "x-client-language": "zh-CN",
        "x-client-timezone": "Asia/Shanghai",
        "x-zcode-agent": "glm",
        "x-platform": "win32-x64",
        "x-os-category": "windows",
        "x-os-version": "10.0.26300",
        "x-request-id": crypto.randomUUID(),
        "x-zcode-session-type": "main",
        "x-zcode-trace-id": crypto.randomUUID(),
        "x-query-id": crypto.randomUUID(),
        "x-zcode-query-source": "main_turn",
        "x-session-id": "${SESSION}",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "accept": "text/event-stream",
      };
      const body = JSON.stringify({ model: "glm-5.3-flash", max_tokens: 16, stream: false,
        messages: [{ role: "user", content: "只回两个字：收到" }] });
      const cases = [
        ["bearer-oauth", { authorization: "Bearer " + OAUTH }],
        ["xapikey-oauth", { "x-api-key": OAUTH }],
        ["both", { "x-api-key": ZJWT, authorization: "Bearer " + OAUTH }],
      ];
      for (const [name, auth] of cases) {
        try {
          const r = await fetch("/api/v1/zcode-plan/anthropic/v1/messages", {
            method: "POST", headers: { ...base, ...auth }, body,
          });
          const t = await r.text();
          out.push(name + " -> " + r.status + " :: " + t.slice(0, 240));
          if (r.ok) break;
        } catch (e) { out.push(name + " ERR " + e.message); }
      }
      return out.join("\\n");
    })()
  `;
  const result = await cdpCall(ws, 3, "Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, 120000);
  console.log("[replay]", result.result.value);
  ws.close();
} catch (e) {
  console.log("[cdp] ERROR", e.message);
} finally {
  try { edge.kill(); } catch {}
  setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch {} }, 2000);
}
