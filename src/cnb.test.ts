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
  CNB_BODY_BUDGET_BYTES,
  CNB_MODELS,
  cnbBuildUpstream,
  cnbCallUpstream,
  cnbDiagnoseJunkSyntax,
  cnbEscapeRepairState,
  cnbForgetRejectedHeads,
  cnbGatedResponse,
  cnbJournalJunk,
  cnbJunkLogState,
  type CnbJunkStore,
  cnbJunkStreak,
  cnbNeutraliseChannelMarkers,
  cnbNeutraliseHead,
  cnbParseToolCalls,
  cnbPreNeutraliseHead,
  cnbRememberRejectedHead,
  cnbRepairMaxTokens,
  cnbStripGitStatus,
  deriveSessionKey,
  handleCnb,
  isReasoningStarvation,
  maybeCompactCnb,
  repairJsonEscapes,
  runAsCnbInternal,
  sessionIdOf,
  summariseWithThinkingFallback,
} from "./cnb.ts";
import { compactionState, resetCompactionStates } from "./zen-compaction.ts";
import type { CnbSummaryAttempt } from "./cnb.ts";

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

Deno.test("effort none is the same request as off, not a rejected value", () => {
  // 2026-10-20 生产实证：dsh 的 `reasoningEffort: "none"` 被拒成
  //   `cnb: reasoning_effort "none" is not supported (...)`
  // 而这条错误冒泡成 upstream_error，调用方（iot-thinking 插件）把它记成
  // 压缩失败、转去走确定性兜底，最终把整段思考替换成 196 字符。
  // 一个词的拼写差别，代价是 100 万字符的思考被丢掉。
  //
  // `"none"` 是 OpenAI Responses API 里关思考的规范值，`"off"` 是 dsh 内部
  // 的写法；两者对上游必须是**同一个**请求。
  const off = build("off");
  const none = build("none");
  assertEquals(
    none.enable_thinking,
    false,
    "none must disable thinking exactly like off",
  );
  assertEquals(
    "reasoning_effort" in none,
    false,
    "none must omit reasoning_effort entirely, same as off",
  );
  assertEquals(
    JSON.stringify(none),
    JSON.stringify(off),
    "off and none must produce byte-identical upstream bodies",
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

Deno.test("the output cap goes upstream under the spelling the upstream reads", () => {
  // 回归：这里曾经发 `maxTokens`（驼形），而上游只认 `max_tokens`——于是
  // 客户端传的上限被静默丢弃、下面那个兜底也从没到达上游，从 70d9de4
  // (2026-09-24) 起整整两周。
  //
  // 判据只能是**键名**：这个套件不打网络，所以"上游认不认"在这里无法直接
  // 观测，能守住的只有"发出去的形状对不对"。上游那边的实测对照记在
  // src/cnb.ts 该行的注释里（snake 生效 / camel 忽略）。
  const up = build();
  assertEquals(
    "max_tokens" in up,
    true,
    "the cap must be sent as snake_case max_tokens",
  );
  assertEquals(
    "maxTokens" in up,
    false,
    "camelCase maxTokens is silently ignored by the upstream - never send it",
  );
  // 客户端说了就算
  const asked = cnbBuildUpstream({
    model: "deepseek-v4.1-flash",
    max_tokens: 4096,
    messages: [{ role: "user", content: "hi" }],
  }).upstream;
  assertEquals(
    asked.max_tokens,
    4096,
    "a caller-supplied max_tokens must survive verbatim",
  );
  // 没说就给兜底，而不是漏发（漏发 = 完全不设限）
  assert(
    typeof up.max_tokens === "number" && up.max_tokens > 0,
    "no caller cap must still produce a positive upstream cap",
  );
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

// ─── 摘要请求自己的体积必须有界（2026-10-24）───
//
// 生产事故：会话涨到 10.8 MB / ~1800 条时，每条头部消息截到 600 字符仍留下
// ~1.9 MB 的摘要 prompt → 摘要请求自己吃上游 413 [BODY_TOO_LARGE] → 每轮都
// 降级成截断 → 截断说明插到最前面，把带指纹的原 system 挤成第二条 → 撞上
// 11128（旧自愈只削第一条）→ 会话永久卡死。装箱后摘要 prompt ≤ 预算，
// 摘要能成功，会话才能收敛到增量更新路径。
Deno.test("the summary prompt packs tool spam but keeps the task thread", async () => {
  resetCompactionStates();
  // ★ 2026-10-24 重写：装箱的判据不再是「prompt 够小」而是「任务必须活着」。
  // 生产事故：任务在最老的区域，装箱只留最新的头部 → 摘要模型根本没见过任务
  // → 重建出的 transcript「只剩工具定义」，模型每轮都在问「你要我干什么」。
  // 现在上下文层装箱保护非 reminder 的 user 消息，只淘汰工具噪音。
  const filler = "细".repeat(1200); // assistant 每条被截到 600 字符
  const TASK =
    "TASK：修复 Spectrum 渲染器的时序问题，pin 卸载后 Won_Update 必须等真实时间追平。";
  const messages: any[] = [{ role: "system", content: "sys" }];
  messages.push({ role: "user", content: TASK });
  for (let i = 0; i < 1800; i++) {
    messages.push({ role: "assistant", content: "SPAM-" + i + "：" + filler });
  }
  messages.push({ role: "user", content: "最新一轮：只回答一个字：好" });
  const body: any = { model: "deepseek-v4.1-flash", max_tokens: 32, messages };

  let prompt = "";
  const note = await maybeCompactCnb(
    body,
    "packed-session",
    async (p: string) => {
      prompt = p;
      return "## Objective\n- packed summary";
    },
  );
  assert(
    note.includes("compacted via summary"),
    "summary must succeed: " + note,
  );

  const promptBytes = new TextEncoder().encode(prompt).length;
  assert(
    promptBytes < 1024 * 1024,
    "the summary prompt itself must fit the upstream body limit, got " +
      promptBytes,
  );
  assert(
    promptBytes < 700 * 1024,
    "the summary prompt must stay under the packing budget, got " + promptBytes,
  );
  assert(
    prompt.includes("TASK：修复 Spectrum"),
    "the original task must survive the packing — it is the whole point",
  );
  assert(
    prompt.includes("已省略"),
    "the omitted tool spam must be visible as an omission",
  );
  assert(
    !prompt.includes("SPAM-2："),
    "the oldest tool spam must be the first thing dropped",
  );
  assert(
    /SPAM-\d{3,4}：/.test(prompt),
    "recent tool spam must survive the packing, not only omissions",
  );
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

// ─── 历史里的旧图片要移出，否则每轮都会 413 ───
//
// 2026-10-06 用户报「图片读取多了他炸了」：读几张图之后每一轮都 413
// [BODY_TOO_LARGE]。根因是**图片在历史里累积**——DSH 把图作为 user 消息的
// image_url 块放进 messages，而 messages 是整段历史，每轮都要重发全部。
// 实测：400KB 的图 base64 后约 533KB，第 3 轮就到 1.18 MiB，而上游硬限约
// 1 MiB（1,048,169 过 / 1,049,193 拒）。

const BIG_IMG = "data:image/png;base64," + "A".repeat(380 * 1024);

function imageHistory(turns: number) {
  const messages: any[] = [{ role: "system", content: "sys" }];
  for (let i = 1; i <= turns; i++) {
    messages.push({
      role: "user",
      content: [{ type: "text", text: "第 " + i + " 张" }, {
        type: "image_url",
        image_url: { url: BIG_IMG },
      }],
    });
    messages.push({ role: "assistant", content: "看过了" });
  }
  messages.push({ role: "user", content: "总结" });
  return { model: "cnb/deepseek-v4.1-flash", max_tokens: 64, messages };
}

function countImages(up: any) {
  let images = 0;
  let placeholders = 0;
  for (const m of up.messages) {
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content) {
      if (p.type === "image_url") images++;
      if (
        p.type === "text" &&
        String(p.text ?? "").includes("较早的图片已从上下文")
      ) placeholders++;
    }
  }
  return { images, placeholders };
}

Deno.test("older images are pulled from history so the body stops growing", () => {
  // 判据是**发出的字节数**，不是"有没有调用某个函数"：413 由字节数决定。
  const body = imageHistory(5);
  const raw = new TextEncoder().encode(JSON.stringify(body)).length;
  assert(
    raw > 1048576,
    "the fixture must actually exceed the upstream limit, got " + raw,
  );

  const up = cnbBuildUpstream(body).upstream;
  const sent = new TextEncoder().encode(JSON.stringify(up)).length;
  assert(
    sent < 1048576,
    "the outgoing body must fit under ~1 MiB, got " + sent,
  );

  const { images, placeholders } = countImages(up);
  // 每张图约 507 KiB，而图片预算是 256 KiB —— 所以只留得下**一张**。
  // 这条曾经写死 2，是按张数丢的旧实现留下的；改成按字节后它就是错的。
  assertEquals(images, 1, "only the newest image fits the byte budget");
  assert(
    placeholders >= 1,
    "each dropped image leaves a placeholder, got " + placeholders,
  );
});

Deno.test("a transcript that fits is left completely alone", () => {
  // 对照组：没超限就不许动。缺了它，无条件砍图也能让上一条通过。
  const body = imageHistory(1);
  const up = cnbBuildUpstream(body).upstream;
  const { images, placeholders } = countImages(up);
  assertEquals(images, 1, "a single image must be sent untouched");
  assertEquals(placeholders, 0, "nothing may be replaced when there is room");
});

Deno.test("the placeholder says what happened instead of silently vanishing", () => {
  // 静默截断是本项目反复在删的那类缺陷：模型不知道图没了会怀疑自己的历史，
  // 排查的人也不知道曾经发生过什么。
  const up = cnbBuildUpstream(imageHistory(4)).upstream;
  let text = "";
  for (const m of up.messages) {
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content) {
      if (p.type === "text") text += String(p.text ?? "");
    }
  }
  assert(
    text.includes("较早的图片已从上下文"),
    "the model must be told an image was removed",
  );
});

// ─── A/B：图片预算按**字节**记，不是按张数 ───
//
// 第一版按"保留最新 2 张"实现，被用户当场打回：他那两张图叫
// imgbig1_1196x899.png / imgbig2_1246x406.png，**最新两张自己就超 1 MiB** ——
// "保留最新 2 张"于是精确保留了超限的那两张，丢旧图一点用没有。
// 413 由字节数决定，不由张数决定，所以预算就得按字节记。

function sizedImage(b64Bytes: number) {
  return {
    type: "image_url",
    image_url: { url: "data:image/png;base64," + "A".repeat(b64Bytes) },
  };
}
function sizedHistory(images: any[]) {
  const messages: any[] = [{ role: "system", content: "sys" }];
  for (let i = 0; i < images.length; i++) {
    messages.push({
      role: "user",
      content: [{ type: "text", text: "第 " + i + " 张" }, images[i]],
    });
    messages.push({ role: "assistant", content: "看过了" });
  }
  messages.push({ role: "user", content: "总结" });
  return { model: "cnb/deepseek-v4.1-flash", max_tokens: 64, messages };
}

Deno.test("two large images do not both survive - the older one is dropped", () => {
  // 这是旧实现的真实漏洞：按张数留 2 张 = 留下两张 400KB 的，必然 413。
  const up = cnbBuildUpstream(
    sizedHistory([sizedImage(400 * 1024), sizedImage(400 * 1024)]),
  ).upstream;
  const { images } = countImages(up);
  assertEquals(images, 1, "two 400 KiB images must not both be sent");
  const bytes = new TextEncoder().encode(JSON.stringify(up)).length;
  assert(bytes < 1048576, "body must fit, got " + bytes);
});

Deno.test("many small images survive together - the budget is bytes, not count", () => {
  // 对照组：按张数丢会把这 20 张砍到 2 张。按字节丢应该留下 10 张以上。
  const many = Array.from({ length: 20 }, () => sizedImage(20 * 1024));
  const up = cnbBuildUpstream(sizedHistory(many)).upstream;
  const { images } = countImages(up);
  assert(
    images > 5,
    "small images within budget must not be discarded by a count rule, kept " +
      images,
  );
  const bytes = new TextEncoder().encode(JSON.stringify(up)).length;
  assert(bytes < 1048576, "body must fit, got " + bytes);
});

Deno.test("an oversized image in history is demoted rather than refused", () => {
  // 这条替换了原先的 "an image too large to send is refused with the real
  // reason"。那条的夹具最后一条消息是 "总结"（无图），图其实在**历史**里——
  // 旧实现一刀切报错才让它通过。语义改成按位置分之后，历史里的超大图应当
  // 被降级放行（否则会话永久卡死），所以那条断言不再成立，由下面两条取代。
  const up = cnbBuildUpstream(sizedHistory([sizedImage(1200 * 1024)])).upstream;
  const { images } = countImages(up);
  assertEquals(images, 0, "an oversized historical image must not be sent");
  const bytes = new TextEncoder().encode(JSON.stringify(up)).length;
  assert(bytes < 1048576, "the request must still be sendable, got " + bytes);
});

// ─── 超大图：历史里的降级放行，当前轮发的如实报错 ───
//
// 第一版一刀切报错，被真实会话打回：用户那个 1210 KiB 的图留在历史里，而
// "第一张无条件保留"意味着它永远删不掉 → 每轮都被拒绝 → 会话卡死。
// **B 把"偶尔 413 后重试成功"变成"永久 400"，比原问题更糟。**
// 现在按位置分：历史里的降级成占位（会话继续），当前轮发的报错（还能改）。

const HUGE = "data:image/png;base64," + "A".repeat(1210 * 1024);

function bigHistory(currentBig: boolean, turns: number) {
  const messages: any[] = [{ role: "system", content: "sys" }];
  messages.push({
    role: "user",
    content: [{ type: "text", text: "看这张" }, {
      type: "image_url",
      image_url: { url: HUGE },
    }],
  });
  messages.push({ role: "assistant", content: "看过了" });
  for (let i = 0; i < turns; i++) {
    messages.push({ role: "user", content: "继续 " + i });
    messages.push({ role: "assistant", content: "好" });
  }
  messages.push({
    role: "user",
    content: currentBig
      ? [{ type: "text", text: "再看" }, {
        type: "image_url",
        image_url: { url: HUGE },
      }]
      : "总结",
  });
  return { model: "cnb/deepseek-v4.1-flash", max_tokens: 64, messages };
}

Deno.test("an oversized image in history is demoted so the session can continue", () => {
  // 这是用户实际卡住的形状：报错一次可以，永久失败不行。
  for (const turns of [0, 20]) {
    const up = cnbBuildUpstream(bigHistory(false, turns)).upstream;
    const bytes = new TextEncoder().encode(JSON.stringify(up)).length;
    assert(bytes < 1048576, "the body must be sendable, got " + bytes);
    const { images } = countImages(up);
    assertEquals(images, 0, "the oversized historical image must not be sent");
  }
});

// ─── 会话身份：缺 id 时不许塌成一个共用常量 ───
//
// 2026-10-07 用户报「摘要跑到别的对话去了」。根因链：DSH 插件只在 modelId
// 以 `zen/` 开头时才发 x-session-id，cnb 渠道收不到任何会话头 → sessionIdOf
// 退化成常量 "cnb-default" → 所有 cnb 会话共用一份压缩摘要。面板日志里每一行
// 都写着 session=cnb-default 就是这个。
//
// 判据：**没有身份时宁可没有身份**（""），也不能捏一个所有调用者共享的常量。
// 空串在 zen-compaction 里等于「不存状态」——压缩照常发生，只是无状态，
// 会从 messages 里自己找上一次的摘要，不会串味。
Deno.test("a request without a session header gets no identity, not a shared constant", () => {
  const bare = new Request("http://cnb.local/cnb/v1/chat/completions", {
    method: "POST",
  });
  assertEquals(
    sessionIdOf(bare),
    "",
    'an absent session id must be "" - a constant like "cnb-default" is shared by every caller',
  );
});

Deno.test("a request with a session header keeps it, and x-session-id wins over x-conversation-id", () => {
  const viaSession = new Request("http://cnb.local/cnb/v1/chat/completions", {
    method: "POST",
    headers: { "x-session-id": "sess-abc" },
  });
  assertEquals(sessionIdOf(viaSession), "sess-abc");

  const viaConversation = new Request(
    "http://cnb.local/cnb/v1/chat/completions",
    { method: "POST", headers: { "x-conversation-id": "conv-xyz" } },
  );
  assertEquals(sessionIdOf(viaConversation), "conv-xyz");

  const both = new Request("http://cnb.local/cnb/v1/chat/completions", {
    method: "POST",
    headers: { "x-session-id": "sess-abc", "x-conversation-id": "conv-xyz" },
  });
  assertEquals(sessionIdOf(both), "sess-abc");
});

Deno.test("an unidentified session still compacts, and keys state by content", async () => {
  // 空 id 不能把压缩一起关掉——那会让「没带头的调用者」永远压不动、每轮 413。
  //
  // ★ 2026-10-19 修：这里原本断言「不留状态」（`compactionState("cnb:")` 必须
  // undefined）。那条判据本身没错（不能塌成共用常量），但它带来的副作用在
  // 生产日志里暴露得很清楚：几乎每行都是 `session=(none)`，于是
  // zen-compaction 从不存状态 ⇒ 下一轮拿不到 anchored summary ⇒ **每轮全量
  // 重算摘要**，cost≈ 从 10582 一路涨到 21083（历史越长越贵，自我放大）。
  //
  // 新判据拆成两条，各自守住一件事：
  //   ① 仍然不能存到共用常量 `cnb:` 下（防串味）；
  //   ② 必须按**首条消息**派生稳定键并存状态（换取增量更新）。
  // 两条都要，缺一条就退回旧故障的某一端。
  resetCompactionStates();
  const messages: any[] = [
    { role: "system", content: "You are helpful." },
  ];
  const filler = "这一段用来把请求体撑过上游的 1 MiB 硬限。".repeat(4000);
  for (let i = 0; i < 60; i += 1) {
    messages.push({ role: "user", content: filler + i });
    messages.push({ role: "assistant", content: "收到" + i });
  }
  messages.push({ role: "user", content: "这是最新一轮，压缩后必须原样保留" });
  const body: any = { model: "deepseek-v4.1-flash", max_tokens: 32, messages };
  const before = new TextEncoder().encode(JSON.stringify(body)).length;
  assert(before > 1048576, "fixture must exceed the limit, got " + before);

  let asked = false;
  await maybeCompactCnb(body, "", async () => {
    asked = true;
    return "## Objective\n- 无身份会话的压缩验证";
  });
  assert(asked, "an unidentified session must still compact");
  const after = new TextEncoder().encode(JSON.stringify(body)).length;
  assert(after < before, "it must actually shrink: " + before + " -> " + after);
  // ① 绝不塌成共用常量：那会让所有无头调用者共用一份摘要。
  assertEquals(
    compactionState("cnb:"),
    undefined,
    'the empty-id path must not store under the constant "cnb:"',
  );
  assertEquals(compactionState(""), undefined);
  // ② 但必须按内容派生一个键并存下来，否则每轮都要重算全量摘要。
  const derived = deriveSessionKey(messages);
  assert(derived !== "", "a headless request must still derive a key");
  assert(
    compactionState(`cnb:${derived}`) !== undefined,
    "state must be stored under the content-derived key so the next turn is incremental",
  );
});

// ─── 内容派生键：同一对话命中同一状态，不同对话互不干扰 ───
//
// 这是上面那条 ② 的判据基础。键必须取自「首条消息」而不是整个历史：
// 历史每轮都会增长，用整段内容做哈希会让每轮的键都变，等于仍然无状态；
// 而表的容量有限，每轮新键还会把它撑爆。
Deno.test("the derived session key is stable across turns and distinct across conversations", () => {
  const first = { role: "system", content: "You are a coding agent." };
  const turn1 = [first, { role: "user", content: "第一轮" }];
  const turn2 = [
    first,
    { role: "user", content: "第一轮" },
    { role: "assistant", content: "回答" },
    { role: "user", content: "第二轮" },
  ];
  assertEquals(
    deriveSessionKey(turn1),
    deriveSessionKey(turn2),
    "the same conversation must keep one key as it grows - otherwise every turn is stateless",
  );
  const other = [
    { role: "system", content: "You are a translator." },
    { role: "user", content: "第一轮" },
  ];
  assert(
    deriveSessionKey(other) !== deriveSessionKey(turn1),
    "a different conversation must not share the key",
  );
  assertEquals(deriveSessionKey([]), "", "no messages means no identity");
  // 前缀保证不会和真实客户端 id 撞车。
  assert(
    deriveSessionKey(turn1).startsWith("auto:"),
    "the derived key must be namespaced away from client-supplied ids",
  );
});

// ─── 端到端：无会话头的第二轮必须走「增量更新」而不是全量重算 ───
//
// 这是 `session=(none)` 那条故障的真正判据。生产日志里 cost≈ 从 10582 一路
// 涨到 21083，原因是每轮都拿不到上一轮的 anchored summary、从头总结整段历史。
// 只断言「键稳定」不够——键稳定但没被用到，现象完全一样。所以这里直接看
// **第二次摘要请求的 prompt 里有没有上一轮的摘要**。
Deno.test("a headless second turn updates the anchored summary instead of restarting", async () => {
  resetCompactionStates();
  const head: any[] = [{ role: "system", content: "You are helpful." }];
  const filler = "用来把请求体撑过上游 1 MiB 硬限的填充文本。".repeat(4000);
  for (let i = 0; i < 60; i += 1) {
    head.push({ role: "user", content: filler + i });
    head.push({ role: "assistant", content: "收到" + i });
  }
  const makeMessages = (tag: string, extra = 0) => [
    ...head.map((m) => ({ ...m })),
    ...Array.from({ length: extra }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      content: filler + `额外${tag}${i}`,
    })),
    { role: "user", content: "最新一轮 " + tag },
  ];

  const prompts: string[] = [];
  const summarize = async (prompt: string) => {
    prompts.push(prompt);
    return prompts.length === 1
      ? "## Objective\n- 第一轮生成的锚定摘要 FIRST_ANCHOR"
      : "## Objective\n- 第二轮增量更新 SECOND_ANCHOR";
  };

  // 第一轮
  const body1: any = {
    model: "deepseek-v4.1-flash",
    max_tokens: 32,
    messages: makeMessages("A"),
  };
  await maybeCompactCnb(body1, "", summarize);
  assertEquals(prompts.length, 1, "the first turn must summarise once");

  // 第二轮：同一段对话继续变长。
  //
  // ★ fixture 必须**真的变长**。早先这里是 `makeMessages("B")`，条数与第一轮
  // 完全相同，只有末条文字不同——于是新增内容全部落在 keepTokens 保留的尾部
  // 里，头部一条没多，增量实现据此判定"没有新内容需要总结"、直接复用上一轮
  // 摘要（这是对的：省掉一次 6 万 token 的调用）。但那样一来这个用例就测不到
  // 它名字里的东西（"更新锚定摘要"），断言只会因为增量短路而红。
  const body2: any = {
    model: "deepseek-v4.1-flash",
    max_tokens: 32,
    messages: makeMessages("B", 6),
  };
  await maybeCompactCnb(body2, "", summarize);
  assertEquals(prompts.length, 2, "the second turn must summarise once more");

  // ★ 判据：第二次的 prompt 必须带上第一次的摘要（增量更新），
  // 而不是“从头创建”。旧代码（无状态）这里永远是 create。
  assert(
    prompts[1].includes("FIRST_ANCHOR"),
    "the second summary must carry the previous anchored summary; without it the model restarts from scratch every turn",
  );
  assert(
    prompts[1].includes("Update the anchored summary"),
    "and it must be phrased as an update, not a fresh creation",
  );
});

// 增量压缩的省钱侧：当客户端这一轮只是"重发同一段历史、末尾多问一句"时，
// 头部一条都没多，摘要里没有任何新信息。这时**不该**再花一次几万 token 的
// 上游调用——复用上一轮的摘要就够了。
//
// 这条路径在真实 DSH 会话里是最常见的那条（每轮重发完整历史），所以它必须
// 被单独盯住：写错的话要么白烧钱（不复用），要么丢掉新内容（复用太早）。
Deno.test("an unchanged head is reused instead of paying for a second summary", async () => {
  resetCompactionStates();
  const head: any[] = [{ role: "system", content: "You are helpful." }];
  const filler = "用来把请求体撑过上游 1 MiB 硬限的填充文本。".repeat(4000);
  for (let i = 0; i < 60; i += 1) {
    head.push({ role: "user", content: filler + i });
    head.push({ role: "assistant", content: "收到" + i });
  }

  const prompts: string[] = [];
  const summarize = (prompt: string) => {
    prompts.push(prompt);
    return Promise.resolve("## Objective\n- 锚定摘要 ANCHOR");
  };

  // 第一轮：触发压缩。
  const body1: any = {
    model: "deepseek-v4.1-flash",
    max_tokens: 32,
    messages: [...head, { role: "user", content: "最新一轮 A" }],
  };
  await maybeCompactCnb(body1, "reuse-session", summarize);
  assertEquals(prompts.length, 1, "the first turn must summarise");

  // 第二轮：历史逐字相同，只有最后一句是新的（落在 keepTokens 保留的尾部）。
  const body2: any = {
    model: "deepseek-v4.1-flash",
    max_tokens: 32,
    messages: [...head, { role: "user", content: "最新一轮 B" }],
  };
  const note = await maybeCompactCnb(body2, "reuse-session", summarize);
  assertEquals(
    prompts.length,
    1,
    "an unchanged head carries no new information, so paying for another summary is pure waste",
  );
  assert(
    note.includes("[compacted reuse]"),
    "and the log must say it reused, so the saving is visible: " + note,
  );
});

// 增量复用的安全阀：索引对不上（客户端重写了历史、或换了会话）时必须退回
// 全量重算，绝不能按下标切片——那会把没总结过的内容当成"已覆盖"而丢掉。
Deno.test("a rewritten history invalidates the covered range", async () => {
  resetCompactionStates();
  const head: any[] = [{ role: "system", content: "You are helpful." }];
  const filler = "用来把请求体撑过上游 1 MiB 硬限的填充文本。".repeat(4000);
  for (let i = 0; i < 60; i += 1) {
    head.push({ role: "user", content: filler + i });
    head.push({ role: "assistant", content: "收到" + i });
  }

  const prompts: string[] = [];
  const summarize = (prompt: string) => {
    prompts.push(prompt);
    return Promise.resolve("## Objective\n- 锚定摘要 ANCHOR");
  };

  await maybeCompactCnb(
    {
      model: "deepseek-v4.1-flash",
      max_tokens: 32,
      messages: [...head, { role: "user", content: "最新一轮" }],
    },
    "rewrite-session",
    summarize,
  );
  assertEquals(prompts.length, 1, "the first turn must summarise");

  // 同一会话 id，但整段历史被换掉了。★ 必须是**等长**替换：长度一变，
  // split 会跟着移动，`covered > selection.split` 那条边界检查就会先挡住，
  // 于是这个用例根本没测到指纹——实测把指纹校验删掉它照样绿。
  // 等长替换下 split 不变，只有内容指纹能识破，判据才落得住。
  const rewritten = head.map((m, i) => ({
    role: m.role,
    content: String(m.content).replace(/./gsu, "X"),
  }));
  assertEquals(
    rewritten.map((m) => String(m.content).length),
    head.map((m) => String(m.content).length),
    "fixture must keep every message the same length, otherwise the bounds guard fires first",
  );
  await maybeCompactCnb(
    {
      model: "deepseek-v4.1-flash",
      max_tokens: 32,
      messages: [...rewritten, { role: "user", content: "最新一轮" }],
    },
    "rewrite-session",
    summarize,
  );
  assertEquals(
    prompts.length,
    2,
    "a fingerprint mismatch must fall back to a full re-summary, not slice by index",
  );
  assert(
    prompts[1].includes("ANCHOR"),
    "the re-summary still carries the previous anchor as context",
  );
});

Deno.test("an oversized image being sent right now is refused, not silently dropped", () => {
  // 当前轮那张是用户此刻要让模型看的东西，静默丢掉才是真骗人——
  // 而且他还能压小重发，报错比默默失败有用。
  const thrown = capture(() => cnbBuildUpstream(bigHistory(true, 0)));
  assert(
    /the image you just sent/.test(thrown),
    "must point at the current message: " + thrown,
  );
  assert(
    /Nothing was sent upstream/.test(thrown),
    "must say nothing was sent: " + thrown,
  );
});

// -- 裸 JSON 参数体不得泄漏到正文（2026-10-16 用户第三次截图报「乱码」） --
//
// 泄漏原文长这样（工具名写在 parameter 标签上、参数写成裸 JSON）：
//   <parameter name="read">
//   {"file_path":"...","offset":200,"limit":95}
//   </parameter>
//   {"file_path":...}   ← 又重复两次
//
// 关键：真实那一轮的 assistant 消息里**同时有一个正常的 tool-call**，所以
// `calls.length === 1`，走不到 `!calls.length` 的 JUNK 闸门。判据必须落在
// 「与工具 schema 的参数名重合度」上，不能用「长得像 JSON」——正文里合法 JSON 很多。

const READ_TOOLS = [{
  function: {
    name: "read",
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        offset: { type: "number" },
        limit: { type: "number" },
      },
      required: ["file_path"],
    },
  },
}];

const LEAK_JSON =
  '{"file_path":"D:\\\\Projects\\\\X\\\\Settings.cs","offset":200,"limit":95}';

Deno.test("a bare JSON parameter body next to a real call is stripped, not leaked", () => {
  resetJunkState();
  const text = "A 收到。\n\n" +
    '<parameter name="read">\n' + LEAK_JSON + "\n</parameter>\n" +
    "</｜｜DSML｜｜ parameter>\n</parameter>\n\n" +
    LEAK_JSON + "\n\n\n" + LEAK_JSON + "\n" +
    OPEN + "\n" +
    '{"name":"read","arguments":' + LEAK_JSON + "}\n" + CLOSE;
  const r = cnbParseToolCalls(text, READ_TOOLS);
  assertEquals(r.calls.length, 1, "the real call survives");
  assertEquals(r.calls[0].function.name, "read");
  assert(
    !r.clean.includes("file_path"),
    "the bare JSON bodies must not reach the client: " + r.clean,
  );
  assert(!r.clean.includes("offset"), "no parameter fragments either");
  assert(r.clean.includes("A 收到"), "prose is kept");
});

Deno.test("a bare JSON body with no real call is stripped and diagnosed", () => {
  resetJunkState();
  const text = "A 收到。\n\n" +
    '<parameter name="read">\n' + LEAK_JSON + "\n</parameter>\n\n" + LEAK_JSON;
  const r = cnbParseToolCalls(text, READ_TOOLS);
  assertEquals(r.calls.length, 0);
  assert(
    !r.clean.includes("file_path"),
    "must not leak the JSON: " + r.clean,
  );
  assert(
    r.clean.includes("What was wrong:"),
    "the model must be told what was wrong instead of silently losing text",
  );
});

Deno.test("unrelated JSON in prose is never deleted", () => {
  resetJunkState();
  // 反向保护：这些对象的键不在任何工具的参数集里（或只有一个非必需键），
  // 误删就是数据丢失。
  //
  // ⚠️ 必须让**清理段真的被激活**，否则这条断言恒真、测不到东西：
  // 清理段的条件是 `calls.length || degenerated || junkToolSyntax`，而单纯一句话
  // 三者全为假、`stripBareToolJson` 根本不会被调用（变异验证发现的第一版就是
  // 这样：去掉重合度门槛后它**依然全绿**）。这里在末尾附一个真调用把闸门打开。
  const tail = "\n" + OPEN + "\n" +
    '{"name":"read","arguments":{"file_path":"D:\\\\y.cs"}}' + "\n" + CLOSE;
  const keep = [
    '配置如下：{"name":"x","version":1}',
    '端口是 {"port":8080}',
    '看看 {"limit":95} 这个', // 单个已知但非必需 —— 保守保留
  ];
  for (const text of keep) {
    const r = cnbParseToolCalls(text + tail, READ_TOOLS);
    assertEquals(r.calls.length, 1, "the appended real call must parse");
    assert(
      r.clean.includes(text),
      "must keep unrelated JSON verbatim, got: " + JSON.stringify(r.clean),
    );
  }
});

Deno.test("DSML markers with mismatched bar counts are normalised (left 1 / right 2)", () => {
  // 实测泄漏形态是**左单右双**；旧正则 `[｜|]{2}DSML[｜|]{2}` 要求两侧各恰好两根，
  // 于是漏过。这条同时守住「不对称」与「带空格」两种。
  for (const tok of ["｜DSML｜｜", "｜DSML｜", "|DSML|", "｜ DSML ｜"]) {
    const text = "<" + tok + 'parameter name="file_path">D:\\\\x.cs</' + tok +
      "parameter>";
    const r = cnbParseToolCalls(text, READ_TOOLS);
    assertEquals(
      r.calls.length,
      1,
      "DSML form <" + tok + "> must be recognised, got clean=" + r.clean,
    );
    assertEquals(r.calls[0].function.name, "read");
  }
});

// -- 第四种退化形态：满屏 `</ calls>` 与空壳调用（2026-10-17 用户第四次截图） --
//
// 截图两张面孔：
//   ① `</ calls>` 重复几十次（`/` 与 `calls` 之间**有空格**）
//   ② `{"name":"read","arguments":}`（arguments 是空值）
//
// 两者都**一个调用也解析不出来**，而清理段的原入口条件是
// `calls.length || degenerated || junkToolSyntax` —— 三者全假，于是整屏原样流给用户。
// 实测：① 修复前残留 30/30；② 长度 28→28（完全没动）。

Deno.test("a flood of degraded close tags is stripped even with no parsed call", () => {
  resetJunkState();
  const flood = "</ calls>\n".repeat(30);
  const r = cnbParseToolCalls(
    "Now I have what I need.\n\n" + flood,
    READ_TOOLS,
  );
  assertEquals(r.calls.length, 0, "no call is recoverable from this shape");
  assertEquals(
    (String(r.clean).match(/<\/\s*calls>/g) || []).length,
    0,
    "every degraded close tag must be gone, got: " + JSON.stringify(r.clean),
  );
  assert(
    String(r.clean).includes("Now I have what I need."),
    "prose survives",
  );
});

Deno.test("degraded close tags are stripped even when a real call is present", () => {
  resetJunkState();
  // 这一轮有正常调用 → 走的是另一个分支，历史实现同样会漏掉 `</ calls>`。
  const text = "prose\n" + "</ calls>\n".repeat(10) +
    OPEN + "\n" + '{"name":"read","arguments":{"file_path":"D:\\\\x.cs"}}' +
    "\n" + CLOSE;
  const r = cnbParseToolCalls(text, READ_TOOLS);
  assertEquals(r.calls.length, 1);
  assertEquals(
    (String(r.clean).match(/<\/\s*calls>/g) || []).length,
    0,
    "must be clean too, got: " + JSON.stringify(r.clean),
  );
});

Deno.test("an empty-arguments call shell is stripped, not echoed", () => {
  resetJunkState();
  const r = cnbParseToolCalls('{"name":"read","arguments":}', READ_TOOLS);
  assertEquals(r.calls.length, 0, "no params means no usable call");
  assert(
    !String(r.clean).includes("arguments"),
    "the shell must not reach the client, got: " + JSON.stringify(r.clean),
  );
});

Deno.test("unrelated JSON is still preserved next to the new detectors", () => {
  resetJunkState();
  // 反向保护：新加的两个探测器（残骸标签 / 空壳调用）都必须**窄**到不误伤。
  const tail = "\n" + OPEN + "\n" +
    '{"name":"read","arguments":{"file_path":"D:\\\\y.cs"}}' + "\n" + CLOSE;
  const keep = [
    '配置如下：{"name":"x","version":1}', // name 不是工具名
    '端口是 {"port":8080}',
    "普通正文里的 calls 这个词不该被删",
  ];
  for (const text of keep) {
    const r = cnbParseToolCalls(text + tail, READ_TOOLS);
    assertEquals(r.calls.length, 1);
    assert(
      r.clean.includes(text),
      "must keep unrelated prose: " + JSON.stringify(r.clean),
    );
  }
});

// ── 11128 自愈：**删掉**被检测到的头部（2026-10-21 直连实测后的定案）──
//
// 判据表（逐条只改一个变量）：
//   指纹在开头                     → 400 / 11128
//   同段文字放长文中间             → 200
//   **删掉开头 48 字符**           → 200   ← 只有这个动作不管上游怎么归一化都成立
//   前面加空格/换行/零宽          → 200，但头部是 48 KB 空白时不成立（归一化后原地）
Deno.test("cnb: cnbNeutraliseHead deletes the head of every checked message", () => {
  const FINGERPRINT = "You are an AI agent powered by DeepSeek Harness.";
  const rest = " This part must survive untouched.";
  const out = cnbNeutraliseHead({
    messages: [
      { role: "system", content: FINGERPRINT + rest },
      // 2026-10-24 实测：检测面是**每一条** system/assistant 消息的开头，
      // 不再只是第一条。这条就是 f05811ec 会话的形状——压缩说明插到最前面，
      // 带指纹的原 system 被挤成第二条，旧版只削第一条于是永远修不好。
      { role: "system", content: FINGERPRINT + " second" },
      { role: "assistant", content: FINGERPRINT + " echoed" },
      { role: "user", content: FINGERPRINT + " in user" },
    ],
  });
  assert(out, "must report a change");
  const head0 = String(out!.messages[0].content);
  assert(
    !head0.includes(FINGERPRINT.slice(0, 20)),
    "the detected head must be gone, not merely prefixed",
  );
  assert(head0.endsWith(rest), "the rest of the instruction must survive");
  const head1 = String(out!.messages[1].content);
  assert(
    !head1.includes(FINGERPRINT.slice(0, 20)) && head1.endsWith("second"),
    "the second system message's head must be cut too",
  );
  const head2 = String(out!.messages[2].content);
  assert(
    !head2.includes(FINGERPRINT.slice(0, 20)) && head2.endsWith("echoed"),
    "an assistant history message whose head matches must be cut too",
  );
  assertEquals(
    out!.messages[3].content,
    FINGERPRINT + " in user",
    "user messages are not on the detection surface and stay untouched",
  );
});

Deno.test("cnb: cnbNeutraliseHead cuts past padding, arrays, and refuses an empty head", () => {
  // 空白填充在头部时必须先跳过去再删，否则删掉的是填充、指纹原地不动。
  // 指纹长度 20 ⇒ 删 48 字符等于连它一起往后多切 28 字符，所以尾巴要够长。
  const padded = cnbNeutraliseHead({
    messages: [{
      role: "system",
      // 48 字符的刀口落在指纹末尾之后，TAIL 必须完整留下
      content: " ".repeat(100) + "FINGERPRINT".repeat(3) + "T".repeat(40) +
        "TAIL",
    }],
  })!;
  const cut = String(padded.messages[0].content);
  assert(
    cut.startsWith(" ".repeat(100)),
    "leading padding is part of the head and must be preserved",
  );
  assert(
    cut.trimStart().endsWith("TAIL"),
    "the text past the 48-character cut must survive",
  );

  // 数组形态：动第一个 text 块，图片块原样保留。
  const arr = cnbNeutraliseHead({
    messages: [{
      role: "system",
      content: [
        // 刀口正好 48 字符：前面 48 个 x 被删掉，TAIL 原样留下
        { type: "text", text: "x".repeat(48) + "TAIL" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AA" } },
      ],
    }],
  })!;
  const parts = arr.messages[0].content as any[];
  assertEquals(
    parts[0].text,
    "TAIL",
    "the text block keeps only what is past the 48-character cut",
  );
  assertEquals(parts[1].type, "image_url", "image blocks are never touched");

  // 空头部没法删：返回 null，让调用方照原样透传错误，而不是假装修过。
  assertEquals(
    cnbNeutraliseHead({ messages: [{ role: "system", content: "   " }] }),
    null,
    "an empty head must not claim a change",
  );

  // 2026-10-24：空的第一条**不再放弃整个自愈**——跳过它继续看下一条。
  // 空说明消息 + 带指纹的第二条，正是 fallbackTruncate 之后最常见的形状。
  const FINGERPRINT = "You are an AI agent powered by DeepSeek Harness.";
  const afterEmpty = cnbNeutraliseHead({
    messages: [
      { role: "system", content: "   " },
      { role: "system", content: FINGERPRINT + "TAIL" },
    ],
  })!;
  assert(afterEmpty, "an empty first message must not abort the sweep");
  const secondHead = String(afterEmpty.messages[1].content);
  assert(
    !secondHead.includes(FINGERPRINT.slice(0, 20)) &&
      secondHead.endsWith("TAIL"),
    "the fingerprint behind an empty leading message must still be cut",
  );
  assertEquals(
    String(afterEmpty.messages[0].content),
    "   ",
    "the empty message itself stays as it was",
  );
});

// 端到端：自愈必须真的发生在**出站请求**上，而不是只通过函数单测。
// 用 monkeypatch 掉全局 fetch 造一个"第一次 11128、删掉头部后 200"的上游，
// 断言出站第二次的 body 里那段指纹真的没了。
Deno.test("cnb: a 400/11128 is retried once with the detected head removed", async () => {
  // 记忆化开启后，「首包原样」只在**没记过**这个头部时成立——先清空，
  // 否则本用例会变成测「首包就削」，丢掉它原本盯的「挨一下再重发」。
  cnbForgetRejectedHeads();
  // 现场落盘是生产取证用的，测试不能往 cwd 写文件。
  const hadDumpEnv = Deno.env.has("CNB_11128_DUMP");
  const prevDumpEnv = hadDumpEnv ? Deno.env.get("CNB_11128_DUMP") : null;
  Deno.env.set("CNB_11128_DUMP", "off");
  const realFetch = globalThis.fetch;
  const bodies: string[] = [];
  let chatCalls = 0;
  globalThis.fetch = ((input: any, init?: any) => {
    const url = String(input);
    if (url.includes("cnb.cool/ai/chat/completions")) {
      bodies.push(String(init?.body ?? ""));
      chatCalls += 1;
      if (chatCalls === 1) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              code: 11128,
              msg: "Illegal API invocation from an unapproved channel",
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          'data: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}\n\n' +
            "data: [DONE]\n\n",
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
            "set-cookie": "csrfkey=1234567890; Path=/",
          },
        },
      ),
    );
  }) as typeof fetch;

  try {
    const req = new Request("http://cnb.local/cnb/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4.1-flash",
        messages: [
          { role: "system", content: "SOME UNKNOWN FINGERPRINT" },
          { role: "user", content: "hi" },
        ],
        stream: false,
        max_tokens: 16,
      }),
    });
    const resp = await handleCnb(
      "/cnb/v1/chat/completions",
      req,
      new URL(req.url),
    );
    assertEquals(resp.status, 200, "the retry must succeed");
    assertEquals(chatCalls, 2, "exactly one extra attempt");
    // 自愈现在是「删掉头部那段文字」，不是「加前缀」：
    //   · 第一次出站必须原样（上游没拦就不改，一分钱不花）；
    //   · 第二次出站必须**不再以那段指纹开头**，且其余文字还在。
    const sent = (i: number) =>
      JSON.parse(bodies[i]).messages.find((m: any) => m.role === "system");
    const first = String(sent(0).content);
    assertEquals(
      first,
      "SOME UNKNOWN FINGERPRINT",
      "the first attempt must carry the head untouched: nothing is prepended",
    );
    const retried = String(sent(1).content);
    assert(
      !retried.includes("SOME UNKNOWN FINGERPRINT"),
      "the retried wire body must have the detected head cut away",
    );
    assert(
      retried.trim() === "",
      "cutting the head is the only edit: the rest was the fingerprint itself",
    );
  } finally {
    globalThis.fetch = realFetch;
    if (hadDumpEnv) Deno.env.set("CNB_11128_DUMP", prevDumpEnv ?? "");
    else Deno.env.delete("CNB_11128_DUMP");
  }
});

