/**
 * TRAE 每日签到（一次性动作，需 trae-auth.json）。
 *
 * ⚠️ 三条实测约束（都来自会骗人的地方）：
 *  1. claim 响应**不含积分数**，只有 {"code":0,"message":"success"}；
 *     真实数值只在**随后**的 status 里（早期实现读 claim 的 credits，恒为 0）。
 *  2. claim 对「今天已领」**幂等**——重复领同样回 code 0，与真成功**无法区分**。
 *     所以必须**先查 status**，用 checked_in 判「是否已领」。
 *  3. 请求体必须是 `{}`（不是 {"req_source":2}）。
 */
const cred = JSON.parse(await Deno.readTextFile("./trae-auth.json"));
const UG_HOST = "https://api.trae.cn";
const STATUS_PATH = "/trae/api/v2/ug/checkin_credits/status";
const CLAIM_PATH = "/trae/api/v2/ug/checkin_credits/claim";

function headers() {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "VSCode 1.107.1 (TRAE SOLO CN)",
    Authorization: `Cloud-IDE-JWT ${cred.access_token}`,
    "X-User-Region": "CN",
    "X-Device-Id": cred.device_id,
  };
}

async function post(path: string, body: string) {
  const resp = await fetch(UG_HOST + path, {
    method: "POST",
    headers: headers(),
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await resp.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch { /* 非 JSON */ }
  return { status: resp.status, json, text };
}

console.log("device_id = " + cred.device_id);
console.log("uid       = " + cred.uid);

const before = await post(STATUS_PATH, "{}");
console.log("\n[1] 领取前 status:", before.text.slice(0, 220));
if (before.status !== 200) {
  console.error("❌ status 查询失败 HTTP " + before.status);
  Deno.exit(1);
}
const alreadyIn = before.json.checked_in === true ||
  before.json.did_checked_in === true;
if (alreadyIn) {
  console.log("\n⚠️ 今天已经签过到了（checked_in=true），跳过领取。");
  console.log(
    "   已领积分 credits=" + (before.json.credits ?? before.json.extra_credits),
  );
  const bal = await post(
    "/trae/api/v2/pay/ide_user_ent_usage",
    '{"require_usage":true,"req_source":2}',
  );
  if (bal.status === 200) {
    const packs = (bal.json.user_entitlement_pack_list ?? []) as Record<
      string,
      unknown
    >[];
    let total = 0;
    for (const p of packs) {
      const base = p.entitlement_base_info as
        | Record<string, unknown>
        | undefined;
      const quota = base?.quota as Record<string, unknown> | undefined;
      if (!quota) continue;
      const limit = Number(quota.credits_limit);
      if (!(limit > 0)) continue;
      const usage = p.usage as Record<string, unknown> | undefined;
      const used = usage ? Number(usage.credits_amount ?? 0) : 0;
      total += limit - used;
      console.log(
        "   " + String(base?.display_desc ?? "包").padEnd(16) +
          String(limit - used).padStart(6) + " / " + limit,
      );
    }
    console.log("   余额合计: " + Math.round(total * 100) / 100);
  }
  Deno.exit(0);
}

/**
 * 领取，带退避重试。
 *
 * ⚠️ 业务码 **9074「当前参与用户太多」是按 device_id 限流的**，
 * 不是账号问题 —— 实测第一次调用就撞上了。所以必须重试，
 * 且**不能靠换 device_id 绕过**（换设备等于换机器，
 * 而 machine_id/device_id 与已落盘的凭据是一对）。
 */
async function claimWithRetry(attempts: number) {
  for (let i = 1; i <= attempts; i++) {
    const resp = await post(CLAIM_PATH, "{}");
    const code = Number(resp.json.code ?? 0);
    if (code === 0) return { ok: true, resp, tries: i };
    // 只有 9074（限流）值得重试；其它业务码重试无意义
    if (code !== 9074) return { ok: false, resp, tries: i };
    if (i < attempts) {
      const waitMs = i * 5000;
      console.log(
        "   9074 限流，" + waitMs / 1000 + "s 后重试（第 " + i + " 次）…",
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  return { ok: false, resp: null, tries: attempts };
}

console.log("\n[2] 领取中（9074 限流会自动退避重试）…");
const claim = await claimWithRetry(4);
if (claim.resp !== null) {
  console.log("   claim ->", claim.resp.text.slice(0, 200));
}
// ⚠️ HTTP 200 不代表成功，判据是业务码。
if (!claim.ok) {
  const code = claim.resp?.json.code ?? "?";
  const msg = claim.resp?.json.message ?? "重试全部失败";
  console.error("❌ 领取失败，业务码 " + code + " " + msg);
  console.error("   9074 是全网高峰限流，隔几分钟重试即可，不是账号问题。");
  Deno.exit(1);
}

console.log("\n[3] 补查 status 取真实积分数…");
const after = await post(STATUS_PATH, "{}");
console.log("   status ->", after.text.slice(0, 220));
const credits = Number(after.json.credits ?? after.json.extra_credits ?? 0);
console.log("\n✅ 今日签到完成，本次获得 " + credits + " 积分");
console.log("   累计余额: " + (after.json.credits ?? after.json.extra_credits));
