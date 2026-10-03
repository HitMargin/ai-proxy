/**
 * WorkBuddy（中国版）纯函数层单测：目录解析、倍率、促销、请求头、请求体。
 *
 * 全部用假件，不碰磁盘也不发网络请求（deno task test 只开 --allow-env）。
 *
 * 判据：每条断言都对应一条真实踩过的坑，且**能被变异推翻** —— 把被测那行删掉
 * 或改错，本文件必须变红。改错不断红的断言等于装饰。
 */

import {
  aggregateWorkBuddySse,
  buildChatBody,
  buildCredential,
  classifyWorkBuddyChatFailure,
  credentialExpiresAtMs,
  displayNameForModel,
  formatCreditsRate,
  guardWorkBuddyStream,
  hasTimeWindow,
  HTTP_HEADER_DOMAIN,
  HTTP_HEADER_ENTERPRISE_ID,
  HTTP_HEADER_NO_AUTHORIZATION,
  HTTP_HEADER_NO_DEPARTMENT_INFO,
  HTTP_HEADER_NO_ENTERPRISE_ID,
  HTTP_HEADER_NO_USER_ID,
  HTTP_HEADER_PRODUCT,
  HTTP_HEADER_TENANT_ID,
  isChatModel,
  isContentRejection,
  isContentRejectionFrame,
  isDeepSeekModel,
  isWorkBuddyExpired,
  isWorkBuddyThrottled,
  jwtClaimMs,
  jwtNickname,
  jwtSubject,
  normalizeCreditsRate,
  normalizeDiscountedRate,
  parseAccountData,
  parseHHMM,
  parseModelsFromConfig,
  parsePromotions,
  parseTokenData,
  postWorkBuddyChatWithThrottleRetry,
  promotionActiveNow,
  readNumberField,
  readStringField,
  resetWorkBuddyCircuit,
  sendWorkBuddyChat,
  stripControlChars,
  toWorkBuddyModelCard,
  trialModelIds,
  tripWorkBuddyCircuit,
  WORKBUDDY_CHAT_TIMEOUT_MS,
  WORKBUDDY_PASSTHROUGH_FIELDS,
  workBuddyAnonymousHeaders,
  workBuddyBaseHeaders,
  workBuddyChatHeaders,
  workBuddyChatSignal,
  workBuddyCooldownRemaining,
  type WorkBuddyCredential,
  workBuddyErrorCode,
  workBuddyLocalError,
  workBuddyLocalErrorBody,
  workBuddyRetryAfterMs,
  workBuddyTruncationError,
  zonedMinutes,
} from "./workbuddy.ts";

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
    access_token: "at",
    refresh_token: "rt",
    expires_at: String(Date.now() + 3_600_000),
    ...overrides,
  };
}

/** 造一个 /v3/config 响应。 */
function config(data: Record<string, unknown>): unknown {
  return { code: 0, data };
}

// ===== 第 10 轮：输出上限的第二个字段 =====
Deno.test("输出上限：正文上限与总上限必须**分别**下发，缺一个上游就不采纳另一个", () => {
  const both = buildChatBody("hy3-c", [], "s", undefined, {
    maxTokens: 200,
    maxCompletionTokens: 24,
  });
  equal(both.max_tokens, 200);
  equal(both.max_completion_tokens, 24);
  // 只给一个时那个字段仍然照发（上游的采纳规则是它的责任，不是我们的）。
  const onlyTotal = buildChatBody("hy3-c", [], "s", undefined, {
    maxTokens: 200,
  });
  equal(onlyTotal.max_tokens, 200);
  equal("max_completion_tokens" in onlyTotal, false);
  const onlyBody_ = buildChatBody("hy3-c", [], "s", undefined, {
    maxCompletionTokens: 24,
  });
  equal(onlyBody_.max_completion_tokens, 24);
  equal("max_tokens" in onlyBody_, false);
});

Deno.test("输出上限：两个字段各自拒掉非正数（0 与负数都不该下发）", () => {
  for (const bad of [0, -1, -100]) {
    const b = buildChatBody("hy3-c", [], "s", undefined, {
      maxTokens: 200,
      maxCompletionTokens: bad,
    });
    equal(b.max_tokens, 200);
    equal(
      "max_completion_tokens" in b,
      false,
      "max_completion_tokens=" + bad,
    );
    const t = buildChatBody("hy3-c", [], "s", undefined, {
      maxTokens: bad,
      maxCompletionTokens: 24,
    });
    equal("max_tokens" in t, false, "max_tokens=" + bad);
    equal(t.max_completion_tokens, 24);
  }
});

Deno.test("输出上限：plan 的默认值**不**填进正文上限（上限语义不同，不能替调用方决定）", () => {
  const b = buildChatBody("hy3-c", [], "s", {
    maxOutputTokens: 4096,
    efforts: [],
    defaultEffort: undefined,
  }, {});
  equal(b.max_tokens, 4096);
  equal("max_completion_tokens" in b, false);
});

// ===== 第 10 轮：透传白名单 =====
Deno.test("透传：采样与结构化字段原样下发", () => {
  const b = buildChatBody("hy3-c", [], "s", undefined, {
    passthrough: {
      response_format: { type: "json_object" },
      top_p: 0.9,
      seed: 42,
      presence_penalty: 0.5,
      frequency_penalty: -0.5,
      logprobs: true,
      top_logprobs: 3,
      n: 2,
      user: "u-1",
      parallel_tool_calls: false,
      service_tier: "flex",
      top_k: 40,
      logit_bias: { "1": -100 },
    },
  });
  for (const key of WORKBUDDY_PASSTHROUGH_FIELDS) {
    equal(key in b, true, "missing passthrough field: " + key);
  }
  equal(b.response_format, { type: "json_object" });
  equal(b.top_p, 0.9);
  equal(b.seed, 42);
  equal(b.user, "u-1");
  equal(b.parallel_tool_calls, false);
});

Deno.test("透传：白名单**之外**的字段一律不下发", () => {
  const b = buildChatBody(
    "hy3-c",
    [{ role: "user", content: "hi" }],
    "s",
    undefined,
    {
      passthrough: {
        // 这几个是我们要改写或必须由代理生成的，调用方给了也不能覆盖。
        model: "evil",
        messages: [],
        stream: false,
        prompt_cache_key: "caller-supplied",
        // 有各自判据与兜底的字段**不走白名单**：白名单包里塞它们等于没给。
        // （这条断言在写测试时真的红了：max_tokens 来自 options.maxTokens，
        //  不来自 passthrough，所以包里的 7 会被忽略且请求体里没有该字段。）
        max_tokens: 7,
        max_completion_tokens: 9,
        reasoning_effort: "high",
        stop: ["x"],
        tools: [{ type: "function" }],
        tool_choice: "auto",
        // 完全无关的自造字段。
        whatever: true,
      },
    },
  );
  equal(b.model, "hy3-c");
  equal(b.messages, [{ role: "user", content: "hi" }]);
  equal(b.stream, true);
  equal(b.prompt_cache_key, "s");
  equal(
    "max_tokens" in b,
    false,
    "max_tokens comes from options, not passthrough",
  );
  equal("max_completion_tokens" in b, false);
  equal("reasoning_effort" in b, false);
  equal("stop" in b, false);
  equal("tools" in b, false);
  equal("tool_choice" in b, false);
  equal("whatever" in b, false);
  for (const key of WORKBUDDY_PASSTHROUGH_FIELDS) {
    equal(key in b, false, "unexpected passthrough field: " + key);
  }
});

Deno.test("透传：显式的 undefined / null 不下发（undefined 是没给，null 是显式清空）", () => {
  const b = buildChatBody("hy3-c", [], "s", undefined, {
    passthrough: {
      top_p: undefined,
      seed: null,
      response_format: null,
    },
  });
  equal("top_p" in b, false, "undefined must not be sent");
  // null 是**显式值**：调用方写了 null 就是想让它出现在请求体里，不能当没给。
  equal("seed" in b, true);
  equal(b.seed, null);
  equal("response_format" in b, true);
});

Deno.test("透传：没有 passthrough 包的调用方行为完全不变", () => {
  const b = buildChatBody("hy3-c", [], "s", undefined, {});
  for (const key of WORKBUDDY_PASSTHROUGH_FIELDS) {
    equal(key in b, false);
  }
  const withEmpty = buildChatBody("hy3-c", [], "s", undefined, {
    passthrough: {},
  });
  equal(Object.keys(withEmpty).length, Object.keys(b).length);
});

// ===== 第 10 轮：错误分类 =====
Deno.test("分类：403 上的 11140 是**内容拦截**，绝不能去续期重试", () => {
  const f = classifyWorkBuddyChatFailure(
    403,
    JSON.stringify({
      code: 11140,
      msg: "request illegal",
      displayMsg: { en: "content did not pass the safety review" },
    }),
  );
  equal(f.rejection, true);
  equal(f.refreshFirst, false, "11140 must not trigger a token refresh");
  equal(f.status, 403);
  equal(f.error.code, 11140);
  equal(f.error.type, "content_rejection");
  equal(f.error.message.includes("another account"), true);
});

Deno.test("分类：拦截判据**不看状态码**（SSE 内嵌 11140 也走同一条通道）", () => {
  for (const status of [200, 400, 401, 403, 429, 500]) {
    const f = classifyWorkBuddyChatFailure(
      status,
      '{"code":11140,"msg":"request illegal"}',
    );
    equal(
      f.rejection,
      true,
      "status " + status + " must classify as rejection",
    );
    equal(f.refreshFirst, false);
  }
});

Deno.test("分类：401 与非拦截的 403 才续期重试一次", () => {
  const a = classifyWorkBuddyChatFailure(
    401,
    '{"code":40100,"msg":"unauthorized"}',
  );
  equal(a.refreshFirst, true);
  equal(a.rejection, false);
  equal(a.status, 401);
  equal(a.error.type, "authentication_error");
  // 403 但不是拦截（权限/额度）⇒ 同样当令牌问题处理，可自愈。
  const b = classifyWorkBuddyChatFailure(
    403,
    '{"code":40300,"msg":"forbidden"}',
  );
  equal(b.refreshFirst, true);
  equal(b.rejection, false);
  equal(b.status, 403);
  // ⚠️ 失败信息不能承诺「正在重试」：重试成功时不回这条，只有续期失败才回它，
  // 那样写等于在失败时骗用户。
  equal(a.error.message.includes("retrying"), false);
});

Deno.test("分类：429 是限流而非认证问题，且带出上游真实业务码", () => {
  const f = classifyWorkBuddyChatFailure(
    429,
    '{"code":14003,"msg":"too many requests"}',
  );
  equal(f.refreshFirst, false, "a 429 must not burn a refresh_token");
  equal(f.rejection, false);
  equal(f.status, 429);
  equal(f.error.code, 14003);
  equal(f.error.type, "rate_limit_exceeded");
});

Deno.test("分类：其余状态码原样透传，且**不**续期", () => {
  for (const status of [400, 404, 500, 502, 503]) {
    const f = classifyWorkBuddyChatFailure(
      status,
      '{"code":' + status + ',"msg":"boom"}',
    );
    equal(f.status, status);
    equal(f.refreshFirst, false);
    equal(f.rejection, false);
    equal(f.error.code, status);
    equal(f.error.type, "upstream_error");
  }
});

Deno.test("分类：拦截判据把「正文里提到 11140」和「真错误体」区分开", () => {
  // 上游拿 HTML 页面挡回来（三个 host 的真 401 都是 openresty HTML）时不能误判。
  const html =
    "<html>\r\n<head><title>401 Authorization Required</title></head>" +
    "<body>\n<center><h1>401 Authorization Required</h1></center>\n<hr>APISIX</body>";
  equal(classifyWorkBuddyChatFailure(401, html).refreshFirst, true);
  // 空的响应体也不能编出一个码来。
  const empty = classifyWorkBuddyChatFailure(500, "");
  equal(empty.error.code, 500);
  equal(empty.refreshFirst, false);
});

Deno.test("本地失败：形状必须与上游失败同族（同一个路由不许有两种 error 形状）", () => {
  // 判据来自一次自检：第 10 轮只把**上游**失败改成 OpenAI 形状，路由自己产生的
  // 400/404/409/502 仍然是 {error:"…字符串"}。客户端按标准形状读 message 时，
  // 上游错误读得到、本地错误读不到 —— 同一个接口两种形状，比两种都不对还难查。
  for (
    const status of [400, 404, 409, 502]
  ) {
    const local = workBuddyLocalError(status, "boom");
    equal(local.status, status);
    equal(local.error.message, "boom");
    equal(
      local.error.code,
      status,
      "没有上游业务码可抄，code 就是 HTTP 状态码",
    );
    equal(local.error.type, "upstream_error");
    // 与 classifyWorkBuddyChatFailure 的返回逐键同形。
    const remote = classifyWorkBuddyChatFailure(status, "");
    equal(
      Object.keys(local.error).sort(),
      Object.keys(remote.error).sort(),
      "error 对象的键集合必须一致",
    );
    equal(typeof local.error.message, "string");
    equal(typeof local.error.type, "string");
  }
});

