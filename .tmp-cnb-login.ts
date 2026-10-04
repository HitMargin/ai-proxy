/// <reference lib="dom" />

/**
 * cnb.cool 一键登录 + 连通性验证（临时取证脚本，与 .tmp-* 同类，不参与主程序）
 *
 * 运行：
 *   deno run -A .tmp-cnb-login.ts              # 拉起浏览器，你登录，脚本自动抓 Cookie
 *   deno run -A .tmp-cnb-login.ts --verify     # 不拉浏览器，只用已有 cnb-login.txt 验证
 *
 * 为什么需要这个脚本
 * ------------------
 * cnb 原本要你 F12 → Network → 复制 Cookie 请求头 → 手工粘进 cnb-login.txt。
 * 这条链路既容易粘错（漏一段、粘成整行请求头），又没有任何验证——粘完
 * 你不知道成没成，只能等下一次推理撞 403 才发现。本脚本把它变成：
 * 浏览器里正常登录 → 自动写盘 → **立即发一次真实请求确认可用**。
 *
 * ⚠️ 判据会漂（这正是不该靠记忆的原因）
 * --------------------------------------
 * AGENTS.md 记的是「匿名会话 401 [NOT_LOGIN]」。2026-10-05 实测匿名打
 * https://cnb.cool/ai/chat/completions 得到的是 **HTTP 403 + errcode 7
 * "User has no permission"**，已经不是 401、也不再回 NOT_LOGIN 字样。
 * 所以本脚本不认状态码、不认错误文案，只认一件事：
 * **带凭据的请求能不能拿到一段真的模型输出**。
 *
 * 写盘格式
 * --------
 * `cnb-login.txt`：单行 `k=v; k=v`。**csrfkey 在写盘前就被剔除**——这不是可选项：
 * src/cnb.ts:49 的注释写明「CSRF token+cookie 对由本代理匿名抓取配对，混入旧
 * csrfkey 会不匹配」。脚本内解析时也按 src/cnb.ts 的同一规则剔除，保持两边一致。
 *
 * 凭据纪律
 * --------
 * 只落盘到 cnb-login.txt（.gitignore 第 51 行已忽略）。终端**不打印 cookie 值**，
 * 只打印 cookie 的**名字**清单，方便你核对「拿到的是不是同一个会话」而不泄露内容。
 */

const CNB_ORIGIN = "https://cnb.cool";
const CNB_CHAT = "https://cnb.cool/ai/chat/completions";
/** 与 src/cnb.ts 的 CNB_LOGIN_FILE 一致（代理由项目根启动，故同为根目录相对路径）。 */
const OUTPUT = "./cnb-login.txt";
/** 探测模型：用聚合/列表里最常见的免费档；不可用时脚本会回退到目录里的第一个。 */
const PROBE_MODEL = "cnb/deepseek-v3.2";

const args = new Set(Deno.args);
const verifyOnly = args.has("--verify") || args.has("-v");

// ---------- 与 src/cnb.ts 逐字一致的两条规则 ----------

/** 登录串里粘进来的 csrfkey 必须剔除：CSRF 对由代理自己匿名抓取配对。 */
function stripCsrfkey(raw: string): string {
  const seen = new Map<string, string>();
  for (const part of raw.split(";").map((x) => x.trim()).filter(Boolean)) {
    if (/^csrfkey=/i.test(part)) continue;
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    seen.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return [...seen].map(([k, v]) => k + "=" + v).join("; ");
}

/**
 * 兼容 Netscape cookies.txt（tab 分列）——src/cnb.ts 也认这个格式。
 * 浏览器扩展导出的往往是它，所以这里同样支持，避免「格式对了但脚本不认」。
 */
function normalizeInput(raw: string): string {
  const t = raw.trim();
  const tab = String.fromCharCode(9);
  if (t.includes(tab) && !t.includes(";")) {
    const parts = t.split(String.fromCharCode(10))
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => {
        const c = l.split(tab);
        return c.length >= 7 ? c[5] + "=" + c[6] : "";
      })
      .filter(Boolean);
    return parts.join("; ");
  }
  return t;
}

/** 只给人看名字，不给人看值。 */
function cookieNames(cookieHeader: string): string[] {
  return cookieHeader.split(";").map((x) => x.trim()).filter(Boolean)
    .map((p) => p.slice(0, Math.max(0, p.indexOf("=")))).filter(Boolean).sort();
}

