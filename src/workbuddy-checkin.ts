/**
 * WorkBuddy 每日签到：查状态 + 领取。
 *
 * ## 接口（2026-10-25 实测确认，两条都真实存在）
 *
 *   POST https://www.workbuddy.cn/v2/billing/meter/checkin-activity-status
 *     body {}  → {"code":0,"data":{active,today_checked_in,streak_days,
 *                  daily_credit,today_credit,is_streak_day,next_streak_day,
 *                  streak_bonus_days,streak_bonus_credit,checkin_dates[],
 *                  week_checkin_days,week_progress[],total_credits,
 *                  start_time,end_time,theme_name,season,activity_name,
 *                  claim_button_text,action_button}}
 *
 *   POST https://www.workbuddy.cn/v2/billing/meter/daily-checkin
 *     body {}  → {"code":0,"data":{credit,streak_days,is_streak_day}}
 *
 * **claim 不需要任何参数**（日期由服务端决定），这一点很关键 —— 见下面那条警告。
 *
 * ## ⚠️ 判据纪律：探测 claim 端点时不要发空 body
 *
 * 找 claim 路径时我按习惯用「空 body 诱发参数校验错误」来判存在性（参数错 ≠
 * 路由不存在）。但 `daily-checkin` **没有参数**，空 body 就是一次**真实领取**：
 * 实测 `{}` 一发出，100 积分当场到账、`streak_days` 10→11、
 * `checkin_dates` 多出当天日期。
 *
 * **副作用接口不能靠「轻量探测」确认存在性**。要么先读文档/前端源码，要么
 * 就承认「探测即执行」，在用户明确同意后再发。这条写在这里，因为下一个来
 * 加签到接口的人会踩同一个坑。
 *
 * ## 为什么单独一个模块而不是塞进 workbuddy-account.ts
 *
 * 与 trae 同一条理由：签到链路的**主机相同但语义不同**——它会计积分、有连续
 * 天数、有活动窗口（start_time/end_time）。把它和「凭据续期 + 模型目录」混在
 * 一起，会让读取凭据的纯函数层无谓地拖上一个有副作用的调用。
 * 但**凭据读取与刷新复用** workbuddy-account.ts，不重写。
 */

import type { WorkBuddyCredential } from "./workbuddy.ts";
import { WORKBUDDY_ENDPOINT, workBuddyCatalogHeaders } from "./workbuddy.ts";

export const CHECKIN_STATUS_PATH = "/v2/billing/meter/checkin-activity-status";
export const CHECKIN_CLAIM_PATH = "/v2/billing/meter/daily-checkin";

export type WorkBuddyFetcher = typeof fetch;

/** 签到状态（一次查询的结果）。 */
export interface WorkBuddyCheckinState {
  /** 活动本身是否在开放期（服务端的 `active`）。 */
  enabled: boolean;
  /** **今天已经领过了**。这是唯一该用来决定「要不要调 claim」的字段。 */
  checkedIn: boolean;
  /** 今日可领积分（服务端下发，本机实测 100）。 */
  credits: number;
  /** 连续签到天数。 */
  streakDays: number;
  /** 累计积分。 */
  totalCredits: number;
  /** 已签到的日期（`YYYY-MM-DD`，倒序）。claim 后必须能在这里看到今天。 */
  checkinDates: string[];
  /** 今天是不是连续奖励日。 */
  isStreakDay: boolean;
  /** 活动窗口，原样透传（面板要显示「还剩几天」）。 */
  startTime: string;
  endTime: string;
  /** 活动名与主题，用于面板展示。 */
  activityName: string;
  themeName: string;
}

/** 领取结果。 */
export interface WorkBuddyClaimResult {
  ok: boolean;
  /** 业务码；0 为成功。 */
  code: number;
  message: string;
  /** 本次实际获得的积分（**claim 响应里有**，不用补查）。 */
  credits?: number;
  /** 领取后的连续天数。 */
  streakDays?: number;
  /**
   * 本来就已经领过、这次什么都没发生。
   *
   * 单独的字段而不是靠 `ok:false` 推断：服务端对「重复领取」通常回业务码 ≠ 0，
   * 那和「网络坏了」在同一个 `ok:false` 上无法区分，而调用方需要分得开
   * （前者是正常状态，后者要报警）。
   */
  alreadyClaimed: boolean;
}

/** 上游返回的统一信封。 */
interface Envelope<T> {
  code?: number;
  msg?: string;
  data?: T;
}

function headersFor(credential: WorkBuddyCredential): Record<string, string> {
  return {
    ...workBuddyCatalogHeaders(credential),
    "Content-Type": "application/json",
  };
}

/**
 * 把上游信封解析成状态。
 *
 * 判据：**`active` 与 `today_checked_in` 必须分开读**。实测这两个字段在
 * 「活动已结束」和「今天已签」两种情况下取值不同，混成一个 `canClaim` 布尔
 * 会让面板把「活动结束」显示成「今天签过了」。
 */
