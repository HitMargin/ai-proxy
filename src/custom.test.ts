import { assertEquals, assert } from "jsr:@std/assert@1";
import {
  CUSTOM_PREFIX,
  customEndpoint,
  customModelId,
  customUpstreamHeaders,
  describeCustomProviders,
  parseCustomProviders,
  resolveCustomTarget,
  validateBaseUrl,
  validateProviderName,
} from "./custom.ts";

const VALID = JSON.stringify([
  { name: "acme", baseUrl: "https://api.acme.test/v1", apiKey: "sk-aaaaaaaaaaaaaaaaaaaa" },
  { name: "self", baseUrl: "http://127.0.0.1:9000/v1", authHeader: "x-api-key", apiKey: "k" },
]);

Deno.test("the prefix is a single static segment, not one per provider", () => {
  // 这是整个模块的设计前提：前缀静态才不需要重启宿主。改坏它等于回到
  // 「每加一个供应商重启一次」。
  assertEquals(CUSTOM_PREFIX, "custom");
  assert(!CUSTOM_PREFIX.includes("/"));
});

Deno.test("a name is validated as a path segment, not just non-empty", () => {
  assertEquals(validateProviderName("Acme"), "acme");
  assertEquals(validateProviderName(" acme-2 "), "acme-2");
  // 进 URL 路径段的字符集合，逐个挡掉。
  assertEquals(validateProviderName("../etc"), null);
  assertEquals(validateProviderName("a/b"), null);
  assertEquals(validateProviderName("a b"), null);
  assertEquals(validateProviderName("a%2f"), null);
  assertEquals(validateProviderName(""), null);
  assertEquals(validateProviderName("x".repeat(33)), null);
  assertEquals(validateProviderName("x".repeat(32)), "x".repeat(32));
});

Deno.test("baseUrl is https, with loopback as the only http exception", () => {
  assertEquals(validateBaseUrl("https://a.test/v1/"), "https://a.test/v1");
  assertEquals(validateBaseUrl("http://127.0.0.1:9000/v1"), "http://127.0.0.1:9000/v1");
  assertEquals(validateBaseUrl("http://localhost:9000"), "http://localhost:9000");
  // 明文 http 到公网等于把凭据和正文都发在明处。
  assertEquals(validateBaseUrl("http://a.test/v1"), null);
  assertEquals(validateBaseUrl(""), null);
  assertEquals(validateBaseUrl("not a url"), null);
  assertEquals(validateBaseUrl("ftp://a.test"), null);
});

Deno.test("one bad entry does not take the rest of the table with it", () => {
  // 用户手写 JSON 有一个错字是常事；整张表报销会让他以为功能坏了。
  const parsed = parseCustomProviders(JSON.stringify([
    { name: "good", baseUrl: "https://a.test/v1" },
    { name: "bad name", baseUrl: "https://b.test/v1" },
    { name: "nourl" },
    { name: "http", baseUrl: "http://plain.test/v1" },
  ]));
  assertEquals(parsed.providers.map((p) => p.name), ["good"]);
  assertEquals(parsed.rejected.length, 3);
  // 理由必须说清是哪一种坏法，否则面板只能说「有三条没进去」。
  assert(parsed.rejected.some((r) => r.reason.includes("name")));
  assert(parsed.rejected.some((r) => r.reason.includes("https")));
});

Deno.test("a duplicate name is rejected rather than silently last-wins", () => {
  // 同名两条会变成「谁在后面谁生效」，那是没有报错的静默覆盖。
  const parsed = parseCustomProviders(JSON.stringify([
    { name: "dup", baseUrl: "https://a.test/v1" },
    { name: "dup", baseUrl: "https://b.test/v1" },
  ]));
  assertEquals(parsed.providers.length, 1);
  assertEquals(parsed.providers[0].baseUrl, "https://a.test/v1");
  assertEquals(parsed.rejected[0].reason, "duplicate name");
});

