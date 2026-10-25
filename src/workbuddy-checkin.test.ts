/**
 * WorkBuddy 签到纯函数层单测：状态解析、领取解析、`runDailyCheckin` 的编排。
 *
 * 全部用假 fetch，不碰网络（`deno task test` 只开 `--allow-env`）。
 *
 * 判据：每条断言对应一处**真实会读错的地方**，且能被变异推翻 —— 改坏被测那行
 * 必须变红。改错不断红的断言等于装饰。
 */

import {
  CHECKIN_CLAIM_PATH,
  CHECKIN_STATUS_PATH,
  claimCheckin,
  fetchCheckinState,
  parseCheckinState,
  parseClaimResult,
  runDailyCheckin,
} from "./workbuddy-checkin.ts";
import type { WorkBuddyCredential } from "./workbuddy.ts";

function assert(condition: unknown, message = "assertion failed"): void {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(
      (message ?? "not equal") + ": expected " + e + ", got " + a,
    );
  }
}

/** 造一份最小凭据。 */
function credential(): WorkBuddyCredential {
  return {
    access_token: "at",
    refresh_token: "rt",
    expires_at: String(Date.now() + 3600_000),
    refresh_expires_at: String(Date.now() + 7200_000),
    token_type: "Bearer",
    scope: "",
    domain: "www.workbuddy.cn",
    user_id: "u1",
    nickname: "tester",
    enterprise_id: "",
    account_type: "personal",
  };
}

/** 真实响应形状（2026-10-25 实测抓下来的字段名与取值）。 */
const STATUS_JSON = {
  code: 0,
  msg: "OK",
  data: {
    active: true,
    today_checked_in: false,
    streak_days: 10,
    daily_credit: 100,
    today_credit: 100,
    is_streak_day: false,
    next_streak_day: 0,
    streak_bonus_days: 0,
    streak_bonus_credit: 0,
    checkin_dates: ["2026-10-24", "2026-10-21"],
    week_checkin_days: 4,
    week_progress: [true, true, true, false, false, false, true],
    total_credits: 1000,
    start_time: "2026-09-30 00:00:00",
    end_time: "2026-12-31 23:59:59",
    theme_name: "Buddy加油站",
    season: 10,
    activity_name: "Buddy应用",
    claim_button_text: "立即领取",
    action_button: { show: true, text: "体验Buddy应用", action: "x" },
  },
};

/**
 * 按 **URL** 路由的假 fetch（不是按调用顺序）。
 *
 * 为什么必须按 URL：`runDailyCheckin` 会查**两次**状态（before / after），
 * 顺序式假件会让「第二次状态」拿到 claim 的响应，于是三条编排断言全部误判 ——
 * 我第一版就是这么写的，三个测试因此假红。假件的路由方式必须与被测代码的
 * 调用语义对齐，而不是对齐我脑子里的调用次数。
 *
 * `statusQueue` 让每次 status 调用依次取一个响应（before / after 可以不同）。
 */
function fakeFetcher(routes: {
  status: { status: number; body: unknown }[];
  claim: { status: number; body: unknown }[];
}) {
  const calls: { url: string; method: string; body?: string }[] = [];
  let statusIndex = 0;
  let claimIndex = 0;
  const json = (r: { status: number; body: unknown }) =>
    Promise.resolve(
      new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  const fetcher = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: String(init?.method ?? "GET"),
      body: init?.body === undefined ? undefined : String(init.body),
    });
    if (url.endsWith(CHECKIN_CLAIM_PATH)) {
      const r = routes.claim[Math.min(claimIndex, routes.claim.length - 1)];
      claimIndex++;
      return json(r);
    }
    const r = routes.status[Math.min(statusIndex, routes.status.length - 1)];
    statusIndex++;
    return json(r);
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

// ---------- 状态解析 ----------

Deno.test("签到状态：active 与 today_checked_in 必须分开读", () => {
  // 混成一个 canClaim 布尔会让面板把「活动结束」显示成「今天签过了」。
  const state = parseCheckinState(STATUS_JSON);
  equal(state.enabled, true, "active=true must map to enabled");
  equal(state.checkedIn, false, "today_checked_in=false must map to checkedIn");

  // 活动结束但今天签过 —— 两个字段各自独立
  const ended = parseCheckinState({
    code: 0,
    data: { ...STATUS_JSON.data, active: false, today_checked_in: true },
  });
  equal(ended.enabled, false);
  equal(ended.checkedIn, true);
});

