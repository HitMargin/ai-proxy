#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read --allow-write
/**
 * 一键签到：TRAE + WorkBuddy（中国版）。
 *
 * ## 两种运行模式
 *
 * **默认直连上游**（需要代理没在跑，或不想依赖它）：
 *
 *     deno task checkin
 *
 * 直接读两份凭据文件、自己续期、直接打上游。凭据路径与代理一致（工作目录下），
 * 所以和代理共用同一份登录态，谁先续期都行。
 *
 * **经本地代理**（代理在跑时更省事，且复用代理的续期与错误分类）：
 *
 *     deno run --allow-env --allow-net --allow-read --allow-write \
 *       scripts/checkin.ts --via-proxy
 *
 * ## 安全性
 *
 * - **不打印任何 token / cookie 值**，只打印昵称、天数、积分。
 * - **幂等**：已签过的平台不会重复发 claim（底层 `claimCheckin` /
 *   `claimTraeDailyCheckin` 先查状态再决定）。
 * - 一个平台失败**不影响**另一个：两个都跑完再汇总，退出码反映整体。
 *
 * ## 为什么默认直连而不是经代理
 *
 * 签到是**账号动作**，与代理是否在跑无关。把脚本绑在代理上会变成「代理没开就签
 * 不了」，而代理本来就是按需启动的。`--via-proxy` 留作便利选项。
 */

import {
  claimTraeDailyCheckin,
  fetchTraeCheckinStatus,
  isTraeExpired,
  readTraeCredential,
  refreshTraeIfNeeded,
} from "../src/trae-account.ts";
import { claimCheckin, fetchCheckinState } from "../src/workbuddy-checkin.ts";
import {
  readWorkBuddyCredential,
  refreshWorkBuddyIfNeeded,
} from "../src/workbuddy-account.ts";

interface Options {
  viaProxy: boolean;
  baseUrl: string;
  /** 只跑某一个平台，便于排查。 */
  only: "trae" | "workbuddy" | null;
  /** 只看状态，不发 claim。 */
  dryRun: boolean;
  json: boolean;
}

function usage(): string {
  return [
    "用法:",
    "  deno task checkin                      # 直连上游（推荐）",
    "  deno task checkin -- --dry-run         # 只看状态，不领取",
    "  deno task checkin -- --only=trae       # 只签 TRAE",
    "  deno task checkin -- --via-proxy       # 经本地代理（需要代理在跑）",
    "  deno task checkin -- --json            # 机器可读输出",
    "",
    "凭据文件（与代理共用，工作目录下）:",
    "  trae-auth.json       TRAE 登录态",
    "  workbuddy-auth.json  WorkBuddy 登录态",
    "",
    "缺失时先跑各自的登录脚本:",
    "  deno run -A .tmp-trae-login.ts",
    "  deno run -A .tmp-workbuddy-login.ts",
  ].join("\n");
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    viaProxy: false,
    baseUrl: "http://127.0.0.1:8000",
    only: null,
    dryRun: false,
    json: false,
  };
  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      Deno.exit(0);
    } else if (arg === "--via-proxy") options.viaProxy = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--json") options.json = true;
    else if (arg.startsWith("--only=")) {
      const v = arg.slice("--only=".length);
      if (v !== "trae" && v !== "workbuddy") {
        console.error(`--only 只接受 trae / workbuddy，收到: ${v}`);
        Deno.exit(2);
      }
      options.only = v;
    } else if (arg.startsWith("--base-url=")) {
      options.baseUrl = arg.slice("--base-url=".length).replace(/\/+$/, "");
    } else {
      console.error(`未知参数: ${arg}\n`);
      console.error(usage());
      Deno.exit(2);
    }
  }
  return options;
}

/** 一个平台的签到结果（打印与 JSON 共用同一份数据）。 */
interface PlatformResult {
  platform: "trae" | "workbuddy";
  configured: boolean;
  /** 动作是否成功（已签过也算成功）。 */
  ok: boolean;
  /** 这次是真领了，还是本来就签过。 */
  alreadyClaimed: boolean;
  /** 本次实得积分。 */
  credits: number;
  /** 连续天数（WorkBuddy 有，TRAE 无）。 */
  streakDays?: number;
  /** 余额 / 累计积分。 */
  balance?: number;
  message: string;
  /** 失败时的原因（不抛，让另一个平台继续）。 */
  error?: string;
}

// ---------- 直连模式 ----------

