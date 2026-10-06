/**
 * cnb 工具调用解析：垃圾语法清理、定向诊断、落盘、熔断。
 *
 * 这批用例盯的是一个具体的用户故障：模型反复写出提示词明令禁止的别家协议
 * (复数 tool_calls / invoke+parameter / function_calls)，解析器一个都不认，
 * 于是整块被剥掉，模型只收到一句通用的 "invalid syntax"——它不知道错在哪，
 * 下一轮把同一种坏写法原样再写一遍。实测单会话连续 13 次大输出回合全这么来
 * 的，输入增长 34 倍、99% 的 token 花在重发上下文上。
 *
 * 全部用假件，不碰磁盘也不发网络请求（deno task test 只开 --allow-env）。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  CNB_MODELS,
  cnbBuildUpstream,
  cnbDiagnoseJunkSyntax,
  cnbJournalJunk,
  cnbJunkLogState,
  type CnbJunkStore,
  cnbJunkStreak,
  cnbParseToolCalls,
  handleCnb,
  maybeCompactCnb,
} from "./cnb.ts";

// LT 是源码里唯一允许出现尖括号的地方。测试正文到处要断言「没有一个裸的尖括号
// 漏到客户端」，写字面量会把标签配对搞坏——这个文件正是靠这条纪律生成的。
const LT = String.fromCharCode(60);
const GT = String.fromCharCode(62);
const TC = "tool_call";
const OPEN = LT + TC + String.fromCharCode(62);
const CLOSE = LT + "/" + TC + String.fromCharCode(62);

const TOOLS = [{
  function: {
    name: "pwsh",
    description: "Run a command",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        description: { type: "string" },
      },
      required: ["command"],
    },
  },
}];

/** 复位模块级计数器，用例之间才不按执行顺序互相影响。 */
function resetJunkState(): void {
  cnbJunkStreak.count = 0;
  cnbJunkStreak.at = 0;
  cnbJunkLogState.at = 0;
}

// -- 合法形状仍然解析得出来（清理逻辑不许把好调用一起吃掉） --

Deno.test("a well-formed call still parses after the junk path was added", () => {
  resetJunkState();
  const r = cnbParseToolCalls(
    "Reading now.\n" + OPEN + "\n" +
      '{"name":"pwsh","arguments":{"command":"ls"}}' + "\n" + CLOSE,
    TOOLS,
  );
  assertEquals(r.calls.length, 1);
  assertEquals(r.calls[0].function.name, "pwsh");
  assertEquals(r.calls[0].function.arguments, '{"command":"ls"}');
  assert(!r.clean.includes(OPEN), "tags must be stripped");
  assert(r.clean.startsWith("Reading"), "prose must survive");
});

// -- 別家协议必须被救回成调用，且它们的标签不得出现在正文里 --
// 判据是**客户端会看到什么**：伪 XML 留在正文里比没有反馈更糟。

Deno.test("a salvaged call hides its plural wrapper tag from the client", () => {
  resetJunkState();
  // 带属性的复数包裹：内层 JSON 被救回成一次**成功**调用（这里是 recover，不是
  // 拒收）。曾经的毛病是外层标签的属性串整块留在正文里发给客户端——用户看到的
  // 正是那堆裸露伪 XML。所以断言必须盯 clean，只盯 calls 会漏掉这个 bug。
  const r = cnbParseToolCalls(
    "Let me check.\n" + "<tool_calls in parallel>\n" +
      '{"name":"pwsh","arguments":{"command":"ls"}}' + "\n" + CLOSE,
    TOOLS,
  );
  assertEquals(r.calls.length, 1, "the payload is salvageable");
  assert(
    !r.clean.includes("parallel"),
    "the wrapper tag must not reach the client",
  );
  assert(!r.clean.includes(LT), "no stray pseudo-XML may reach the client");
  assertEquals(r.clean, "Let me check.", "prose survives, tags gone");
});