Deno.test("本地失败：type 可显式指定，且不能被默认值吃掉", () => {
  equal(
    workBuddyLocalError(400, "bad", "invalid_request_error").error.type,
    "invalid_request_error",
  );
  equal(
    workBuddyLocalError(409, "no cred", "authentication_error").error.type,
    "authentication_error",
  );
  // 显式传 upstream_error（= 默认值）也必须是字符串，不是空串/undefined。
  const explicit = workBuddyLocalError(500, "boom", "upstream_error");
  equal(explicit.error.type, "upstream_error");
  equal(explicit.error.code, 500);
});

Deno.test("响应体：必须真的有 error 键（展开 error 会把整个 error 键弄丢）", () => {
  // 这是第 11 轮第一版的真 bug，且**任何单测都抓不到**：main.ts 里写的是
  // `jsonResponse({ ...local.error, available })`，展开后响应变成
  // `{message,type,code,available}` —— error 键整个不见了，只读 error.message
  // 的解析器照样读不到。上一批测试只断言 helper 的返回值，helper 本身是对的，
  // 错的是**组装**。判据：组装响应体的代码也必须住 src/，并断言「线上形状」而不是
  // 「函数返回值」。
  const local = workBuddyLocalError(
    400,
    "Unknown WorkBuddy model: x",
    "invalid_request_error",
  );
  const body = workBuddyLocalErrorBody(local, { available: ["a", "b"] });
  // 关键断言：error 键存在本身。
  equal(Object.keys(body).indexOf("error") >= 0, true, "响应体必须有 error 键");
  equal(typeof body.error, "object");
  equal(body.error.message, "Unknown WorkBuddy model: x");
  equal(body.error.type, "invalid_request_error");
  equal(body.error.code, 400);
  // available 作为兄弟键存在，但不污染 error 本身。
  equal(body.available, ["a", "b"]);
  equal(
    Object.keys(body.error).sort(),
    ["code", "message", "type"],
    "extra 键不许进 error 对象，否则多绕一层",
  );
});

Deno.test("响应体：没有 extra 时形状就是 error 本身（不许凭空多个键）", () => {
  const body = workBuddyLocalErrorBody(workBuddyLocalError(404, "nope"));
  equal(Object.keys(body).sort(), ["error"]);
  equal(body.error.message, "nope");
  equal(body.error.code, 404);
});

Deno.test("响应体：extra 里就算带了 error 键也不许覆盖真的 error", () => {
  // 展开顺序敏感的那一条。前两条用例的 extra 里没有 error 键，所以**两种顺序都过**，
  // 断言等于没写（`{error, ...extra}` 与 `{...extra, error}` 键集合完全相同）。
  // 只有 extra 自己携带同名键时，顺序才有可观测的后果 —— 这正是变异体存活的原因。
  const local = workBuddyLocalError(500, "boom");
  const shadowed = workBuddyLocalErrorBody(local, { error: "a string, oops" });
  equal(
    typeof shadowed.error,
    "object",
    "extra 里的 error 字符串不许顶掉真 error",
  );
  equal(shadowed.error.message, "boom");
  equal(shadowed.error.code, 500);
});

Deno.test("响应体：上游失败与本地失败必须走同一个组装口", () => {
  // 参数类型是放宽的（code: number | string）而不是只收 WorkBuddyLocalError：
  // 上游失败的 code 是业务码、可能是字符串（stream_cut 就是字符串）。它要是进不来，
  // 调用方就会另写一条拼装代码，「同一个路由不许有两种错误形状」立刻重新长回来。
  const upstream = classifyWorkBuddyChatFailure(502, "");
  const body = workBuddyLocalErrorBody(upstream, { detail: "raw body here" });
  equal(Object.keys(body).indexOf("error") >= 0, true);
  equal(body.error.message, upstream.error.message);
  equal(body.error.type, upstream.error.type);
  equal(body.error.code, upstream.error.code);
  equal(body.detail, "raw body here");
});

Deno.test("响应体：extra 的普通兄弟键照常透传", () => {
  const body = workBuddyLocalErrorBody(workBuddyLocalError(500, "boom"), {
    detail: "upstream said no",
  });
  equal(body.error.message, "boom");
  equal(body.detail, "upstream said no");
});
// ===== 业务码读取 =====
Deno.test("业务码：只从真报文里读，读不出就返回 undefined（绝不编）", () => {
  equal(workBuddyErrorCode('{"code":14003,"msg":"x"}'), 14003);
  equal(
    workBuddyErrorCode('{"code":"14003"}'),
    undefined,
    "字符串不是数字",
  );
  equal(workBuddyErrorCode('{"code":null}'), undefined);
  equal(workBuddyErrorCode('{"code":1.5e400}'), undefined);
  equal(workBuddyErrorCode(""), undefined);
  equal(workBuddyErrorCode("plain text"), undefined);
  equal(workBuddyErrorCode("[1,2,3]"), undefined);
  equal(workBuddyErrorCode("null"), undefined);
  // 非 JSON 的报文也要能挖 —— 三个 host 的真 401 是 openresty HTML。
  equal(workBuddyErrorCode('garbage "code":11140 tail'), 11140);
  equal(workBuddyErrorCode('garbage "code": abc'), undefined);
});

Deno.test("凭据：解析不出过期时刻时**不**判过期", () => {
  // 归一化失败的账号若被判过期，会被永久锁死在「请重新登录」。
  assert(
    !isWorkBuddyExpired(credential({ expires_at: "not-a-date" })),
    "unparsable expiry must not count as expired",
  );
  assert(
    isWorkBuddyExpired(credential({ expires_at: String(Date.now() - 1) })),
    "a past timestamp is expired",
  );
});

Deno.test("凭据：expires_at 认 ISO、秒级与毫秒级三种形态", () => {
  const ms = Date.now() + 60_000;
  assert(
    !isWorkBuddyExpired(credential({ expires_at: new Date(ms).toISOString() })),
    "ISO expiry",
  );
  assert(
    !isWorkBuddyExpired(
      credential({ expires_at: String(Math.floor(ms / 1000)) }),
    ),
    "seconds expiry",
  );
  assert(
    !isWorkBuddyExpired(credential({ expires_at: String(ms) })),
    "milliseconds expiry",
  );
});

Deno.test("凭据：domain 缺失是空串，X-Domain 必须兜回默认域名", () => {
  // 用 ?? 会让 X-Domain 以空值发出（参考实现的真实缺陷，有单测复现）。
  const headers = workBuddyBaseHeaders(credential());
  equal(headers[HTTP_HEADER_DOMAIN], "www.workbuddy.cn", "default domain");
  equal(
    workBuddyBaseHeaders(credential({ domain: "" }))[HTTP_HEADER_DOMAIN],
    "www.workbuddy.cn",
    "empty domain falls back",
  );
  equal(
    workBuddyBaseHeaders(credential({ domain: "other.example" }))[
      HTTP_HEADER_DOMAIN
    ],
    "other.example",
    "credential domain is honoured at this layer",
  );
});

Deno.test("凭据：企业账号要同时带 X-Enterprise-Id 与 X-Tenant-Id", () => {
  const headers = workBuddyBaseHeaders(
    credential({ enterprise_id: "ent-1" }),
  );
  equal(headers[HTTP_HEADER_ENTERPRISE_ID], "ent-1");
  equal(headers[HTTP_HEADER_TENANT_ID], "ent-1");
  const personal = workBuddyBaseHeaders(credential());
  assert(
    personal[HTTP_HEADER_ENTERPRISE_ID] === undefined,
    "personal accounts carry no enterprise header",
  );
});

Deno.test("聊天头：X-Product 发的是归属名，不是部署类型", () => {
  const headers = workBuddyChatHeaders(credential());
  equal(headers[HTTP_HEADER_PRODUCT], "WorkBuddy");
  equal(
    headers[HTTP_HEADER_DOMAIN],
    "www.workbuddy.cn",
    "chat X-Domain follows the product, not the credential snapshot",
  );
  equal(
    workBuddyChatHeaders(credential({ domain: "stale.example" }))[
      HTTP_HEADER_DOMAIN
    ],
    "www.workbuddy.cn",
    "stale credential domain must not override the destination host",
  );
});

Deno.test("倍率：credits 是 x 在前、促销是 x 在后", () => {
  equal(normalizeCreditsRate("x0.29"), "x0.29");
  equal(normalizeCreditsRate("x0.03 credits"), "x0.03");
  equal(normalizeCreditsRate("1.62x"), "x1.62", "suffix form still parses");
  equal(normalizeCreditsRate(""), undefined, "empty means no rate info");
  equal(normalizeCreditsRate(undefined), undefined);
  // 用同一个正则会让**每一个**促销价静默失败：界面显示原价、后台按促销计费。
  equal(normalizeDiscountedRate("0.50x"), "x0.50");
  equal(normalizeDiscountedRate("x0.15"), "x0.15");
  equal(normalizeDiscountedRate(0.5), undefined, "not a string");
});

Deno.test("倍率文案：箭头形态", () => {
  equal(formatCreditsRate("x0.17", "x0.50"), "x0.17→x0.50");
  equal(formatCreditsRate("x0.29", undefined), "x0.29");
  equal(formatCreditsRate(undefined, "x0.50"), "x0.50");
  equal(formatCreditsRate(undefined, undefined), undefined);
});

Deno.test("解析：scope 多行文本必须被压成一行", () => {
  const token = parseTokenData({
    accessToken: "at",
    refreshToken: "rt",
    scope: "profile\n    offline_access\n    email",
  });
  assert(!token.scope.includes("\n"), "scope must not keep newlines");
  equal(stripControlChars("a\u0000b\r\nc"), "a b c");
});

Deno.test("解析：token 只给相对秒数时要换算成时间戳", () => {
  const issuedAt = Math.floor(Date.now() / 1000) - 10;
  const token = parseTokenData({
    accessToken: "at",
    refreshToken: "rt",
    expiresIn: 3600,
  });
  const expiry = Number(token.expiresAt);
  assert(
    Number.isFinite(expiry) && expiry > Date.now(),
    "relative expiresIn must become an absolute ms timestamp, got " +
      token.expiresAt,
  );
  assert(issuedAt > 0, "sanity");
});

Deno.test("促销：每日时段必须本地推算（跨零点也算），不看时段就全天显示夜间价", () => {
  const night = {
    schedule: {
      timezone: "Asia/Shanghai",
      daily: [{ start: "23:00", end: "07:50" }],
    },
  };
  const day = {
    schedule: {
      timezone: "Asia/Shanghai",
      daily: [{ start: "07:50", end: "23:00" }],
    },
  };
  const hours = [0, 3, 8, 12, 23];
  for (const h of hours) {
    const at = new Date(Date.UTC(2026, 0, 1, h - 8, 30));
    const nightActive = promotionActiveNow(night, at);
    const dayActive = promotionActiveNow(day, at);
    equal(
      nightActive !== dayActive,
      true,
      "两条活动互补，h=" + h + " 不能同时生效",
    );
    equal(nightActive, h === 0 || h === 3 || h === 23, "夜间时段 h=" + h);
  }
  // 无时段 ⇒ 按生效处理（宁可多显示一条过期促销）。
  equal(promotionActiveNow({}, new Date()), true);
  equal(promotionActiveNow({ schedule: { daily: [] } }, new Date()), true);
  equal(hasTimeWindow({ daily: [{ start: "1", end: "2" }] }), true);
  equal(hasTimeWindow({ daily: [] }), false);
  equal(hasTimeWindow({ validFrom: "2026-01-01T00:00:00Z" }), true);
  equal(hasTimeWindow("nope"), false);
});

Deno.test("促销：有效期窗口要真的参与判定（validFrom/validUntil 都会否掉）", () => {
  const now = new Date("2026-06-01T12:00:00Z");
  equal(
    promotionActiveNow(
      { schedule: { validFrom: "2026-07-01T00:00:00Z" } },
      now,
    ),
    false,
    "还没开始的活动不能计价",
  );
  equal(
    promotionActiveNow(
      { schedule: { validUntil: "2026-05-01T00:00:00Z" } },
      now,
    ),
    false,
    "已经结束的活动不能计价",
  );
  equal(
    promotionActiveNow(
      { schedule: { validFrom: "2026-05-01T00:00:00Z" } },
      now,
    ),
    true,
  );
});

