// 在 cnbBuildUpstream 之后把真实出站 body 落盘，用于复现用户的 11128
import * as cnb from "./src/cnb.ts";
(globalThis as any).__DUMP__ = true;
const origFetch = globalThis.fetch;
globalThis.fetch = async (input: any, init: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (
    String(url).includes("/ai/chat/completions") && init?.body &&
    typeof init.body === "string"
  ) {
    try {
      await Deno.writeTextFile(".tmp-outbound-body.json", init.body);
    } catch (e) {
      console.log("dump fail", e);
    }
  }
  return origFetch(input, init);
};
const handler = (cnb as any).handleCnbResponses ?? (cnb as any).handleCnbChat;
console.log(
  "exports:",
  Object.keys(cnb).filter((k) => /handle|Upstream|Build/i.test(k)).join(", "),
);