Deno.test("a salvaged function_call leaves no tag in the clean text", () => {
  resetJunkState();
  const r = cnbParseToolCalls(
    "Sure.\n" + "<function_call>\n" + '{"name":"pwsh"}',
    TOOLS,
  );
  assertEquals(r.calls.length, 1, "the payload is salvageable");
  assert(!r.clean.includes(LT), "no stray pseudo-XML may reach the client");
  assertEquals(r.clean, "Sure.", "prose only");
});

Deno.test("a function_calls pair around an invoke block is salvaged", () => {
  resetJunkState();
  const r = cnbParseToolCalls(
    '<function_calls>\n<invoke name="pwsh"><parameter name="command">ls</parameter></invoke>\n</function_calls>',
    TOOLS,
  );
  assertEquals(r.calls.length, 1, "the payload is salvageable");
  assert(!r.clean.includes(LT), "no stray pseudo-XML may reach the client");
  assertEquals(r.clean, "", "everything between the pair is consumed");
});

Deno.test("a bare invoke block is salvaged and the prose survives", () => {
  resetJunkState();
  const r = cnbParseToolCalls(
    "Sure, let me check.\n" +
      '<invoke name="pwsh">\n<parameter name="command">ls</parameter>\n</invoke>',
    TOOLS,
  );
  assertEquals(r.calls.length, 1, "the payload is salvageable");
  assert(r.clean.startsWith("Sure, let me check."), "prose must survive");
  assert(!r.clean.includes(LT), "pseudo-XML must be stripped");
});

Deno.test("plain text is untouched", () => {
  resetJunkState();
  const r = cnbParseToolCalls("Nothing to do here.", TOOLS);
  assertEquals(r.calls.length, 0);
  assertEquals(r.clean, "Nothing to do here.");
});

Deno.test("a salvaged call with an attrs-free plural tag also leaves no tag", () => {
  resetJunkState();
  // 与上一条的差别只在属性：`tool_calls>`（无属性）早先就被清掉了，
  // 带属性的那一边漏了很久。两条一起钉住，避免只修一半。
  const r = cnbParseToolCalls(
    "Working on it.\n" + LT + "tool_calls" + String.fromCharCode(62) + "\n" +
      '{"name":"pwsh","arguments":{"command":"ls"}}' + "\n" + CLOSE,
    TOOLS,
  );
  assertEquals(r.calls.length, 1, "the payload is salvageable");
  assert(!r.clean.includes(LT), "no stray pseudo-XML may reach the client");
  assertEquals(r.clean, "Working on it.");
});

// -- 真正不可救的形状：拒收 + 诊断 + 熔断 --

Deno.test("a singular function_call with nothing salvageable is stripped, not leaked", () => {
  resetJunkState();
  // 这条走的是 **JUNK 正则**（不是上面那条 function_call 的救援路径）：
  // 内容不是 JSON，所以 JUNK 是唯一清理出口。它若只认复数，
  // 单数这半边的标签会整块漏到客户端——正是用户看到的裸露伪 XML。
  const r = cnbParseToolCalls(
    "Intro.\n" + LT + "function_call" + GT + "\nNot JSON at all.",
    TOOLS,
  );
  assertEquals(r.calls.length, 0, "nothing is salvageable here");
  assert(r.clean.includes("NOT executed"), "the rejection must be stated");
  // 反馈说明里本来就带一个合法的 tool_call 示范，所以不能拿整段 clean 查尖括号。
  // 判据切成两半：**说明之前**那段（= 模型原文的残留）不许有任何尖括号。
  const beforeNote = r.clean.split("[proxy]")[0];
  assert(
    !beforeNote.includes(LT),
    "no stray pseudo-XML before the note: " + beforeNote,
  );
  assert(
    r.clean.includes("only reads"),
    "the diagnosis must point at the legal shape: " + r.clean.slice(-160),
  );
});

