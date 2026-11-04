// probe-cdp.mjs — 用 headless Edge 的页面上下文发 Start Plan 请求（真 Chromium 网络栈）
import { spawn } from "node:child_process";
import { createDecipheriv, createHash } from "node:crypto";
import { homedir, platform, userInfo } from "node:os";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---- 解密 zcodejwttoken ----
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
console.log("[token] len =", zjwt.length);

// ---- 启动 headless Edge ----
const profile = mkdtempSync(join(tmpdir(), "edge-cdp-"));
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9333;
const edge = spawn(EDGE, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--window-size=800,600",
  "about:blank",
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
  // 拿 target
  await new Promise((r) => setTimeout(r, 2500));
  const targetsResp = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  let targets = await targetsResp.json();
  let page = targets.find((t) => t.type === "page");
  if (!page) {
    const put = await fetch(`http://127.0.0.1:${PORT}/json/new?https://zcode.z.ai/`, { method: "PUT" });
    page = await put.json();
  }
  console.log("[cdp] target:", page.url);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

  // 导航到 zcode.z.ai（同源化页面上下文）
  await cdpCall(ws, 1, "Page.enable");
  await cdpCall(ws, 2, "Page.navigate", { url: "https://zcode.z.ai/" });
  await new Promise((r) => setTimeout(r, 5000));
  const ready = await cdpCall(ws, 3, "Runtime.evaluate", { expression: "location.href", returnByValue: true });
  console.log("[cdp] page now at:", ready.result.value);

  // 页面上下文发请求：候选路径 × 认证形状
  const expr = `
    (async () => {
      const out = [];
      const cases = [
        ["anth/messages", "/api/v1/zcode-plan/anthropic/messages"],
        ["anth/v1/messages", "/api/v1/zcode-plan/anthropic/v1/messages"],
        ["openai/chat", "/api/v1/zcode-plan/chat/completions"],
      ];
      for (const [name, path] of cases) {
        try {
          const r = await fetch(path, {
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
              "x-api-key": "${zjwt}",
            },
            body: JSON.stringify({ model: "glm-5.3-flash", max_tokens: 16, stream: false,
              messages: [{ role: "user", content: "只回两个字：收到" }] }),
          });
          const t = await r.text();
          out.push(name + " -> HTTP " + r.status + " :: " + t.slice(0, 260));
          if (r.ok) break;
        } catch (e) { out.push(name + " -> FETCH-ERROR: " + e.message); }
      }
      return out.join("\\n");
    })()
  `;
  const result = await cdpCall(ws, 4, "Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, 90000);
  console.log("[page-fetch]", result.result.value);
  ws.close();
} catch (e) {
  console.log("[cdp] ERROR", e.message);
} finally {
  try { edge.kill(); } catch {}
  setTimeout(() => rmSync(profile, { recursive: true, force: true }), 1500);
}