Deno.test("促销：时段解析失败一律按生效处理（不能误杀正在打折的模型）", () => {
  const now = new Date();
  const broken = {
    schedule: {
      timezone: "Asia/Shanghai",
      daily: [{ start: "24:00", end: "7:50" }],
    },
  };
  equal(promotionActiveNow(broken, now), false, "非法时段不匹配任何 slot");
  equal(parseHHMM("24:00"), undefined);
  equal(parseHHMM("12:60"), undefined);
  equal(parseHHMM("1230"), undefined);
  equal(parseHHMM(1230), undefined);
  equal(parseHHMM("7:50"), 7 * 60 + 50, "不补零也要认");
  equal(zonedMinutes(now, "Not/AZone"), undefined, "坏时区要退回不判断");
  equal(
    zonedMinutes(now, ""),
    zonedMinutes(now, "Asia/Shanghai"),
    "空时区用默认",
  );
});

Deno.test("促销：算不出墙上时间时不能编一个（宁可按不判断处理）", () => {
  // Intl 对非法 Date 直接抛，走 catch 分支。
  equal(
    zonedMinutes({} as unknown as Date, "Asia/Shanghai"),
    undefined,
    "非法 Date 让 Intl 直接抛，走 catch",
  );
  // hour/minute 取不到数字（时区库形态异常）时也必须当判不出。
  // ⚠️ 必须给**普通函数**：zonedMinutes 里是 `new Intl.DateTimeFormat(...)`，
  // 箭头函数不可构造，那样只会走到 catch 分支而测不到非有限这条。
  const real = Intl.DateTimeFormat;
  (Intl as unknown as Record<string, unknown>).DateTimeFormat = function () {
    return {
      formatToParts: () => [
        { type: "hour", value: "??" },
        { type: "minute", value: "??" },
      ],
    };
  };
  try {
    equal(
      zonedMinutes(new Date(), "Asia/Shanghai"),
      undefined,
      "NaN 小时/分钟不能当成 0 点",
    );
    equal(
      promotionActiveNow(
        {
          schedule: {
            timezone: "Asia/Shanghai",
            daily: [{ start: "00:00", end: "23:59" }],
          },
        },
        new Date(),
      ),
      true,
      "判不出墙上时间就不该匹配任何 slot，按生效处理",
    );
  } finally {
    (Intl as unknown as Record<string, unknown>).DateTimeFormat = real;
  }
});

Deno.test("促销：坏 slot 必须整条跳过而不是把整张表否掉", () => {
  const at = new Date(Date.UTC(2026, 0, 1, 4, 30)); // 上海 12:30
  equal(
    promotionActiveNow({ schedule: { daily: [null, 7, {}] } }, at),
    false,
    "全是坏 slot ⇒ 没有任何时段匹配",
  );
  equal(
    promotionActiveNow(
      { schedule: { daily: [null, { start: "03:00", end: "04:00" }] } },
      at,
    ),
    false,
    "好 slot 与坏 slot 混排时只按好的那些判",
  );
  equal(
    promotionActiveNow(
      { schedule: { daily: [null, { start: "12:00", end: "13:00" }] } },
      at,
    ),
    true,
    "同一个好 slot 命中时不能被前面的坏条目否掉",
  );
});

Deno.test("促销表：坏条目逐条跳过而不是整表丢弃", () => {
  const rates = parsePromotions({
    modelPromotions: [
      null,
      {
        enabled: false,
        modelIds: ["m-off"],
        discount: { discountedCredits: "x0.5" },
      },
      { enabled: true, modelIds: ["m-nodiscount"] },
      { enabled: true, modelIds: ["m-zero"], discount: { factor: 0 } },
      {
        enabled: true,
        modelIds: ["m-zero0"],
        discount: { discountedCredits: "0x" },
      },
      {
        enabled: true,
        modelIds: ["m-noids"],
        discount: { discountedCredits: "x0.4" },
      },
      { enabled: true, discount: { discountedCredits: "x0.4" } },
      {
        enabled: true,
        modelIds: ["m-ok", 7, ""],
        discount: { discountedCredits: "x0.4" },
      },
      {
        enabled: true,
        modelIds: ["m-dup"],
        discount: { discountedCredits: "x0.9" },
        priority: 1,
      },
      {
        enabled: true,
        modelIds: ["m-dup"],
        discount: { discountedCredits: "x0.3" },
        priority: 5,
      },
    ],
  }, new Date());
  equal(rates.get("m-off"), undefined, "enabled:false 不计价");
  equal(rates.get("m-nodiscount"), undefined, "没有 discount 字段就跳过");
  equal(rates.get("m-zero"), undefined, "factor:0 但没有时段 ⇒ 不能标免费");
  equal(rates.get("m-zero0"), undefined, "归一化后是 x0 的占位要跳过");
  equal(rates.get("m-noids"), "x0.4", "没有时间窗的普通折扣照常计价");
  equal(rates.size, 3, "缺 modelIds 的条目不能顺带污染整张表");
  equal(rates.get("m-ok"), "x0.4");
  equal(rates.get("m-dup"), "x0.3", "高 priority 覆盖低 priority");
  equal(parsePromotions({}, new Date()).size, 0, "没有促销表就是空映射");
});

Deno.test("促销表：归一化不出倍率时跳过；低优先级不得覆盖高优先级", () => {
  const rates = parsePromotions({
    modelPromotions: [
      // 非字符串 discountedCredits ⇒ 归一化返回 undefined，必须跳过。
      {
        enabled: true,
        modelIds: ["m-bad-rate"],
        discount: { discountedCredits: 7 },
      },
      {
        enabled: true,
        modelIds: ["m-bad-rate"],
        discount: { discountedCredits: "0.9x" },
        priority: 9,
      },
      {
        enabled: true,
        modelIds: ["m-bad-rate"],
        discount: { discountedCredits: "0.1x" },
        priority: 1,
      },
    ],
  }, new Date());
  equal(rates.get("m-bad-rate"), "x0.9", "低优先级的 0.1x 不得覆盖 0.9x");
});

Deno.test("促销表：factor 为 0 且带时段时可以标免费", () => {
  const rates = parsePromotions({
    modelPromotions: [{
      enabled: true,
      modelIds: ["m-free"],
      discount: { factor: 0 },
      schedule: {
        timezone: "Asia/Shanghai",
        daily: [{ start: "00:00", end: "23:59" }],
      },
    }],
  }, new Date("2026-06-01T04:00:00Z"));
  equal(rates.get("m-free"), "免费");
});

Deno.test("试用横幅：只认 targetModelId，坏条目逐个跳过", () => {
  equal(trialModelIds({}).length, 0);
  equal(trialModelIds({ productFeaturesConfig: "nope" }).length, 0);
  equal(
    trialModelIds({ productFeaturesConfig: { ModelTrialBanner: 5 } }).length,
    0,
  );
  equal(
    trialModelIds({
      productFeaturesConfig: { ModelTrialBanner: { banners: "x" } },
    })
      .length,
    0,
  );
  equal(
    trialModelIds({
      productFeaturesConfig: {
        ModelTrialBanner: {
          banners: [
            null,
            { targetModelId: "t-1" },
            { targetModelId: "" },
            { targetModelId: 5 },
            { targetModelId: "t-2" },
          ],
        },
      },
    }),
    ["t-1", "t-2"],
  );
});

Deno.test("过滤：自动选择别名只认 auto/default 两个字面量", () => {
  const models = parseModelsFromConfig(
    config({
      agents: [
        { name: "craft", models: ["auto", "default", "default-model"] },
      ],
      models: [],
    }),
  );
  const ids = models.map((m) => m.id);
  assert(!ids.includes("auto"), "auto is not a model");
  assert(!ids.includes("default"), "default is not a model");
  // 前缀匹配会把官方入口 default-model 一起误杀。
  assert(ids.includes("default-model"), "default-model is an official entry");
});

Deno.test("过滤：补全线、极小输出上限与出图模型都排除", () => {
  assert(!isChatModel("codewise-default-model-v2", undefined));
  assert(!isChatModel("nes-anything", undefined));
  assert(!isChatModel("completion-x", undefined));
  assert(
    !isChatModel("x", { maxOutputTokens: 128 }),
    "completion-sized output",
  );
  assert(!isChatModel("x", { tags: ["text-to-image"] }));
  assert(!isChatModel("x", { supportsExtra: true }));
  assert(isChatModel("glm-5.3", { maxOutputTokens: 131072 }));
  // meta 缺失（只由 agent 引用）不该把模型误杀。
  assert(isChatModel("only-in-agents", undefined));
});

Deno.test("促销：factor 0 在时间窗内是「免费」，无窗口则跳过", () => {
  const free = {
    enabled: true,
    discount: { discountedCredits: "0x", factor: 0 },
    schedule: {
      daily: [{ start: "00:00", end: "23:59" }],
      timezone: "Asia/Shanghai",
    },
    modelIds: ["hy4-preview"],
  };
  equal(
    parsePromotions({ modelPromotions: [free] }).get("hy4-preview"),
    "免费",
  );
  const placeholder = { ...free, schedule: undefined };
  assert(
    !parsePromotions({ modelPromotions: [placeholder] }).has("hy4-preview"),
    "a windowless factor-0 is an ended placeholder",
  );
});

Deno.test("促销：时段外不显示夜间折扣价", () => {
  // 全天显示夜间折扣 = 用户按折扣价预期、后台按原价计费。
  const night = {
    enabled: true,
    discount: { discountedCredits: "0.50x", factor: 0.5 },
    schedule: {
      daily: [{ start: "23:00", end: "07:50" }],
      timezone: "Asia/Shanghai",
    },
    modelIds: ["glm-5.2"],
  };
  const noon = new Date("2026-01-02T04:00:00Z"); // 北京时间 12:00
  assert(
    !parsePromotions({ modelPromotions: [night] }, noon).has("glm-5.2"),
    "12:00 local is outside the 23:00-07:50 window",
  );
  const midnight = new Date("2026-01-01T16:30:00Z"); // 北京时间 00:30
  equal(
    parsePromotions({ modelPromotions: [night] }, midnight).get("glm-5.2"),
    "x0.50",
    "00:30 local is inside the window",
  );
});

Deno.test("促销：已过期与已停用都跳过，同模型取 priority 最高", () => {
  const expired = {
    enabled: true,
    discount: { discountedCredits: "0.10x", factor: 0.1 },
    schedule: { validUntil: "2026-01-01T00:00:00Z" },
    modelIds: ["m"],
  };
  assert(!parsePromotions({ modelPromotions: [expired] }).has("m"));
  const off = {
    enabled: false,
    discount: { discountedCredits: "0.10x", factor: 0.1 },
    modelIds: ["m"],
  };
  assert(!parsePromotions({ modelPromotions: [off] }).has("m"));
  const low = {
    priority: 10,
    discount: { discountedCredits: "0.80x", factor: 0.8 },
    modelIds: ["m"],
  };
  const high = {
    priority: 90,
    discount: { discountedCredits: "0.20x", factor: 0.2 },
    modelIds: ["m"],
  };
  equal(
    parsePromotions({ modelPromotions: [low, high] }).get("m"),
    "x0.20",
    "higher priority wins",
  );
  equal(
    parsePromotions({ modelPromotions: [high, low] }).get("m"),
    "x0.20",
    "order in the array does not matter",
  );
});

Deno.test("促销：schedule 挂在促销项上，不在 discount 里", () => {
  // 层级写错会让时间窗判断永久落空，于是夜间折扣变成全天显示。
  const promo = {
    enabled: true,
    discount: { discountedCredits: "0.50x", factor: 0.5 },
    schedule: {
      daily: [{ start: "23:00", end: "07:50" }],
      timezone: "Asia/Shanghai",
    },
    modelIds: ["m"],
  };
  assert(
    !parsePromotions(
      { modelPromotions: [promo] },
      new Date("2026-01-02T04:00:00Z"),
    ).has("m"),
  );
});

Deno.test("目录：agent 引用的模型排最前，其余 data.models 补齐", () => {
  const models = parseModelsFromConfig(
    config({
      agents: [{ name: "craft", models: ["glm-5.3"] }],
      models: [
        { id: "kimi-k2.6", name: "Kimi K2.6", maxInputTokens: 256000 },
        { id: "glm-5.3", name: "GLM-5.3", maxOutputTokens: 131072 },
      ],
    }),
  );
  equal(models.map((m) => m.id), ["glm-5.3", "kimi-k2.6"]);
  equal(models[0].maxOutputTokens, 131072);
  equal(models[0].agentReferenced, true);
  equal(models[1].agentReferenced, undefined, "not agent-referenced");
});