Deno.test("an unsalvageable payload is rejected with the diagnosis and a note", () => {
  resetJunkState();
  // 开闭标签都在、内容却不是 JSON：这是唯一会走拒收路径的形状。
  const r = cnbParseToolCalls(
    OPEN + "\n" + "Not JSON, just prose." + "\n" + CLOSE,
    TOOLS,
  );
  assertEquals(r.calls.length, 0, "nothing can be parsed out of prose");
  assert(r.clean.includes("NOT executed"), "must say the call did not run");
  assert(r.clean.includes("What was wrong:"), "must carry the diagnosis");
  assert(
    !r.clean.includes("Not JSON, just prose."),
    "the bad payload itself must not be echoed as the answer",
  );
});

Deno.test("a note is appended to the prose, not pasted over it", () => {
  resetJunkState();
  const r = cnbParseToolCalls(
    "Here is my answer first.\n" + OPEN + "\n" + "still not JSON\n" + CLOSE,
    TOOLS,
  );
  assert(
    r.clean.startsWith("Here is my answer first."),
    "the model's text comes first, feedback after it",
  );
  assert(r.clean.includes("What was wrong:"));
});

// -- 定向诊断：必须说出这一轮违反了哪一条 --

Deno.test("the diagnosis names the plural wrapper, not a generic failure", () => {
  resetJunkState();
  const r = cnbParseToolCalls(
    "Let me run it." + "\n" + "<tool_calls in parallel>\n" +
      "Not JSON, just prose.",
    TOOLS,
  );
  // 判据：反馈里出现具体错因。只有一句 invalid syntax 时模型无从改起。
  assert(/plural/i.test(r.clean), "must say which tag is illegal: " + r.clean);
  assert(r.clean.includes("What was wrong:"), "must label the diagnosis");
});

Deno.test("the diagnosis names function_call as a foreign protocol", () => {
  resetJunkState();
  const d = cnbDiagnoseJunkSyntax(
    "<function_call>\n" + '{"name":"pwsh"}',
  );
  assert(/function_call/i.test(d), "must name the tag: " + d);
  assert(/another tool protocol/i.test(d), "must explain why: " + d);
});

Deno.test("the diagnosis names invoke/parameter as a foreign protocol", () => {
  resetJunkState();
  const d = cnbDiagnoseJunkSyntax(
    '<invoke name="pwsh"></invoke><parameter name="command">ls</parameter>',
  );
  assert(/invoke|parameter/i.test(d), "must name the tag: " + d);
  assert(/another tool protocol/i.test(d), "must explain why: " + d);
  // 只断言「出现了 invoke 这个词」是弱断言：把说明改成
  // "invoke/parameter is not a shape this client reads" 照样绿——
  // 词还在，**解释**没了。所以再钉一条：必须指向唯一合法的替代形状。
  assert(/only reads/i.test(d), "must point at the legal shape: " + d);
});

Deno.test("a missing JSON object is reported as such", () => {
  resetJunkState();
  const d = cnbDiagnoseJunkSyntax(
    "I will call a tool now.\n" + OPEN + "\nLet me run ls\n",
  );
  assert(/no JSON object/i.test(d), "must say the object is absent: " + d);
});

Deno.test("an object without a name field is reported as missing name", () => {
  resetJunkState();
  const d = cnbDiagnoseJunkSyntax(
    OPEN + "\n" + '{"arguments":{"command":"ls"}}' + "\n" + CLOSE,
  );
  assert(/"name"/i.test(d), "must point at the missing key: " + d);
});

Deno.test("an object without an arguments object is reported", () => {
  resetJunkState();
  const d = cnbDiagnoseJunkSyntax(
    OPEN + "\n" + '{"name":"pwsh"}' + "\n" + CLOSE,
  );
  assert(/"arguments"/i.test(d), "must point at the missing key: " + d);
});

