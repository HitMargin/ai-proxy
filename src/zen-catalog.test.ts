import { assertEquals } from "jsr:@std/assert";
import { parseZenCatalog, parseZenCatalogEntry } from "./zen-catalog.ts";

Deno.test("catalog reads the effort ladder the model publishes", () => {
  const entry = parseZenCatalogEntry({
    id: "space-bunny-free",
    reasoning: true,
    reasoning_options: [{
      type: "effort",
      values: ["low", "medium", "high", "xhigh", "max"],
    }],
    limit: { context: 1048576, output: 524288 },
    modalities: { input: ["text", "image", "video"], output: ["text"] },
  });
  assertEquals(entry, {
    id: "space-bunny-free",
    context: 1048576,
    output: 524288,
    inputModalities: ["text", "image", "video"],
    reasoning: true,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    toggleOnly: false,
  });
});

Deno.test("a toggle is not an effort ladder", () => {
  const entry = parseZenCatalogEntry({
    id: "longcat-2.5-preview-free",
    reasoning: true,
    reasoning_options: [{ type: "toggle" }],
    limit: { context: 1000000, output: 131072 },
  });
  assertEquals(entry?.toggleOnly, true);
  assertEquals(entry?.efforts, []);
});

Deno.test("an empty options list means not controllable, not a toggle", () => {
  const entry = parseZenCatalogEntry({
    id: "mimo-v2.6-flash-free",
    reasoning: true,
    reasoning_options: [],
    limit: { context: 200000, output: 32000 },
  });
  assertEquals(entry?.reasoning, true);
  assertEquals(entry?.toggleOnly, false);
  assertEquals(entry?.efforts, []);
});

Deno.test("a ladder survives a record with no limits", () => {
  const entry = parseZenCatalogEntry({
    id: "mystery-free",
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["low", "high"] }],
  });
  assertEquals(entry?.efforts, ["low", "high"]);
  assertEquals(entry?.context, 0);
  assertEquals(entry?.output, 0);
});

Deno.test("a record carrying nothing usable is dropped", () => {
  assertEquals(parseZenCatalogEntry({ id: "empty-free" }), null);
  assertEquals(
    parseZenCatalogEntry({ limit: { context: 10, output: 5 } }),
    null,
  );
  assertEquals(parseZenCatalogEntry(null), null);
  assertEquals(parseZenCatalogEntry("space-bunny-free"), null);
});

Deno.test("non-positive limits are refused rather than published", () => {
  const entry = parseZenCatalogEntry({
    id: "weird-free",
    limit: { context: 0, output: -1 },
    reasoning_options: [{ type: "effort", values: ["low"] }],
  });
  assertEquals(entry?.context, 0);
  assertEquals(entry?.output, 0);
});

Deno.test("only the opencode provider is indexed", () => {
  const index = parseZenCatalog({
    openrouter: {
      models: {
        "some/paid-model": {
          id: "some/paid-model",
          limit: { context: 8, output: 8 },
        },
      },
    },
    opencode: {
      api: "https://opencode.ai/zen/v1",
      models: {
        "space-bunny-free": {
          id: "space-bunny-free",
          limit: { context: 1048576, output: 524288 },
        },
        "deepseek-v4-flash-free": {
          id: "deepseek-v4-flash-free",
          limit: { context: 200000, output: 128000 },
        },
      },
    },
  });
  assertEquals([...index.keys()].sort(), [
    "deepseek-v4-flash-free",
    "space-bunny-free",
  ]);
});

Deno.test("a payload without the opencode provider yields nothing", () => {
  assertEquals(parseZenCatalog({ openrouter: { models: {} } }).size, 0);
  assertEquals(parseZenCatalog(null).size, 0);
  assertEquals(parseZenCatalog({ opencode: {} }).size, 0);
});