async function checkinTraeDirect(dryRun: boolean): Promise<PlatformResult> {
  const base: PlatformResult = {
    platform: "trae",
    configured: false,
    ok: false,
    alreadyClaimed: false,
    credits: 0,
    message: "",
  };
  const credential = await readTraeCredential(".").catch(() => undefined);
  if (credential === undefined) {
    return {
      ...base,
      message: "没有凭据，先跑 deno run -A .tmp-trae-login.ts",
    };
  }
  // 续期：401 时 claim 会自己重试一次，但过期很久的 token 直接续更省事。
  const fresh =
    (await refreshTraeIfNeeded(".", credential).catch(() => undefined)) ??
      credential;
  if (isTraeExpired(fresh)) {
    return {
      ...base,
      configured: true,
      message: "登录态已过期且续期失败，需要重新登录",
    };
  }
  const state = await fetchTraeCheckinStatus(fresh);
  if (dryRun) {
    return {
      ...base,
      configured: true,
      ok: true,
      alreadyClaimed: state.checkedIn,
      credits: state.credits,
      message: state.checkedIn
        ? `今天已签（可领 ${state.credits} 积分）`
        : `今天未签（可领 ${state.credits} 积分）`,
    };
  }
  const result = await claimTraeDailyCheckin(fresh);
  return {
    ...base,
    configured: true,
    ok: result.ok,
    alreadyClaimed: result.alreadyClaimed,
    credits: result.credits ?? 0,
    message: result.alreadyClaimed
      ? "今天已经签过"
      : result.ok
      ? `签到成功，本次 +${result.credits ?? 0} 积分`
      : `签到失败 code=${result.code} ${result.message}`,
  };
}

async function checkinWorkbuddyDirect(
  dryRun: boolean,
): Promise<PlatformResult> {
  const base: PlatformResult = {
    platform: "workbuddy",
    configured: false,
    ok: false,
    alreadyClaimed: false,
    credits: 0,
    message: "",
  };
  const credential = await readWorkBuddyCredential(".", Deno.readTextFile)
    .catch(() => undefined);
  if (credential === undefined) {
    return {
      ...base,
      message: "没有凭据，先跑 deno run -A .tmp-workbuddy-login.ts",
    };
  }
  const fresh =
    (await refreshWorkBuddyIfNeeded(".", credential).catch(() => undefined)) ??
      credential;
  const state = await fetchCheckinState(fresh);
  if (dryRun) {
    return {
      ...base,
      configured: true,
      ok: true,
      alreadyClaimed: state.checkedIn,
      credits: state.credits,
      streakDays: state.streakDays,
      balance: state.totalCredits,
      message: state.checkedIn
        ? `今天已签，连续 ${state.streakDays} 天`
        : `今天未签（可领 ${state.credits} 积分，连续 ${state.streakDays} 天）`,
    };
  }
  const result = await claimCheckin(fresh, fetch, undefined, state);
  // claim 之后**必须再查一次**：claim 回 ok 只说明那次调用成功。
  // 与 runDailyCheckin 同一条判据，但这里要多拿 streakDays / totalCredits。
  const after = await fetchCheckinState(fresh).catch(() => state);
  return {
    ...base,
    configured: true,
    ok: result.ok && after.checkedIn,
    alreadyClaimed: result.alreadyClaimed,
    credits: result.credits ?? 0,
    streakDays: after.streakDays,
    balance: after.totalCredits,
    message: result.alreadyClaimed
      ? `今天已经签过，连续 ${after.streakDays} 天`
      : result.ok
      ? `签到成功，本次 +${
        result.credits ?? 0
      } 积分，连续 ${after.streakDays} 天`
      : `签到失败 code=${result.code} ${result.message}`,
  };
}

// ---------- 经代理模式 ----------

async function post(
  url: string,
  timeoutMs = 30_000,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const r = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
  });
  let body: unknown = null;
  try {
    body = await r.json();
  } catch {
    body = null;
  }
  return { ok: r.ok, status: r.status, body };
}

/**
 * 代理 /account 与 /checkin 的响应形状。
 *
 * 用**可选字段的显式类型**而不是 `any`/`unknown`：这两条是我们自己代理的
 * 输出（形状由 main.ts 决定），不需要防御未知输入；而 `unknown` 会让下面每个
 * 字段访问都要收窄一次，读起来全是类型体操。字段全部可选，因为 TRAE 与
 * WorkBuddy 各自只填一部分（TRAE 有 balance、WorkBuddy 有 streakDays）。
 */
interface ProxyAccountInfo {
  configured?: boolean;
  error?: string;
  balance?: { total?: number };
  checkin?: {
    checkedIn?: boolean;
    credits?: number;
    streakDays?: number;
    totalCredits?: number;
  } | null;
}