Deno.test("a string arguments value is reported instead of being coerced", () => {
  resetJunkState();
  const d = cnbDiagnoseJunkSyntax(
    OPEN + "\n" + '{"name":"pwsh","arguments":"ls"}' + "\n" + CLOSE,
  );
  assert(/arguments/i.test(d), "must point at the bad shape: " + d);
});

Deno.test("a diagnosis never guesses intent, only visible facts", () => {
  resetJunkState();
  // 猜错会把模型引到错误方向，比没有反馈更糟。这里验证确定性：
  // 同一个输入永远得到同一句话，且不含未观测到的指控。
  const a = cnbDiagnoseJunkSyntax(
    OPEN + "\n" + '{"name":"pwsh"}' + "\n" + CLOSE,
  );
  const b = cnbDiagnoseJunkSyntax(
    OPEN + "\n" + '{"name":"pwsh"}' + "\n" + CLOSE,
  );
  assertEquals(a, b);
  assert(!/probably|maybe|perhaps/i.test(a), "no speculation: " + a);
});

// -- 熔断：坏写法不改时不许再把长说明发一遍 --

Deno.test("the first two rejections carry the full shape and the diagnosis", () => {
  resetJunkState();
  const first = cnbParseToolCalls(
    OPEN + "\n" + "Not JSON, just prose." + "\n" + CLOSE,
    TOOLS,
  );
  const second = cnbParseToolCalls(
    OPEN + "\n" + "Not JSON, just prose." + "\n" + CLOSE,
    TOOLS,
  );
  assert(first.clean.includes("EXACTLY this shape"), "full note on #1");
  assert(first.clean.includes("What was wrong:"), "diagnosis on #1");
  assert(second.clean.includes("EXACTLY this shape"), "full note on #2");
  assert(second.clean.includes("What was wrong:"), "diagnosis on #2");
});

Deno.test("a third consecutive rejection keeps the diagnosis but drops the long shape", () => {
  resetJunkState();
  const notes: string[] = [];
  for (let i = 0; i < 3; i++) {
    notes.push(
      cnbParseToolCalls(
        OPEN + "\n" + "Not JSON, just prose." + "\n" + CLOSE,
        TOOLS,
      ).clean,
    );
  }
  // 第 3 次（索引 2）起走熔断版
  assert(notes[2].includes("What was wrong:"), "diagnosis still delivered");
  assert(notes[2].includes("3 times in a row"), "the streak is stated");
  assert(
    !notes[2].includes("EXACTLY this shape"),
    "long shape must be dropped",
  );
  // 熔断版必须更短——这就是省下的上下文。若它反而更长，这个熔断是在烧 token。
  assert(notes[2].length < notes[1].length, "circuit note must be shorter");
});

Deno.test("a fresh streak restarts at the full note", () => {
  resetJunkState();
  // 窗口语义：距上次拒收很久以后再来一次，算新的一串而不是继续累计。
  cnbJunkStreak.count = 9;
  cnbJunkStreak.at = 0; // 与 Date.now() 相差必然超过 60 秒
  const r = cnbParseToolCalls(
    OPEN + "\n" + "Not JSON, just prose." + "\n" + CLOSE,
    TOOLS,
  );
  assert(
    r.clean.includes("EXACTLY this shape"),
    "a fresh streak restarts at the full note",
  );
  assertEquals(cnbJunkStreak.count, 1);
});

// -- 落盘：垃圾原文必须写到能留下来的地方 --

interface Store extends CnbJunkStore {
  writes: Array<{ path: string; text: string; append: boolean }>;
}

function memoryStore(size = 0): Store {
  const writes: Store["writes"] = [];
  return {
    writes,
    size: () => size,
    write(path: string, text: string, append: boolean) {
      writes.push({ path, text, append });
    },
  };
}

