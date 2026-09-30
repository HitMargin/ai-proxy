import { EgressPool, maskProxyUrl, parseProxyList } from "./zen-egress.ts";

/** Narrow an optional so the compiler proves the value is present. */
function assertExists<T>(
  value: T | undefined,
  message: string,
): asserts value is T {
  if (value === undefined) throw new Error(message);
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message = ""): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) {
    throw new Error(message || `expected ${right}, got ${left}`);
  }
}

Deno.test("an empty pool hands back no proxy so the caller dials directly", () => {
  const pool = new EgressPool();
  assertEqual(pool.size, 0);
  assertEqual(pool.pick(), undefined);
  assertEqual(pool.describe(), []);
});

Deno.test("only dialable proxy schemes are accepted", () => {
  const pool = new EgressPool({
    proxies: [
      "http://127.0.0.1:8080",
      "socks5://127.0.0.1:1080",
      "https://127.0.0.1:8443",
      "socks5h://127.0.0.1:1081",
      // None of these can be dialled, so they must be dropped rather than
      // failing the whole configuration.
      "ftp://127.0.0.1:21",
      "not a url",
      "",
    ],
  });
  assertEqual(pool.size, 4);
  // Compare host:port: URL.toString normalises the trailing slash per scheme,
  // so the serialized form differs between http and socks5 for no real reason.
  assertEqual(
    pool.describe().map((entry) => {
      const url = new URL(entry);
      return `${url.protocol}//${url.hostname}:${url.port}`;
    }),
    [
      "http://127.0.0.1:8080",
      "socks5://127.0.0.1:1080",
      "https://127.0.0.1:8443",
      "socks5h://127.0.0.1:1081",
    ],
  );
});

Deno.test("round robin spreads requests across every exit", () => {
  const pool = new EgressPool({
    proxies: ["http://a:1", "http://b:2", "http://c:3"],
    strategy: "round_robin",
  });
  const seen: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    const pick = pool.pick();
    assertExists(pick, "a non-empty pool always yields a proxy");
    seen.push(pick.proxy.hostname);
  }
  assertEqual(seen, ["a", "b", "c", "a", "b", "c"]);
});

Deno.test("fill pins every request to the first exit", () => {
  const pool = new EgressPool({
    proxies: ["http://a:1", "http://b:2"],
    strategy: "fill",
  });
  const seen: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    const pick = pool.pick();
    assertExists(pick, "a non-empty pool always yields a proxy");
    seen.push(pick.proxy.hostname);
  }
  assertEqual(seen, ["a", "a", "a", "a"]);
});

Deno.test("random stays inside the pool", () => {
  const pool = new EgressPool({
    proxies: ["http://a:1", "http://b:2"],
    strategy: "random",
  });
  for (let i = 0; i < 20; i += 1) {
    const pick = pool.pick();
    assertExists(pick, "a non-empty pool always yields a proxy");
    assert(
      ["a", "b"].includes(pick.proxy.hostname),
      "random must pick a known exit",
    );
  }
});

Deno.test("a cooling exit is skipped for the next pick", () => {
  const pool = new EgressPool({
    proxies: ["http://a:1", "http://b:2"],
    strategy: "round_robin",
  });
  const first = pool.pick();
  assertExists(first, "a non-empty pool always yields a proxy");
  assertEqual(first.index, 0);
  pool.coolDown(0, 60_000);

  const second = pool.pick();
  assertExists(second, "a non-empty pool always yields a proxy");
  assert(
    second.proxy.hostname !== "a",
    "the cooling exit must not be handed out again",
  );
});

Deno.test("an expired cooldown frees the exit again", async () => {
  const pool = new EgressPool({
    proxies: ["http://a:1", "http://b:2"],
    strategy: "fill",
  });
  pool.coolDown(0, 1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assertEqual(pool.cooldowns().length, 0, "an expired cooldown is forgotten");
  const pick = pool.pick();
  assertExists(pick, "a non-empty pool always yields a proxy");
  assertEqual(pick.proxy.hostname, "a");
});

Deno.test("reconfiguring the pool voids stale cooldowns", () => {
  const pool = new EgressPool({ proxies: ["http://a:1", "http://b:2"] });
  pool.coolDown(0, 60_000);
  assertEqual(pool.cooldowns().length, 1);
  // Index 0 now refers to a different exit, so its cooldown must not carry.
  pool.configure({ proxies: ["http://c:3", "http://d:4"] });
  assertEqual(pool.cooldowns().length, 0);
});

Deno.test("proxy credentials are never exposed", () => {
  assertEqual(
    maskProxyUrl("http://user:secret@host:8080"),
    "http://***@host:8080/",
  );
  assertEqual(maskProxyUrl("http://host:8080"), "http://host:8080");
  assertEqual(maskProxyUrl("nonsense"), "nonsense");
  const pool = new EgressPool({ proxies: ["http://user:secret@host:8080"] });
  assert(
    !pool.describe()[0].includes("secret"),
    "the panel must not receive the proxy password",
  );
});

Deno.test("a proxy list parses from commas, spaces and newlines", () => {
  assertEqual(
    parseProxyList("http://a:1, socks5://b:2\nhttp://c:3  "),
    ["http://a:1", "socks5://b:2", "http://c:3"],
  );
  assertEqual(parseProxyList(undefined), []);
  assertEqual(parseProxyList("   "), []);
});
