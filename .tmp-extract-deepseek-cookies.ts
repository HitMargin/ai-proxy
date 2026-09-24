/// <reference lib="dom" />

/**
 * 全自动 DeepSeek Cookie 提取（扫码登录，无需输入密码）
 *
 * 运行：
 *   deno run -A .tmp-extract-deepseek-cookies.ts
 *
 * 流程：
 *   1. 自动打开 Chromium 浏览器
 *   2. 访问 chat.deepseek.com
 *   3. 等待页面出现登录二维码
 *   4. 你用 DeepSeek App 扫码登录
 *   5. 自动检测登录成功
 *   6. 自动提取 Cookie 保存到 deepseek-cookies.txt
 *   7. 自动重启本地代理
 *   8. 自动测试 API
 */

const TARGET = "https://chat.deepseek.com/";
const SIGN_IN_URL = "https://chat.deepseek.com/sign_in";
const OUTPUT = "./deepseek-cookies.txt";
const AUTH_OUTPUT = "./deepseek-auth.txt";
const HEADERS_OUTPUT = "./deepseek-headers.json";
const PROXY_URL = "http://localhost:8000";

function findBrowserExecutable(): string {
  const candidates = Deno.build.os === "windows"
    ? [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      ]
    : [];

  for (const candidate of candidates) {
    try {
      if (Deno.statSync(candidate).isFile) return candidate;
    } catch {}
  }
  throw new Error("未找到可用的 Edge/Chrome 浏览器");
}

async function waitForQrCode(page: any): Promise<boolean> {
  console.log("📱 等待登录二维码出现...");

  for (let i = 0; i < 30; i++) {
    try {
      const hasQr = await page.evaluate(() => {
        const selectors = [
          '[class*="qr"]',
          '[class*="QR"]',
          '[class*="code"]',
          '[class*="Code"]',
          'canvas',
          'img[class*="login"]',
        ];
        return selectors.some(s => document.querySelector(s) !== null);
      });

      if (hasQr) {
        console.log("✅ 检测到登录二维码/登录界面");
        return true;
      }

      const currentUrl = page.url();
      if (currentUrl.includes("/chat") && !currentUrl.includes("login")) {
        console.log("✅ 检测到已登录（直接进入聊天界面）");
        return true;
      }
    } catch {}

    await new Promise((r) => setTimeout(r, 1000));
  }

  return false;
}