Deno.test("a junk line is journalled once per debounce window", () => {
  resetJunkState();
  const store = memoryStore();
  cnbJournalJunk("first\n", store, 1_000_000);
  cnbJournalJunk("second\n", store, 1_000_200); // 窗口内，合并
  cnbJournalJunk("third\n", store, 2_000_000); // 窗口外，落盘
  assertEquals(
    store.writes.map((w) => w.text.trim()),
    ["first", "third"],
    "the debounce must collapse two writes in the same window",
  );
});

Deno.test("the journalled path is the file the proxy can read back", () => {
  resetJunkState();
  const store = memoryStore();
  cnbJournalJunk("line\n", store, 1_000_000);
  // path 若漂移，写进去的日志谁也找不到——那等于没落盘。
  assertEquals(store.writes[0].path, "./cnb-junk.log");
  assert(
    store.writes[0].append,
    "must append, not overwrite the previous evidence",
  );
});

Deno.test("an oversized journal restarts rather than growing without bound", () => {
  resetJunkState();
  const store = memoryStore(512 * 1024 + 1);
  cnbJournalJunk("line\n", store, 1_000_000);
  assertEquals(
    store.writes[0].append,
    false,
    "past the cap the file must be rewritten, not appended to",
  );
});

Deno.test("a journal failure never breaks the response", () => {
  resetJunkState();
  const hostile: CnbJunkStore = {
    size: () => {
      throw new Error("read-only filesystem");
    },
    write: () => {
      throw new Error("read-only filesystem");
    },
  };
  // 日志坏掉决不能把正常响应一起打死。
  cnbJournalJunk("line\n", hostile, 1_000_000);
});

// ─── 推理档位：off 必须真的关掉，未知值必须报错 ───
//
// 判据全部来自 2026-10-06 的实测：off 使上游输出 0 个思考字符，minimal ~ xhigh
// 都出 80~144 个，而喂 `banana` 上游回 `400 code 11150 the reasoning effort
// value is not supported by the current model`——上游校验，所以这张表可信。
//
// 旧代码写成 `enable_thinking = true` 硬编码 + `["low","medium","high","max"]`
// 白名单，后果正是用户报过的那个：**选 off 反而开满思考**，minimal/xhigh 也被
// 悄悄降级成 high。
// 这个文件的 assert 是自己写的、不含 throws；把抛出捕获成字符串来比对。
function capture(fn: () => unknown): string {
  try {
    fn();
    return "(did not throw)";
  } catch (e: any) {
    return String(e?.message ?? e);
  }
}

const build = (effort?: string) =>
  cnbBuildUpstream({
    model: "deepseek-v4.1-flash",
    max_tokens: 32,
    messages: [{ role: "user", content: "hi" }],
    ...(effort === undefined ? {} : { reasoning_effort: effort }),
  }).upstream;

Deno.test("effort off really switches thinking off", () => {
  const up = build("off");
  assertEquals(
    up.enable_thinking,
    false,
    "off must set enable_thinking false, not fall through to high",
  );
  // 不发 reasoning_effort 是**必需**的，不是整洁：实测上游拒绝 effort="off"
  // （400 code 11150），它只认「enable_thinking=false 且不提档位」。
  // 第一版我把 off 原样转发，线上直接 400。
  assertEquals(
    "reasoning_effort" in up,
    false,
    "off must omit reasoning_effort entirely - the upstream 400s on it",
  );
});

Deno.test("every published effort survives the request body verbatim", () => {
  // 这是"档位丢失"那条 bug 的回归：白名单里没有的档位曾被静默改成 high，
  // 调用方看到自己的选择被接受，实际发出去的是另一个值。
  for (const effort of ["minimal", "low", "medium", "high", "max", "xhigh"]) {
    const up = build(effort);
    assertEquals(
      up.reasoning_effort,
      effort,
      effort + " must be sent as itself",
    );
    assertEquals(up.enable_thinking, true, effort + " keeps thinking on");
  }
});