Deno.test("目录：试用横幅模型要留下，且带 agentReferenced 之外的来源", () => {
  const models = parseModelsFromConfig(
    config({
      agents: [],
      models: [],
      productFeaturesConfig: {
        ModelTrialBanner: { banners: [{ targetModelId: "hy4-preview-f" }] },
      },
    }),
  );
  equal(models.map((m) => m.id), ["hy4-preview-f"]);
  equal(
    models[0].name,
    "Hy4 Preview F",
    "falls back to a readable id-derived name",
  );
});

Deno.test("目录：倍率与促销价按 id 关联到同一个模型", () => {
  const models = parseModelsFromConfig(
    config({
      agents: [{ name: "craft", models: ["glm-5.2"] }],
      models: [{ id: "glm-5.2", name: "GLM-5.2", credits: "x0.29" }],
      modelPromotions: [
        {
          enabled: true,
          priority: 5,
          discount: { discountedCredits: "0.50x", factor: 0.5 },
          modelIds: ["glm-5.2"],
        },
      ],
    }),
  );
  equal(models[0].creditsRate, "x0.29");
  equal(models[0].discountedCreditsRate, "x0.50");
});

Deno.test("目录：坏响应返回空数组而不是抛错", () => {
  equal(parseModelsFromConfig(null), []);
  equal(parseModelsFromConfig("nope"), []);
  equal(parseModelsFromConfig({ data: null }), []);
  equal(parseModelsFromConfig({ data: { models: "no" } }), []);
});

Deno.test("目录：models/agents 里的坏条目逐个跳过，不许炸掉整张表", () => {
  const models = parseModelsFromConfig(
    config({
      agents: [
        null,
        7,
        {},
        { name: "cli", models: ["glm-5.3", 5, null] },
        { name: "cli", models: "no" },
        { name: "cli" },
      ],
      models: [null, "x", {}, { id: 7 }, { id: "kimi-k2.6", name: "K" }],
    }),
  );
  equal(models.map((m) => m.id), ["glm-5.3", "kimi-k2.6"]);
  equal(models[0].agentReferenced, true, "只有带 models 的 agent 才算数");
});

Deno.test("目录：排位只认第一个同名 agent（后来的同名条目不再顶到前面）", () => {
  const models = parseModelsFromConfig(
    config({
      agents: [
        { name: "cli" },
        { name: "cli", models: ["glm-5.3"] },
      ],
      models: [
        { id: "kimi-k2.6", name: "Kimi" },
        { id: "glm-5.3", name: "GLM" },
      ],
    }),
  );
  equal(
    models.map((m) => m.id),
    ["kimi-k2.6", "glm-5.3"],
    "第一个同名 agent 没有 models 就没有可顶前的模型，glm 只能按 data.models 原序出现",
  );
  equal(
    models[1].agentReferenced,
    true,
    "agentReferenced 来自全部 agent 的引用集合，与排位用的第一个条目无关",
  );
});

Deno.test("目录：不可对话的模型不得混进选择器（每条判据各挡一类）", () => {
  const models = parseModelsFromConfig(
    config({
      agents: [{
        name: "cli",
        models: [
          "nes-a1",
          "completion-gf",
          "codewise-jump",
          "hunyuan-image-alpha",
          "auto",
          "default",
          "hy3",
        ],
      }],
      models: [
        { id: "codewise-jump", name: "CW", supportsExtra: true },
        { id: "hunyuan-image-alpha", name: "IMG", tags: ["text-to-image"] },
      ],
    }),
  );
  equal(models.map((m) => m.id), ["hy3"], "只剩真正能对话的那个");
});

Deno.test("目录：maxOutputTokens 落在补全区间的一律丢掉", () => {
  const models = parseModelsFromConfig(
    config({
      models: [
        { id: "small-1", name: "S1", maxOutputTokens: 1 },
        { id: "small-256", name: "S2", maxOutputTokens: 256 },
        { id: "big-257", name: "B", maxOutputTokens: 257 },
        { id: "huge", name: "H", maxOutputTokens: 131072 },
      ],
    }),
  );
  equal(models.map((m) => m.id), ["big-257", "huge"]);
});

Deno.test("目录：试用横幅里的别名与重复项只留一个", () => {
  const models = parseModelsFromConfig(
    config({
      agents: [{ name: "cli", models: ["hy3"] }],
      models: [{ id: "hy3", name: "HY3" }],
      productFeaturesConfig: {
        ModelTrialBanner: {
          banners: [
            { targetModelId: "hy3" },
            { targetModelId: "auto" },
            { targetModelId: "hy4-preview-f" },
            { targetModelId: "hy4-preview-f" },
          ],
        },
      },
    }),
  );
  equal(models.map((m) => m.id), ["hy3", "hy4-preview-f"]);
});

Deno.test("目录：缺 maxOutputTokens 时不猜", () => {
  const models = parseModelsFromConfig(
    config({ models: [{ id: "m", name: "M" }] }),
  );
  assert(
    models[0].maxOutputTokens === undefined,
    "guessing high gets a 400, guessing low truncates",
  );
});

Deno.test("请求体：必定带 stream 与 prompt_cache_key", () => {
  const body = buildChatBody(
    "glm-5.3",
    [{ role: "user", content: "hi" }],
    "sess-1",
    undefined,
    {},
  );
  equal(body.stream, true);
  equal(body.prompt_cache_key, "sess-1");
  assert(
    !("max_tokens" in body),
    "no known output cap means we send no cap at all",
  );
});

Deno.test("请求体：max_tokens 优先用调用方给的，其次远端的", () => {
  equal(
    buildChatBody("m", [], "s", { maxOutputTokens: 131072 }, { maxTokens: 512 })
      .max_tokens,
    512,
  );
  equal(
    buildChatBody("m", [], "s", { maxOutputTokens: 131072 }, {}).max_tokens,
    131072,
  );
});

Deno.test("请求体：调用方给的 effort 必须原样下发", () => {
  const plan = { efforts: ["low", "high"] };
  equal(
    buildChatBody("m", [], "s", plan, { reasoningEffort: "high" })
      .reasoning_effort,
    "high",
  );
  // "none" 是**唯一的关闭档**，它必然不在 supportedEfforts 里（那里只列开着
  // 的档）。曾用 efforts.includes() 过滤，于是「关思考」被静默丢掉：请求照发、
  // 思考照开 —— 而实测正是收到 "none" 才把推理从 ~1200 压到 ~0。
  equal(
    buildChatBody("m", [], "s", plan, { reasoningEffort: "none" })
      .reasoning_effort,
    "none",
    "the off switch is not in the ladder and must still be sent",
  );
  // 未声明的档位也照发：实测上游接受**任意字符串**（totally-bogus → 200），
  // 只有类型错（数字）才 400。所以那个校验防的不是 400，是静默丢弃。
  equal(
    buildChatBody("m", [], "s", plan, { reasoningEffort: "ultra" })
      .reasoning_effort,
    "ultra",
  );
});

Deno.test("请求体：调用方没选档时不替裸请求补默认档", () => {
  // 裸请求（不带 effort）是否思考**因模型而异**，所以不能无脑补一个默认档：
  // 实测 minimax-m2.7 裸请求思考 840 token，补上目录的 effort:"medium" 后变 0；
  // 反过来 hy3-c 裸请求本来就在思考（359 token），硬塞一个 high 只会改掉
  // 用户没要求过的行为。回退因此只对 deepseek 系成立 —— 它们的裸请求实测
  // 恒为 0，不补就等于思考功能整个失效。
  assert(
    !("reasoning_effort" in buildChatBody("hy3-c", [], "s", {
      efforts: ["low", "high"],
      defaultEffort: "high",
    }, {})),
    "a ladder must not become an implicit choice when the caller picked none",
  );
  assert(
    !("reasoning_effort" in
      buildChatBody("minimax-m3", [], "s", { efforts: [] }, {})),
    "a model with no ladder keeps the bare request bare",
  );
  assert(
    !("reasoning_effort" in buildChatBody("glm-5.1", [], "s", undefined, {})),
    "no plan at all means no effort field",
  );
  // 声明了默认档但没有阶梯的模型**同样不补**：声明本身不构成「该模型需要
  // effort 才思考」的证据，只有 deepseek 系的裸请求实测恒为 0。
  assert(
    !("reasoning_effort" in buildChatBody("minimax-m3", [], "s", {
      efforts: [],
      defaultEffort: "medium",
    }, {})),
    "a declared default effort is not on its own a reason to send one",
  );
});

Deno.test("请求体：deepseek 系必须同时带 thinking 与 reasoning_effort", () => {
  assert(isDeepSeekModel("DeepSeek-V4-Pro"), "prefix match, case-insensitive");
  const body = buildChatBody(
    "deepseek-v4-pro",
    [],
    "s",
    { efforts: ["low", "high"] },
    {},
  );
  equal(body.thinking, { type: "enabled" });
  equal(body.reasoning_effort, "high", "falls back to high");
  // 声明的默认档**优先于** "high"：它才是这个模型自己声明的起点。实测两端点
  // 的默认值 20 处不一致（glm-5.2 是 medium vs high），所以这条优先级要盯住。
  equal(
    buildChatBody("deepseek-v4-pro", [], "s", {
      efforts: ["low", "high"],
      defaultEffort: "low",
    }, {}).reasoning_effort,
    "low",
    "the declared default beats the high preference",
  );
  // 但声明的档**不在阶梯里**时不能照发 —— 那等于给上游一个它没公布过的档。
  equal(
    buildChatBody("deepseek-v4-pro", [], "s", {
      efforts: ["low", "high"],
      defaultEffort: "medium",
    }, {}).reasoning_effort,
    "high",
    "a default outside the ladder is not sent",
  );
  // 阶梯里没有 high 时退到第一个，而不是发一个编出来的 "high"。
  equal(
    buildChatBody("deepseek-v4-pro", [], "s", { efforts: ["xhigh", "max"] }, {})
      .reasoning_effort,
    "xhigh",
    "no high in the ladder means the first rung",
  );
  const other = buildChatBody(
    "glm-5.3",
    [],
    "s",
    { efforts: ["low", "high"] },
    {},
  );
  assert(
    !("thinking" in other),
    "only the deepseek family needs the switch",
  );
});

Deno.test("拦截：内容判定用三个独立信号", () => {
  assert(
    isContentRejection('{"code":11140,"msg":"request illegal"}'),
    "business code 11140",
  );
  assert(isContentRejection('{"msg":"request illegal"}'), "msg wording");
  assert(
    isContentRejection('{"displayMsg":{"zh":"内容未通过安全审核"}}'),
    "display message",
  );
  assert(
    isContentRejection("The content did not pass the safety review."),
    "english display message",
  );
  assert(!isContentRejection(""), "empty body is not a rejection");
  assert(
    !isContentRejection('{"code":12153}'),
    "a refresh failure is different",
  );
});

Deno.test("拦截：流内判定必须是窄的", () => {
  // 「安全审核」/「request illegal」可能出现在**模型自己写的正文**里。
  const prose = JSON.stringify({
    choices: [{ delta: { content: "request illegal 与 11140 是两个码" } }],
  });
  assert(
    !isContentRejectionFrame(prose),
    "a normal content frame must never be treated as a rejection",
  );
  assert(
    isContentRejectionFrame('{"code":11140,"msg":"request illegal"}'),
    "a top-level error frame with no choices is a rejection",
  );
  assert(
    !isContentRejectionFrame("data: [DONE]"),
    "the terminator frame is not an error",
  );
  assert(
    !isContentRejectionFrame("not json at all"),
    "unparsable frames are left alone",
  );
});

Deno.test("兜底展示名由 id 推出，不查静态表", () => {
  equal(displayNameForModel("glm-5.3"), "Glm 5.3");
  equal(displayNameForModel("hy4-preview-free"), "Hy4 Preview");
});

