import {
  claimTraeDailyCheckin,
  fetchTraeBalance,
  fetchTraeCheckinStatus,
  isTraeExpired,
  needsTraeRefresh,
  readTraeCredential,
  refreshTraeCredential,
  type TraeCredential,
  traeUgHeaders,
  writeTraeCredential,
} from "./trae-account.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal<T>(actual: T, expected: T, message?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      message ??
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

const NOW = Date.parse("2026-10-02T12:00:00Z");

function credential(overrides: Partial<TraeCredential> = {}): TraeCredential {
  return {
    access_token: "access-1",
    refresh_token: "refresh-1",
    expires_at: String(NOW + 14 * 24 * 3600 * 1000),
    uid: "2971347912497099",
    nickname: "（1761121491907",
    machine_id: "cb0f25b5d0883aebb7fc9069495bff2e",
    device_id: "5a7fe3b320092df39a52346115b405d0",
    ...overrides,
  };
}

/** 用假 fetch 按 URL 后缀分派，并记录每次请求的 body，供断言「请求体必须是什么」。 */
function fakeFetch(
  routes: Record<string, (body: string) => { status?: number; json: unknown }>,
  log?: { path: string; body: string }[],
): typeof fetch {
  return (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    const path = new URL(url).pathname;
    log?.push({ path, body: String(init?.body ?? "") });
    const route = routes[path];
    if (route === undefined) {
      return Promise.resolve(
        new Response(JSON.stringify({ code: 404 }), { status: 404 }),
      );
    }
    const out = route(String(init?.body ?? ""));
    return Promise.resolve(
      new Response(JSON.stringify(out.json), {
        status: out.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
}

const STATUS = "/trae/api/v2/ug/checkin_credits/status";
const CLAIM = "/trae/api/v2/ug/checkin_credits/claim";
const USAGE = "/trae/api/v2/pay/ide_user_ent_usage";

// ---------- 凭据 ----------

// 文件读写用内存假件，不碰磁盘。
// `deno task test` 只开 --allow-env；为了让这几个用例能跑而给 CI 加
// --allow-read/--allow-write 是错的取舍 —— 那会让整套测试都拿到文件系统权限。
const missing = (path: string) => {
  throw new Error(`ENOENT: ${path}`);
};
const holding = (content: string) => {
  const files = new Map<string, string>([[ROOT + "/trae-auth.json", content]]);
  const read = (path: string) => {
    const value = files.get(path);
    if (value === undefined) throw new Error(`ENOENT: ${path}`);
    return Promise.resolve(value);
  };
  const write = (path: string, data: string) => {
    files.set(path, data);
    return Promise.resolve();
  };
  return { read, write, files };
};
const ROOT = "/project";

Deno.test("a credential file that does not exist is reported as absent, not as an error", async () => {
  equal(await readTraeCredential(ROOT, missing), undefined);
});

Deno.test("a malformed credential file is also reported as absent (the same user-visible path)", async () => {
  const store = holding("{not json");
  equal(await readTraeCredential(ROOT, store.read), undefined);
});

Deno.test("a credential without access_token counts as absent", async () => {
  const store = holding('{"refresh_token":"r"}');
  equal(await readTraeCredential(ROOT, store.read), undefined);
});

Deno.test("a written credential round-trips, and the device ids survive", async () => {
  const store = holding("");
  const original = credential();
  await writeTraeCredential(ROOT, original, store.write);
  const read = await readTraeCredential(ROOT, store.read);
  assert(read !== undefined, "credential should round-trip");
  equal(read.machine_id, original.machine_id);
  equal(read.device_id, original.device_id);
  equal(read.access_token, original.access_token);
  equal(read.refresh_token, original.refresh_token);
  // 磁盘路径必须拼对：写和读要落在同一个文件上
  assert(
    store.files.has(ROOT + "/trae-auth.json"),
    "must write to <root>/trae-auth.json",
  );
});

Deno.test("a missing field falls back to an empty string rather than dropping the credential", async () => {
  // 只读 access_token 的文件仍应可用：续期要 refresh_token，
  // 没有它就明确报「请重新登录」，而不是整个账号读不出来。
  const store = holding('{"access_token":"only"}');
  const read = await readTraeCredential(ROOT, store.read);
  assert(read !== undefined, "should still parse");
  equal(read.refresh_token, "");
  equal(read.machine_id, "");
  equal(read.device_id, "");
  equal(needsTraeRefresh(read, NOW), false);
});

Deno.test("expiry is read from millisecond strings, second strings and ISO", () => {
  const ms = NOW + 1000;
  equal(isTraeExpired(credential({ expires_at: String(ms) }), NOW), false);
  equal(isTraeExpired(credential({ expires_at: String(ms) }), ms + 1), true);
  // 秒级时间戳（< 1e12）也必须被换算，否则永远判定为未过期
  equal(
    isTraeExpired(
      credential({ expires_at: String(Math.floor(ms / 1000)) }),
      ms + 1,
    ),
    true,
  );
  equal(
    isTraeExpired(
      credential({ expires_at: new Date(ms).toISOString() }),
      ms + 1,
    ),
    true,
  );
});

Deno.test("an unparseable expiry is never treated as expired", () => {
  equal(isTraeExpired(credential({ expires_at: "soon" }), NOW + 1e12), false);
  equal(needsTraeRefresh(credential({ expires_at: "soon" }), NOW), false);
});

Deno.test("refresh is wanted a day before expiry, never before that, and never without a refresh token", () => {
  const day = 24 * 3600 * 1000;
  const expires = NOW + 14 * day;
  equal(
    needsTraeRefresh(
      credential({ expires_at: String(expires) }),
      expires - 2 * day,
    ),
    false,
  );
  equal(
    needsTraeRefresh(
      credential({ expires_at: String(expires) }),
      expires - day,
    ),
    true,
  );
  equal(
    needsTraeRefresh(
      credential({ expires_at: String(expires), refresh_token: "" }),
      expires - day,
    ),
    false,
  );
});

// ---------- 请求头 ----------

Deno.test("the credit endpoints carry Cloud-IDE-JWT, never a bare Bearer", () => {
  const headers = traeUgHeaders(credential());
  equal(headers.authorization, "Cloud-IDE-JWT access-1");
  equal(headers["x-device-id"], "5a7fe3b320092df39a52346115b405d0");
  // SOLO 专属头混进 Ug 端点会被拒
  equal(headers["x-machine-id"], undefined);
  equal(headers["x-ide-version"], undefined);
});

// ---------- 签到状态 ----------

Deno.test("did_checked_in counts as checked in too (the live account only sends that field)", async () => {
  const cred = credential();
  const state = await fetchTraeCheckinStatus(
    cred,
    fakeFetch({
      [STATUS]: () => ({
        json: {
          checked_in: false,
          did_checked_in: true,
          credits: 100,
          enable: true,
        },
      }),
    }),
  );
  equal(state.checkedIn, true);
  equal(state.credits, 100);
  equal(state.enabled, true);
});

Deno.test("extra_credits stands in when credits is absent", async () => {
  const state = await fetchTraeCheckinStatus(
    credential(),
    fakeFetch({
      [STATUS]: () => ({ json: { did_checked_in: false, extra_credits: 250 } }),
    }),
  );
  equal(state.credits, 250);
  equal(state.checkedIn, false);
});

Deno.test("the status request body is the empty object", async () => {
  const log: { path: string; body: string }[] = [];
  await fetchTraeCheckinStatus(
    credential(),
    fakeFetch({
      [STATUS]: () => ({ json: {} }),
    }, log),
  );
  equal(log[0].body, "{}");
});

// ---------- 领取 ----------

Deno.test("an already-checked-in day never claims (claim is idempotent, so it cannot tell)", async () => {
  const log: { path: string; body: string }[] = [];
  const result = await claimTraeDailyCheckin(
    credential(),
    fakeFetch({
      [STATUS]: () => ({ json: { checked_in: true, credits: 100 } }),
      // 若被调用，这里会返回「成功」——所以断言必须落在「CLAIM 没被调用」
      [CLAIM]: () => ({ json: { code: 0, message: "success" } }),
    }, log),
  );
  equal(result.alreadyClaimed, true);
  equal(result.ok, true);
  equal(result.credits, 100);
  equal(log.filter((e) => e.path === CLAIM).length, 0);
});

Deno.test("a successful claim reports the credits from status, not from the claim response", async () => {
  // claim 响应**不含** credits（真实形状就是 code/message 两个字段），
  // 读它的 credits 恒为 0 —— 那正是「领取成功但加 0 积分」的成因。
  let statusCalls = 0;
  const result = await claimTraeDailyCheckin(
    credential(),
    fakeFetch({
      [STATUS]: () => {
        statusCalls++;
        return {
          json: {
            checked_in: statusCalls === 1 ? false : true,
            did_checked_in: statusCalls === 1 ? false : true,
            credits: 100,
          },
        };
      },
      [CLAIM]: () => ({ json: { code: 0, message: "success" } }),
    }),
    { sleepFn: () => Promise.resolve() },
  );
  equal(result.ok, true);
  equal(result.alreadyClaimed, false);
  equal(result.credits, 100);
  // 领取后必须补查一次 status 才拿得到真实数值
  assert(statusCalls >= 2, "status must be re-read after a successful claim");
});

Deno.test("a 9074 backs off and retries, and reports the throttles", async () => {
  const throttles: number[] = [];
  let claims = 0;
  const result = await claimTraeDailyCheckin(
    credential(),
    fakeFetch({
      [STATUS]: () => ({ json: { did_checked_in: false, credits: 100 } }),
      [CLAIM]: () => {
        claims++;
        return {
          json: { code: 9074, message: "当前参与用户太多，请稍后再试" },
        };
      },
    }),
    {
      attempts: 3,
      backoffMs: 1000,
      sleepFn: () => Promise.resolve(),
      onThrottle: (attempt, waitMs) => throttles.push(waitMs),
    },
  );
  equal(result.ok, false);
  equal(result.code, 9074);
  equal(claims, 3);
  equal(throttles, [1000, 2000]);
  equal(result.throttled, 3);
});

Deno.test("a 9074 that clears on retry still reports success", async () => {
  let claims = 0;
  const result = await claimTraeDailyCheckin(
    credential(),
    fakeFetch({
      [STATUS]: () => ({ json: { did_checked_in: claims > 0, credits: 100 } }),
      [CLAIM]: () => {
        claims++;
        return claims < 2
          ? { json: { code: 9074, message: "busy" } }
          : { json: { code: 0, message: "success" } };
      },
    }),
    { attempts: 4, sleepFn: () => Promise.resolve() },
  );
  equal(result.ok, true);
  equal(result.throttled, 1);
});

Deno.test("a non-9074 business code fails at once (retrying it would be pointless)", async () => {
  let claims = 0;
  const result = await claimTraeDailyCheckin(
    credential(),
    fakeFetch({
      [STATUS]: () => ({ json: { did_checked_in: false, credits: 100 } }),
      [CLAIM]: () => {
        claims++;
        return { json: { code: 9004, message: "device id required" } };
      },
    }),
    { sleepFn: () => Promise.resolve() },
  );
  equal(result.ok, false);
  equal(result.code, 9004);
  equal(claims, 1);
});

Deno.test("an HTTP 200 with a non-zero code is a failure, not a success", async () => {
  const result = await claimTraeDailyCheckin(
    credential(),
    fakeFetch({
      [STATUS]: () => ({ json: { did_checked_in: false, credits: 100 } }),
      [CLAIM]: () => ({ status: 200, json: { code: 9074, message: "busy" } }),
    }),
    { attempts: 1 },
  );
  equal(result.ok, false);
  equal(result.code, 9074);
});

Deno.test("a failed post-claim status read still counts as claimed (the claim itself landed)", async () => {
  let statusCalls = 0;
  const result = await claimTraeDailyCheckin(
    credential(),
    fakeFetch({
      [STATUS]: () => {
        statusCalls++;
        if (statusCalls === 1) return { json: { did_checked_in: false } };
        // 领取后那次 status 挂掉
        return { status: 500, json: {} };
      },
      [CLAIM]: () => ({ json: { code: 0, message: "success" } }),
    }),
  );
  equal(result.ok, true);
  equal(result.credits, undefined);
});

// ---------- 余额 ----------

Deno.test("balance sums the packs and skips the zero-limit ones", async () => {
  const balance = await fetchTraeBalance(
    credential(),
    fakeFetch({
      [USAGE]: () => ({
        json: {
          user_entitlement_pack_list: [
            {
              entitlement_base_info: {
                display_desc: "每月登录赠送",
                quota: { credits_limit: 500 },
              },
              usage: { credits_amount: 0 },
              expire_time: 1790783999,
            },
            {
              entitlement_base_info: {
                display_desc: "签到奖励",
                quota: { credits_limit: 150 },
              },
              usage: { credits_amount: 50 },
            },
            {
              entitlement_base_info: {
                display_desc: "空包",
                quota: { credits_limit: 0 },
              },
            },
          ],
        },
      }),
    }),
  );
  equal(balance.total, 600);
  equal(balance.packs.length, 2);
  equal(balance.packs[0].name, "每月登录赠送");
  // 1790783999 是秒级 Unix 时间戳 = 2026-09-30T15:59:59Z；
  // 当成毫秒会落在 1970-01-21，所以这条断言真的能抓到「忘了乘 1000」。
  equal(balance.packs[0].expires, "2026-09-30");
  equal(balance.packs[1].remaining, 100);
});

Deno.test("without require_usage the balance reads inflated, so the body must carry it", async () => {
  const log: { path: string; body: string }[] = [];
  await fetchTraeBalance(
    credential(),
    fakeFetch({
      [USAGE]: () => ({ json: { user_entitlement_pack_list: [] } }),
    }, log),
  );
  equal(log[0].body, '{"require_usage":true,"req_source":2}');
});

Deno.test("the expire timestamp is read as seconds, not milliseconds", async () => {
  const balance = await fetchTraeBalance(
    credential(),
    fakeFetch({
      [USAGE]: () => ({
        json: {
          user_entitlement_pack_list: [{
            entitlement_base_info: {
              display_desc: "包",
              quota: { credits_limit: 10 },
            },
            expire_time: 1790783999,
          }],
        },
      }),
    }),
  );
  // 秒级 1790783999 = 2026-09-30；当成毫秒会落在 1970
  equal(balance.packs[0].expires, "2026-09-30");
});

Deno.test("a missing pack list is an empty balance, not a crash", async () => {
  const balance = await fetchTraeBalance(
    credential(),
    fakeFetch({
      [USAGE]: () => ({ json: {} }),
    }),
  );
  equal(balance.total, 0);
  equal(balance.packs, []);
});

// ---------- 续期 ----------

Deno.test("refresh rotates the refresh token and keeps the device fingerprint", async () => {
  const before = credential();
  const after = await refreshTraeCredential(
    before,
    fakeFetch({
      "/cloudide/api/v3/trae/oauth/ExchangeToken": () => ({
        json: {
          Result: {
            Token: "access-2",
            RefreshToken: "refresh-2",
            TokenExpireAt: 1793000000,
          },
        },
      }),
    }),
    NOW,
  );
  equal(after.access_token, "access-2");
  // ⚠️ 必须轮换：旧 refreshToken 即刻失效，不回写等于 14 天后续期必失败
  equal(after.refresh_token, "refresh-2");
  // 设备指纹一个字节都不能动
  equal(after.machine_id, before.machine_id);
  equal(after.device_id, before.device_id);
  equal(after.uid, before.uid);
  equal(after.expires_at, "1793000000000");
});

Deno.test("a refresh response with no new refresh token keeps the old one", async () => {
  const after = await refreshTraeCredential(
    credential(),
    fakeFetch({
      "/cloudide/api/v3/trae/oauth/ExchangeToken": () => ({
        json: { Result: { Token: "access-3" } },
      }),
    }),
    NOW,
  );
  equal(after.access_token, "access-3");
  equal(after.refresh_token, "refresh-1");
});

Deno.test("a refresh without a refresh token is refused instead of hitting the network", async () => {
  let calls = 0;
  const counting = (input: string | URL | Request, init?: RequestInit) => {
    calls++;
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  await refreshTraeCredential(
    credential({ refresh_token: "" }),
    counting as typeof fetch,
  ).then(
    () => {
      throw new Error("should have rejected");
    },
    (error: Error) => {
      assert(
        error.message.includes("refresh_token"),
        "should name the missing token",
      );
    },
  );
  equal(calls, 0);
});

Deno.test("a refresh response without a token is an error, not a silent empty credential", async () => {
  await refreshTraeCredential(
    credential(),
    fakeFetch({
      "/cloudide/api/v3/trae/oauth/ExchangeToken": () => ({
        json: { Result: {} },
      }),
    }),
    NOW,
  ).then(
    () => {
      throw new Error("should have rejected");
    },
    (error: Error) => {
      assert(
        error.message.includes("缺少 Token"),
        "should say the token is missing",
      );
    },
  );
});

Deno.test("the exchange body is PascalCase with the literal ClientSecret '-'", async () => {
  const log: { path: string; body: string }[] = [];
  await refreshTraeCredential(
    credential(),
    fakeFetch({
      "/cloudide/api/v3/trae/oauth/ExchangeToken": () => ({
        json: { Result: { Token: "a" } },
      }),
    }, log),
    NOW,
  );
  const body = JSON.parse(log[0].body) as Record<string, unknown>;
  equal(body.ClientID, "en1oxy7wnw8j9n");
  equal(body.RefreshToken, "refresh-1");
  equal(body.ClientSecret, "-");
});