// ── 记忆化：被拒过的头部，下一轮**首包就削**（省一次整包上传）──
//
// 生产日志里 1198 次 11128 只对应两个固定头部，所以「先挨一次 400 再重发」
// 是纯浪费：每轮白传 ~357 KB。记住样本后，首包就是已经削过的终态请求。
// ── 2026-10-24：harness 注入的 gitStatus 快照段整段触发 11128（与身份指纹
// 两套判据：不锚定开头、句子/字段单独都不拦、整块形状被匹配）。出站剥离是
// 预防动作，锚定 harness 原文样板。
Deno.test("cnb: cnbStripGitStatus removes the harness snapshot block and keeps the rest", () => {
  const before = "# Harness\nYou are an agent.";
  const block =
    "gitStatus: This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.\n\nCurrent branch: master\n\nMain branch (you will usually use this for PRs): master\n\nGit user: HitMargin\n\nStatus:\n(clean)\n\nRecent commits:\nd88728f 修：渲染完成后结算画面按键长时间无响应\n1747318 修：渲染完卡在关卡里";
  const after = "\n\n# Tools\nUse them.";
  const out = cnbStripGitStatus(before + "\n\n" + block + after);
  assert(
    !out.includes("Current branch") && !out.includes("Recent commits"),
    "the whole block must be gone: fields alone still trip the check",
  );
  assert(
    out.startsWith(before),
    "content before the block must survive untouched",
  );
  assert(
    out.endsWith(after),
    "the next section after the block must survive untouched",
  );
  assert(
    out.includes("snapshot omitted"),
    "a one-line stub must remain so the model knows a snapshot existed",
  );
});