Deno.test("签到状态：缺字段时给中性值，不抛也不伪造", () => {
  const state = parseCheckinState({ code: 0, data: {} });
  equal(state.enabled, false);
  equal(state.checkedIn, false);
  equal(state.credits, 0);
  equal(state.checkinDates, []);
  // 空响应体也不能炸
  const empty = parseCheckinState(null);
  equal(empty.enabled, false);
});

Deno.test("签到状态：积分优先取 today_credit，回落 daily_credit", () => {
  // 两者语义不同（今日实得 vs 每日额度），但都缺席时才该是 0。
  const a = parseCheckinState({
    code: 0,
    data: { today_credit: 50, daily_credit: 100 },
  });
  equal(a.credits, 50, "today_credit wins when present");
  const b = parseCheckinState({ code: 0, data: { daily_credit: 100 } });
  equal(b.credits, 100, "falls back to daily_credit");
});

Deno.test("签到状态：checkin_dates 只保留字符串项", () => {
  const state = parseCheckinState({
    code: 0,
    data: { checkin_dates: ["2026-10-24", 123, null, "2026-10-21"] },
  });
  equal(state.checkinDates, ["2026-10-24", "2026-10-21"]);
});

// ---------- 领取解析 ----------

Deno.test("领取结果：code 缺失按失败算，不乐观默认成功", () => {
  // 「没拿到 code」和「code=0」是两件事。默认成功的代价是面板显示
  // 「签到成功」而实际什么都没发生。
  const r = parseClaimResult({ msg: "weird" });
  equal(r.ok, false, "missing code must not be treated as success");
  equal(r.code, -1);
});

Deno.test("领取结果：真实响应形状被正确解析", () => {
  const r = parseClaimResult({
    code: 0,
    msg: "OK",
    data: { credit: 100, streak_days: 11, is_streak_day: false },
  });
  equal(r.ok, true);
  equal(r.credits, 100);
  equal(r.streakDays, 11);
});

// ---------- 编排 ----------

Deno.test("签到编排：今天已领时**不发 claim**，直接返回 alreadyClaimed", async () => {
  // 关键行为：每轮面板轮询都不该多打一次上游，也不该让服务端去拒。
  const { fetcher, calls } = fakeFetcher({
    status: [{
      status: 200,
      body: { code: 0, data: { ...STATUS_JSON.data, today_checked_in: true } },
    }],
    claim: [{ status: 200, body: { code: 0, data: { credit: 100 } } }],
  });
  const outcome = await runDailyCheckin(credential(), fetcher);
  equal(outcome.claim, null, "no claim may be sent when already checked in");
  equal(outcome.confirmed, true);
  // 只查了两次状态（before + after），一次 claim 都没发
  const claimCalls = calls.filter((c) => c.url.endsWith(CHECKIN_CLAIM_PATH));
  equal(claimCalls.length, 0, "the claim endpoint must not be called");
  equal(calls.length, 2);
});

Deno.test("claimCheckin 自身：已签到时**必须**拒绝发 claim（不能只靠调用方拦）", async () => {
  // 为什么这条必须直测 claimCheckin：上面那条走 runDailyCheckin，而它**自己**
  // 就跳过了 claim —— 于是 claimCheckin 内部的那个判断从未被执行到，把它改成
  // `if (false)` 测试依然全绿（我第一版就是这样漏的，变异测试当场抓到）。
  // 判据：**防护要在它真正生效的那一层被验证**，不能靠上游调用方遮住。
  const { fetcher, calls } = fakeFetcher({
    status: [{
      status: 200,
      body: { code: 0, data: { ...STATUS_JSON.data, today_checked_in: true } },
    }],
    claim: [{ status: 200, body: { code: 0, data: { credit: 100 } } }],
  });
  const result = await claimCheckin(credential(), fetcher);
  equal(result.alreadyClaimed, true);
  equal(result.credits, 0, "nothing was claimed, so nothing was credited");
  equal(
    calls.filter((c) => c.url.endsWith(CHECKIN_CLAIM_PATH)).length,
    0,
    "claimCheckin must not call the claim endpoint when already checked in",
  );
});

Deno.test("claimCheckin 自身：活动未开放时**必须**拒绝发 claim", async () => {
  // 同一条判据的第二半：另一个提前返回分支也要被真正覆盖。
  const { fetcher, calls } = fakeFetcher({
    status: [{
      status: 200,
      body: { code: 0, data: { ...STATUS_JSON.data, active: false } },
    }],
    claim: [{ status: 200, body: { code: 0, data: {} } }],
  });
  const result = await claimCheckin(credential(), fetcher);
  equal(result.ok, false);
  equal(
    result.alreadyClaimed,
    false,
    "a closed activity is not 'already claimed'",
  );
  equal(
    calls.filter((c) => c.url.endsWith(CHECKIN_CLAIM_PATH)).length,
    0,
    "claimCheckin must not call the claim endpoint for a closed activity",
  );
});