// ---------- 浏览器 ----------

function findBrowserExecutable(): string {
  const candidates = Deno.build.os === "windows"
    ? [
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ]
    : Deno.build.os === "darwin"
    ? [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ]
    : [
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge",
    ];
  for (const c of candidates) {
    try {
      if (Deno.statSync(c).isFile) return c;
    } catch { /* 试下一个 */ }
  }
  throw new Error("未找到可用浏览器（Edge/Chrome）。装了别的浏览器请自行加进候选表。");
}

/**
 * 登录成功的判据：**会话 cookie 出现且能通过一次真实推理**，而不是「URL 变了」
 * 或「页面上有头像」。cookie 出现只是必要条件——本函数只回答「cookie 有了没」，
 * 真正算不算数交给 verify()。
 */
async function waitForSessionCookie(context: any, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  let lastNames: string[] = [];
  while (Date.now() < deadline) {
    let cookies: Array<{ name: string; value: string; domain: string }> = [];
    try {
      cookies = await context.cookies(CNB_ORIGIN);
    } catch { /* 浏览器还在起 */ }

    // CNBSESSION 是实测看到的会话 cookie 名。不写死唯一名字：万一上游改名，
    // 退回到「拿全部 cnb.cool cookie」，宁可多带也不能因为改了个名字就抓不到。
    const session = cookies.filter((c) =>
      /cnbsession|session|token|auth/i.test(c.name) && c.value
    );
    lastNames = cookies.map((c) => c.name).sort();
    const hasSession = session.length > 0;

    if (hasSession && !announced) {
      announced = true;
      console.log("  ✓ 检测到会话 cookie：" + session.map((c) => c.name).join(", "));
    }
    if (announced) {
      // 登录刚完成时 cookie 可能还在补写，多等一轮让它们稳定下来。
      await new Promise((r) => setTimeout(r, 2500));
      return cookies.map((c) => c.name + "=" + c.value).join("; ");
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    "等待登录超时。当前 cnb.cool 域下可见的 cookie 名：" +
      (lastNames.length ? lastNames.join(", ") : "（一个都没有）"),
  );
}

// ---------- 验证（唯一的判据） ----------

interface Verdict {
  ok: boolean;
  httpStatus: number | null;
  detail: string;
  model: string;
  text: string;
}

/**
 * 发一次真实推理请求。**这是唯一的成功判据**：状态码、错误文案都不认，
 * 只认「有没有真的吐出一段文本」。
 */
async function verify(cookieHeader: string, model: string): Promise<Verdict> {
  const started = Date.now();
  let status: number | null = null;
  let text = "";
  let detail = "";
  try {
    const r = await fetch(CNB_CHAT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cookie": cookieHeader,
        "accept": "text/event-stream, application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        stream: true,
        max_tokens: 16,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    status = r.status;

    const ct = r.headers.get("content-type") || "";
    const body = await r.text();
    if (ct.includes("event-stream")) {
      for (const line of body.split(String.fromCharCode(10))) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const j = JSON.parse(payload);
          const d = j?.choices?.[0]?.delta ?? j?.choices?.[0]?.message;
          const piece = d?.content ?? d?.reasoning_content ?? "";
          if (typeof piece === "string") text += piece;
        } catch { /* 非 JSON 帧忽略 */ }
      }
    } else {
      try {
        const j = JSON.parse(body);
        const c = j?.choices?.[0]?.message?.content;
        if (typeof c === "string") text = c;
        if (j?.errcode || j?.errmsg) detail = `errcode ${j.errcode}: ${j.errmsg}`;
      } catch {
        detail = body.slice(0, 200);
      }
    }
    if (!detail && !text) detail = body.slice(0, 200);
  } catch (e) {
    detail = e instanceof Error ? e.message : String(e);
  }

  const ms = Date.now() - started;
  const ok = text.trim().length > 0;
  return {
    ok,
    httpStatus: status,
    model,
    text: text.trim(),
    detail: ok ? `${ms}ms` : `${ms}ms · ${detail}`,
  };
}

/**
 * 探测模型名。自由档每周变，所以**不写死**：先看代理的目录里有什么，
 * 拿不到再退回默认值。这样脚本不会因为某个 id 下架而假装渠道坏了。
 */