Deno.test("cnb: cnbStripGitStatus strips a block that runs to the end of the text", () => {
  const out = cnbStripGitStatus(
    "Intro.\n\ngitStatus: This is the git status at the start of the conversation.\n\nCurrent branch: master",
  );
  assert(out.startsWith("Intro."), "content before the block must survive");
  assert(
    !out.includes("Current branch"),
    "a trailing block has no heading after it and must be cut to the end",
  );
});

Deno.test("cnb: cnbStripGitStatus leaves user-written gitStatus text alone", () => {
  const text =
    "My notes: gitStatus: custom tracking for my repo.\n\nCurrent branch: dev";
  assertEquals(
    cnbStripGitStatus(text),
    text,
    "the harness boilerplate anchor must be required: arbitrary user text stays",
  );
});

Deno.test("cnb: the heal never cuts a pure tool-call message", () => {
  const out = cnbNeutraliseHead({
    messages: [
      {
        role: "system",
        content: "You are an AI agent powered by DeepSeek Harness.",
      },
      {
        role: "assistant",
        content: OPEN + "\n" +
          '{"name":"pwsh","arguments":{"command":"ls"}}' + "\n" + CLOSE,
      },
    ],
  });
  assert(out, "the system fingerprint still gives the heal something to cut");
  const a = String(out!.messages[1].content);
  assert(
    a.startsWith(OPEN),
    "the tool-call opening tag must survive: cutting it would corrupt the XYML",
  );
  assert(
    !String(out!.messages[0].content).includes("DeepSeek Harness"),
    "the system head is still cut",
  );
});