Deno.test("限流判定：状态码与业务码任一命中就算限流", () => {
  // 429 直接命中
  assert(isWorkBuddyThrottled(429, undefined));
  assert(isWorkBuddyThrottled(429, ""));
  // 报文里的 14003（探测与真实对话的限流形状不同，状态码可能不是 429）
  assert(isWorkBuddyThrottled(400, '{"code":14003,"msg":"too many requests"}'));
  // 带空格与缩进的变体也要命中
  assert(isWorkBuddyThrottled(200, '{"code" : 14003 }'));
  // 反例：别的业务码不是限流
  assert(
    !isWorkBuddyThrottled(400, '{"code":11102,"msg":"service info not found"}'),
  );
  assert(!isWorkBuddyThrottled(400, '{"code":11140}'));
  // 反例：限流字样出现在正文里不算 —— 上游模型可能正在讨论限流
  assert(
    !isWorkBuddyThrottled(
      500,
      "rate_limit exceeded while computing 1400 items",
    ),
  );
  assert(!isWorkBuddyThrottled(500, ""));
  assert(!isWorkBuddyThrottled(500, undefined));
});

Deno.test("Retry-After：秒数、HTTP 日期与解不出的三种形态", () => {
  equal(workBuddyRetryAfterMs("30"), 30_000);
  equal(workBuddyRetryAfterMs("0.5"), 500);
  assert(workBuddyRetryAfterMs(null) === 0);
  assert(workBuddyRetryAfterMs("") === 0);
  assert(workBuddyRetryAfterMs("soon") === 0);
  // 已过期的日期折算成 0，而不是负数
  const past = new Date(Date.now() - 60_000).toUTCString();
  assert(workBuddyRetryAfterMs(past) === 0);
  const future = new Date(Date.now() + 45_000).toUTCString();
  const got = workBuddyRetryAfterMs(future);
  assert(
    got > 40_000 && got <= 45_000,
    "a future date must fold to ms left: " + got,
  );
});

Deno.test("闸门：记一次限流后有窗口，清掉后归零", () => {
  resetWorkBuddyCircuit();
  equal(workBuddyCooldownRemaining(), 0);
  const window = tripWorkBuddyCircuit("too many requests");
  assert(window > 0, "tripping must open a window");
  assert(workBuddyCooldownRemaining() > 0);
  resetWorkBuddyCircuit();
  equal(workBuddyCooldownRemaining(), 0);
});

Deno.test("闸门：更长的窗口不会被更短的一次覆盖掉", () => {
  resetWorkBuddyCircuit();
  // 先记一个 20s 的（默认），再记一个 1s 的 —— 窗口必须仍是 20s 那个。
  const first = tripWorkBuddyCircuit("first", 20_000);
  const second = tripWorkBuddyCircuit("second", 1_000);
  assert(
    second >= first - 50,
    "the longer window must win: " + first + " -> " + second,
  );
  assert(workBuddyCooldownRemaining() >= 19_000);
  resetWorkBuddyCircuit();
});

Deno.test("闸门：上游要求的冷却不超过默认上限", () => {
  resetWorkBuddyCircuit();
  // 上游说等 2 小时也不照做：本渠道的 429 是抖动不是封禁，照做会让用户等两小时。
  tripWorkBuddyCircuit("sweeping ban", 2 * 60 * 60_000);
  const left = workBuddyCooldownRemaining();
  assert(left <= 20_000 + 50, "a 2h cooldown must be clamped: " + left);
  assert(left > 19_000);
  resetWorkBuddyCircuit();
});

Deno.test("闸门：过了窗口时间就自动放行", () => {
  resetWorkBuddyCircuit();
  tripWorkBuddyCircuit("window");
  // 用一个远未来的时间点求剩余 —— 必须为 0，否则窗口永远不会自己关。
  equal(workBuddyCooldownRemaining(Date.now() + 10 * 60_000), 0);
  resetWorkBuddyCircuit();
});

/** 假的上游响应：只带重试编排要用的那几个面。 */
function fakeUpstream(
  status: number,
  body: string,
  headers: Record<string, string> = {},
) {
  return {
    status,
    headers: {
      get: (name: string) =>
        headers[name.toLowerCase()] ?? headers[name] ?? null,
    },
    text: () => Promise.resolve(body),
  };
}

Deno.test("重试：第一次就成功时不退避也不读报文", async () => {
  let calls = 0;
  const slept: number[] = [];
  const out = await postWorkBuddyChatWithThrottleRetry(
    () => {
      calls++;
      return Promise.resolve(fakeUpstream(200, "ok"));
    },
    {
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    },
  );
  equal(calls, 1, "a success must not be resent");
  equal(out.attempts, 1);
  equal(out.backoffMs, 0);
  equal(out.throttledBody, "");
  equal(slept, []);
});

Deno.test("重试：429 会退避再来一次并交出第二次的响应", async () => {
  let calls = 0;
  const slept: number[] = [];
  const out = await postWorkBuddyChatWithThrottleRetry(
    () => {
      calls++;
      return Promise.resolve(
        calls === 1
          ? fakeUpstream(429, '{"code":14003}')
          : fakeUpstream(200, "recovered"),
      );
    },
    {
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    },
  );
  equal(calls, 2);
  equal(out.attempts, 2);
  equal(out.response.status, 200);
  assert(
    out.throttledBody.includes("14003"),
    "the 429 body must reach the log",
  );
  equal(slept.length, 1, "exactly one backoff");
});

Deno.test("重试：连续两次 429 也只重试一次（不无限重发）", async () => {
  let calls = 0;
  const out = await postWorkBuddyChatWithThrottleRetry(
    () => {
      calls++;
      return Promise.resolve(fakeUpstream(429, "still throttled"));
    },
    { sleep: () => Promise.resolve() },
  );
  equal(calls, 2, "a sustained throttle must not become a retry storm");
  equal(out.attempts, 2);
  equal(out.response.status, 429);
});

Deno.test("重试：非 429 的失败不重试", async () => {
  for (const status of [400, 401, 403, 500, 502]) {
    let calls = 0;
    const out = await postWorkBuddyChatWithThrottleRetry(
      () => {
        calls++;
        return Promise.resolve(fakeUpstream(status, "nope"));
      },
      { sleep: () => Promise.resolve() },
    );
    equal(calls, 1, "status " + status + " must not be resent");
    equal(out.attempts, 1);
  }
});

Deno.test("重试：退避时长上限是硬顶，上游要 30s 也只等 1.5s", async () => {
  let slept = -1;
  await postWorkBuddyChatWithThrottleRetry(
    () => Promise.resolve(fakeUpstream(429, "x", { "retry-after": "30" })),
    {
      sleep: (ms) => {
        slept = ms;
        return Promise.resolve();
      },
    },
  );
  equal(slept, 1_500);
  assert(
    slept < 30_000,
    "waiting the full upstream hint would strand the user",
  );
});

Deno.test("重试：上游给的短 Retry-After 被采纳", async () => {
  let slept = -1;
  await postWorkBuddyChatWithThrottleRetry(
    () => Promise.resolve(fakeUpstream(429, "x", { "retry-after": "1" })),
    {
      sleep: (ms) => {
        slept = ms;
        return Promise.resolve();
      },
    },
  );
  equal(slept, 1_000);
});

function fakeUpstream2(
  status: number,
  body = "",
  headers: Record<string, string> = {},
) {
  return {
    status,
    headers: {
      get: (name: string) =>
        headers[name.toLowerCase()] ?? headers[name] ?? null,
    },
    text: () => Promise.resolve(body),
  };
}

Deno.test("派发：没撞限流时只发一发上游（双发回归）", async () => {
  resetWorkBuddyCircuit();
  let calls = 0;
  const slept: number[] = [];
  const out = await sendWorkBuddyChat(
    () => {
      calls++;
      return Promise.resolve(fakeUpstream2(200, "ok"));
    },
    {
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    },
  );
  equal(calls, 1, "a healthy chat must cost exactly one upstream send");
  equal(out.attempts, 1);
  equal(out.response?.status, 200);
  equal(out.cooldownMs, undefined);
  equal(slept, []);
});

Deno.test("派发：被闸门挡住时一发都不发", async () => {
  resetWorkBuddyCircuit();
  tripWorkBuddyCircuit("test");
  let calls = 0;
  const out = await sendWorkBuddyChat(() => {
    calls++;
    return Promise.resolve(fakeUpstream2(200));
  });
  equal(calls, 0, "a tripped gate must not spend an upstream request");
  equal(out.attempts, 0);
  equal(out.response, undefined);
  assert((out.cooldownMs ?? 0) > 0, "the caller needs a Retry-After value");
  resetWorkBuddyCircuit();
});

Deno.test("派发：429 退避成功时不记窗口", async () => {
  resetWorkBuddyCircuit();
  let calls = 0;
  const out = await sendWorkBuddyChat(
    () => {
      calls++;
      return Promise.resolve(
        calls === 1
          ? fakeUpstream2(429, '{"code":14003}')
          : fakeUpstream2(200, "recovered"),
      );
    },
    { sleep: () => Promise.resolve() },
  );
  equal(calls, 2);
  equal(out.response?.status, 200);
  equal(
    out.cooldownMs,
    undefined,
    "a jitter the retry rode out must not close the gate",
  );
  equal(workBuddyCooldownRemaining(), 0);
});

Deno.test("派发：连续两次 429 记窗口并交出 Retry-After", async () => {
  resetWorkBuddyCircuit();
  let calls = 0;
  const out = await sendWorkBuddyChat(
    () => {
      calls++;
      return Promise.resolve(fakeUpstream2(429, "still throttled"));
    },
    { sleep: () => Promise.resolve() },
  );
  equal(calls, 2, "one retry, never a storm");
  assert(
    (out.cooldownMs ?? 0) > 0,
    "a sustained throttle must open the gate",
  );
  assert(
    (out.cooldownMs ?? 0) <= 20_000,
    "the window must stay clamped: " + out.cooldownMs,
  );
  resetWorkBuddyCircuit();
});

Deno.test("派发：401 不开闸门也不重发", async () => {
  resetWorkBuddyCircuit();
  let calls = 0;
  const out = await sendWorkBuddyChat(
    () => {
      calls++;
      return Promise.resolve(fakeUpstream2(401, "stale token"));
    },
    { sleep: () => Promise.resolve() },
  );
  equal(calls, 1, "a 401 is the refresh path, not the throttle path");
  equal(out.response?.status, 401);
  equal(out.cooldownMs, undefined);
  equal(workBuddyCooldownRemaining(), 0);
});
Deno.test("派发：retryOnce:false 时撞到 429 也不记窗口", async () => {
  resetWorkBuddyCircuit();
  let calls = 0;
  const out = await sendWorkBuddyChat(
    () => {
      calls++;
      return Promise.resolve(fakeUpstream2(429, '{"code":14003}'));
    },
    { retryOnce: false, sleep: () => Promise.resolve() },
  );
  equal(calls, 1);
  equal(out.attempts, 1);
  equal(out.response?.status, 429);
  equal(
    out.cooldownMs,
    undefined,
    "opting out of the retry must opt out of the gate too",
  );
  equal(workBuddyCooldownRemaining(), 0);
});

Deno.test("请求体：工具声明与 tool_choice 必须透传（否则 agent 循环停在第一轮）", () => {
  const tools = [{
    type: "function",
    function: {
      name: "get_weather",
      parameters: { type: "object", properties: { city: { type: "string" } } },
    },
  }];
  const body = buildChatBody("hy3-c", [], "s1", undefined, {
    tools,
    toolChoice: "auto",
  });
  assert(
    JSON.stringify(body.tools) === JSON.stringify(tools),
    "tools must reach the upstream verbatim, not be translated or dropped",
  );
  equal(body.tool_choice, "auto");
});

Deno.test("请求体：空工具数组不下发（等于没给工具，透传只是噪声）", () => {
  const body = buildChatBody("hy3-c", [], "s1", undefined, { tools: [] });
  assert(
    !("tools" in body),
    "an empty tools array is indistinguishable from none",
  );
  assert(!("tool_choice" in body), "no tool_choice without tools");
  const noTools = buildChatBody("hy3-c", [], "s1", undefined, {});
  assert(
    !("tools" in noTools),
    "a caller that sent nothing must stay identical",
  );
});

function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
}

const AGG_FRAME = (delta: unknown, finish: string, usage = "null") =>
  "data: " + JSON.stringify({
    id: "chatcmpl-x",
    model: "hy3",
    created: 7,
    choices: [{ index: 0, delta, finish_reason: finish }],
    usage: usage === "null" ? null : JSON.parse(usage),
  }) + "\n\n";

