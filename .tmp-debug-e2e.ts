import { CNB_HEAD_PREFIX, handleCnb } from "./src/cnb.ts";
const realFetch = globalThis.fetch;
const bodies: string[] = [];
let n = 0;
(globalThis as any).fetch = (input: any, init?: any) => {
  const url = String(input);
  if (url.includes("cnb.cool/ai/chat/completions")) {
    bodies.push(String(init?.body ?? ""));
    n += 1;
    if (n === 1) {
      return Promise.resolve(
        new Response(JSON.stringify({ code: 11128, msg: "x" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(
      new Response(
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );
  }
  return Promise.resolve(
    new Response(
      '<script>window.csrftoken = "' + "a".repeat(32) + '";</script>',
      {
        status: 200,
        headers: {
          "content-type": "text/html",
          "set-cookie": "csrfkey=1; Path=/",
        },
      },
    ),
  );
};
const req = new Request("http://cnb.local/cnb/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "deepseek-v4.1-flash",
    messages: [{ role: "system", content: "SOME UNKNOWN FINGERPRINT" }, {
      role: "user",
      content: "hi",
    }],
    stream: false,
    max_tokens: 16,
  }),
});
const resp = await handleCnb("/cnb/v1/chat/completions", req, new URL(req.url));
console.log("status", resp.status, "attempts", bodies.length);
for (let i = 0; i < bodies.length; i++) {
  const m = JSON.parse(bodies[i]).messages[0];
  console.log(
    "attempt",
    i,
    "len",
    String(m.content).length,
    "tail:",
    JSON.stringify(String(m.content).slice(-60)),
  );
}
globalThis.fetch = realFetch;