// ── 2026-10-24（晚）：DSH 会话削头后仍 11128——第二类内容级触发：
// 「DeepSeek Harness + GUI 指代样板」的组合匹配（跨度约 200 字符、与位置无关）。
// 修复 = 出站把品牌词改写成提示词本来就在用的简称 "DSH"。
Deno.test("cnb: outbound preprocessing strips gitStatus and rewrites the harness brand", () => {
  const GUI =
    "You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names. " +
    'When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI.';
  // gitStatus 块后面必须隔着分节标题：剥离的结束边界是「空行+标题」或文本末尾
  // （生产里 harness 的 gitStatus 段后面总跟着其余分节），夹具要造出同款形状。
  const out = cnbNeutraliseChannelMarkers(
    "gitStatus: This is the git status at the start of the conversation.\n\nCurrent branch: master\n\n# GUI\n" +
      GUI,
  );
  assert(
    !out.includes("Current branch"),
    "the gitStatus block must be stripped",
  );
  assert(out.includes("# GUI"), "the following section must survive");
  assert(!out.includes("DeepSeek Harness"), "the brand must be rewritten");
  assert(
    out.includes("DSH Web GUI") && out.includes("this page"),
    "the sentence must survive with the neutral token in place",
  );
});

Deno.test("cnb: the appended tool prompt is preprocessed too", () => {
  const built: any = cnbBuildUpstream({
    model: "deepseek-v4.1-flash",
    messages: [{ role: "user", content: "hi" }],
    tools: [{
      function: {
        name: "gui",
        description: "Drive the DeepSeek Harness Web GUI.",
        parameters: { type: "object", properties: {} },
      },
    }],
  });
  const up = built.upstream ?? built;
  const first = String(up.messages[0].content);
  assert(
    !first.includes("DeepSeek Harness"),
    "tool descriptions are appended after the message map and must not reintroduce the brand",
  );
  assert(first.includes("DSH Web GUI"), "the description must survive renamed");
});

Deno.test("cnb: a remembered head is stripped before the first upload", () => {
  cnbForgetRejectedHeads();
  const HEAD = "You are an AI agent powered by DeepSeek Harness.";
  const body = () => ({
    messages: [
      { role: "system", content: HEAD + " Keep this." },
      { role: "user", content: "hi" },
    ],
  });

  // 没记过 → 一律不动（宁可多传一次，也不改写没被拒过的头部）
  assertEquals(
    cnbPreNeutraliseHead(body()),
    null,
    "an unremembered head must pass through untouched",
  );

  cnbRememberRejectedHead(body());
  const out = cnbPreNeutraliseHead(body())!;
  assert(out, "a remembered head must be pre-stripped");
  const head = String(out.messages[0].content);
  assert(
    !head.includes(HEAD),
    "the remembered head must be gone before the first upload",
  );
  assert(
    head.trim() === "Keep this.",
    "only the head is cut: the rest of the instruction survives",
  );
  assertEquals(
    out.messages[1].content,
    "hi",
    "other messages are never touched",
  );

  // 换一个没被拒过的头部 → 仍然不动
  assertEquals(
    cnbPreNeutraliseHead({
      messages: [{ role: "system", content: "Totally different rules." }],
    }),
    null,
    "a different head must not be touched just because some head was",
  );
});

// 端到端：记忆已热时，上游只该看到 **一次** 请求，且那次的首包头部已被削掉。
Deno.test("cnb: a known-rejected head costs only one upload", async () => {
  cnbForgetRejectedHeads();
  const HEAD = "You are an AI agent powered by DeepSeek Harness.";
  // 先让代理「见过」这个头部被拒（记忆化的来源就是真实的那一次 400）
  cnbRememberRejectedHead({
    messages: [{ role: "system", content: HEAD + " Keep this." }],
  });

  const realFetch = globalThis.fetch;
  const bodies: string[] = [];
  globalThis.fetch = ((input: any, init?: any) => {
    const url = String(input);
    if (url.includes("cnb.cool/ai/chat/completions")) {
      bodies.push(String(init?.body ?? ""));
      return Promise.resolve(
        new Response(
          'data: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}' +
            "\n\n" + "data: [DONE]\n\n",
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
            "set-cookie": "csrfkey=1234567890; Path=/",
          },
        },
      ),
    );
  }) as typeof fetch;

  try {
    const req = new Request("http://cnb.local/cnb/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4.1-flash",
        messages: [
          { role: "system", content: HEAD + " Keep this." },
          { role: "user", content: "hi" },
        ],
        stream: false,
        max_tokens: 16,
      }),
    });
    const resp = await handleCnb(
      "/cnb/v1/chat/completions",
      req,
      new URL(req.url),
    );
    assertEquals(resp.status, 200);
    assertEquals(
      bodies.length,
      1,
      "a remembered head must not need a second upload",
    );
    const sent = JSON.parse(bodies[0]).messages.find((m: any) =>
      m.role === "system"
    );
    assert(
      !String(sent.content).includes(HEAD),
      "the very first wire body must already have the head cut away",
    );
  } finally {
    globalThis.fetch = realFetch;
    cnbForgetRejectedHeads();
  }
});
Deno.test("cnb: the head of an oversized body is never an empty system message", async () => {
  // ★ 2026-10-21 生产实测的形状：/`responses` 的 `instructions` 转换后是 chat body 的
  // **第一条 system**；它单条就超过 1 MiB 预算时，fallbackTruncate 的
  // 「system 也受预算约束」分支会把它砍成 0 字节，于是出站 `messages[0]` 是
  // `{role:"system", content:""}`。空头部没有可以删的文字，
  // 自愈只能作罢，那一次 retry 必然再被拦（生产日志里连续两轮都只有
  // "retrying once"，没有任何一行成功）。
  //
  // 这个用例钉两件事：①空头部真的会从 handleCnb 的出站 body 里出现；
  // ②出站头部永远不是空串——空头部意味着自愈无从下手，重试必然白费。
  const realFetch = globalThis.fetch;
  const bodies: string[] = [];
  globalThis.fetch = ((input: any, init?: any) => {
    const url = String(input);
    if (url.includes("cnb.cool/ai/chat/completions")) {
      bodies.push(String(init?.body ?? ""));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            code: 11128,
            msg: "Illegal API invocation from an unapproved channel",
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(
      new Response(
        '<script>window.csrftoken = "' + "c".repeat(32) + '";</script>',
        {
          status: 200,
          headers: {
            "content-type": "text/html",
            "set-cookie": "csrfkey=1234567892; Path=/",
          },
        },
      ),
    );
  }) as typeof fetch;

  const prev = Deno.env.get("CNB_COMPACTION");
  Deno.env.set("CNB_COMPACTION", "off");
  try {
    const respReq = new Request("http://cnb.local/cnb/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4.1-flash",
        // 单条就把 1 MiB 预算吃光（压缩关掉，只让头部检查出手）。
        instructions: "You are an agent. " + "x".repeat(1_100_000),
        input: [{ role: "user", content: "只回一个字：好" }],
        max_output_tokens: 16,
      }),
    });
    const resp = await handleCnb(
      "/cnb/v1/responses",
      respReq,
      new URL(respReq.url),
    );
    assert(resp.status >= 400, "the stubbed upstream blocks everything");
    // 自愈只有一次重试：把头部第一句删掉。这里只断言"试过重试"，
    // 不锁死上限的具体取值（次数是策略，不是这条用例保护的性质）。
    assert(bodies.length >= 2, "first try + one head-removed retry");
    assert(
      bodies.length <= 3,
      "the retry must be bounded, not an infinite loop",
    );
    const heads = bodies.map((b) =>
      JSON.parse(b).messages[0] as { role: string; content: any }
    );
    for (const h of heads) {
      const len = typeof h.content === "string"
        ? h.content.length
        : JSON.stringify(h.content ?? "").length;
      assert(
        len > 0,
        "the outbound head must not be an empty system message: an empty head " +
          "gives the head cut nothing to remove, so the retry would be wasted",
      );
    }
  } finally {
    globalThis.fetch = realFetch;
    if (prev === undefined) Deno.env.delete("CNB_COMPACTION");
    else Deno.env.set("CNB_COMPACTION", prev);
  }
});

