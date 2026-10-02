/**
 * WorkBuddy（中国版）纯函数层单测：目录解析、倍率、促销、请求头、请求体。
 *
 * 全部用假件，不碰磁盘也不发网络请求（deno task test 只开 --allow-env）。
 *
 * 判据：每条断言都对应一条真实踩过的坑，且**能被变异推翻** —— 把被测那行删掉
 * 或改错，本文件必须变红。改错不断红的断言等于装饰。
 */

import {
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
  normalizeCreditsRate,
  normalizeDiscountedRate,
  parseModelsFromConfig,
  parsePromotions,
  parseTokenData,
  stripControlChars,
  workBuddyBaseHeaders,
  workBuddyChatHeaders,
  type WorkBuddyCredential,
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

Deno.test("请求体：只有模型支持该等级时才发 reasoning_effort", () => {
  const plan = { efforts: ["low", "high"] };
  equal(
    buildChatBody("m", [], "s", plan, { reasoningEffort: "high" })
      .reasoning_effort,
    "high",
  );
  // 发一个未声明的档位会被服务端 400。
  assert(
    !("reasoning_effort" in
      buildChatBody("m", [], "s", plan, { reasoningEffort: "ultra" })),
    "undeclared effort must not be sent",
  );
  assert(
    !("reasoning_effort" in buildChatBody("m", [], "s", undefined, {
      reasoningEffort: "high",
    })),
    "a model with no declared ladder gets no effort field",
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