Deno.test("签到编排：未签到时先查后领，并**再查一次**确认", async () => {
  const { fetcher, calls } = fakeFetcher({
    status: [
      { status: 200, body: STATUS_JSON },
      {
        status: 200,
        body: {
          code: 0,
          data: {
            ...STATUS_JSON.data,
            today_checked_in: true,
            streak_days: 11,
          },
        },
      },
    ],
    claim: [{
      status: 200,
      body: { code: 0, data: { credit: 100, streak_days: 11 } },
    }],
  });
  const outcome = await runDailyCheckin(credential(), fetcher);
  equal(outcome.before.checkedIn, false);
  equal(outcome.claim?.ok, true);
  equal(outcome.claim?.credits, 100);
  equal(outcome.after.checkedIn, true, "the after-state is what we trust");
  equal(outcome.confirmed, true);
  // 顺序必须是 status → claim → status，且**状态只查两次**：claimCheckin 必须
  // 复用 runDailyCheckin 刚查到的那份 before，不能自己再查一遍（那是同一次运行
  // 里的重复请求，我第一版就是这样，测试当场抓到了）。
  equal(calls.length, 3, "two status calls plus one claim");
  assert(calls[0].url.endsWith(CHECKIN_STATUS_PATH), "first call is status");
  assert(calls[1].url.endsWith(CHECKIN_CLAIM_PATH), "second call is claim");
  assert(calls[2].url.endsWith(CHECKIN_STATUS_PATH), "third call is status");
  equal(
    calls.filter((c) => c.url.endsWith(CHECKIN_STATUS_PATH)).length,
    2,
    "status must be fetched exactly twice (before and after), never three times",
  );
});

Deno.test("签到编排：claim 回 ok 但状态没变时 confirmed 必须为 false", async () => {
  // claim 的返回值只说明「这次调用成功了」，不说明服务端已把今天记进
  // checkin_dates。本项目在「claim 成功但状态没变」上踩过，只信状态查询。
  const { fetcher } = fakeFetcher({
    status: [STATUS_JSON, STATUS_JSON].map((body) => ({
      status: 200,
      body: body as unknown,
    })),
    claim: [{
      status: 200,
      body: { code: 0, data: { credit: 100, streak_days: 11 } },
    }],
  });
  const outcome = await runDailyCheckin(credential(), fetcher);
  equal(outcome.claim?.ok, true, "the claim call itself succeeded");
  equal(outcome.after.checkedIn, false);
  equal(
    outcome.confirmed,
    false,
    "ok on the claim response must not be reported as confirmed",
  );
});

Deno.test("签到编排：活动未开放时不去领，也不谎报成功", async () => {
  const { fetcher, calls } = fakeFetcher({
    status: [{
      status: 200,
      body: { code: 0, data: { ...STATUS_JSON.data, active: false } },
    }],
    claim: [{ status: 200, body: { code: 0, data: {} } }],
  });
  const outcome = await runDailyCheckin(credential(), fetcher);
  equal(outcome.claim?.ok, false);
  equal(outcome.claim?.message, "checkin activity is not active");
  equal(
    calls.filter((c) => c.url.endsWith(CHECKIN_CLAIM_PATH)).length,
    0,
    "a closed activity must not be claimed",
  );
});

Deno.test("签到：claim 返回非 JSON 时给出可读错误，不抛", () => {
  // 上游的 5xx 常是 HTML/空体（本项目在其它渠道见过 openresty 的 HTML）。
  const fetcher = ((input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith(CHECKIN_STATUS_PATH)) {
      return Promise.resolve(
        new Response(JSON.stringify(STATUS_JSON), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.resolve(
      new Response("<html>bad gateway</html>", { status: 502 }),
    );
  }) as unknown as typeof fetch;

  return claimCheckin(credential(), fetcher).then((r) => {
    equal(r.ok, false);
    assert(
      r.message.includes("502"),
      "the HTTP status must appear in the message",
    );
  });
});

Deno.test("签到的请求形状：POST + 空 JSON 对象（上游不接受其它 body）", async () => {
  const { fetcher, calls } = fakeFetcher({
    status: [{ status: 200, body: STATUS_JSON }],
    claim: [],
  });
  await fetchCheckinState(credential(), fetcher);
  equal(calls.length, 1);
  equal(calls[0].method, "POST");
  equal(calls[0].body, "{}", "the upstream expects an empty JSON object");
  assert(
    calls[0].url.startsWith("https://www.workbuddy.cn/"),
    "must hit the CN site, not the international one",
  );
});