Deno.test("malformed env is reported, not treated as an empty table", () => {
  // 「没配」和「配坏了」要分开：都当成空表的话，用户看到的是渠道消失而没有任何提示。
  const broken = parseCustomProviders("{not json");
  assertEquals(broken.providers.length, 0);
  assertEquals(broken.rejected.length, 1);
  assert(broken.rejected[0].reason.includes("JSON"));
  const notArray = parseCustomProviders('{"name":"a"}');
  assert(notArray.rejected[0].reason.includes("array"));
  // 真正没配才算空表、且不报错。
  const empty = parseCustomProviders("");
  assertEquals(empty.providers, []);
  assertEquals(empty.rejected, []);
});

Deno.test("an unset apiKey is absent, not an empty credential", () => {
  // 空串会被当成「配过了」而放行一个没有凭据的请求。
  const parsed = parseCustomProviders(JSON.stringify([
    { name: "nokey", baseUrl: "https://a.test/v1" },
  ]));
  assertEquals(parsed.providers[0].apiKey, "");
  const described = describeCustomProviders(parsed);
  assertEquals(described.providers[0].keySet, false);
  // 面板形状里不能出现凭据本身。
  assert(!JSON.stringify(described).includes("apiKey"));
});

Deno.test("the name is the first segment, so upstream ids keep their own slashes", () => {
  // deepseek-ai/deepseek-v4.1-flash、z-ai/glm-5.3 这类 id 自带斜杠。
  // 按最后一段切会在一半的模型上切错，而上游收到错模型名只回 400。
  const parsed = parseCustomProviders(VALID);
  const hit = resolveCustomTarget(parsed, "acme/deepseek-ai/deepseek-v4.1-flash");
  assert(hit !== null);
  assertEquals(hit.provider.name, "acme");
  assertEquals(hit.upstreamModel, "deepseek-ai/deepseek-v4.1-flash");
});

Deno.test("an unknown name resolves to null rather than guessing a provider", () => {
  // 猜一个 = 把请求发给别的上游，那比报错危险得多。
  const parsed = parseCustomProviders(VALID);
  assertEquals(resolveCustomTarget(parsed, "ghost/model"), null);
  assertEquals(resolveCustomTarget(parsed, "model"), null);
  assertEquals(resolveCustomTarget(parsed, "acme/"), null);
  assertEquals(resolveCustomTarget(parsed, ""), null);
});

Deno.test("the credential goes in the header the provider named", () => {
  const parsed = parseCustomProviders(VALID);
  const bearer = resolveCustomTarget(parsed, "acme/m")!;
  const h1 = customUpstreamHeaders(bearer.provider, bearer.upstreamModel, new Headers(), true);
  assertEquals(h1.get("authorization"), "Bearer sk-aaaaaaaaaaaaaaaaaaaa");
  // 流式请求必须声明它，否则网关可能按非流式回一整个 JSON。
  assertEquals(h1.get("accept"), "text/event-stream");

  const keyed = resolveCustomTarget(parsed, "self/m")!;
  const h2 = customUpstreamHeaders(keyed.provider, keyed.upstreamModel, new Headers(), false);
  assertEquals(h2.get("x-api-key"), "k");
  // 用了自己的头就不该同时发一个空的 Bearer。
  assertEquals(h2.get("authorization"), null);
});

Deno.test("a client's own credential is never forwarded to a custom upstream", () => {
  // 转发了就等于把本代理的入站凭据送给第三方上游。
  const parsed = parseCustomProviders(VALID);
  const hit = resolveCustomTarget(parsed, "acme/m")!;
  const incoming = new Headers({ authorization: "Bearer caller-key", "x-api-key": "caller" });
  const out = customUpstreamHeaders(hit.provider, hit.upstreamModel, incoming, true);
  assertEquals(out.get("authorization"), "Bearer sk-aaaaaaaaaaaaaaaaaaaa");
  assertEquals(out.get("x-api-key"), null);
});

Deno.test("endpoint and model id compose without doubling or dropping slashes", () => {
  const parsed = parseCustomProviders(VALID);
  const hit = resolveCustomTarget(parsed, "acme/org/model")!;
  assertEquals(customEndpoint(hit.provider, "/chat/completions"), "https://api.acme.test/v1/chat/completions");
  assertEquals(customEndpoint(hit.provider, "/models"), "https://api.acme.test/v1/models");
  assertEquals(customModelId(hit.provider.name, hit.upstreamModel), "acme/org/model");
});