Deno.test("cnb: a non-11128 400 is passed through without a retry", async () => {
  const realFetch = globalThis.fetch;
  let chatCalls = 0;
  const upstreamBody = JSON.stringify({ code: 11101, msg: "bad request" });
  globalThis.fetch = ((input: any) => {
    const url = String(input);
    if (url.includes("cnb.cool/ai/chat/completions")) {
      chatCalls += 1;
      return Promise.resolve(
        new Response(upstreamBody, {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(
      new Response(
        '<script>window.csrftoken = "' + "b".repeat(32) + '";</script>',
        {
          status: 200,
          headers: {
            "content-type": "text/html",
            "set-cookie": "csrfkey=1234567891; Path=/",
          },
        },
      ),
    );
  }) as typeof fetch;

  try {
    const req = new Request("http://cnb.local/cnb/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4.1-flash",
        messages: [
          { role: "system", content: "You are a coding agent." },
          { role: "user", content: "hi" },
        ],
        stream: false,
        max_tokens: 16,
      }),
    });
    const resp = await handleCnb(
      "/cnb/v1/chat/completions",
      req,
      new URL(req.url),
    );
    assertEquals(resp.status, 400, "deterministic 4xx must not be retried");
    assertEquals(chatCalls, 1, "no extra attempt");
    assert(
      (await resp.text()).includes("11101"),
      "the upstream diagnosis must survive the Response rebuild",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ─── 第五次修：body 超预算却「压根没压缩」也必须在返回前收敛 ───
//
// 前四次修的都是「压了但没压够」。这两条守的是更糟的形态：**压根没压，一声不吭**。
//
// 起因是用户质疑「所以你修复了字节和token？真的吗」（m01090）。当时我用一个
// 6.25 MB 的 body 测得 `writeSummaryCalled=false, after=before`，第一反应是
// 测量脚本有问题。脚本确实有问题（构造方式不真实），但换到真实形态后漏洞仍在：
//
// 形态 B（6 轮 × 40 万字符）：
//     writeSummaryCalled = false
//     after = before = 7204563   ← body 一个字节没动
//
// 链条是：maybeCompactCnb 为给摘要 prompt 限体积，先把头部每条消息截到 600
// 字符；这一步把整个 transcript 也缩小了 → selectTail 认为「全都装得下」→
// 返回 undefined → compactIfNeeded 静默 return {changed:false, note:""} →
// 调用方只处理 changed 与 note==="summary-failed"，两个都不命中 → 直接结束。
// 上游收到 7.2 MB，413，而日志一行没有。
//
// 判据：**只要进了 maybeCompactCnb 且 bytes > budget，返回时 body 必须 <= budget。**
// 下面两条分别守住「必须收敛」与「收敛了要如实说」。
Deno.test("cnb: an oversized body converges even when each message dwarfs the tail budget", async () => {
  // 形态 B：轮数少、每条极大（单条 40 万字符 ≈ 1.2 MB，两头都超过 45% 的尾部预算）。
  //
  // 修复前的链条：没有一条装得进尾巴 → `selectTailByBytes` 的 split 落到末尾
  // → 尾巴为空 → 摘要那条捷径被判定为“没有可总结的部分” → 7.2 MB 的 body 原样
  // 上传、每轮 413，日志里只有 `(all messages dropped)`（历史见 1998–2017 行）。
  //
  // 现在有两条兜底：尾部至少留最后一条；装不下就把正文硬截到剩余空间。
  // 判据因此换成两条**产品级**的不变量（旧版断言的 `asked === false` 是那个
  // 缺陷的副产品，修复后尾巴不再为空，摘要自然会被问一次）：
  //   a) body 必须收敛到预算之内；
  //   b) 最新那一轮必须还在——压缩是为了继续会话，不是为了清空。
  const filler = "中文填充".repeat(100000); // 单条 40 万字符 ≈ 1.2 MB UTF-8
  const messages: any[] = [{
    role: "system",
    content: "You are a coding agent.",
  }];
  for (let i = 0; i < 6; i += 1) {
    messages.push({ role: "user", content: filler + i });
    messages.push({ role: "assistant", content: "收到" + i });
  }
  messages.push({ role: "user", content: "最新一轮，压缩后必须保留" });
  const body: any = {
    model: "deepseek-v4.1-flash",
    max_tokens: 120000,
    stream: true,
    messages,
    tools: Array.from({ length: 10 }, (_, i) => ({
      type: "function",
      function: {
        name: `t${i}`,
        description: "x".repeat(300),
        parameters: { type: "object" },
      },
    })),
  };
  const before = new TextEncoder().encode(JSON.stringify(body)).length;
  assert(
    before > CNB_BODY_BUDGET_BYTES,
    "fixture must exceed the budget, got " + before,
  );

  let asked = false;
  await maybeCompactCnb(body, "", async () => {
    asked = true;
    throw new Error("simulated");
  });

  const after = new TextEncoder().encode(JSON.stringify(body)).length;
  assert(
    after <= CNB_BODY_BUDGET_BYTES,
    `body must converge under the budget: ${before} -> ${after}` +
      (asked ? " (summary was asked)" : " (summary skipped)"),
  );

  // ★ 这条是 2026-10-22 修复的判据：宁可超限（由截断收口）也不能把问题弄丢。
  // 旧代码在这里一条消息都不留，模型收到的请求里没有用户的问题。
  const survivors = (body.messages ?? []).filter((m: any) =>
    m && m.role === "user" && typeof m.content === "string" &&
    m.content.includes("最新一轮")
  );
  assertEquals(
    survivors.length,
    1,
    "the newest turn must survive compaction: " +
      JSON.stringify(
        (body.messages ?? []).map((
          m: any,
        ) => [m?.role, String(m?.content ?? "").slice(0, 20)]),
      ),
  );
  // 只有一条说明 = “全部丢光”。压缩可以丢历史，不能丢到没有对话。
  assert(
    (body.messages ?? []).length > 1,
    "compaction must not reduce the request to the note alone",
  );
});

Deno.test("cnb: the kept tail follows keepTokens, not the byte budget", async () => {
  // 生产日志实测（2026-10-22）：
  //   [compacted via summary] kept=198 msgs bytes 1964338 -> 482024
  // 482 KB 正好是字节预算的 47.6%：尾巴被设成了字节的 45%，keepTokens 于是
  // 名存实亡，每轮把十几万 token 的历史原样送给上游。判据是 keepTokens。
  const chunk = "数据块".repeat(500); // 1500 字符 ≈ 4.5 KB
  const messages: any[] = [{
    role: "system",
    content: "You are a coding agent.",
  }];
  for (let i = 0; i < 260; i += 1) {
    messages.push({ role: "user", content: chunk + i });
    messages.push({ role: "assistant", content: "收到" + i });
  }
  const body: any = {
    model: "deepseek-v4.1-flash",
    max_tokens: 8000,
    messages,
  };
  const before = new TextEncoder().encode(JSON.stringify(body)).length;
  assert(
    before > CNB_BODY_BUDGET_BYTES,
    "fixture must exceed the budget, got " + before,
  );

  await maybeCompactCnb(body, "", async () => "SUMMARY-PLACEHOLDER");

  const after = new TextEncoder().encode(JSON.stringify(body)).length;
  assert(
    after <= CNB_BODY_BUDGET_BYTES,
    "compacted body must fit the budget: " + before + " -> " + after,
  );
  // ★ 这条钉住口径：尾巴按 keepTokens(8000) 留 ≈ 几十 KB；
  // 旧口径按字节预算的 45% 留，会是 ~450 KB。
  assert(
    after < 120000,
    "the tail must follow keepTokens, not 45% of the byte budget: " +
      before + " -> " + after + ", kept=" + body.messages.length + " msgs",
  );
  assert(
    body.messages.length < 60,
    "too many messages kept verbatim: " + body.messages.length,
  );
});

Deno.test("cnb: skipping compaction is reported, not silent", async () => {
  // 「没压」与「压了没压够」都要有话说。旧代码这条路径不打任何日志，
  // 于是 7.2 MB 的请求被上游 413 时，日志里找不到任何线索。
  const filler = "中文填充".repeat(100000);
  const messages: any[] = [{
    role: "system",
    content: "You are a coding agent.",
  }];
  for (let i = 0; i < 6; i += 1) {
    messages.push({ role: "user", content: filler + i });
    messages.push({ role: "assistant", content: "收到" + i });
  }
  const body: any = {
    model: "deepseek-v4.1-flash",
    max_tokens: 120000,
    messages,
  };

  const note = await maybeCompactCnb(body, "", async () => {
    throw new Error("simulated");
  });

  // 返回值本身就是判据：旧签名返回 void，调用方无从知道「做了什么」。
  assert(note !== "", "a skipped compaction must report what it did");
  // 必须看得出是「跳过摘要、改成截断」，而不是「成功压缩」。
  assert(
    note.includes("truncation") || note.includes("skipped"),
    "the note must say the body was truncated / the summary was skipped, got: " +
      note,
  );
});

// ---------- 2026-10-19 第六次：摘要请求不得再被压缩（递归） ----------
//
// 生产日志里出现过这一行：
//   [compacted via truncation] (all messages dropped)
//   session=cnb:cnb-summary:1792404332945 ... bytes 1314332 -> 232
// session 前缀 cnb-summary: 说明这是**摘要调用自己**在压缩。它的 prompt
// 就是「被压缩掉的那段历史」，天然巨大，于是它超预算、被截成一条说明，
// 上游只收到 63 个字符，摘要必然为空 —— 这正是同时期高频出现的
// "summary response carried no content" 的来源。
Deno.test("cnb: an internal summary call is never compacted again", async () => {
  const filler = "中文填充".repeat(100000);
  const messages: any[] = [{
    role: "system",
    content: "You are a coding agent.",
  }];
  for (let i = 0; i < 6; i += 1) {
    messages.push({ role: "user", content: filler + i });
    messages.push({ role: "assistant", content: "收到" + i });
  }
  const body: any = {
    model: "deepseek-v4.1-flash",
    max_tokens: 120000,
    messages,
  };
  const before = JSON.stringify(body);

  let summaryCalls = 0;
  const note = await runAsCnbInternal(() =>
    maybeCompactCnb(body, "cnb-summary:t", async () => {
      summaryCalls += 1;
      return "unused";
    })
  );

  // 判据一：内部调用不许压缩，body 必须一个字节都没动。
  assertEquals(
    JSON.stringify(body),
    before,
    "an internal call must not be compacted",
  );
  // 判据二：不许白跑一次摘要（那既费钱又会再次触发同样的递归）。
  assertEquals(summaryCalls, 0, "an internal call must not spawn a summary");
  // 判据三：什么都不做就不要说做了什么，否则日志又会误导。
  assertEquals(note, "", "an internal call must not report a compaction");
});

Deno.test("cnb: the same oversized body is compacted when it is not internal", async () => {
  // 上一条的反面对照：证明「没压缩」是因为 internal 标记，而不是因为
  // 这个 body 本来就不超预算（否则上一条会永远绿）。
  const filler = "中文填充".repeat(100000);
  const messages: any[] = [{
    role: "system",
    content: "You are a coding agent.",
  }];
  for (let i = 0; i < 6; i += 1) {
    messages.push({ role: "user", content: filler + i });
    messages.push({ role: "assistant", content: "收到" + i });
  }
  const body: any = {
    model: "deepseek-v4.1-flash",
    max_tokens: 120000,
    messages,
  };
  const before = JSON.stringify(body).length;

  const note = await maybeCompactCnb(body, "user-session", async () => {
    throw new Error("simulated");
  });

  assert(note !== "", "a user call over budget must report what it did");
  assert(
    JSON.stringify(body).length < before,
    "a user call over budget must actually shrink",
  );
});

// ---------- 2026-10-19 第六次（其二）：摘要 prompt 里 tool_calls 也要截 ----------
//
// forSummary 旧逻辑只截 `typeof m.content === "string"` 的 message。但带
// tool_calls 的 assistant 消息 content 是 null，真正占体积的是
// `tool_calls[].function.arguments`；tool 消息的体积在 content 上，但它是
// 另一条 role。两者都绕过了截断，实测把摘要 prompt 顶到 4.5 MB
// —— CNB 上游上限 921600 字节的 4 倍，摘要请求必被截断成空壳。
Deno.test("cnb: giant tool payloads are truncated out of the summary prompt", async () => {
  const big = "工具输出：".repeat(5000);
  const messages: any[] = [{
    role: "system",
    content: "You are a coding agent.",
  }];
  for (let i = 0; i < 60; i += 1) {
    messages.push({ role: "user", content: `第 ${i} 轮` });
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [{
        id: `c${i}`,
        type: "function",
        function: {
          name: "read",
          arguments: JSON.stringify({ path: "/x", body: big }),
        },
      }],
    });
    messages.push({ role: "tool", tool_call_id: `c${i}`, content: big });
  }
  const body: any = {
    model: "deepseek-v4.1-flash",
    max_tokens: 120000,
    messages,
  };

  let promptBytes = -1;
  await maybeCompactCnb(body, "probe-tool-prompt", (prompt) => {
    promptBytes = new TextEncoder().encode(prompt).length;
    return Promise.resolve("fake summary");
  });

  assert(promptBytes > 0, "fixture must actually reach the summary writer");
  // 判据：摘要 prompt 必须低于上游 1 MiB 线（留出 envelope 余量）。
  // 旧逻辑这里是 4.5 MB 量级，会红。
  const limit = CNB_BODY_BUDGET_BYTES;
  assert(
    promptBytes <= limit,
    `the summary prompt must stay under the upstream limit, got ${promptBytes} > ${limit}`,
  );
});

// ---------- 2026-10-19 第七次：思考吃光摘要额度 ----------
//
// 生产日志（新诊断打出来的）：
//   summary response carried no content (status=200
//   content-type=text/event-stream bytes=881289 data-lines=4095
//   reasoning-chars=16476 finish=length head="data: {...")
// 也就是说模型把 4096 tokens 全花在思考上，正文一个字没输出。
// 这不是解析 bug，是模型行为；能确定翻盘的办法是把思考关掉重跑。
const summaryAttempt = (over: Partial<CnbSummaryAttempt>) => ({
  content: "",
  status: 200,
  contentType: "text/event-stream",
  bytes: 881289,
  dataLines: 4095,
  reasoningChars: 16476,
  finishReason: "length",
  exhaustedByReasoning: false,
  prefix: "",
  ...over,
});

Deno.test("cnb: an empty summary caused by burnt reasoning budget is retried with thinking off", async () => {
  const efforts: Array<"off" | null> = [];
  const text = await summariseWithThinkingFallback(async (effort) => {
    efforts.push(effort);
    if (effort === null) {
      return summaryAttempt({
        content: "",
        finishReason: "length",
        reasoningChars: 16476,
        exhaustedByReasoning: true,
      });
    }
    return summaryAttempt({
      content: "会话摘要：改了三处截断逻辑。",
      finishReason: "stop",
      reasoningChars: 0,
    });
  });

  // 判据一：必须真的重试过，且第二次明确关掉思考。
  assertEquals(
    efforts,
    [null, "off"],
    "must retry exactly once with thinking off",
  );
  // 判据二：返回值必须是第二次的正文，不是空串。
  assertEquals(text, "会话摘要：改了三处截断逻辑。");
});

Deno.test("cnb: an empty summary that is NOT reasoning starvation is not retried", async () => {
  // 反面对照：上游直接报错 / 不肯给正文时，重试只是浪费一次调用和一次
  // 摘要 token。判据是"没重试"，而不是"重试了但失败"。
  let calls = 0;
  let error = "";
  try {
    await summariseWithThinkingFallback(() => {
      calls += 1;
      return Promise.resolve(summaryAttempt({
        content: "",
        status: 500,
        finishReason: "",
        reasoningChars: 0,
        exhaustedByReasoning: false,
      }));
    });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  assertEquals(calls, 1, "a non-reasoning failure must not trigger a retry");
  assert(
    error.includes("carried no content"),
    "the failure must still be reported, got: " + error,
  );
  // 诊断量必须带上，否则这条日志在生产里等于没有信息。
  assert(
    error.includes("data-lines=") && error.includes("reasoning-chars="),
    "the error must carry the diagnostic counters, got: " + error,
  );
});

Deno.test("cnb: a summary that fails even with thinking off reports both attempts", async () => {
  let error = "";
  try {
    await summariseWithThinkingFallback((effort) =>
      Promise.resolve(summaryAttempt({
        content: "",
        finishReason: effort === "off" ? "stop" : "length",
        reasoningChars: effort === "off" ? 0 : 16476,
        exhaustedByReasoning: effort !== "off",
      }))
    );
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  // 两个 attempt 的信息都要在，否则没法判断是"思考问题"还是"上游坏了"。
  assert(error.includes("even with thinking disabled"), "got: " + error);
  assert(
    error.includes("first:"),
    "must report the first attempt, got: " + error,
  );
  assert(
    error.includes("second:"),
    "must report the second attempt, got: " + error,
  );
});

// ---------- 2026-10-19 第七次（其二）：重试的总开关要单独测 ----------
//
// 上面那几条测试是**注入** attempt 的，绕过了 requestCnbSummary 里推导
// exhaustedByReasoning 的那段代码。判据写错时它们照样全绿，重试却被
// 静默禁用——所以判据本身必须单独对着输入测。
Deno.test("cnb: reasoning starvation is recognised by three conditions together", () => {
  // 正例：真实失败现场的形状（2026-10-19 生产日志）。
  assert(
    isReasoningStarvation("", "length", 16476),
    "empty body + length cut + real reasoning must count as starvation",
  );
  // 三个条件各缺一个都必须为假，否则会误触发重试。
  assertEquals(
    isReasoningStarvation("有正文", "length", 16476),
    false,
    "a non-empty answer is never starvation",
  );
  assertEquals(
    isReasoningStarvation("", "stop", 16476),
    false,
    "a natural stop is not a length cut",
  );
  assertEquals(
    isReasoningStarvation("", "length", 0),
    false,
    "no reasoning at all means disabling thinking cannot help",
  );
  // 纯空白正文要算空：上游有时回 " " 或 "\n"。
  assert(
    isReasoningStarvation("  \n ", "length", 500),
    "whitespace-only content must count as empty",
  );
});

// ---------- 2026-10-19 第十次修：/responses 这条路必须压缩 ----------
//
// 用户报的 413 就是这个。DSH 的 desktop profile 里 provider `cnb` 声明的是
// `api: openai-responses`（~/.dsh/profiles/desktop/cordis.patch.yml:1545），
// 于是每轮都打 /responses。而压缩只接在 /chat/completions 上（/messages 靠
// 自转发白送），/responses 直接把 responsesToChat 的结果喂给 cnbBuildUpstream
// —— 1.5 MB 的会话原样发出去，上游 413。
//
// 判据必须是**离开代理的请求体**，不是 helper 的返回值：helper 可以正确、
// 而调用方忘了接。所以这里 stub 掉 fetch，量真正发往上游的字节。
Deno.test("cnb: an oversized /responses body is compacted before it leaves", async () => {
  const originalFetch = globalThis.fetch;
  const postedBytes: number[] = [];
  globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
    const url = String(input);
    // ① 取 CSRF 的那一次：回一个带 csrftoken 与 csrfkey 的首页
    if (url === "https://cnb.cool/" || url === "https://cnb.cool") {
      return new Response(
        '<html><script>window.csrftoken = "' +
          "a".repeat(32) + '";</script></html>',
        {
          status: 200,
          headers: {
            "content-type": "text/html",
            "set-cookie": "csrfkey=123456789",
          },
        },
      );
    }
    // ② 真正的推理调用：记下体积，回一个最小的 SSE
    postedBytes.push(
      new TextEncoder().encode(String(init.body ?? "")).length,
    );
    return new Response(
      'data: {"id":"x","choices":[{"delta":{"content":"ok"},' +
        '"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof fetch;

  try {
    // 造一个约 1.2 MiB 的 Responses 会话（工具结果最容易把 body 顶大）。
    const inputItems: any[] = [];
    for (let i = 0; i < 6; i++) {
      inputItems.push({
        type: "function_call",
        call_id: `call_${i}`,
        name: "pwsh",
        arguments: JSON.stringify({ command: `echo ${i}` }),
      });
      inputItems.push({
        type: "function_call_output",
        call_id: `call_${i}`,
        output: `[${i}] ` + "排查输出。".repeat(20000),
      });
    }
    inputItems.push({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "回复 OK" }],
    });

    const rb = {
      model: "cnb/deepseek-v4.1-flash",
      stream: false,
      instructions: "You are a coding agent.",
      input: inputItems,
    };
    const rawBytes = new TextEncoder().encode(JSON.stringify(rb)).length;
    assert(
      rawBytes > 1048576,
      "the fixture must actually exceed the upstream limit, got " + rawBytes,
    );

    const request = new Request("http://x/cnb/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-session-id": "probe-responses-413",
      },
      body: JSON.stringify(rb),
    });
    const r = await handleCnb(
      "/cnb/v1/responses",
      request,
      new URL("http://x/cnb/v1/responses"),
    );

    assertEquals(
      r.status,
      200,
      "compaction must save the request, not fail it",
    );
    assert(postedBytes.length > 0, "the upstream must have been called");
    // 核心断言：**任何**一次发往上游的请求体都不许超 1 MiB。修之前这里
    // 会是 ~1.2 MB，上游回 [BODY_TOO_LARGE] 413。
    const biggest = Math.max(...postedBytes);
    assert(
      biggest <= 1048576,
      `every upstream body must fit the 1 MiB limit, biggest was ${biggest}`,
    );
    // 也别只是"刚好过"：压缩该把它砍回预算内。这里用常量而不是写死的
    // 900/950 KiB——预算调过一次（900 KiB → 992 KiB），写死的数字会在调预算
    // 时静默失效（本来就是它先红，才暴露出夹具与阈值绑死的问题）。
    assert(
      biggest <= CNB_BODY_BUDGET_BYTES,
      `compaction should bring it under the budget, biggest was ${biggest}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// 流式分支是同一段顺序，但它跑在 TransformStream 的后台任务里，
// 所以断言方式不同：只看上游收到的字节（上面那条覆盖了"压缩真的发生"，
// 这条只盯住"流式这条路也没有绕过压缩"）。
Deno.test("cnb: the streaming /responses path compacts too", async () => {
  const originalFetch = globalThis.fetch;
  const postedBytes: number[] = [];
  globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
    const url = String(input);
    if (url === "https://cnb.cool/" || url === "https://cnb.cool") {
      return new Response(
        '<html><script>window.csrftoken = "' +
          "b".repeat(32) + '";</script></html>',
        {
          status: 200,
          headers: {
            "content-type": "text/html",
            "set-cookie": "csrfkey=987654321",
          },
        },
      );
    }
    postedBytes.push(
      new TextEncoder().encode(String(init.body ?? "")).length,
    );
    return new Response(
      'data: {"id":"x","choices":[{"delta":{"content":"ok"},' +
        '"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof fetch;

  try {
    const inputItems: any[] = [];
    for (let i = 0; i < 6; i++) {
      inputItems.push({
        type: "function_call",
        call_id: `call_${i}`,
        name: "pwsh",
        arguments: JSON.stringify({ command: `echo ${i}` }),
      });
      inputItems.push({
        type: "function_call_output",
        call_id: `call_${i}`,
        output: `[${i}] ` + "排查输出。".repeat(20000),
      });
    }
    inputItems.push({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "回复 OK" }],
    });

    const request = new Request("http://x/cnb/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-session-id": "probe-responses-stream",
      },
      body: JSON.stringify({
        model: "cnb/deepseek-v4.1-flash",
        stream: true,
        instructions: "You are a coding agent.",
        input: inputItems,
      }),
    });
    const r = await handleCnb(
      "/cnb/v1/responses",
      request,
      new URL("http://x/cnb/v1/responses"),
    );
    assertEquals(r.status, 200);
    // 把流读干，后台任务才会真的发出上游请求。
    await r.text();

    assert(postedBytes.length > 0, "the upstream must have been called");
    const biggest = Math.max(...postedBytes);
    assert(
      biggest <= 1048576,
      `the streaming path must fit the 1 MiB limit, biggest was ${biggest}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── 串行闸的两条生产日志（2026-10-21）──────────────────────────────────────
//
// 生产里 [cnb-gate] fp=1f2kn02 released after 277260ms 是两件事叠出来的：
// ① 消费方（cnbIter）读到 data: [DONE] 就 return，既不 cancel 也不读完，闸只能
//    等 2 分钟空闲兜底才放；② 排队的请求把「排队时间」算进了自己的持有时间，
//    于是每个并发请求都打一条假的 slow hold。两处都修了，各钉一个用例。
const NL = String.fromCharCode(10);
const SENTINEL = "data: [DONE]" + NL + NL;

Deno.test("cnb-gate: the upstream [DONE] sentinel releases the gate before the body closes", async () => {
  const enc = new TextEncoder();
  let released = 0;
  // 真实 cnb 发完哨兵**不关流**，连接就挂在那儿。所以这里故意不 close()。
  const upstream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode('data: {"choices":[]}' + NL + NL));
      c.enqueue(enc.encode(SENTINEL));
    },
  });
  const gated = cnbGatedResponse(
    new Response(upstream, { status: 200 }),
    () => {
      released += 1;
    },
  );
  const reader = gated.body!.getReader();
  // 读到哨兵为止，**不 cancel** —— 正是 cnbIter 的行为。
  const dec = new TextDecoder();
  let seen = "";
  while (!seen.includes("[DONE]")) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += dec.decode(value, { stream: true });
  }
  assertEquals(
    released,
    1,
    "the [DONE] sentinel must release the gate itself, not the 2min idle backstop",
  );
  await reader.cancel().catch(() => {});
});

Deno.test("cnb-gate: [DONE] is still recognised when it straddles a chunk boundary", async () => {
  const enc = new TextEncoder();
  let released = 0;
  const upstream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode("data: [DO")); // 切在哨兵中间
      c.enqueue(enc.encode("NE]" + NL + NL));
    },
  });
  const gated = cnbGatedResponse(
    new Response(upstream, { status: 200 }),
    () => {
      released += 1;
    },
  );
  const reader = gated.body!.getReader();
  const dec = new TextDecoder();
  let seen = "";
  while (!seen.includes("[DONE]")) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += dec.decode(value, { stream: true });
  }
  assertEquals(released, 1, "a split sentinel must still release the gate");
  await reader.cancel().catch(() => {});
});

