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
  displayNameForModel,
  formatCreditsRate,
  HTTP_HEADER_DOMAIN,
  HTTP_HEADER_ENTERPRISE_ID,
  HTTP_HEADER_PRODUCT,
  HTTP_HEADER_TENANT_ID,
  isChatModel,
  isContentRejection,
  isContentRejectionFrame,
  isDeepSeekModel,
  isWorkBuddyExpired,
  isWorkBuddyThrottled,
  normalizeCreditsRate,
  normalizeDiscountedRate,
  parseModelsFromConfig,
  parsePromotions,
  parseTokenData,
  postWorkBuddyChatWithThrottleRetry,
  resetWorkBuddyCircuit,
  sendWorkBuddyChat,
  stripControlChars,
  tripWorkBuddyCircuit,
  workBuddyBaseHeaders,
  workBuddyChatHeaders,
  workBuddyCooldownRemaining,
  type WorkBuddyCredential,
  workBuddyRetryAfterMs,
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