Deno.test("聚合：流式帧拼成一个 chat.completion（非流式调用方的唯一可用形状）", async () => {
  const out = await aggregateWorkBuddySse(sseStream([
    ": heartbeat\n",
    AGG_FRAME({ role: "assistant", content: "" }, ""),
    AGG_FRAME({ content: "Hel" }, ""),
    AGG_FRAME({ content: "lo" }, ""),
    AGG_FRAME({ reasoning_content: "think " }, ""),
    AGG_FRAME(
      {},
      "stop",
      JSON.stringify({ prompt_tokens: 23, total_tokens: 30 }),
    ),
    "data: [DONE]\n\n",
  ]));
  equal(out.id, "chatcmpl-x");
  equal(out.model, "hy3");
  equal(out.created, 7);
  equal(out.content, "Hello");
  equal(out.reasoning, "think ");
  equal(out.finishReason, "stop");
  equal(out.rejectionPayload, "");
  equal(out.toolCalls.length, 0);
  equal(out.usage?.total_tokens, 30);
});

Deno.test("聚合：工具调用的分片必须按 index 拼完整（id/name 只在首帧）", async () => {
  const out = await aggregateWorkBuddySse(sseStream([
    AGG_FRAME(
      {
        tool_calls: [{
          id: "call-1",
          type: "function",
          index: 0,
          function: { name: "get_weather", arguments: '{"city":' },
        }],
      },
      "",
    ),
    AGG_FRAME(
      { tool_calls: [{ index: 0, function: { arguments: ' "Paris"}' } }] },
      "",
    ),
    AGG_FRAME({}, "tool_calls"),
    "data: [DONE]\n\n",
  ]));
  equal(out.toolCalls.length, 1);
  equal(out.toolCalls[0].id, "call-1");
  equal(out.toolCalls[0].function.name, "get_weather");
  equal(
    out.toolCalls[0].function.arguments,
    '{"city": "Paris"}',
    "argument fragments must concatenate in arrival order",
  );
  equal(out.finishReason, "tool_calls");
});

Deno.test("聚合：上游报了 stop 但有工具调用时必须改判 tool_calls", async () => {
  const out = await aggregateWorkBuddySse(sseStream([
    AGG_FRAME(
      {
        tool_calls: [{
          id: "t",
          type: "function",
          index: 0,
          function: { name: "f", arguments: "{}" },
        }],
      },
      "",
    ),
    AGG_FRAME({}, "stop"),
    "data: [DONE]\n\n",
  ]));
  equal(
    out.finishReason,
    "tool_calls",
    'a client told "stop" will keep talking instead of running the tool',
  );
});

Deno.test("聚合：11140 拦截帧不能被当成内容累加（否则得到一段空的平静回答）", async () => {
  const out = await aggregateWorkBuddySse(sseStream([
    AGG_FRAME({ content: "let me check" }, ""),
    "data: " + JSON.stringify({ code: 11140, msg: "request illegal" }) + "\n\n",
    AGG_FRAME({ content: "...and that is fine" }, "stop"),
    "data: [DONE]\n\n",
  ]));
  assert(
    out.rejectionPayload !== "",
    "the caller must be told the turn was rejected, not handed silence",
  );
  equal(
    out.content,
    "let me check",
    "nothing after the rejection frame may be appended",
  );
});

Deno.test("聚合：正文里出现 11140 词句的正常帧不算拦截（判据必须窄）", async () => {
  const out = await aggregateWorkBuddySse(sseStream([
    AGG_FRAME(
      { content: "the safety review returned code 11140 for another request" },
      "stop",
    ),
    "data: [DONE]\n\n",
  ]));
  equal(out.rejectionPayload, "");
  assert(out.content.includes("11140"), "a content frame is content");
});

Deno.test("聚合：帧被切成半个 JSON 时必须等到完整才能判（不能切坏）", async () => {
  const full = AGG_FRAME({ content: "split" }, "");
  const cut = Math.floor(full.length / 2);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(full.slice(0, cut)));
      controller.enqueue(encoder.encode(full.slice(cut)));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  const out = await aggregateWorkBuddySse(stream);
  equal(out.content, "split");
});

Deno.test("聚合：畸形帧必须被跳过而不是把整条流打断", async () => {
  const junk = [
    "data:",
    "data:   ",
    "data: not json at all",
    'data: "just a string"',
    "data: [1,2,3]",
    'data: {"id":"x","choices":[]}',
    'data: {"choices":[null]}',
    'data: {"choices":[7]}',
    'data: {"choices":[{"delta":null}]}',
    'data: {"choices":[{"delta":7}]}',
    'data: {"choices":[{"delta":{"tool_calls":[null,7,"x"]}}]}',
  ];
  const out = await aggregateWorkBuddySse(sseStream([
    ...junk.map((line) => line + "\n\n"),
    AGG_FRAME({ content: "survived" }, "stop"),
    "data: [DONE]\n\n",
  ]));
  equal(out.content, "survived", "畸形帧全部被跳过");
  equal(out.finishReason, "stop");
  equal(out.toolCalls.length, 0, "坏 tool_call 不得造出半截调用");
  equal(out.truncated, false);
  equal(out.rejectionPayload, "");
});

Deno.test("聚合：id/model/created 只有真值才覆盖（不能用 0 顶掉首帧）", async () => {
  const out = await aggregateWorkBuddySse(sseStream([
    AGG_FRAME({ content: "a" }, ""),
    "data: " + JSON.stringify({
      id: 7,
      model: 9,
      created: "nope",
      usage: "nope",
      choices: [{ delta: { content: "b" } }],
    }) + "\n\n",
    "data: [DONE]\n\n",
  ]));
  equal(out.id, "chatcmpl-x", "非字符串 id 不覆盖");
  equal(out.model, "hy3", "非字符串 model 不覆盖");
  equal(out.created, 7, "非数字 created 不覆盖");
  equal(out.content, "ab", "内容照常累加");
  equal(out.usage, undefined, "usage 不是 record 就当没有");
});

Deno.test("聚合：usage 缺失时不得编一个出来", async () => {
  const out = await aggregateWorkBuddySse(sseStream([
    AGG_FRAME({ content: "x" }, "stop"),
    "data: [DONE]\n\n",
  ]));
  equal(
    out.usage,
    undefined,
    "inventing token counts would bill the caller for a guess",
  );
});
function toolNameFrame(name: string, args: string): string {
  return AGG_FRAME(
    {
      tool_calls: [{
        index: 0,
        function: { name, arguments: args },
      }],
    },
    "",
  );
}

Deno.test("聚合：空 name 的分片帧不得抹掉首帧给的工具名", async () => {
  const out = await aggregateWorkBuddySse(sseStream([
    toolNameFrame("get_weather", ""),
    toolNameFrame("", '{"city": "Paris"}'),
    AGG_FRAME({}, "tool_calls"),
    "data: [DONE]\n\n",
  ]));
  equal(
    out.toolCalls[0].function.name,
    "get_weather",
    "an empty-name fragment must not wipe the name from the first frame",
  );
});

Deno.test("聚合：工具名在多个分片帧重发时只能留一个", async () => {
  const out = await aggregateWorkBuddySse(sseStream([
    toolNameFrame("get_weather", '{"city":'),
    toolNameFrame("get_weather", ' "Paris"}'),
    AGG_FRAME({}, "tool_calls"),
    "data: [DONE]\n\n",
  ]));
  equal(
    out.toolCalls[0].function.name,
    "get_weather",
    "a repeated tool name must not concatenate into get_weatherget_weather",
  );
  equal(
    out.toolCalls[0].function.arguments,
    '{"city": "Paris"}',
    "arguments still concatenate while the name does not",
  );
});

Deno.test("聚合：完整的流不算截断（有 [DONE] 终止帧）", async () => {
  const out = await aggregateWorkBuddySse(sseStream([
    AGG_FRAME({ content: "答完了" }, "stop"),
    "data: [DONE]\n\n",
  ]));
  equal(out.truncated, false, "带 [DONE] 不算截断");
  equal(out.content, "答完了");
});

Deno.test("聚合：上游半路断掉必须报截断（不能与正常结束同形）", async () => {
  const out = await aggregateWorkBuddySse(sseStream([
    AGG_FRAME({ content: "半句话" }, ""),
    AGG_FRAME({ content: "没了" }, "stop"),
  ]));
  // 这正是原来的缺陷：截断与正常结束产出逐字节相同的响应，调用方无从分辨。
  equal(out.truncated, true, "缺 [DONE] 就是截断");
  equal(out.content, "半句话没了", "已收到的内容仍然如实保留");
  equal(out.finishReason, "stop", "上游自己说了 stop 也不算终止证据");
});

Deno.test("聚合：什么都吐出来就干净结束也不算截断（有终止帧）", async () => {
  const out = await aggregateWorkBuddySse(sseStream(["data: [DONE]\n\n"]));
  equal(out.truncated, false, "[DONE] 到过就不算截断");
  equal(out.content, "");
});

Deno.test("聚合：正文里提到 [DONE] 不算终止帧（判据是整帧而不是 includes）", async () => {
  const out = await aggregateWorkBuddySse(sseStream([
    AGG_FRAME({ content: '数组里有 "[DONE]" 这个字样' }, "stop"),
  ]));
  equal(out.truncated, true, "正文提到 [DONE] 不能顶替终止帧");
});

Deno.test("聚合：内容拦截是业务收尾，不是传输截断", async () => {
  const out = await aggregateWorkBuddySse(sseStream([
    AGG_FRAME({ content: "半句" }, ""),
    'data: {"code":11140,"msg":"blocked"}\n\n',
  ]));
  equal(out.truncated, false, "拦截帧有独立的失败通道，不能被算成截断");
  equal(out.rejectionPayload !== "", true, "拦截报文仍然如实带回");
});

Deno.test("聚合：零内容零工具的截断也要被认出来（不能安静地交一份空回答）", async () => {
  const out = await aggregateWorkBuddySse(sseStream([
    AGG_FRAME({ role: "assistant", content: "" }, ""),
  ]));
  equal(out.truncated, true, "空的截断同样是截断");
  equal(out.content, "");
});

Deno.test("截断映射：完整的流不产生错误（不能把正常回答变成 502）", async () => {
  const ok = await aggregateWorkBuddySse(sseStream([
    AGG_FRAME({ content: "答完了" }, "stop"),
    "data: [DONE]\n\n",
  ]));
  equal(workBuddyTruncationError(ok), undefined, "完整流不该被拦下");
});

Deno.test("截断映射：半截回答要报 stream_cut（502，不能当完整回答交出去）", async () => {
  const cut = await aggregateWorkBuddySse(sseStream([
    AGG_FRAME({ content: "说到一半" }, ""),
  ]));
  const err = workBuddyTruncationError(cut);
  equal(err?.status, 502);
  equal(err?.body.error.type, "stream_cut");
  equal(err?.body.error.code, "stream_cut");
});

Deno.test("截断映射：零内容零工具要报 empty_response（空回答不是正常结束）", async () => {
  const cut = await aggregateWorkBuddySse(sseStream([
    AGG_FRAME({ role: "assistant", content: "" }, ""),
  ]));
  const err = workBuddyTruncationError(cut);
  equal(err?.body.error.type, "empty_response", "没交付任何东西要说出来");
  equal(err?.status, 502);
});

Deno.test("截断映射：只有工具调用也算交付过东西（不能报 empty_response）", async () => {
  const cut = await aggregateWorkBuddySse(sseStream([
    toolNameFrame("get_weather", ' {"city":"Paris"}'),
  ]));
  equal(cut.content, "", "确实一个字都没说");
  equal(cut.toolCalls.length, 1, "但工具调用发出来了");
  const err = workBuddyTruncationError(cut);
  equal(err?.body.error.type, "stream_cut", "有工具调用就不是空交付");
});
Deno.test("重试：retryOnce:false 时一次都不重试", async () => {
  let calls = 0;
  let slept = 0;
  const out = await postWorkBuddyChatWithThrottleRetry(
    () => {
      calls++;
      return Promise.resolve(fakeUpstream(429, "x"));
    },
    {
      retryOnce: false,
      sleep: () => {
        slept++;
        return Promise.resolve();
      },
    },
  );
  equal(calls, 1);
  equal(out.attempts, 1);
  equal(slept, 0);
});

/**
 * 造一个「上游还在生成」的流：先给一帧，然后**永不结束**。
 *
 * 上游 request 被取消时 cancel() 会翻转 cancelled 标志 —— 这就是判据：取消有没有
 * 一路传回上游 socket。没有它，一次关标签页就会让这一发在上游跑满 600 秒。
 */
function generatingStream(
  firstFrame: string,
  hooks: { cancelled?: () => void; pulls?: () => number },
) {
  const encoder = new TextEncoder();
  let pulls = 0;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(firstFrame));
    },
    pull() {
      pulls += 1;
      hooks.pulls?.();
      if (pulls === 1) return;
      return new Promise<void>(() => {});
    },
    cancel() {
      hooks.cancelled?.();
    },
  });
}

