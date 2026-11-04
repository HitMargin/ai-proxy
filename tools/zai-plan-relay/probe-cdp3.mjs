// probe-cdp3.mjs — 把 ZCode 的真实 session cookies 搬进 headless Edge，重放模型请求
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
    try {
      copyFileSync(join(src, f), dst);
    } catch {
      // 活库被 SQLite 锁住：PowerShell 共享读强行拷贝
      const ps = `$src=[IO.File]::Open('${join(src, f).replace(/\\/g, "\\\\")}','Open','Read','ReadWrite');$dst=[IO.File]::Create('${dst.replace(/\\/g, "\\\\")}');$src.CopyTo($dst);$src.Close();$dst.Close()`;
      execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { stdio: "pipe" });
    }
  }
}
console.log("[cookies] copied:", existsSync(join(netDir, "Cookies")) ? "yes" : "NO");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9335;
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

  const cookies = await cdpCall(ws, 3, "Network.getCookies", { urls: ["https://zcode.z.ai/"] });
  console.log("[cookies] visible to page:", cookies.cookies.map((c) => c.name).join(", ") || "(none)");

  const expr = `
    (async () => {
      const out = [];
      const variants = [
        ["bearer", { "authorization": "Bearer ${zjwt}" }],
        ["xapikey", { "x-api-key": "${zjwt}" }],
      ];
      for (const [name, auth] of variants) {
        try {
          const r = await fetch("/api/v1/zcode-plan/anthropic/v1/messages", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "anthropic-version": "2023-06-01",
              "accept": "text/event-stream",
              "user-agent": "ZCode/3.17.2",
              "x-zcode-app-version": "3.17.2",
              "x-device-mid": "0c5f8e58-4f22-45c3-a8dc-a507071cf840",
              "x-request-id": crypto.randomUUID(),
              "x-zcode-session-type": "main",
              "x-zcode-query-source": "main_turn",
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
  const result = await cdpCall(ws, 4, "Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, 120000);
  console.log("[page-fetch]", result.result.value);
  ws.close();
} catch (e) {
  console.log("[cdp] ERROR", e.message);
} finally {
  try { edge.kill(); } catch {}
  setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch {} }, 2000);
}