Deno.test("no effort asked for means the upstream default", () => {
  const up = build(undefined);
  assertEquals(
    up.reasoning_effort,
    "high",
    "the default stays high when the caller says nothing",
  );
  assertEquals(up.enable_thinking, true);
});

Deno.test("an effort the upstream rejects is an error, not a silent downgrade", () => {
  // 静默回落比报错更糟：调用方以为自己选的档位生效了。
  const thrown = capture(() => build("banana"));
  assert(
    /not supported/.test(thrown),
    "an unsupported effort must be reported, not rewritten to high",
  );
});

Deno.test("effort is case-insensitive but never invented", () => {
  const up = build("HIGH");
  assertEquals(
    up.reasoning_effort,
    "high",
    "spelling is normalised, the rung is not",
  );
  assert(
    /not supported/.test(capture(() => build("ultra"))),
    "an invented rung is also refused",
  );
});

// ─── 模型列表：只发布上游实际在跑的那个 id ───
//
// 实测：上游把所有模型名（deepseek-v4-flash / -pro / deepseek-v4.1-flash / -max）
// 都路由到同一个后端，响应里一律回 "model":"deepseek-v4.1-flash"。所以旧表里的
// `pro` 不是"更强的模型"，只是会被静默重定向的旧名——把它留在选择器里等于
// 给用户一个假的等级。
Deno.test("the published model list names only what the upstream actually runs", () => {
  const ids = CNB_MODELS.map((m: any) => m.id);
  assertEquals(ids, ["deepseek-v4.1-flash"]);
  // 旧名不能留在表里：它会被重定向，用户却以为那是另一个池子
  assert(
    !ids.includes("deepseek-v4-pro"),
    "a redirected alias must not be published as its own model",
  );
  assert(!ids.includes("deepseek-v4-flash"));
});

Deno.test("the default model matches the published one", () => {
  // 默认值和表必须一致：默认一个已下架的 id 会让"没指定模型"的请求悄悄走旧名
  const up = cnbBuildUpstream({
    max_tokens: 32,
    messages: [{ role: "user", content: "hi" }],
  }).upstream;
  assertEquals(up.model, CNB_MODELS[0].id);
});

// ─── Anthropic Messages 路由 ───
//
// 2026-10-06 起因：用户在 Deno Deploy 日志里看到 `POST /cnb/v1/v1/messages -> 404`。
// cnb 原本只有 models/chat/responses，Anthropic 形态的客户端打 /messages 只能拿到
// 一句 "Not found"。现在补上了，转换复用 commandcode 那套（已带 20 个单测）。
//
// 这三条只验证**路由边界**，不打上游：发一次真实 cnb 请求要 30 秒且需要登录
// cookie，把那种耗时放进套件会让 `deno task test` 从 2 秒变成几分钟。