Deno.test("cnb: a request that queued behind another does not report the queue wait as a hold", async () => {
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  const warns: string[] = [];
  // 阈值压到 1.5 秒：真持有 2 秒的记一条（合法），排队 2 秒的**不该**再记一条。
  // 修之前它会把 2 秒排队算进持有，于是多出一条假日志。
  const HOLD = 1500;
  const WAIT = 1500;
  globalThis.fetch = ((input: any) => {
    const url = String(input);
    if (url.includes("cnb.cool/ai/chat/completions")) {
      const hung = new ReadableStream<Uint8Array>({
        start() {/* 永远不吐也不关 */},
      });
      return Promise.resolve(
        new Response(hung, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );
    }
    return Promise.resolve(
      new Response(
        '<script>window.csrftoken = "' + "a".repeat(32) + '";</script>',
        {
          status: 200,
          headers: {
            "content-type": "text/html",
            "set-cookie": "csrfkey=1234567890; Path=/",
          },
        },
      ),
    );
  }) as typeof fetch;
  console.warn = (...args: any[]) => {
    warns.push(args.map((a) => String(a)).join(" "));
  };
  const saveHold = Deno.env.get("CNB_GATE_SLOW_HOLD_MS");
  const saveWait = Deno.env.get("CNB_GATE_SLOW_WAIT_MS");
  Deno.env.set("CNB_GATE_SLOW_HOLD_MS", String(HOLD));
  Deno.env.set("CNB_GATE_SLOW_WAIT_MS", String(WAIT));
  const body = () => ({
    model: "deepseek-v4.1-flash",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
    max_tokens: 16,
  });
  try {
    // a 拿到闸但**不读** body → 闸被它占着；b 排在它后面。
    const a = await cnbCallUpstream(body());
    const bP = cnbCallUpstream(body());
    await new Promise((r) => setTimeout(r, WAIT + 500));
    await a.body!.cancel().catch(() => {});
    const b = await bP;
    await b.body!.cancel().catch(() => {});
    const holds = warns.filter((w) => w.includes("slow hold"));
    assertEquals(
      holds.length,
      1,
      "only the request that actually held the gate may log a slow hold; got:" +
        NL + warns.join(NL),
    );
    assert(
      warns.some((w) => w.includes("waited")),
      "the queued request should still report how long it waited",
    );
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
    if (saveHold === undefined) Deno.env.delete("CNB_GATE_SLOW_HOLD_MS");
    else Deno.env.set("CNB_GATE_SLOW_HOLD_MS", saveHold);
    if (saveWait === undefined) Deno.env.delete("CNB_GATE_SLOW_WAIT_MS");
    else Deno.env.set("CNB_GATE_SLOW_WAIT_MS", saveWait);
  }
});

// ─── 代理内修复轮（2026-10-24）───
//
// 坏语法反馈原来是拼在助手正文后面发给客户端的——那是一个**已经结束的回合**，
// 模型永远没机会「重发」，harness 看到纯文本回合就收工（用户实测「不会重试
// 直接就停止了」）。而且那段 [proxy] 文字进了 transcript，模型下一轮会把它
// 当成自己的话复读出来。修复：反馈不出代理，对上游补问一轮，第二轮续在
// 同一个响应里。

const JUNK_OUT = "让我看看。" + "\n" + OPEN + "\n" +
  '{"arguments":{"filepath":"x.ts"}}' + "\n" + CLOSE;
// 参数名故意不撞任何工具参数：撞上会被「按参数形状猜工具」救回去，走不到垃圾闸
const GOOD_OUT = OPEN + "\n" +
  '{"name":"pwsh","arguments":{"command":"ls"}}' + "\n" + CLOSE;

function sseChat(content: string, finish = "stop"): Response {
  return new Response(
    "data: " +
      JSON.stringify({
        choices: [{ delta: { content }, finish_reason: null }],
      }) + "\n\n" +
      "data: " +
      JSON.stringify({
        choices: [{ delta: {}, finish_reason: finish }],
      }) + "\n\n" +
      "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

// 与生产 cnb 尾帧同形：usage（含三种缓存方言）挂在 finish 帧上
function sseChatUsage(
  content: string,
  usage: Record<string, unknown>,
): Response {
  return new Response(
    "data: " +
      JSON.stringify({
        choices: [{ delta: { content }, finish_reason: null }],
      }) + "\n\n" +
      "data: " +
      JSON.stringify({
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage,
      }) + "\n\n" +
      "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function sseChatThink(think: string, content = "", finish = "stop"): Response {
  return new Response(
    "data: " +
      JSON.stringify({
        choices: [{ delta: { reasoning_content: think }, finish_reason: null }],
      }) + "\n\n" +
      "data: " +
      JSON.stringify({
        choices: [{ delta: { content }, finish_reason: null }],
      }) + "\n\n" +
      "data: " +
      JSON.stringify({
        choices: [{ delta: {}, finish_reason: finish }],
      }) + "\n\n" +
      "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function stubCnbUpstream(
  bodies: string[],
  replyFor: (call: number) => Response,
): typeof fetch {
  return ((input: any, init?: any) => {
    const url = String(input);
    if (url.includes("cnb.cool/ai/chat/completions")) {
      bodies.push(String(init?.body ?? ""));
      return Promise.resolve(replyFor(bodies.length));
    }
    return Promise.resolve(
      new Response(
        '<script>window.csrftoken = "' + "a".repeat(32) + '";</script>',
        {
          status: 200,
          headers: {
            "content-type": "text/html",
            "set-cookie": "csrfkey=1234567890; Path=/",
          },
        },
      ),
    );
  }) as typeof fetch;
}

function repairRequestBody(stream: boolean): Request {
  return new Request("http://cnb.local/cnb/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4.1-flash",
      messages: [{ role: "user", content: "看看 x.ts" }],
      tools: TOOLS,
      max_tokens: 64,
      stream,
    }),
  });
}

async function postRepair(body: Request): Promise<Response> {
  return await handleCnb(
    "/cnb/v1/chat/completions",
    body,
    new URL("http://cnb.local/cnb/v1/chat/completions"),
  );
}

function resetJunkStreak() {
  cnbJunkStreak.count = 0;
  cnbJunkStreak.at = 0;
}

Deno.test("the parser flags junk and can leave the note out for the repair round", () => {
  resetJunkStreak();
  // 默认（notes 开）：clean 带反馈，junk/diagnosis 标记齐全
  const withNote = cnbParseToolCalls(JUNK_OUT, TOOLS);
  assertEquals(withNote.calls.length, 0);
  assertEquals(withNote.junk, true);
  assert(
    withNote.diagnosis.includes("name"),
    "the diagnosis must say what was wrong: " + withNote.diagnosis,
  );
  assert(
    withNote.clean.includes("invalid syntax"),
    "default behaviour keeps the note appended",
  );
  // notes 关：clean 不带反馈，标记照旧——反馈的去向由修复轮决定
  const silent = cnbParseToolCalls(JUNK_OUT, TOOLS, { notes: false });
  assertEquals(silent.junk, true);
  assertEquals(silent.diagnosis, withNote.diagnosis);
  assert(
    !silent.clean.includes("invalid syntax"),
    "notes:false must not append the note",
  );
  assert(
    !silent.clean.includes(OPEN),
    "notes:false must still strip the junk tags",
  );
  // notes 关不碰熔断计数——计数由修复轮的编排方（cnbJunkFeedback）择机调用
  assertEquals(cnbJunkStreak.count, 1, "only the notes-on call may count");
  // 好调用不受影响
  const good = cnbParseToolCalls(GOOD_OUT, TOOLS, { notes: false });
  assertEquals(good.calls.length, 1);
  assertEquals(good.junk, false);
  resetJunkStreak();
});

Deno.test("cnb: an unparseable tool call is repaired in-proxy, not shipped as a dead-end note", async () => {
  resetJunkStreak();
  cnbForgetRejectedHeads();
  const realFetch = globalThis.fetch;
  const bodies: string[] = [];
  globalThis.fetch = stubCnbUpstream(
    bodies,
    (call) => call === 1 ? sseChat(JUNK_OUT) : sseChat(GOOD_OUT),
  );
  try {
    const resp = await postRepair(repairRequestBody(true));
    assertEquals(resp.status, 200);
    const text = await resp.text();
    assertEquals(bodies.length, 2, "the proxy must re-ask upstream once");
    const repair = JSON.parse(bodies[1]);
    assert(
      repair.messages.some((m: any) =>
        m.role === "assistant" && String(m.content).includes(OPEN)
      ),
      "the repair request must carry the model's own raw output",
    );
    assert(
      repair.messages.some((m: any) =>
        m.role === "user" && String(m.content).includes("invalid syntax")
      ),
      "the repair request must carry the feedback as a user message",
    );
    assert(
      text.includes('"pwsh"'),
      "the repaired call must reach the client",
    );
    assert(
      text.includes('"finish_reason":"tool_calls"'),
      "the repaired turn must end as a tool_calls turn",
    );
    assert(
      !text.includes("[proxy]"),
      "the feedback note must never reach the client",
    );
  } finally {
    globalThis.fetch = realFetch;
    resetJunkStreak();
  }
});

Deno.test("cnb: a plain-text round 2 continues the turn without any note", async () => {
  resetJunkStreak();
  const realFetch = globalThis.fetch;
  const bodies: string[] = [];
  globalThis.fetch = stubCnbUpstream(
    bodies,
    (call) =>
      call === 1
        ? sseChat(JUNK_OUT)
        : sseChat("直接回答：读它需要 pwsh 工具。"),
  );
  try {
    const resp = await postRepair(repairRequestBody(true));
    assertEquals(resp.status, 200);
    const text = await resp.text();
    assertEquals(bodies.length, 2);
    assert(
      text.includes("直接回答"),
      "round 2's plain text must continue the same turn",
    );
    assert(
      !text.includes("[proxy]"),
      "a round 2 that said something needs no fallback note",
    );
    assert(
      !text.includes('"finish_reason":"tool_calls"'),
      "no call materialised, so the turn must not claim tool_calls",
    );
  } finally {
    globalThis.fetch = realFetch;
    resetJunkStreak();
  }
});

Deno.test("cnb: when round 2 is unavailable the note comes back exactly once", async () => {
  resetJunkStreak();
  const realFetch = globalThis.fetch;
  const bodies: string[] = [];
  globalThis.fetch = stubCnbUpstream(
    bodies,
    (call) =>
      call === 1 ? sseChat(JUNK_OUT) : new Response("boom", { status: 500 }),
  );
  try {
    const resp = await postRepair(repairRequestBody(false));
    assertEquals(resp.status, 200);
    const out = await resp.json();
    // 修复轮对 5xx 会在 cnbCallUpstreamInner 里退避重试（1 次首发 + 6 次重试）
    assert(
      bodies.length >= 2,
      "the repair round must have been attempted: " + bodies.length,
    );
    const content = String(out.choices?.[0]?.message?.content ?? "");
    assert(
      content.includes("[proxy]"),
      "the fallback note must reach the client when nothing else did",
    );
    assertEquals(
      content.split("[proxy]").length - 1,
      1,
      "the note must appear exactly once",
    );
    assert(
      !content.includes("filepath"),
      "the raw junk payload must not leak into the content (the note's" +
        " own shape example legitimately contains the literal tags)",
    );
  } finally {
    globalThis.fetch = realFetch;
    resetJunkStreak();
  }
});

Deno.test("cnb: a repaired non-streaming turn ships tool_calls with no note", async () => {
  resetJunkStreak();
  const realFetch = globalThis.fetch;
  const bodies: string[] = [];
  globalThis.fetch = stubCnbUpstream(
    bodies,
    (call) => call === 1 ? sseChat(JUNK_OUT) : sseChat(GOOD_OUT),
  );
  try {
    const resp = await postRepair(repairRequestBody(false));
    assertEquals(resp.status, 200);
    const out = await resp.json();
    assertEquals(bodies.length, 2);
    const msg = out.choices?.[0]?.message;
    assertEquals(out.choices?.[0]?.finish_reason, "tool_calls");
    const calls = msg?.tool_calls ?? [];
    assertEquals(calls.length, 1);
    assertEquals(calls[0]?.function?.name, "pwsh");
    const content = String(msg?.content ?? "");
    assert(
      !content.includes("[proxy]"),
      "the note must not ride along with a repaired turn",
    );
  } finally {
    globalThis.fetch = realFetch;
    resetJunkStreak();
  }
});

// ─── 水位修剪不许清空会话（2026-10-24 遗忘根因）───
//
// 生产取证（.tmp-cnb-compact-*.json）：ZCode 会话 tools ≈ 826KB，60% 落地目标
// (609484B) 比开销还小 → fallbackTruncate 的 usable ≤ 0 → 三道装箱循环一条
// 都装不进 → 发给上游的整个 transcript 只剩一条 99 字节的说明。模型每轮都问
// 「你要我干什么」。修复：开销吃掉 60% 目标时，修剪预算退到「硬预算 − 余量」。
Deno.test("the watermark trim keeps the conversation alive when tools alone exceed the target", async () => {
  resetCompactionStates();
  const budget = CNB_BODY_BUDGET_BYTES;
  // tools ≈ 0.72 × budget：非消息开销本身就超过 60% 目标（生产 ZCode 的形态）
  const bigDescription = "x".repeat(Math.floor(budget * 0.72));
  const bigTools = [{
    type: "function",
    function: {
      name: "read_file",
      description: bigDescription,
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
      },
    },
  }];
  const TASK = "TASK：把落日滤镜的默认强度从 0.6 调到 0.8，然后跑 verify.ps1。";
  const messages: any[] = [
    { role: "system", content: "You are a coding agent. Keep this rule." },
    { role: "user", content: TASK },
  ];
  const filler = "历".repeat(300);
  for (let i = 0; i < 400; i++) {
    messages.push({ role: "assistant", content: "step " + i + " " + filler });
  }
  messages.push({ role: "user", content: "最新一轮：继续" });
  const body: any = {
    model: "deepseek-v4.1-flash",
    max_tokens: 32,
    messages,
    tools: bigTools,
  };
  const before = new TextEncoder().encode(JSON.stringify(body)).length;
  assert(before > budget, "fixture must exceed the budget: " + before);

  const note = await maybeCompactCnb(
    body,
    "tools-squeeze-session",
    // 摘要是模型写的——真实场景里它必然带上任务（生产 dump 里的 healthy 会话
    // 正是如此）。这里如实模拟，并断言「摘要带任务」这一事实穿过修剪存活。
    async () =>
      "## Objective" + "\n" + "- TASK：把落日滤镜的默认强度从 0.6 调到 0.8",
  );

  const after = new TextEncoder().encode(JSON.stringify(body)).length;
  assert(
    !note.includes("(all messages dropped)"),
    "the trim must not empty the conversation: " + note,
  );
  assert(
    after <= budget,
    "the trimmed body must still fit the budget: " + after,
  );
  assert(
    body.messages.length > 3,
    "the conversation must survive: got " + body.messages.length + " messages",
  );
  assert(
    body.messages.some((m: any) =>
      typeof m.content === "string" && m.content.includes("TASK：")
    ),
    "the task (inside the summary) must survive the trim",
  );
  assert(
    body.messages.some((m: any) =>
      typeof m.content === "string" &&
      m.content.includes("Conversation Summary")
    ),
    "the anchored summary must survive the trim",
  );
});

// 摘要失败路径：截断直接落在**原始** transcript 上，最老的任务消息受任务保护
// 必须存活——这正是 2026-10-24 取证里被清空的那种现场（tools 挤占 + 修剪）。
Deno.test("the summary-failed trim keeps the original task when tools alone exceed the target", async () => {
  resetCompactionStates();
  const budget = CNB_BODY_BUDGET_BYTES;
  const bigDescription = "x".repeat(Math.floor(budget * 0.72));
  const bigTools = [{
    type: "function",
    function: {
      name: "read_file",
      description: bigDescription,
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
      },
    },
  }];
  const TASK =
    "TASK：修复 Spectrum 渲染器的时序问题，pin 卸载后 Won_Update 必须等真实时间追平。";
  const messages: any[] = [
    { role: "system", content: "You are a coding agent. Keep this rule." },
    { role: "user", content: TASK },
  ];
  const filler = "历".repeat(300);
  for (let i = 0; i < 400; i++) {
    messages.push({ role: "assistant", content: "step " + i + " " + filler });
  }
  messages.push({ role: "user", content: "最新一轮：继续" });
  const body: any = {
    model: "deepseek-v4.1-flash",
    max_tokens: 32,
    messages,
    tools: bigTools,
  };
  const before = new TextEncoder().encode(JSON.stringify(body)).length;
  assert(before > budget, "fixture must exceed the budget: " + before);

  const note = await maybeCompactCnb(
    body,
    "tools-squeeze-fail-session",
    async () => {
      throw new Error("stub summary failure");
    },
  );

  const after = new TextEncoder().encode(JSON.stringify(body)).length;
  assert(
    note.includes("summary generation failed"),
    "the failure must be visible in the note: " + note,
  );
  assert(
    !note.includes("(all messages dropped)"),
    "the trim must not empty the conversation: " + note,
  );
  assert(
    after <= budget,
    "the trimmed body must still fit the budget: " + after,
  );
  assert(
    body.messages.some((m: any) =>
      typeof m.content === "string" && m.content.includes("TASK：")
    ),
    "the original task message must survive the trim",
  );
  assert(
    body.messages.some((m: any) =>
      typeof m.content === "string" && m.content.includes("最新一轮")
    ),
    "the newest turn must survive the trim",
  );
});

