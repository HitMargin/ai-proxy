// probe-cdp2.mjs — 路径 × 凭据矩阵（headless Edge 页面上下文，真 Chromium 栈）
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
const oauthRaw = decrypt(store["oauth:zai:access_token"]).trim();
const oauth = (() => { try { const j = JSON.parse(oauthRaw); return j.accessToken || j.access_token || oauthRaw; } catch { return oauthRaw; } })();
const locKey = Object.keys(store).find((k) => k.startsWith("project-key-location:v1:"));
const location = JSON.parse(decrypt(store[locKey]));
const apiKeyId = location.apiKeyId;

const profile = mkdtempSync(join(tmpdir(), "edge-cdp2-"));
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9334;
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
  await cdpCall(ws, 2, "Page.navigate", { url: "https://zcode.z.ai/" });
  await new Promise((r) => setTimeout(r, 5000));

  const expr = `
    (async () => {
      const out = [];
      const tokens = { zjwt: ${JSON.stringify(zjwt)}, oauth: ${JSON.stringify(oauth)}, apiKeyId: ${JSON.stringify(apiKeyId)} };
      const paths = [
        "/api/v1/zcode-plan/anthropic/messages",
        "/api/v1/zcode-plan/anthropic/v1/messages",
        "/api/v1/zcode-plan/chat/completions",
      ];
      for (const path of paths) {
        for (const [tname, tok] of Object.entries(tokens)) {
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
                "x-api-key": tok,
              },
              body: JSON.stringify({ model: "glm-5.3-flash", max_tokens: 16, stream: false,
                messages: [{ role: "user", content: "只回两个字：收到" }] }),
            });
            const t = await r.text();
            out.push(path.split("zcode-plan")[1] + " [" + tname + "] -> " + r.status + " :: " + t.slice(0, 200));
            if (r.ok) return out.join("\\n");
          } catch (e) { out.push(path + " [" + tname + "] -> ERR " + e.message); }
        }
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