const msgReq = (path: string, body: unknown) =>
  new Request("http://x" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

Deno.test("an Anthropic Messages route exists on cnb", async () => {
  // 判据： malformed 的 Anthropic 请求得到 **Anthropic 形状的 400**
  // （"max_tokens is required"），而不是裸 404 —— 这条错误消息来自
  // anthropicMessagesToChat，只有路由接对了才可能出现。
  const r = await handleCnb(
    "/cnb/v1/messages",
    msgReq("/cnb/v1/messages", {
      model: "deepseek-v4.1-flash",
      messages: [{ role: "user", content: "hi" }],
    }),
    new URL("http://x/cnb/v1/messages"),
  );
  assertEquals(r.status, 400, "the messages route must answer, not 404");
  const text = await r.text();
  assert(
    /max_tokens/.test(text),
    "the Anthropic converter's own error must surface: " + text,
  );
});

Deno.test("a path with a duplicated v1 segment still reaches messages", async () => {
  // 用户日志里就是 /cnb/v1/v1/messages。endsWith 匹配让它也能用——所以
  // "路径拼重了"不是这条请求失败的原因，别让人往那个方向查。
  const r = await handleCnb(
    "/cnb/v1/v1/messages",
    msgReq("/cnb/v1/v1/messages", {
      model: "deepseek-v4.1-flash",
      messages: [{ role: "user", content: "hi" }],
    }),
    new URL("http://x/cnb/v1/v1/messages"),
  );
  assertEquals(r.status, 400);
  assert(
    /max_tokens/.test(await r.text()),
    "the duplicated segment must not change which route answers",
  );
});

Deno.test("an unknown path says what this channel does serve", async () => {
  // 一句 "Not found" 让人分不清是拼错了还是渠道不支持。清单要和上面的分支
  // 一致——这里同时断言它提到了 messages（我加过路由之后就修正过这条文案）。
  const r = await handleCnb(
    "/cnb/v1/nope",
    msgReq("/cnb/v1/nope", {}),
    new URL("http://x/cnb/v1/nope"),
  );
  assertEquals(r.status, 404);
  const text = await r.text();
  assert(
    /chat\/completions/.test(text),
    "the 404 must list the real routes: " + text,
  );
  // 断言 "POST /messages" 而不是 "/messages"：文案后半段的
  // "/cnb/v1/v1/messages also matches" 也含 /messages，只查子串时分不清
  // 两处——实测把 "POST /messages" 那行删掉后这条仍然全绿。
  assert(
    /POST \/messages/.test(text),
    "the 404 must list the messages route that now exists: " + text,
  );
  // 路由数也要对：清单漏一条等于把用户引向 404
  const listed = (text.match(/POST \/[a-z]+/g) || []).length;
  assertEquals(
    listed,
    3,
    "three POST routes must be listed, got " + listed + " in: " + text,
  );
});

// ─── 图片形态：cnb 只收内联 data URL ───
//
// 实测 2026-10-06 对着部署好的渠道：
//   "data:image/png;base64,..." -> 200（模型答得出颜色）
//   "https://..."               -> 400 code 11135 "Please start a new conversation,
//                                  replace the image, and try again"
// 上游这句话还会被我们包成 "Upstream error"，于是 413 body-too-large 这种毫不想干
// 的错成了用户看到的东西——真正的原因（该用 data URL）一个字都不出现。
// 03:15 那次连烧两次重试就是这么来的。
const DATA_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const imgBody = (url: string) => ({
  model: "cnb/deepseek-v4.1-flash",
  max_tokens: 16,
  messages: [{
    role: "user",
    content: [
      { type: "text", text: "一个词" },
      { type: "image_url", image_url: { url } },
    ],
  }],
});

Deno.test("an inline data URL image is passed through", () => {
  const up = cnbBuildUpstream(imgBody(DATA_PNG)).upstream;
  const imgs = up.messages[0].content.filter((p: any) =>
    p.type === "image_url"
  );
  assertEquals(imgs.length, 1, "the image must survive into the upstream body");
  assertEquals(
    imgs[0].image_url.url,
    DATA_PNG,
    "the data URL is forwarded verbatim",
  );
});

Deno.test("an http(s) image URL is refused with the reason", () => {
  // 不该转发出去让上游回 11135——那句错误被包成 "Upstream error" 之后，
  // 跟真正的原因完全对不上。
  for (
    const url of ["https://example.com/a.png", "http://cnb.cool/favicon.ico"]
  ) {
    const thrown = capture(() => cnbBuildUpstream(imgBody(url)));
    assert(
      /inline images|data:image/.test(thrown),
      "must say the inline requirement: " + thrown,
    );
  }
});

Deno.test("one bad image refuses the whole body rather than half-sending", () => {
  // 半套发出去 = 上游收到一个没有图的请求，模型答"没有图"，而用户以为图发出去了。
  const thrown = capture(() =>
    cnbBuildUpstream({
      model: "cnb/deepseek-v4.1-flash",
      max_tokens: 16,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "x" },
          { type: "image_url", image_url: { url: DATA_PNG } },
          {
            type: "image_url",
            image_url: { url: "https://example.com/b.png" },
          },
        ],
      }],
    })
  );
  assert(
    /inline images/.test(thrown),
    "a single non-inline image must refuse the request",
  );
});