export function parseCheckinState(payload: unknown): WorkBuddyCheckinState {
  const env = (payload ?? {}) as Envelope<Record<string, unknown>>;
  const d = (env.data ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const dates = Array.isArray(d.checkin_dates)
    ? d.checkin_dates.filter((x): x is string => typeof x === "string")
    : [];
  return {
    enabled: d.active === true,
    checkedIn: d.today_checked_in === true,
    credits: num(d.today_credit) || num(d.daily_credit),
    streakDays: num(d.streak_days),
    totalCredits: num(d.total_credits),
    checkinDates: dates,
    isStreakDay: d.is_streak_day === true,
    startTime: str(d.start_time),
    endTime: str(d.end_time),
    activityName: str(d.activity_name),
    themeName: str(d.theme_name),
  };
}

/** 把 claim 的响应解析成结果。`code` 缺失按失败算，不要乐观默认成功。 */
export function parseClaimResult(payload: unknown): WorkBuddyClaimResult {
  const env = (payload ?? {}) as Envelope<Record<string, unknown>>;
  const code = typeof env.code === "number" ? env.code : -1;
  const d = (env.data ?? {}) as Record<string, unknown>;
  const credit = typeof d.credit === "number" ? d.credit : undefined;
  const streak = typeof d.streak_days === "number" ? d.streak_days : undefined;
  return {
    ok: code === 0,
    code,
    message: typeof env.msg === "string" ? env.msg : "",
    credits: credit,
    streakDays: streak,
    // code 0 却有 credit 字段为 0/缺失 —— 那不是「已经领过」，是真的领到了 0，
    // 两种都要如实分开：这里的 alreadyClaimed 只在**业务码明确表示重复**时才置位，
    // 具体判定留给调用方（见 claimCheckin）。
    alreadyClaimed: false,
  };
}

/** 查今日签到状态。**只读，无副作用。** */
export async function fetchCheckinState(
  credential: WorkBuddyCredential,
  fetcher: WorkBuddyFetcher = fetch,
  signal?: AbortSignal,
): Promise<WorkBuddyCheckinState> {
  const r = await fetcher(WORKBUDDY_ENDPOINT + CHECKIN_STATUS_PATH, {
    method: "POST",
    headers: headersFor(credential),
    body: "{}",
    signal,
  });
  if (!r.ok) {
    throw new Error(`workbuddy checkin status HTTP ${r.status}`);
  }
  return parseCheckinState(await r.json());
}

/**
 * 领取今日签到。
 *
 * `alreadyClaimed` 的判定：调用前先查一次状态（`state.checkedIn === true` 则
 * 直接返回，**不发 claim**）。这比「发出去让它回业务错」好 —— 后者每天多一次
 * 无意义请求，且不同账号的重复领取错误码不一定一致（实测样本只有一个账号，
 * 没有第二个账号来验证「重复领取回什么码」，所以不假装知道）。
 *
 * `knownState` 是给 `runDailyCheckin` 的优化：它刚查过状态，再让这里查一遍
 * 就是同一次运行里连查两次。不传则自己查（单独调用的场景）。
 */
export async function claimCheckin(
  credential: WorkBuddyCredential,
  fetcher: WorkBuddyFetcher = fetch,
  signal?: AbortSignal,
  knownState?: WorkBuddyCheckinState,
): Promise<WorkBuddyClaimResult> {
  const state = knownState ??
    await fetchCheckinState(credential, fetcher, signal);
  if (state.checkedIn) {
    return {
      ok: true,
      code: 0,
      message: "already checked in today",
      credits: 0,
      streakDays: state.streakDays,
      alreadyClaimed: true,
    };
  }
  if (!state.enabled) {
    return {
      ok: false,
      code: -1,
      message: "checkin activity is not active",
      streakDays: state.streakDays,
      alreadyClaimed: false,
    };
  }

  const r = await fetcher(WORKBUDDY_ENDPOINT + CHECKIN_CLAIM_PATH, {
    method: "POST",
    headers: headersFor(credential),
    body: "{}",
    signal,
  });
  // 非 2xx 也要尽力读 body：上游的业务错误常常是 HTTP 200 + code≠0，
  // 但网络层错误是 5xx，两种都要能把原因说清。
  let payload: unknown = null;
  try {
    payload = await r.json();
  } catch {
    payload = null;
  }
  if (payload === null) {
    return {
      ok: false,
      code: -1,
      message: `workbuddy checkin claim HTTP ${r.status} (non-JSON body)`,
      streakDays: state.streakDays,
      alreadyClaimed: false,
    };
  }
  return parseClaimResult(payload);
}

/**
 * 一次性「签完并报告」：查状态 → 按需领取 → 再查一次确认。
 *
 * 为什么最后要**再查一次**：claim 的响应只说明「这次调用成功了」，不说明
 * 「今天在服务端已经算签过」。而 `checkin_dates` 里出现今天的日期才是权威。
 * 本项目在「claim 成功了但状态没变」上踩过（trae 那条：claim 响应不含积分，
 * 必须补查 status 才拿得到）。这里同样只信状态查询的结果。
 */
export async function runDailyCheckin(
  credential: WorkBuddyCredential,
  fetcher: WorkBuddyFetcher = fetch,
  signal?: AbortSignal,
): Promise<{
  before: WorkBuddyCheckinState;
  claim: WorkBuddyClaimResult | null;
  after: WorkBuddyCheckinState;
  /** 服务端状态真的变了才算成功（不能只信 claim 的返回值）。 */
  confirmed: boolean;
}> {
  const before = await fetchCheckinState(credential, fetcher, signal);
  // 把刚查到的状态传进去，避免同一次运行里连查两次（claimCheckin 内部会
  // 自己查一次来做「已领就不发 claim」的判定）。
  const claim = before.checkedIn
    ? null
    : await claimCheckin(credential, fetcher, signal, before);
  const after = await fetchCheckinState(credential, fetcher, signal);
  return {
    before,
    claim,
    after,
    // 只信**状态查询**：claim 回 ok 只说明那次调用成功，不说明服务端已把今天
    // 记进 checkin_dates。所以判据是 after.checkedIn，而不是 claim.ok。
    confirmed: after.checkedIn === true,
  };
}