async function resolveProbeModel(): Promise<string> {
  try {
    const r = await fetch("http://127.0.0.1:8000/v1/models", {
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return PROBE_MODEL;
    const j = await r.json();
    const ids: string[] = (j?.data ?? []).map((m: any) => String(m?.id ?? ""));
    const cnb = ids.filter((id) => id.startsWith("cnb/"));
    const free = cnb.find((id) => /free|flash|v3/i.test(id));
    return free ?? cnb[0] ?? PROBE_MODEL;
  } catch {
    return PROBE_MODEL;
  }
}

// ---------- main ----------

async function main() {
  console.log("cnb.cool 一键登录 / 连通性验证");
  console.log("================================");

  let cookieHeader = "";

  if (verifyOnly) {
    let raw = "";
    try {
      raw = Deno.readTextFileSync(OUTPUT);
    } catch {
      console.error(`✗ 找不到 ${OUTPUT}，没有可验证的凭据。先不带 --verify 跑一次登录。`);
      Deno.exit(1);
    }
    cookieHeader = stripCsrfkey(normalizeInput(raw));
    const names = cookieNames(cookieHeader);
    console.log(`模式：仅验证（${OUTPUT}，${names.length} 个 cookie）`);
    if (!names.length) {
      console.error("✗ 文件里没解析出任何 cookie（是不是空了，或者粘成了整行请求头？）");
      Deno.exit(1);
    }
    console.log("  cookie 名：" + names.join(", "));
  } else {
    const { chromium } = await import("npm:playwright");
    const exe = findBrowserExecutable();
    console.log("浏览器：" + exe);

    const browser = await chromium.launch({ executablePath: exe, headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();

    console.log("\n请在打开的窗口里登录 cnb.cool（扫码或账号密码都行）。");
    console.log("登录完成后本脚本会自动继续，无需回到终端按键。\n");

    await page.goto(CNB_ORIGIN, { waitUntil: "domcontentloaded" }).catch(() => {});

    try {
      cookieHeader = await waitForSessionCookie(context, 5 * 60 * 1000);
    } finally {
      await browser.close().catch(() => {});
    }

    cookieHeader = stripCsrfkey(cookieHeader);
    const names = cookieNames(cookieHeader);
    console.log("  cookie 名：" + names.join(", "));

    if (!names.length) {
      console.error("✗ 没抓到任何 cookie，未写盘（免得用空文件覆盖掉现有凭据）。");
      Deno.exit(1);
    }

    // 写盘前先验证：**不验证就写盘，等于把「粘对了没」这个问题推给下一次推理**。
    // 验证失败时保留原文件，避免用一份坏凭据覆盖一份可能还好的。
    console.log("\n验证中（真实请求，会消耗一次极小的免费额度）...");
    const model = await resolveProbeModel();
    const verdict = await verify(cookieHeader, model);

    if (!verdict.ok) {
      console.error(`✗ 验证失败：HTTP ${verdict.httpStatus ?? "?"} · ${verdict.detail}`);
      console.error("  未写盘（保留原有 cnb-login.txt）。常见原因：");
      console.error("   · 登录了但该账号没有 cnb AI 推理权限");
      console.error("   · 拿到的 cookie 不含会话（清一下浏览器 cookie 重试）");
      Deno.exit(1);
    }

    await Deno.writeTextFile(OUTPUT, cookieHeader + String.fromCharCode(10));
    console.log(`✓ 验证通过（${verdict.model} 回：${JSON.stringify(verdict.text.slice(0, 60))}）`);
    console.log(`✓ 已写入 ${OUTPUT}（${names.length} 个 cookie，csrfkey 已剔除）`);
    console.log("  代理按 mtime 热加载，无需重启。");
    return;
  }

  console.log("\n验证中（真实请求）...");
  const model = await resolveProbeModel();
  const verdict = await verify(cookieHeader, model);
  if (verdict.ok) {
    console.log(`✓ 可用：${verdict.model} 回 ${JSON.stringify(verdict.text.slice(0, 60))}（${verdict.detail}）`);
  } else {
    console.error(`✗ 不可用：HTTP ${verdict.httpStatus ?? "?"} · ${verdict.detail}`);
    Deno.exit(1);
  }
}

if (import.meta.main) await main();