// ─── cnb 会话压缩：打破 1 MiB 死锁 ───
//
// 2026-10-06 用户会话涨到 89 轮/576M token，请求体超过上游 1 MiB 硬限
// （实测边界 1,048,169 B 通过、1,049,193 B 起 413 [BODY_TOO_LARGE]），
// 而 harness 自己的压缩请求同样超限 —— 它得发一次模型调用来写摘要。
// 死锁：上下文 1.2 MiB → 压缩要发请求 → 请求体同样超 → 413 → 压不掉。
//
// 实现接的是 src/zen-compaction.ts（Zen 已在用的 opencode 官方移植），
// 关键约束是**压缩必须发生在 cnbBuildUpstream 之前**，否则改写的 messages
// 不会进入实际请求（AGENTS.md 里 Zen 那条踩过）。

Deno.test("a cnb transcript above the body budget is compacted", async () => {
  // 用中文填充：一个字符三字节，正是「按字符估算会漏掉」的那种输入。
  const filler =
    "这是一段用来把请求体撑过上游 1 MiB 硬限制的中文填充文本，每个汉字占三个字节。";
  const messages: any[] = [{ role: "system", content: "You are helpful." }];
  for (let i = 0; i < 600; i++) {
    messages.push({
      role: "user",
      content: "第 " + i + " 轮：" + filler.repeat(12),
    });
    messages.push({ role: "assistant", content: "收到。" + filler.repeat(8) });
  }
  messages.push({
    role: "user",
    content: "只回答一个字：好（这是最新一轮，压缩后必须原样保留）",
  });
  const body: any = { model: "deepseek-v4.1-flash", max_tokens: 32, messages };
  const before = new TextEncoder().encode(JSON.stringify(body)).length;
  assert(
    before > 1048576,
    "fixture must actually exceed the upstream limit, got " + before,
  );

  let summaryAsked = false;
  // 摘要写入器换成桩：不打上游，返回一段合法摘要。
  await maybeCompactCnb(body, "test-session", async () => {
    summaryAsked = true;
    return "## Objective\n- 讨论 TechniqueSimulator.cpp\n\n## Work State\n### Active\n- 压缩验证";
  });

  const after = new TextEncoder().encode(JSON.stringify(body)).length;
  assert(summaryAsked, "compaction must ask for a summary");
  assert(
    after < before,
    "the rebuilt body must be smaller: " + before + " -> " + after,
  );
  assert(
    after < 1048576,
    "the rebuilt body must fit under the upstream limit, got " + after,
  );
  // 摘要必须以 system 消息落在重建后的 transcript 里
  assert(
    body.messages.some((m: any) =>
      typeof m.content === "string" &&
      m.content.includes("Conversation Summary")
    ),
    "the anchored summary must be in the rebuilt transcript",
  );
  // 尾部必须保留原文：只留摘要会让模型看不到最近几轮
  assert(
    body.messages.some((m: any) =>
      typeof m.content === "string" && m.content.includes("最新一轮")
    ),
    "the newest turn must survive verbatim",
  );
});

Deno.test("a transcript under the budget is left completely alone", async () => {
  // 对照组：没超限就不许动。缺了它，实现里「无条件压缩」也会让上一条通过。
  const body: any = {
    model: "deepseek-v4.1-flash",
    max_tokens: 32,
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "你好" },
    ],
  };
  const snapshot = JSON.stringify(body);
  await maybeCompactCnb(body, "test-session", async () => {
    throw new Error("must not be called for a small transcript");
  });
  assertEquals(
    JSON.stringify(body),
    snapshot,
    "a small transcript must be untouched",
  );
});