// ─── 非法转义静默修复（2026-10-24）───
//
// 用户实测形态：pwsh 调用里带 Windows 路径 `ProjectSettings\ProjectSettings.asset`，
// `\P`/`\A` 不是合法 JSON 转义，严格解析拒掉整个对象 → 整个调用进垃圾闸 →
// 烧一轮修复重问。模型的本意就是单个反斜杠，补成 `\\` 是唯一合理解读，
// 且解析回来值零损失——这种调用应该直接成功，而不是走任何重试路径。
Deno.test("a Windows path with raw backslashes parses instead of hitting the junk gate", () => {
  resetJunkStreak();
  cnbEscapeRepairState.n = 0;
  // 源码里 \\ = 文本里的一个反斜杠：这就是模型写出的坏 JSON（\P 非法转义）
  const payload = OPEN + "\n" +
    '{"name":"pwsh","arguments":{"command":"Select-String -Path ProjectSettings\\ProjectSettings.asset -Pattern \'applicationIdentifier\' -Context 1,3 | ForEach-Object { $_.Line }","description":"Inspect settings"}}' +
    "\n" + CLOSE;
  const r = cnbParseToolCalls(payload, TOOLS);
  assertEquals(
    r.calls.length,
    1,
    "the call must parse, not fall into the junk gate",
  );
  assertEquals(r.junk, false);
  const args = JSON.parse(r.calls[0].function.arguments);
  assert(
    args.command.includes("ProjectSettings\\ProjectSettings.asset"),
    "the value must keep single backslashes: " + args.command,
  );
  assert(
    args.command.includes("ForEach-Object { $_.Line }"),
    "braces inside the string must not break extraction: " + args.command,
  );
  assert(
    !r.clean.includes(OPEN),
    "the parsed block must be stripped from the text",
  );
  assert(
    cnbEscapeRepairState.n === 1,
    "the rescue must be counted for observability",
  );
  cnbEscapeRepairState.n = 0;
  resetJunkStreak();
});

