/**
 * WorkBuddy 凭据层单测：文件读写、续期、终态判定。
 *
 * 全部用假 fetch / 假读写，不碰磁盘也不发网络请求。
 *
 * 判据：每条断言都对应一条真实踩过的坑，且**能被变异推翻** —— 把被测那行删掉
 * 或改错，本文件必须变红。
 */

import {
  isWorkBuddyUsable,
  needsWorkBuddyRefresh,
  readWorkBuddyCredential,
  refreshWorkBuddyCredential,
  refreshWorkBuddyIfNeeded,
  WORKBUDDY_REFRESH_SKEW_MS,
  type WorkBuddyFetcher,
  WorkBuddyRefreshTokenExpiredError,
  writeWorkBuddyCredential,
} from "./workbuddy-account.ts";
import type { WorkBuddyCredential } from "./workbuddy.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
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
function credential(
  overrides: Partial<WorkBuddyCredential> = {},
): WorkBuddyCredential {
  return {
    access_token: "at-1",
    refresh_token: "rt-1",
    expires_at: String(Date.now() + 3600_000),
    domain: "www.workbuddy.cn",
    user_id: "u-1",
    nickname: "n-1",
    enterprise_id: "",
    account_type: "personal",
    ...overrides,
  };
}

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetcher(
  handler: (call: Call) => { status?: number; body: string },
): { fetcher: WorkBuddyFetcher; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher = ((url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    const result = handler(call);
    return Promise.resolve(
      new Response(result.body, {
        status: result.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as WorkBuddyFetcher;
  return { fetcher, calls };
}

function tokenBody(
  overrides: Record<string, unknown> = {},
  accessToken = "at-2",
): string {
  return JSON.stringify({
    code: 0,
    msg: "OK",
    data: {
      accessToken,
      refreshToken: "rt-2",
      tokenType: "Bearer",
      expiresIn: 7200,
      refreshExpiresIn: 1209600,
      scope: "profile\noffline_access\nemail",
      domain: "www.workbuddy.cn",
      ...overrides,
    },
  });
}

Deno.test("凭据：文件缺失与坏 JSON 都按「未登录」处理", async () => {
  const missing = await readWorkBuddyCredential(
    "/nope",
    () => Promise.reject(new Error("ENOENT")),
  );
  assert(missing === undefined, "a missing file means never logged in");

  const broken = await readWorkBuddyCredential(
    "/x",
    () => Promise.resolve("{not json"),
  );
  assert(broken === undefined, "a corrupt file must not throw");

  const empty = await readWorkBuddyCredential(
    "/x",
    () => Promise.resolve(JSON.stringify({ refresh_token: "rt" })),
  );
  assert(empty === undefined, "no access_token means unusable");
});

Deno.test("凭据：读取保留原始 expires_at 形态，不做二次归一化", async () => {
  const iso = await readWorkBuddyCredential("/x", () =>
    Promise.resolve(
      JSON.stringify({ access_token: "a", expires_at: "2026-01-01T00:00:00Z" }),
    ));
  equal(iso?.expires_at, "2026-01-01T00:00:00Z", "ISO is carried through");
});

Deno.test("凭据：写出是带换行的缩进 JSON", async () => {
  let written = "";
  await writeWorkBuddyCredential("/root", credential(), (_path, data) => {
    written = data;
    return Promise.resolve();
  });
  assert(
    written.endsWith("\n"),
    "trailing newline keeps the file diff-friendly",
  );
  assert(
    JSON.parse(written).access_token === "at-1",
    "the written file must be parseable",
  );
});

Deno.test("续期：不到窗口不续期，也不写盘", async () => {
  const now = Date.now();
  const fresh = credential({ expires_at: String(now + 3600_000) });
  assert(
    !needsWorkBuddyRefresh(fresh, now),
    "an hour of headroom is not worth a refresh round-trip",
  );
  const { fetcher, calls } = fakeFetcher(() => ({ body: tokenBody() }));
  const paths: string[] = [];
  const result = await refreshWorkBuddyIfNeeded(
    "/root",
    fresh,
    fetcher,
    now,
    undefined,
    (path) => {
      paths.push(path);
      return Promise.resolve();
    },
  );
  assert(result === undefined, "undefined means the caller skips the write");
  equal(calls.length, 0, "no request should be made");
  equal(paths, [], "a needless write would churn the credential mtime");
});

Deno.test("续期：进窗口才续期并回写新令牌", async () => {
  const now = 1_800_000_000_000;
  const soon = credential({ expires_at: String(now + 1000) });
  assert(
    needsWorkBuddyRefresh(soon, now),
    "inside the skew window the token must be renewed",
  );
  const { fetcher, calls } = fakeFetcher(() => ({ body: tokenBody() }));
  const refreshed = await refreshWorkBuddyCredential(
    soon,
    fetcher,
    now,
  );
  equal(calls.length, 1, "exactly one refresh request");
  equal(
    (calls[0].init.headers as Record<string, string>)[
      "X-Refresh-Token"
    ],
    "rt-1",
    "refresh_token travels in the header, not the body",
  );
  assert(
    calls[0].url.endsWith("/v2/plugin/auth/token/refresh"),
    "refresh path",
  );
  equal(refreshed.access_token, "at-2", "new access token is adopted");
  equal(refreshed.refresh_token, "rt-2", "rotated refresh token is adopted");
  assert(refreshed.expires_at !== soon.expires_at, "expiry is recomputed");
  equal(refreshed.user_id, "u-1", "account fields survive the refresh");
  equal(refreshed.nickname, "n-1", "nickname survives the refresh");

  const paths: string[] = [];
  const again = await refreshWorkBuddyIfNeeded(
    "/root",
    soon,
    fetcher,
    now,
    undefined,
    (path) => {
      paths.push(path);
      return Promise.resolve();
    },
  );
  equal(
    paths,
    ["/root/workbuddy-auth.json"],
    "the renewed credential must land in the credential file",
  );
  assert(
    again !== undefined && again.refresh_token === "rt-2",
    "the refreshed credential is returned to the caller",
  );
});

Deno.test("续期：响应没带 refresh_token 时必须保留旧的", async () => {
  const { fetcher } = fakeFetcher(() => ({
    body: tokenBody({ refreshToken: "" }),
  }));
  const refreshed = await refreshWorkBuddyCredential(credential(), fetcher);
  equal(
    refreshed.refresh_token,
    "rt-1",
    "dropping it would break the next refresh, days later",
  );
});

Deno.test("续期：域名以产品常量为准，不吃凭据里的旧快照", async () => {
  const { fetcher, calls } = fakeFetcher(() => ({ body: tokenBody() }));
  await refreshWorkBuddyCredential(
    credential({ domain: "www.workbuddy.ai" }),
    fetcher,
  );
  equal(
    (calls[0].init.headers as Record<string, string>)["X-Domain"],
    "www.workbuddy.cn",
    "a stale domain snapshot would resolve the wrong tenant",
  );
});

Deno.test("续期：401/403 与 expired 文案都算终态，不再重试", async () => {
  const terminal: { status: number; body: string }[] = [
    { status: 401, body: "<html>401 Authorization Required</html>" },
    { status: 403, body: JSON.stringify({ code: 403, msg: "forbidden" }) },
    {
      status: 400,
      body: JSON.stringify({ code: 10001, msg: "refreshToken is expired" }),
    },
  ];
  for (const item of terminal) {
    const { fetcher } = fakeFetcher(() => item);
    let thrown: unknown;
    try {
      await refreshWorkBuddyCredential(credential(), fetcher);
    } catch (error) {
      thrown = error;
    }
    assert(
      thrown instanceof WorkBuddyRefreshTokenExpiredError,
      `HTTP ${item.status} must be terminal: ${String(thrown)}`,
    );
  }
});

Deno.test("续期：openresty 的 HTML 401 不能变成解析错误", async () => {
  const { fetcher } = fakeFetcher(() => ({
    status: 401,
    body: "<html><head><title>401 Authorization Required</title></head></html>",
  }));
  let thrown: Error | undefined;
  try {
    await refreshWorkBuddyCredential(credential(), fetcher);
  } catch (error) {
    thrown = error as Error;
  }
  assert(
    thrown instanceof WorkBuddyRefreshTokenExpiredError,
    "the HTML body must not turn a 401 into a JSON parse failure",
  );
  assert(
    !thrown.message.includes("JSON"),
    "the message must talk about auth, not parsing",
  );
});

Deno.test("续期：非终态失败是可重试错误，不能被当成令牌失效", async () => {
  const { fetcher } = fakeFetcher(() => ({
    status: 500,
    body: JSON.stringify({ code: 500, msg: "internal error" }),
  }));
  let thrown: Error | undefined;
  try {
    await refreshWorkBuddyCredential(credential(), fetcher);
  } catch (error) {
    thrown = error as Error;
  }
  assert(thrown instanceof Error, "it throws");
  assert(
    !(thrown instanceof WorkBuddyRefreshTokenExpiredError),
    "a 500 is transient and must stay retryable",
  );
});

Deno.test("续期：响应缺 data 或缺 accessToken 都要报错而不是返回半份凭据", async () => {
  const bad = [
    JSON.stringify({ code: 0, msg: "OK" }),
    JSON.stringify({ code: 0, data: { refreshToken: "rt-2" } }),
  ];
  for (const body of bad) {
    const { fetcher } = fakeFetcher(() => ({ body }));
    let thrown: unknown;
    try {
      await refreshWorkBuddyCredential(credential(), fetcher);
    } catch (error) {
      thrown = error;
    }
    assert(thrown instanceof Error, `must throw for ${body}`);
    assert(
      !(thrown instanceof WorkBuddyRefreshTokenExpiredError),
      "a malformed 200 is not a dead refresh_token",
    );
  }
});

Deno.test("可用性：过期但能续期 ⇒ 仍可用；过期且不能续期 ⇒ 不可用", () => {
  const now = Date.now();
  const dead = credential({ expires_at: String(now - 1000) });
  assert(
    isWorkBuddyUsable(dead, now),
    "expired but refreshable: the reactive 401 path can still save it",
  );
  const hopeless = credential({
    expires_at: String(now - 1000),
    refresh_token: "",
  });
  assert(
    !isWorkBuddyUsable(hopeless, now),
    "expired with no refresh_token: the user must log in again",
  );
  assert(
    !isWorkBuddyUsable(credential({ access_token: "" }), now),
    "no token at all is never usable",
  );
});

Deno.test("续期：提前量必须小到不会变成「每请求一次续期」", () => {
  assert(
    WORKBUDDY_REFRESH_SKEW_MS <= 60 * 60 * 1000,
    "an hour is the ceiling; the real safety net is the 401 retry path",
  );
});