interface ProxyCheckinInfo {
  ok?: boolean;
  alreadyClaimed?: boolean;
  credits?: number;
  streakDays?: number;
  totalCredits?: number;
  balance?: { total?: number };
  message?: string;
  error?: string;
}

async function checkinViaProxy(
  options: Options,
  platform: "trae" | "workbuddy",
  dryRun: boolean,
): Promise<PlatformResult> {
  const base: PlatformResult = {
    platform,
    configured: false,
    ok: false,
    alreadyClaimed: false,
    credits: 0,
    message: "",
  };
  const account = await fetch(`${options.baseUrl}/${platform}/v1/account`, {
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (account === null || !account.ok) {
    return {
      ...base,
      message:
        `代理不可达（${options.baseUrl}）——先跑 restart.ps1 -Local，或改用直连模式`,
    };
  }
  const info = (await account.json().catch(() => null)) as
    | ProxyAccountInfo
    | null;
  if (info?.configured !== true) {
    return {
      ...base,
      message: String(
        info?.error ?? "代理里这个渠道没有配置凭据",
      ),
    };
  }
  if (dryRun) {
    return {
      ...base,
      configured: true,
      ok: true,
      alreadyClaimed: info.checkin?.checkedIn === true,
      credits: info.checkin?.credits ?? 0,
      streakDays: info.checkin?.streakDays,
      balance: platform === "trae"
        ? info.balance?.total
        : info.checkin?.totalCredits,
      message: info.checkin?.checkedIn
        ? "今天已签（--dry-run 不领取）"
        : "今天未签（--dry-run 不领取）",
    };
  }
  const r = await post(`${options.baseUrl}/${platform}/v1/checkin`);
  const payload = (r.body ?? {}) as ProxyCheckinInfo;
  if (!r.ok || r.body === null) {
    return {
      ...base,
      configured: true,
      message: `代理返回 HTTP ${r.status}`,
    };
  }
  return {
    ...base,
    configured: true,
    ok: payload.ok === true || payload.alreadyClaimed === true,
    alreadyClaimed: payload.alreadyClaimed === true,
    credits: payload.credits ?? 0,
    streakDays: payload.streakDays,
    balance: platform === "trae"
      ? payload.balance?.total
      : payload.totalCredits,
    message: payload.alreadyClaimed
      ? "今天已经签过"
      : payload.ok
      ? `签到成功，本次 +${payload.credits ?? 0} 积分`
      : String(payload.message ?? payload.error ?? "未知失败"),
  };
}

// ---------- 主流程 ----------

const options = parseArgs(Deno.args);
const platforms: ("trae" | "workbuddy")[] = options.only
  ? [options.only]
  : ["trae", "workbuddy"];

const results: PlatformResult[] = [];
for (const platform of platforms) {
  let result: PlatformResult;
  try {
    if (options.viaProxy) {
      result = await checkinViaProxy(options, platform, options.dryRun);
    } else {
      result = platform === "trae"
        ? await checkinTraeDirect(options.dryRun)
        : await checkinWorkbuddyDirect(options.dryRun);
    }
  } catch (error) {
    result = {
      platform,
      configured: true,
      ok: false,
      alreadyClaimed: false,
      credits: 0,
      message: "异常",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  results.push(result);
}

if (options.json) {
  console.log(
    JSON.stringify(
      {
        mode: options.viaProxy ? "proxy" : "direct",
        dryRun: options.dryRun,
        results,
      },
      null,
      2,
    ),
  );
} else {
  console.log(
    `签到${options.dryRun ? "状态（dry-run，不领取）" : ""}` +
      `  模式=${options.viaProxy ? "经代理" : "直连上游"}`,
  );
  console.log("─".repeat(64));
  for (const r of results) {
    const tag = !r.configured ? " ⚠ 未配置" : r.ok ? "✓" : "✗";
    // 只补 message 里没提到的数字：message 已经写了「连续 N 天」时不再重复。
    const extra: string[] = [];
    if (r.streakDays !== undefined && !r.message.includes("连续")) {
      extra.push(`连续 ${r.streakDays} 天`);
    }
    if (r.balance !== undefined && !r.message.includes("余额")) {
      extra.push(`余额 ${r.balance}`);
    }
    console.log(
      `${tag} ${r.platform.padEnd(10)} ${r.message}` +
        `${extra.length ? `（${extra.join("，")}）` : ""}`,
    );
    if (r.error) console.log(`    └ ${r.error}`);
  }
}

// 退出码：全部成功才 0。未配置也按失败算 —— 一个「什么都没签」的运行不该
// 被计划任务当成成功（那会静默一个月不签到）。
const failed = results.filter((r) => !r.ok || !r.configured);
Deno.exit(failed.length === 0 ? 0 : 1);