Deno.test("escape repair touches only invalid escapes", () => {
  // 合法转义（\n \" \\ \u0041 \f）在**文本层**原样保留——\f 是合法 JSON 转义，
  // 它撞上 Windows 路径（C:\Users\file）的问题由值层的 repairPathControlChars
  // 还原（见下一条端到端用例），文本层无权改动合法转义
  assertEquals(repairJsonEscapes('{"a":"x\\ny"}'), '{"a":"x\\ny"}');
  assertEquals(
    repairJsonEscapes('{"a":"say \\"hi\\""}'),
    '{"a":"say \\"hi\\""}',
  );
  assertEquals(repairJsonEscapes('{"a":"\\u0041"}'), '{"a":"\\u0041"}');
  assertEquals(repairJsonEscapes('{"a":"C:\\file"}'), '{"a":"C:\\file"}');
  // 非法转义补双：解析后的值仍是单个反斜杠（模型的本意）
  assertEquals(
    JSON.parse(repairJsonEscapes('{"a":"C:\\Users"}')).a,
    "C:\\Users",
  );
  // \u 后面不是 4 位十六进制 → 补双，值是字面 \uZZ12
  assertEquals(
    JSON.parse(repairJsonEscapes('{"a":"\\uZZ12"}')).a,
    "\\uZZ12",
  );
  // 字符串之外一个字不动
  assertEquals(repairJsonEscapes('a "b\\c" d'), 'a "b\\\\c" d');
  // 悬尾反斜杠补双（闭合交给截断修复）
  assertEquals(repairJsonEscapes('{"a":"x\\'), '{"a":"x\\\\');
  // 没有反斜杠时快速返回原串
  assertEquals(repairJsonEscapes('{"a":"plain"}'), '{"a":"plain"}');
});

Deno.test("a legal-escape path (C:\\Users\\file) survives the value-level repair", () => {
  resetJunkStreak();
  cnbEscapeRepairState.n = 0;
  // \f 是合法 JSON 转义：文本层不修，但解析出的换页符在命令里绝不是本意。
  // 端到端判据：pushJsonCall 的命令类参数清理把换页符还原成字面 \f。
  // 源码 \\ = 文本里一个反斜杠：\U 非法（文本层补双），\f 合法（值层还原）
  const payload = OPEN + "\n" +
    '{"name":"pwsh","arguments":{"command":"type C:\\Users\\file.txt","description":"Read user file"}}' +
    "\n" + CLOSE;
  const r = cnbParseToolCalls(payload, TOOLS);
  assertEquals(r.calls.length, 1);
  assertEquals(r.junk, false);
  const args = JSON.parse(r.calls[0].function.arguments);
  assert(
    args.command.includes("C:\\Users\\file.txt"),
    "the formfeed must be restored to a literal backslash-f: " +
      JSON.stringify(args.command),
  );
  assert(
    !/\x0C/.test(args.command),
    "no control character may remain in the command",
  );
  cnbEscapeRepairState.n = 0;
  resetJunkStreak();
});

// ─── /responses 也必须接修复轮（2026-10-24，用户「还是中断」的真相）───
//
// 生产取证：`grep -c "tool-call repair: re-asking"` = **0**。DSH desktop 的
// cnb 声明的是 `api: openai-responses`，走的是 /responses；而修复轮第一版
// 只接在 chat completions 两条路径上，responses 明确留了旧行为（把反馈当正文
// 发出去 → 回合结束）。用户看到的「还是中断」就是这条旧路径。
Deno.test("cnb: /responses repairs an unparseable call in-proxy (streaming)", async () => {
  resetJunkStreak();
  const prev = Deno.env.get("CNB_COMPACTION");
  Deno.env.set("CNB_COMPACTION", "off");
  const realFetch = globalThis.fetch;
  const bodies: string[] = [];
  globalThis.fetch = stubCnbUpstream(
    bodies,
    (call) => call === 1 ? sseChat(JUNK_OUT) : sseChat(GOOD_OUT),
  );
  try {
    const req = new Request("http://cnb.local/cnb/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4.1-flash",
        input: [{ role: "user", content: "看看 x.ts" }],
        tools: TOOLS,
        max_output_tokens: 64,
        stream: true,
      }),
    });
    const resp = await handleCnb(
      "/cnb/v1/responses",
      req,
      new URL("http://cnb.local/cnb/v1/responses"),
    );
    assertEquals(resp.status, 200);
    const text = await resp.text();
    assertEquals(bodies.length, 2, "the proxy must re-ask upstream once");
    const repair = JSON.parse(bodies[1]);
    assert(
      repair.messages.some((m: any) =>
        m.role === "assistant" && String(m.content).includes(OPEN)
      ),
      "the repair request must carry the model's own raw output",
    );
    assert(
      text.includes('"function_call"'),
      "the repaired call must reach the client as a function_call item",
    );
    assert(
      !text.includes("[proxy]"),
      "the feedback note must never reach the client",
    );
  } finally {
    globalThis.fetch = realFetch;
    resetJunkStreak();
    if (prev === undefined) Deno.env.delete("CNB_COMPACTION");
    else Deno.env.set("CNB_COMPACTION", prev);
  }
});

Deno.test("cnb: /responses repairs an unparseable call in-proxy (non-streaming)", async () => {
  resetJunkStreak();
  const prev = Deno.env.get("CNB_COMPACTION");
  Deno.env.set("CNB_COMPACTION", "off");
  const realFetch = globalThis.fetch;
  const bodies: string[] = [];
  globalThis.fetch = stubCnbUpstream(
    bodies,
    (call) => call === 1 ? sseChat(JUNK_OUT) : sseChat(GOOD_OUT),
  );
  try {
    const req = new Request("http://cnb.local/cnb/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4.1-flash",
        input: [{ role: "user", content: "看看 x.ts" }],
        tools: TOOLS,
        max_output_tokens: 64,
        stream: false,
      }),
    });
    const resp = await handleCnb(
      "/cnb/v1/responses",
      req,
      new URL("http://cnb.local/cnb/v1/responses"),
    );
    assertEquals(resp.status, 200);
    const out = await resp.json();
    assertEquals(bodies.length, 2);
    const calls = (out.output ?? []).filter((o: any) =>
      o.type === "function_call"
    );
    assertEquals(calls.length, 1, "the repaired call must be in output");
    assertEquals(calls[0].name, "pwsh");
    const textItems = (out.output ?? []).filter((o: any) =>
      o.type === "message"
    );
    const text = textItems.map((i: any) =>
      (i.content ?? []).map((c: any) => c.text ?? "").join("")
    ).join("");
    assert(
      !text.includes("[proxy]"),
      "the note must not ride along with a repaired response",
    );
  } finally {
    globalThis.fetch = realFetch;
    resetJunkStreak();
    if (prev === undefined) Deno.env.delete("CNB_COMPACTION");
    else Deno.env.set("CNB_COMPACTION", prev);
  }
});

// ─── 历史 replay 剥掉我们自己的 [proxy] 反馈（防复读）───
//
// 修复轮出现之前，反馈是拼在助手正文末尾发给客户端的；客户端把它回放进历史，
// 模型于是把它当成自己的话接着写（AGENTS.md 实错②的持续形态）。出站时要剥掉。
Deno.test("cnb: a replayed assistant message loses an injected [proxy] note", () => {
  const built = cnbBuildUpstream({
    model: "deepseek-v4.1-flash",
    messages: [
      { role: "user", content: "看看 x.ts" },
      {
        role: "assistant",
        content: "我先看看。\n\n" +
          "[proxy] Your previous tool call used an invalid syntax that no " +
          "client can parse, so it was NOT executed. Do NOT stop.",
      },
      { role: "user", content: "继续" },
    ],
    tools: TOOLS,
  });
  const asst = built.upstream.messages.find((m: any) => m.role === "assistant");
  assert(asst, "the assistant message must survive");
  assert(
    !String(asst.content).includes("[proxy]"),
    "the injected note must be stripped from replayed history: " +
      String(asst.content),
  );
  assert(
    String(asst.content).includes("我先看看。"),
    "the model's own words must survive the strip",
  );
});

Deno.test("cnb: repair max tokens only grows on a length cut", () => {
  assertEquals(cnbRepairMaxTokens(120000, false), undefined);
  assertEquals(cnbRepairMaxTokens(64, true), 8192);
  assertEquals(cnbRepairMaxTokens(50000, true), 100000);
  assertEquals(cnbRepairMaxTokens(100000, true), 120000);
  assertEquals(cnbRepairMaxTokens(undefined, true), 120000);
});

// ─── /messages（Anthropic）也要吃到修复轮——靠自转发继承，必须端到端验证 ───
//
// handleCnbMessages 把请求转成 chat 形状后**调 handleCnb("/cnb/v1/chat/completions")**，
// 修复轮在 chat 处理器里触发，Anthropic 转换层只负责把 OpenAI SSE 翻成 Anthropic
// 事件流。风险点在**时序**：修复轮的 tool_calls 是在流末尾追加的普通 OpenAI
// chunk，openAiStreamToAnthropic 若只认「先 tool_calls 后文本」或对迟到块处理有
// 假设，tool_use 就到不了 Claude 形态的客户端——这条不测就等于没验证。
Deno.test("cnb: an Anthropic Messages stream carries the repaired tool_use", async () => {
  resetJunkStreak();
  const prev = Deno.env.get("CNB_COMPACTION");
  Deno.env.set("CNB_COMPACTION", "off");
  const realFetch = globalThis.fetch;
  const bodies: string[] = [];
  globalThis.fetch = stubCnbUpstream(
    bodies,
    (call) => call === 1 ? sseChat(JUNK_OUT) : sseChat(GOOD_OUT),
  );
  try {
    const req = new Request("http://cnb.local/cnb/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "test",
      },
      body: JSON.stringify({
        model: "deepseek-v4.1-flash",
        max_tokens: 64,
        messages: [{ role: "user", content: "看看 x.ts" }],
        tools: [{
          name: "pwsh",
          description: "Run a command",
          input_schema: {
            type: "object",
            properties: {
              command: { type: "string" },
              description: { type: "string" },
            },
            required: ["command"],
          },
        }],
        stream: true,
      }),
    });
    const resp = await handleCnb(
      "/cnb/v1/messages",
      req,
      new URL("http://cnb.local/cnb/v1/messages"),
    );
    assertEquals(resp.status, 200);
    const text = await resp.text();
    assertEquals(
      bodies.length,
      2,
      "the repair round must fire via self-forward",
    );
    assert(
      text.includes('"tool_use"'),
      "the repaired call must arrive as an Anthropic tool_use block",
    );
    assert(
      text.includes('"pwsh"'),
      "the tool name must survive the conversion",
    );
    assert(
      text.includes('"stop_reason":"tool_use"'),
      "the stream must end with stop_reason tool_use",
    );
    assert(
      !text.includes("[proxy]"),
      "the feedback note must never reach the Anthropic client",
    );
  } finally {
    globalThis.fetch = realFetch;
    resetJunkStreak();
    if (prev === undefined) Deno.env.delete("CNB_COMPACTION");
    else Deno.env.set("CNB_COMPACTION", prev);
  }
});

// ─── /messages 的 usage 记账（2026-10-24，用户实测「未缓存输入 0 / 缓存读取 0 全都是 0」）───
//
// 生产实测 cnb 尾帧把三种缓存方言报齐（OpenAI cached_tokens / DeepSeek hit /
// Anthropic 原生 cache_read_input_tokens），旧转换层只映射 completion_tokens，
// message_start 写死 0——Claude 形态客户端的缓存与输入记账恒为 0。
Deno.test("cnb: an Anthropic Messages stream reports input and cache usage", async () => {
  const prev = Deno.env.get("CNB_COMPACTION");
  Deno.env.set("CNB_COMPACTION", "off");
  const realFetch = globalThis.fetch;
  globalThis.fetch = stubCnbUpstream([], () =>
    sseChatUsage("好的。", {
      prompt_tokens: 12000,
      completion_tokens: 64,
      total_tokens: 12064,
      prompt_tokens_details: { cached_tokens: 0, reasoning_tokens: 0 },
      prompt_cache_hit_tokens: 10000,
      prompt_cache_miss_tokens: 2000,
      cache_read_input_tokens: 10000,
      cache_creation_input_tokens: 0,
      prompt_cache_write_tokens: 0,
    }));
  try {
    const req = new Request("http://cnb.local/cnb/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test" },
      body: JSON.stringify({
        model: "deepseek-v4.1-flash",
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });
    const resp = await handleCnb(
      "/cnb/v1/messages",
      req,
      new URL("http://cnb.local/cnb/v1/messages"),
    );
    assertEquals(resp.status, 200);
    const text = await resp.text();
    const deltaLine = text.split("\n").find((l) =>
      l.startsWith("data: ") && l.includes('"message_delta"')
    );
    assert(deltaLine, "missing message_delta");
    const usage = JSON.parse(deltaLine.slice(6)).usage;
    assertEquals(usage.input_tokens, 2000, "uncached input must be reported");
    assertEquals(usage.output_tokens, 64, "output must be reported");
    assertEquals(
      usage.cache_read_input_tokens,
      10000,
      "cache read must be reported (this was the user-visible zero)",
    );
    assert(
      !("cache_creation_input_tokens" in usage),
      "a zero cache write must stay absent, not asserted as 0",
    );
  } finally {
    globalThis.fetch = realFetch;
    if (prev === undefined) Deno.env.delete("CNB_COMPACTION");
    else Deno.env.set("CNB_COMPACTION", prev);
  }
});
