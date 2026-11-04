// probe-cdp4.mjs — CDP 网络层强制 ZCode 指纹头（绕过浏览器禁改头的限制）
import { spawn } from "node:child_process";
import { createDecipheriv, createHash } from "node:crypto";
import { homedir, platform, userInfo } from "node:os";
import { readFileSync, mkdtempSync, rmSync, mkdirSync, copyFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const profile = mkdtempSync(join(tmpdir(), "edge-cookies-"));
const netDir = join(profile, "Default", "Network");
mkdirSync(netDir, { recursive: true });
const src = String.raw`C:\Users\22282\AppData\Roaming\ZCode\session\Network`;
import { execSync } from "node:child_process";
for (const f of readdirSync(src)) {
  if (f === "Cookies" || f.startsWith("Cookies-")) {
    const dst = join(netDir, f);
    try { copyFileSync(join(src, f), dst); } catch {
      const ps = `$src=[IO.File]::Open('${join(src, f).replace(/\\/g, "\\\\")}','Open','Read','ReadWrite');$dst=[IO.File]::Create('${dst.replace(/\\/g, "\\\\")}');$src.CopyTo($dst);$src.Close();$dst.Close()`;
      execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { stdio: "pipe" });
    }
  }
}

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9338;
const edge = spawn(EDGE, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--disable-extensions", "about:blank",
], { stdio: "ignore" });

async function cdpCall(ws, id, method, params = {}, timeoutMs = 30000) {
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

const FINGERPRINT = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ZCode/3.17.2 Chrome/152.0.7977.130 Electron/44.7.0 Safari/537.36",
  "x-zcode-app-version": "3.17.2",
  "x-title": "Z Code@electron",
  "x-platform": "win32-x64",
  "x-os-category": "windows",
  "x-os-version": "10.0.26300",
  "x-client-language": "zh-CN",
  "x-client-timezone": "Asia/Shanghai",



  "x-device-mid": "0c5f8e58-4f22-45c3-a8dc-a507071cf840",
  "x-zcode-query-source": "main_turn",
  "x-zcode-session-type": "main",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
};

try {
  await new Promise((r) => setTimeout(r, 2500));
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  let page = targets.find((t) => t.type === "page");
  if (!page) page = await (await fetch(`http://127.0.0.1:${PORT}/json/new?https://zcode.z.ai/`, { method: "PUT" })).json();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  await cdpCall(ws, 1, "Page.enable");
  await cdpCall(ws, 2, "Network.enable");
  // 网络层强制整套指纹头：对页面所有请求生效（含 fetch 的 auth 头注入测试）
  await cdpCall(ws, 3, "Network.setExtraHTTPHeaders", { headers: FINGERPRINT });
  await cdpCall(ws, 4, "Page.navigate", { url: "https://zcode.z.ai/cn" });
  await new Promise((r) => setTimeout(r, 5000));

  const expr = `
    (async () => {
      const out = [];
      for (const [name, auth] of [["bearer", { "authorization": "Bearer ${zjwt}" }], ["xapikey", { "x-api-key": "${zjwt}" }]]) {
        try {
          const r = await fetch("/api/v1/zcode-plan/anthropic/v1/messages", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "anthropic-version": "2023-06-01",
              "accept": "text/event-stream",
              "x-request-id": crypto.randomUUID(),
              "x-zcode-trace-id": crypto.randomUUID(),
              "x-session-id": crypto.randomUUID(),
              "x-query-id": crypto.randomUUID(),
              ...auth,
            },
            body: JSON.stringify({ model: "glm-5.3-flash", max_tokens: 16, stream: false,
              messages: [{ role: "user", content: "只回两个字：收到" }] }),
          });
          const t = await r.text();
          out.push(name + " -> HTTP " + r.status + " :: " + t.slice(0, 300));
          if (r.ok) break;
        } catch (e) { out.push(name + " -> FETCH-ERROR: " + e.message); }
      }
      return out.join("\\n");
    })()
  `;
  const result = await cdpCall(ws, 5, "Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, 120000);
  console.log("[page-fetch]", result.result.value);
  ws.close();
} catch (e) {
  console.log("[cdp] ERROR", e.message);
} finally {
  try { edge.kill(); } catch {}
  setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch {} }, 2000);
}