const GUARD_FRAME = "data: " + JSON.stringify({
  id: "chatcmpl-g",
  model: "hy3",
  created: 3,
  choices: [{ index: 0, delta: { content: "partial" }, finish_reason: "" }],
}) + "\n\n";

Deno.test("流：客户端取消必须传回上游（否则这一发继续生成到结束）", async () => {
  let cancelled = false;
  const guarded = guardWorkBuddyStream(
    generatingStream(GUARD_FRAME, {
      cancelled: () => {
        cancelled = true;
      },
    }),
    () => {},
  );
  const reader = guarded.getReader();
  equal((await reader.read()).value !== undefined, true, "先拿到一帧");
  await reader.cancel("client went away");
  await new Promise((resolve) => setTimeout(resolve, 30));
  equal(cancelled, true, "上游必须收到取消");
});

Deno.test("流：客户端取消后不得再补帧（controller 已 canceled，enqueue 会抛）", async () => {
  const rejections: unknown[] = [];
  const onRejection = (event: PromiseRejectionEvent) => {
    rejections.push(event.reason);
    event.preventDefault();
  };
  globalThis.addEventListener("unhandledrejection", onRejection);
  try {
    const guarded = guardWorkBuddyStream(
      generatingStream(GUARD_FRAME, {}),
      () => {},
    );
    const reader = guarded.getReader();
    await reader.read();
    await reader.cancel();
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  } finally {
    globalThis.removeEventListener("unhandledrejection", onRejection);
  }
  equal(
    rejections.map((reason) => String(reason)),
    [],
    "a cancelled client must not surface as an unhandled rejection",
  );
});

Deno.test("流：内容拦截后补 error 帧与 [DONE] 再收尾", async () => {
  const rejections: unknown[] = [];
  const onRejection = (event: PromiseRejectionEvent) => {
    rejections.push(event.reason);
    event.preventDefault();
  };
  globalThis.addEventListener("unhandledrejection", onRejection);
  try {
    const encoder = new TextEncoder();
    const rejectionFrame = "data: " + JSON.stringify({
      code: 11140,
      msg: "request illegal",
    }) + "\n\n";
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const guarded = guardWorkBuddyStream(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(rejectionFrame));
        },
        pull() {
          return held;
        },
      }),
      () => {},
    );
    const reader = guarded.getReader();
    const first = await reader.read();
    // 拦截帧让 wrapper 收尾并补 error 帧 + [DONE]，两个 chunk 是一次 read 之前的 enqueue
    equal(first.done, false, "补帧成功");
    const chunks: string[] = [
      new TextDecoder().decode(first.value ?? new Uint8Array()),
    ];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(new TextDecoder().decode(next.value ?? new Uint8Array()));
    }
    release?.();
    const text = chunks.join("");
    equal(text.includes("content_rejection"), true, "补了 error 帧");
    equal(text.includes("[DONE]"), true, "补了 [DONE]");
  } finally {
    globalThis.removeEventListener("unhandledrejection", onRejection);
  }
  equal(
    rejections.map((reason) => String(reason)),
    [],
    "拦截收尾不得变成未处理拒绝",
  );
});

Deno.test("流：拦截时 onRejection 必须带着原帧载荷被调用", async () => {
  const seen: string[] = [];
  let cancelled = false;
  const encoder = new TextEncoder();
  const rejectionFrame = "data: " + JSON.stringify({
    code: 11140,
    msg: "request illegal",
    displayMsg: "内容涉及敏感信息",
  }) + "\n\n";
  const held = new Promise<void>(() => {});
  const guarded = guardWorkBuddyStream(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(rejectionFrame));
      },
      pull() {
        return held;
      },
      cancel() {
        cancelled = true;
      },
    }),
    (rejection) => {
      seen.push(rejection.payload);
    },
  );
  for await (const _ of guarded) {
    // 读完即可（拦到拦截帧后 wrapper 会自行收尾）。
  }
  equal(seen.length, 1, "回调只触发一次");
  assert(seen[0].includes("11140"), "原帧载荷必须交给调用方");
  equal(cancelled, true, "拦截后上游被取消");
});

Deno.test("流：扫描只判 data 行（注释帧与半行不得被误当成拦截）", async () => {
  let cancelled = false;
  const encoder = new TextEncoder();
  const seen: string[] = [];
  // 前导注释行里写着 11140 —— 若不先挡 startsWith("data:")，它会被当拦截。
  const stream = guardWorkBuddyStream(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(": note 11140 request illegal\n\n" + GUARD_FRAME),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    }),
    (rejection) => {
      seen.push(rejection.payload);
    },
  );
  for await (const chunk of stream) {
    // 收集即可。
  }
  equal(seen.length, 0, "注释行不是拦截帧");
  equal(cancelled, false, "正常结束的流不该被取消");
  // ⚠️ 下面这行注释不是客套：上面那条 `: note 11140 request illegal` 的前缀是
  // 「: note」**6 个字符**，即便把 startsWith("data:") 守卫删掉，第 6 个字符往后
  // 也切不出合法 JSON，变异体照样绿。真正能杀掉那个变异体的形状是**前缀恰好
  // 5 个字符**（切片点正好落在 JSON 的开括号上），所以单开一条用例。
});

Deno.test("流：注释行前缀恰好 5 个字符时也不许被当成拦截（守卫的真正形状）", async () => {
  // 这条单独立，是因为它守的是 `startsWith("data:")` 这道守卫本身。
  // 变异体 G2 把守卫换成 `if (line.length > 0)`：于是每条行都拿第 6 个字符往后
  // 当 JSON 试。绝大多数行切不出合法 JSON（4 个、6 个字符的前缀都试过），
  // 所以老用例里那种 `: note ...` 形状压根杀不掉它 —— 变异体会存活。
  // 唯一能暴露的形状是**前缀恰好 5 个字符**：切片点正好落在 `{` 上。
  // 实测：G2 存活时本用例看到 onRejection 调用 1 次 + 尾帧被改写成
  // content_rejection 错误；真代码下是 0 次 + [DONE] 原样透传。
  const encoder = new TextEncoder();
  const evil = ": abc" + JSON.stringify({
    code: 11140,
    msg: "request illegal",
  }) + "\n";
  const body = ": heartbeat\n" + GUARD_FRAME + "\n" + evil + "data: [DONE]\n\n";
  const seen: string[] = [];
  const stream = guardWorkBuddyStream(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    }),
    (rejection) => {
      seen.push(rejection.payload);
    },
  );
  let out = "";
  for await (const chunk of stream) {
    out += new TextDecoder().decode(chunk);
  }
  equal(seen.length, 0, "五字符前缀的注释行也不是拦截帧");
  equal(out.includes("request illegal"), true, "注释行内容原样透传");
  equal(out.indexOf("content_rejection"), -1, "不许把注释行改写成错误帧");
});
Deno.test("流：同一个 chunk 里的多帧必须逐行判（真 socket 不一行一包）", async () => {
  // ⚠️ 这条用例守的是**真实 chunk 形状**：上游把「心跳注释 + 若干帧 + [DONE]」放在
  // 一个 TCP chunk 里送达是常态。老夹具一行一个 chunk，于是扫描循环写成
  // lastIndexOf（只取最后一行、拿整个前缀去判 startsWith）也是绿的 ——
  // 实测那种实现下 onRejection 调用 0 次、原始 11140 原样透传给客户端。
  const encoder = new TextEncoder();
  const rejection = "data: " + JSON.stringify({
    id: "chatcmpl-x",
    model: "hy3",
    created: 1,
    code: 11140,
    msg: "request illegal",
  }) + "\n\n";
  const shapes: Record<string, string[]> = {
    // 拦截帧与 [DONE] 同包。
    "rejection-then-done": [
      ": heartbeat\n" + rejection + "\ndata: [DONE]\n\n",
    ],
    // 拦截帧在包尾，后面什么都没有。
    "content-then-rejection": [
      ": heartbeat\n" + GUARD_FRAME + rejection,
    ],
    // 拦帧被 TCP 切成两半，第二片以残缺 JSON 开头。
    "rejection-split-mid-json": [
      ": heartbeat\n" + GUARD_FRAME + rejection.slice(0, 25),
      rejection.slice(25) + "\ndata: [DONE]\n\n",
    ],
    // 多帧之后才出现拦截帧。
    "many-frames-then-rejection": [
      ": heartbeat\n" + GUARD_FRAME + GUARD_FRAME + GUARD_FRAME + rejection,
    ],
  };
  for (const [name, chunks] of Object.entries(shapes)) {
    const seen: string[] = [];
    const stream = guardWorkBuddyStream(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      }),
      (r) => {
        seen.push(r.payload);
      },
    );
    const decoder = new TextDecoder();
    let out = "";
    for await (const chunk of stream) {
      out += decoder.decode(chunk, { stream: true });
    }
    equal(seen.length, 1, name + ": 拦帧必须被认出来一次");
    assert(
      seen[0].indexOf("11140") >= 0,
      name + ": 回调必须带着原始载荷",
    );
    // 判据不能是「输出里有没有 11140」—— 改写后的 error 帧里也有这个码。真正的
    // 区别在于**顶层还是嵌在 error 里**：上游发的是顶层 {code,msg}，客户端插件
    // index.js 只认 payload.error，于是顶层裸帧会被当成一条无内容的普通帧，
    // 接着读到 [DONE] 就报「成功但什么都没收到」。
    assert(
      out.indexOf('"msg":"request illegal"') < 0,
      name + ": 顶层 {" + '"msg":"request illegal"' + "} 裸帧不得透传给客户端",
    );
    assert(
      out.indexOf('"type":"content_rejection"') >= 0,
      name + ": 必须补一个 OpenAI 形状的 error 帧",
    );
    assert(out.indexOf("[DONE]") >= 0, name + ": 必须用 [DONE] 收尾");
  }
});

Deno.test("流：一整包多帧但没有拦截时不能误报（正常路径不许被改写）", async () => {
  // 反向用例：修「漏判」不能变成「乱判」。一整包里三帧正常内容 + [DONE]，
  // 客户端必须收到**原始字节**（含心跳注释行），回调 0 次。
  const encoder = new TextEncoder();
  let seen = 0;
  const payload = ": heartbeat\n" + GUARD_FRAME + GUARD_FRAME + GUARD_FRAME +
    "data: [DONE]\n\n";
  const stream = guardWorkBuddyStream(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(payload));
        controller.close();
      },
    }),
    () => {
      seen += 1;
    },
  );
  const decoder = new TextDecoder();
  let out = "";
  for await (const chunk of stream) {
    out += decoder.decode(chunk, { stream: true });
  }
  equal(seen, 0, "正常的一整包不许被判成拦截");
  equal(out, payload, "正常路径必须逐字节原样透传");
});

Deno.test("流：正常流到结束时不取消上游（判据不能只看 clientGone）", async () => {
  let cancelled = false;
  // ⚠️ 判据必须在**会正常结束的那条流**上取。上一版拿一个没有 cancel 钩子的
  // 流去跑收尾、把 cancelled 断在另一条流上，于是无论实现怎么改都绿 ——
  // 断言看起来在测「不该取消」，实际什么都没测到。
  //
  // 这条断言仍然杀不掉「无条件 cancel」变异体，但**不是因为漏测**：探针证实
  // 流一旦 done，reader.cancel() 就不再落到源的 cancel 钩子上（关闭态与出错态
  // 都一样），所以那个变异体在本平台不可观测 —— 见 AGENTS.md「变异体存活先
  // 问平台是不是已经吞了它」。
  const encoder = new TextEncoder();
  const closing = guardWorkBuddyStream(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(GUARD_FRAME));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    }),
    () => {},
  );
  const reader = closing.getReader();
  const seen: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    seen.push(new TextDecoder().decode(value ?? new Uint8Array()));
  }
  equal(seen.join("").includes("[DONE]"), true, "原样转发 [DONE]");
  equal(cancelled, false, "自然结束的流没有被取消");
});

Deno.test("信号：客户端一中止，合成的信号立刻 aborted（上游随之收手）", () => {
  const client = new AbortController();
  const signal = workBuddyChatSignal(client.signal);
  if (signal.aborted) throw new Error("还没中止就已经 aborted");
  client.abort();
  if (!signal.aborted) {
    throw new Error("客户端已 abort，合成信号却没跟上");
  }
});

Deno.test("信号：没有客户端信号时，只由超时控制（不能一开始就 aborted）", () => {
  const signal = workBuddyChatSignal();
  if (signal.aborted) {
    throw new Error("刚建好就 aborted：超时被当成了立即中止");
  }
});

