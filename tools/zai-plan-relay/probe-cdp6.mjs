// probe-cdp6.mjs — 会话建立序列测试：先 billing，再 messages
import { spawn } from "node:child_process";
import { createDecipheriv, createHash } from "node:crypto";
import { homedir, platform, userInfo } from "node:os";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
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

const profile = mkdtempSync(join(tmpdir(), "edge-seq-"));
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9341;
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

  const expr = `
    (async () => {
      const out = [];
      const base = {
        "content-type": "application/json",
        "user-agent": "ZCode/3.17.2",
        "x-zcode-app-version": "3.17.2",
        "x-device-mid": "0c5f8e58-4f22-45c3-a8dc-a507071cf840",
        "x-request-id": crypto.randomUUID(),
        "x-zcode-session-type": "main",
        "x-zcode-query-source": "main_turn",
      };
      // step1: billing/balance（真实客户端的会话建立序列）
      try {
        const r = await fetch("/api/v1/zcode-plan/billing/balance?app_version=3.17.2", {
          headers: { ...base, authorization: "Bearer ${zjwt}", accept: "application/json, text/plain, */*" },
        });
        const t = await r.text();
        out.push("step1 billing(Bearer) -> " + r.status + " :: " + t.slice(0, 120));
      } catch (e) { out.push("step1 ERR " + e.message); }
      // step2: client/configs
      try {
        const r = await fetch("/api/v1/client/configs?app_version=3.17.2&platform=win32-x64", {
          headers: { ...base, authorization: "Bearer ${zjwt}", accept: "application/json, text/plain, */*" },
        });
        const t = await r.text();
        out.push("step2 configs(Bearer) -> " + r.status + " :: " + t.slice(0, 120));
      } catch (e) { out.push("step2 ERR " + e.message); }
      // step3+4: messages，两种认证
      for (const [name, auth] of [["xapikey", { "x-api-key": "${zjwt}" }], ["bearer", { authorization: "Bearer ${zjwt}" }]]) {
        try {
          const r = await fetch("/api/v1/zcode-plan/anthropic/v1/messages", {
            method: "POST",
            headers: { ...base, "anthropic-version": "2023-06-01", accept: "text/event-stream", ...auth },
            body: JSON.stringify({ model: "glm-5.3-flash", max_tokens: 16, stream: false,
              messages: [{ role: "user", content: "只回两个字：收到" }] }),
          });
          const t = await r.text();
          out.push("step messages(" + name + ") -> " + r.status + " :: " + t.slice(0, 260));
          if (r.ok) break;
        } catch (e) { out.push("step messages(" + name + ") ERR " + e.message); }
      }
      return out.join("\\n");
    })()
  `;
  const result = await cdpCall(ws, 3, "Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, 120000);
  console.log(result.result.value);
  ws.close();
} catch (e) {
  console.log("[cdp] ERROR", e.message);
} finally {
  try { edge.kill(); } catch {}
  setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch {} }, 2000);
}