async function waitForLoginComplete(page: any): Promise<boolean> {
  console.log("🔍 检测登录状态...");

  for (let i = 0; i < 60; i++) {
    try {
      const currentUrl = page.url();
      if (currentUrl.includes("/chat") && !currentUrl.includes("login")) {
        console.log("✅ URL 变化，检测到登录成功！");
        return true;
      }

      const hasChatInterface = await page.evaluate(() => {
        const selectors = [
          '[class*="chat"]',
          '[class*="input"]',
          'textarea',
          '[contenteditable]',
        ];
        return selectors.some(s => document.querySelector(s) !== null);
      });

      if (hasChatInterface) {
        console.log("✅ 检测到聊天界面，登录成功！");
        return true;
      }

      try {
        const resp = await page.request.fetch(TARGET + "api/v0/chat_session/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          data: "{}",
        });
        const text = await resp.text();
        if (text.includes('chat_session') && !text.includes('Missing Token')) {
          console.log("✅ API 检测到登录成功！");
          return true;
        }
      } catch {}

      console.log(`[${i}] 等待登录中...`);
    } catch (e: any) {
      console.log(`[${i}] 检测出错:`, e.message?.slice(0, 50));
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  return false;
}

async function main() {
  console.log("🚀 全自动 DeepSeek Cookie 提取流程\n");

  console.log("1️⃣ 检测本机浏览器...");
  const browserPath = findBrowserExecutable();
  console.log(`   使用: ${browserPath}`);

  console.log("\n2️⃣ 启动浏览器...");
  const { chromium } = await import("npm:playwright");

  const browser = await chromium.launch({
    headless: false,
    executablePath: browserPath,
  });

  const context = await browser.newContext();

  const page = await context.newPage();
  let bearerToken = "";
  const capturedHeaders: Record<string, string> = {};
  page.on("request", (request: any) => {
    const headers = request.headers();
    const authorization = headers["authorization"] || "";
    if (!bearerToken && authorization.startsWith("Bearer ")) {
      bearerToken = authorization.slice(7).trim();
    }
    for (const name of ["x-hif-dliq", "x-hif-leim", "x-client-platform", "x-client-version", "x-app-version", "accept-language", "user-agent"]) {
      const value = headers[name];
      if (value && !capturedHeaders[name]) capturedHeaders[name] = value;
    }
  });

  console.log(`3️⃣ 打开 ${SIGN_IN_URL}`);
  await page.goto(SIGN_IN_URL, { waitUntil: "domcontentloaded" });

  console.log("\n4️⃣ 请在浏览器中扫码登录 DeepSeek...");
  console.log("   （如果看到二维码，请用 DeepSeek App 扫描）");
  console.log("   （如果已经登录，会自动继续）\n");

  const qrFound = await waitForQrCode(page);
  console.log(qrFound ? "⏳ 已打开登录页，等待扫码/确认登录..." : "⏳ 请在打开的页面完成登录...");

  const loggedIn = await waitForLoginComplete(page);
  if (!loggedIn) {
    console.log("\n❌ 未检测到登录成功，退出。");
    await browser.close();
    Deno.exit(1);
  }

  // 登录后的首页会调用受保护 API；重载一次可可靠捕获前端实际使用的 Bearer Token。
  console.log("\n5️⃣ 捕获登录 Token...");
  await page.reload({ waitUntil: "domcontentloaded" });
  for (let i = 0; i < 30 && !bearerToken; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!bearerToken) {
    const storageToken = await page.evaluate(() => {
      const entries = Object.entries(localStorage);
      const likely = entries
        .filter(([key, value]) => /token|auth|jwt|session/i.test(key) && typeof value === "string" && value.length >= 20)
        .sort((a, b) => b[1].length - a[1].length)[0];
      if (!likely) return "";
      const value = likely[1].trim();
      if (value.startsWith('"') && value.endsWith('"')) {
        try { return String(JSON.parse(value)); } catch { return value.slice(1, -1); }
      }
      return value;
    });
    bearerToken = storageToken;
  }
  if (!bearerToken) {
    console.log("❌ 登录已检测到，但没有捕获到 Bearer Token；请确认登录完成后再重试。");
    await browser.close();
    Deno.exit(1);
  }
  Deno.writeTextFileSync(AUTH_OUTPUT, bearerToken + "\n");
  Deno.writeTextFileSync(HEADERS_OUTPUT, JSON.stringify(capturedHeaders, null, 2) + "\n");
  console.log(`   Bearer Token 已保存到 ${AUTH_OUTPUT}（值未显示）`);
  console.log(`   浏览器请求头已保存到 ${HEADERS_OUTPUT}`);

  console.log("\n6️⃣ 提取 Cookie...");
  const cookies = await context.cookies();

  const filtered = cookies.filter((c: any) => {
    const domain = c.domain || "";
    return domain.includes("deepseek.com");
  });

  if (filtered.length === 0) {
    console.log("❌ 未找到任何 Cookie");
    await browser.close();
    Deno.exit(1);
  }

  console.log(`   找到 ${filtered.length} 个 Cookie`);

  const lines: string[] = [
    "# Netscape HTTP Cookie File",
    "# https://curl.se/docs/http-cookies.html",
    "# Generated by extract-deepseek-cookies.ts",
    "",
  ];

  for (const c of filtered) {
    const domain = c.domain || "";
    const includeSubdomains = domain.startsWith(".") ? "TRUE" : "FALSE";
    const path = c.path || "/";
    const secure = c.secure ? "TRUE" : "FALSE";
    const expiration = c.expires ? Math.floor(c.expires) : 0;
    const name = c.name;
    const value = (c.value || "").replace(/\r/g, "").replace(/\n/g, "");

    const flag = c.httpOnly ? "#HttpOnly_" : "";
    lines.push(`${flag}${domain}\t${includeSubdomains}\t${path}\t${secure}\t${expiration}\t${name}\t${value}`);
  }

  const content = lines.join("\n") + "\n";
  Deno.writeTextFileSync(OUTPUT, content);
  console.log(`\n6️⃣ 已保存到 ${OUTPUT}`);

  await browser.close();
  console.log("   浏览器已关闭");

  console.log("   登录浏览器已关闭\n");

  console.log("7️⃣ 重启本地代理...");
  try {
    const proc = new Deno.Command("cmd", {
      args: ["/c", "pwsh .\\restart.ps1 -Local"],
      cwd: Deno.cwd(),
      stdout: "inherit",
      stderr: "inherit",
    });
    const p = proc.spawn();
    const status = await p.status;
    if (status.success) {
      console.log("   代理重启成功\n");
    } else {
      console.log("   代理重启返回:", status.code);
    }
  } catch (e: any) {
    console.log("   代理重启出错:", e.message);
  }

  console.log("8️⃣ 等待代理就绪...");
  for (let i = 0; i < 15; i++) {
    try {
      const r = await fetch(PROXY_URL + "/");
      if (r.ok) {
        console.log("   代理已就绪\n");
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log("9️⃣ 测试 /deepseek-web/v1/chat/completions...");
  const testBody = JSON.stringify({
    model: "deepseek-chat",
    messages: [{ role: "user", content: "你好，这是一个全自动测试。" }],
  });

  try {
    const testResp = await fetch(PROXY_URL + "/deepseek-web/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: testBody,
    });

    const testText = await testResp.text();
    console.log(`   状态: ${testResp.status}`);
    console.log(`   响应: ${testText.slice(0, 500)}`);

    if (testResp.ok && testText.includes("choices")) {
      console.log("\n🎉🎉🎉 全部完成！DeepSeek 网页端反代已成功运行！");
      console.log(`\n   测试接口: ${PROXY_URL}/deepseek-web/v1/chat/completions`);
      console.log("   使用方法:");
      console.log('   curl http://localhost:8000/deepseek-web/v1/chat/completions \\');
      console.log('     -H "Content-Type: application/json" \\');
      console.log('     -d \'{"model":"deepseek-chat","messages":[{"role":"user","content":"你好"}]}\'');
    } else {
      console.log("\n⚠️  测试未通过，可能原因：");
      console.log("   - Cookie 已过期，请重新运行此脚本");
      console.log("   - DeepSeek 要求 Proof-of-Work（当前未实现，后续可能添加）");
      console.log("   - 网络连接问题");
    }
  } catch (e: any) {
    console.log("\n❌ 测试失败:", e.message);
  }
}

await main();