Deno.test("信号：超时到期也会中止合成信号（不能只认客户端那一侧）", async () => {
  const client = new AbortController();
  const signal = workBuddyChatSignal(client.signal, 20);
  let abortedByTimeout = false;
  signal.addEventListener("abort", () => {
    abortedByTimeout = client.signal.aborted;
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
  if (!signal.aborted) throw new Error("超时没有中止合成信号");
  if (abortedByTimeout) {
    throw new Error("超时中止被误记成客户端中止");
  }
});

Deno.test("流：上游中途断掉必须让客户端读到 error（不能安静截断）", async () => {
  const encoder = new TextEncoder();
  const guarded = guardWorkBuddyStream(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(GUARD_FRAME));
      },
      pull() {
        return Promise.reject(new Error("upstream socket died"));
      },
    }),
    () => {},
  );
  const reader = guarded.getReader();
  equal((await reader.read()).value !== undefined, true, "先拿到一帧");
  let failed = false;
  let message = "";
  try {
    await reader.read();
  } catch (error) {
    failed = true;
    message = String(error);
  }
  equal(failed, true, "上游断了就得报错，不能假装正常结束");
  equal(message.includes("upstream socket died"), true, "把原因带出去");
});

/**
 * 造一个「正常帧 → 11140 拦截帧 → 永远挂着」的流。
 *
 * 拦到 11140 之后代理已经知道这一发没人要了，上游必须被 cancel；否则它会照
 * 常生成到结束而 credit 照算（探针里 cancel 钩子一次都没被触发就是证据）。
 */
function rejectionStream(hooks: { cancelled: () => void }) {
  const encoder = new TextEncoder();
  let pulls = 0;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(
        "data: " + JSON.stringify({
          choices: [{ delta: { content: "第一段" } }],
        }) + "\n\n",
      ));
    },
    pull(controller) {
      pulls += 1;
      if (pulls === 1) {
        controller.enqueue(encoder.encode(
          "data: " + JSON.stringify({ code: 11140, msg: "request illegal" }) +
            "\n\n",
        ));
        return;
      }
      return new Promise<void>(() => {});
    },
    cancel() {
      hooks.cancelled();
    },
  });
}

Deno.test("请求体：stop 与 temperature 原样下发（判据不能只看有没有该字段）", () => {
  const body = buildChatBody("hy3-c", [], "s1", undefined, {
    stop: ["STOP", "END"],
    temperature: 0.7,
  });
  equal(body.stop, ["STOP", "END"], "stop 列表必须原样透传");
  equal(body.temperature, 0.7, "temperature 0 也要能下发（不是假值判断）");
  const bare = buildChatBody("hy3-c", [], "s1", undefined, {});
  assert(!("stop" in bare), "没给 stop 就不该出现该字段");
  assert(!("temperature" in bare), "没给 temperature 就不该出现该字段");
  const emptyStop = buildChatBody("hy3-c", [], "s1", undefined, { stop: [] });
  assert(!("stop" in emptyStop), "空 stop 列表等于没给");
  const zero = buildChatBody("hy3-c", [], "s1", undefined, { temperature: 0 });
  equal(zero.temperature, 0, "0 是合法值，不能被 if (x) 吃掉");
});

Deno.test("目录卡：能力字段缺失就不下发，efforts 为空时整个 reasoning 省略", () => {
  const thin = toWorkBuddyModelCard({
    id: "m-1",
    name: "M1",
    reasoningEfforts: [],
  });
  assert(!("context_window" in thin), "远端没给窗口就别编一个");
  assert(!("max_output_tokens" in thin), "远端没给上限就别编一个");
  assert(!("reasoning" in thin), "空阶梯要整体省略，空数组会被 harness 拒掉");
  equal(thin.input_modalities, ["text"]);
  assert(!("creditsRate" in thin), "没有倍率信息就不下发");
  const full = toWorkBuddyModelCard({
    id: "m-2",
    name: "M2",
    contextWindow: 128_000,
    maxOutputTokens: 8192,
    supportsImages: true,
    reasoningEfforts: ["low", "high"],
    defaultReasoningEffort: "high",
    creditsRate: "x1",
    discountedCreditsRate: "x0.5",
  });
  equal(full.context_window, 128_000);
  equal(full.max_output_tokens, 8192);
  equal(full.input_modalities, ["text", "image"]);
  equal(full.reasoning?.defaultEffort, "high");
  equal(full.creditsRate, "x1→x0.5");
});

Deno.test("目录卡：声明的默认档不在阶梯里时必须回落（不能下发一个无效档位）", () => {
  const card = toWorkBuddyModelCard({
    id: "m-3",
    name: "M3",
    reasoningEfforts: ["low", "medium"],
    defaultReasoningEffort: "ultra",
  });
  equal(card.reasoning?.defaultEffort, "low", "阶梯里没有 high 就取第一个");
});

Deno.test("匿名头：四个 X-No-* 一个都不能少（缺一个就去找不存在的登录态）", () => {
  const headers = workBuddyAnonymousHeaders();
  equal(headers[HTTP_HEADER_NO_AUTHORIZATION], "true");
  equal(headers[HTTP_HEADER_NO_USER_ID], "true");
  equal(headers[HTTP_HEADER_NO_ENTERPRISE_ID], "true");
  equal(headers[HTTP_HEADER_NO_DEPARTMENT_INFO], "true");
  equal(headers[HTTP_HEADER_DOMAIN], "www.workbuddy.cn");
  assert(
    headers["User-Agent"]?.startsWith("WorkBuddy/"),
    "匿名登录也要带真实 UA",
  );
  assert(!("Authorization" in headers), "匿名请求不得带任何 Authorization");
});

/** 造一个只有 payload 段的 JWT（atob 路径，不需要签名）。 */
function jwt(payload: Record<string, unknown>): string {
  const raw = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";
  for (const byte of raw) binary += String.fromCharCode(byte);
  return "header." + btoa(binary) + ".signature";
}

Deno.test("JWT：坏令牌不许抛（这是登录兜底路径，最不该在运行期炸）", () => {
  equal(jwtClaimMs("garbage", "exp"), undefined, "单段不是 JWT");
  equal(jwtClaimMs("", "exp"), undefined, "空串不是 JWT");
  equal(jwtClaimMs(12345, "exp"), undefined, "非字符串令牌");
  equal(jwtClaimMs("a.!!!not-base64!!!.c", "exp"), undefined, "base64 坏了");
  equal(
    jwtClaimMs("a." + btoa("not-json") + ".c", "exp"),
    undefined,
    "payload 不是 JSON",
  );
  equal(jwtNickname("garbage"), "");
  equal(jwtSubject("garbage"), "");
  equal(jwtNickname(jwt({ nickname: "" })), "", "空昵称要继续往下找");
  equal(jwtNickname(jwt({ preferred_username: "pu" })), "pu");
  equal(jwtNickname(jwt({ name: "nm" })), "nm");
  equal(jwtNickname(jwt({ nickname: 7 })), "", "非字符串不算");
  equal(jwtSubject(jwt({ sub: 7 })), "", "非字符串 sub 不算");
  equal(jwtSubject(jwt({ sub: "u-9" })), "u-9");
});

Deno.test("JWT：exp/iat 是秒，要换算成毫秒（漏乘 1000 会把寿命差 1000 倍）", () => {
  const token = jwt({ exp: 1795696324, iat: 1790944324, sub: "u-1" });
  equal(jwtClaimMs(token, "exp"), 1795696324000);
  equal(jwtClaimMs(token, "iat"), 1790944324000);
  equal(
    jwtClaimMs(jwt({ exp: "1795696324" }), "exp"),
    undefined,
    "字符串 exp 不认",
  );
});

Deno.test("兜底：expires_at 不可解析时退回 JWT exp（那是权威值）", () => {
  const cred = credential({
    expires_at: "not-a-date",
    access_token: jwt({ exp: 1795696324 }),
  });
  equal(credentialExpiresAtMs(cred), 1795696324000);
  const none = credential({ expires_at: "", access_token: "garbage" });
  equal(credentialExpiresAtMs(none), undefined, "两条路都断了就只能不知道");
});

Deno.test("读数：数值型字符串要认，指数写法要当缺失（否则会算错输出上限）", () => {
  equal(readNumberField({ v: "24000" }, "v"), 24000);
  equal(readNumberField({ v: " 7 " }, "v"), 7);
  equal(
    readNumberField({ v: "1e3" }, "v"),
    undefined,
    "指数写法不认，否则会算错上限",
  );
  equal(readNumberField({ v: "-3" }, "v"), -3);
  equal(readNumberField({ v: "abc" }, "v"), undefined);
  equal(readNumberField({}, "v"), undefined);
  equal(readStringField({ v: 0 }, "v"), "0", "数字 0 不是缺失");
  equal(readStringField({ v: null }, "v"), "");
  equal(
    stripControlChars("a\u0000b  c"),
    "a b c",
    "控制字符与连续空白都要清掉",
  );
});

Deno.test("登录：token 响应的相对秒数要按 iat 换算成绝对时刻", () => {
  const token = parseTokenData({
    accessToken: jwt({ iat: 1790944324 }),
    expiresIn: 7200,
    refreshExpiresIn: 1209600,
  });
  equal(token.expiresAt, String(1790944324000 + 7200 * 1000));
  equal(token.refreshExpiresAt, String(1790944324000 + 1209600 * 1000));
  equal(token.tokenType, "Bearer", "缺 tokenType 要有默认值");
  // expiresAt 给了绝对值时优先用它，不再换算。
  const absolute = parseTokenData({
    accessToken: "at",
    expiresAt: "1795649744000",
    expiresIn: 7200,
  });
  equal(absolute.expiresAt, "1795649744000");
  // 秒级绝对值要乘 1000。
  equal(
    parseTokenData({ accessToken: "at", expiresAt: "1795649744" }).expiresAt,
    "1795649744000",
  );
  // 不可解析就原样保留，别把线索抹成空串。
  equal(
    parseTokenData({ accessToken: "at", expiresAt: "soon" }).expiresAt,
    "soon",
  );
  // 两边都没有 ⇒ 空串（面板显示「有效期未知」）。
  equal(parseTokenData({ accessToken: "at" }).expiresAt, "");
  equal(parseTokenData(null).accessToken, "");
});

Deno.test("登录：账号字段缺失时逐项回落（不能把整份账号当成空）", () => {
  const full = parseAccountData({
    uid: "u-1",
    nickname: "n-1",
    enterpriseId: "e-1",
    type: "enterprise",
  });
  equal(full.uid, "u-1");
  equal(full.accountType, "enterprise");
  const thin = parseAccountData({ uid: 7 });
  equal(thin.uid, "7", "数字 uid 要转成字符串");
  equal(thin.nickname, "");
  equal(thin.accountType, "personal", "缺 type 默认个人账号");
  const built = buildCredential(
    parseTokenData({
      accessToken: jwt({ sub: "jwt-uid", nickname: "jwt-nick" }),
    }),
    parseAccountData({}),
  );
  equal(built.user_id, "jwt-uid", "账号为空时用 JWT 的 sub 兜底");
  equal(built.nickname, "jwt-nick");
});

Deno.test("流：内容拦截必须取消上游（否则这一发继续生成到结束、credit 照算）", async () => {
  let cancelled = false;
  const guarded = guardWorkBuddyStream(
    rejectionStream({
      cancelled: () => {
        cancelled = true;
      },
    }),
    () => {},
  );
  const text = await new Response(guarded).text();
  equal(text.includes("content_rejection"), true, "拦截仍然要补 error 帧");
  equal(cancelled, true, "停止读取不等于取消上游");
});

Deno.test("聚合：内容拦截必须取消上游（同一个漏，聚合侧也得补）", async () => {
  let cancelled = false;
  const out = await aggregateWorkBuddySse(rejectionStream({
    cancelled: () => {
      cancelled = true;
    },
  }));
  equal(out.rejectionPayload !== "", true, "拦截报文如实带回");
  equal(out.truncated, false, "拦截有独立通道，不是传输截断");
  equal(cancelled, true, "没人要的输出还在上游继续生成");
});

Deno.test("正常结束的流不得被取消（cancel 只属于拦截与客户端取消两条路径）", async () => {
  let cancelled = false;
  const encoder = new TextEncoder();
  const out = await aggregateWorkBuddySse(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(AGG_FRAME({ content: "答完了" }, "stop")),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  equal(out.truncated, false);
  // 同样是平台吞掉：流已 done，cancel 到不了源的钩子，所以这条只保证「没有在
  // 自然结束时提前 break 出循环」（那种情况源还开着、钩子会翻，会被抓到）。
  equal(cancelled, false, "自然读到 done 的流被多取消了一次");
});
