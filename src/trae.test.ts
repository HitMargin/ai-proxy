/**
 * TRAE 推理：目录合并、协议双向翻译、流式帧。
 *
 * 全部用假件，不碰磁盘也不发网络请求（deno task test 只开 --allow-env）。
 */

import {
  buildOpenAIChunk,
  mapTraeUsage,
  parseTraeBatchModelList,
  parseTraeSSELine,
  toModelCard,
  traeAgentHeaders,
  transformToSOLOBody,
} from "./trae.ts";

function assert(condition: unknown, message: string): asserts condition {
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

/** 造一条目录条目。 */
function entry(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    config_name: "demo",
    display_config: { display_name: "Demo" },
    usage: "chat_completion",
    config_switch: true,
    is_invisible_to_user: false,
    context_window_tokens: { max: 200000 },
    model_detail_list: [{ max_tokens: 32000 }],
    ...overrides,
  };
}
// ── 目录 ──

Deno.test("hidden entries never reach the catalog", () => {
  // 实测：不滤会有 34 条 is_invisible_to_user 的模型混进来。
  const models = parseTraeBatchModelList({
    function_configs: [
      {
        function: "solo_agent",
        config_info_list: [
          entry({ config_name: "visible" }),
          entry({ config_name: "ghost", is_invisible_to_user: true }),
        ],
      },
    ],
  });
  equal(models.map((m) => m.id), ["visible"]);
});

Deno.test("a disabled entry and a non-chat entry are both dropped", () => {
  const models = parseTraeBatchModelList({
    function_configs: [{
      function: "solo_agent",
      config_info_list: [
        entry({ config_name: "off", config_switch: false }),
        // usage 缺失时保留：上游没说不等于不是对话模型。
        entry({ config_name: "notchat", usage: "summary" }),
        entry({ config_name: "silent_usage", usage: undefined }),
      ],
    }],
  });
  equal(models.map((m) => m.id), ["silent_usage"]);
});

Deno.test("an empty effort ladder must not overwrite one that has options", () => {
  // 这是原实现最隐蔽的 bug：上游把空档位的条目排在**最后**，无条件「后覆盖前」
  // 于是用更空的条目覆盖信息更全的，实测 13 个模型丢掉 reasoning_effort_config。
  //
  // ⚠️ 夹具的顺序就是这条断言本身。空档位**必须后到**才能触发规则 1 —— 我第一版
  // 把它放在前面，于是「后覆盖前」本来就会保留真档位，规则 1 根本不会执行，
  // 那条断言因此在删掉规则 1 之后**照样绿**。
  // 判据：写合并规则的测试时，先问「去掉这条规则，哪种顺序会红」。
  const models = parseTraeBatchModelList({
    function_configs: [
      {
        // 先来：真档位
        function: "solo_agent",
        config_info_list: [
          entry({
            reasoning_effort_config: {
              options: ["light", "high"],
              default_level: "light",
            },
          }),
        ],
      },
      {
        // 后到：空档位 —— 必须在这个位置
        function: "solo_work_lite",
        config_info_list: [
          entry({
            reasoning_effort_config: { options: [], support_thinking: false },
          }),
        ],
      },
    ],
  });
  const model = models[0];
  assert(model !== undefined, "the model must survive");
  equal(model.reasoning?.options, ["light", "high"], "the ladder must be kept");
  // 档位必须与 function 同源，所以整条择优 —— 通道也要跟着换。
  equal(model.function, "solo_agent");
});

Deno.test("an entry with support_thinking false does not count as declaring a ladder", () => {
  // 只判「配置存在」是不够的：{support_thinking: false, options: ["high"]} 存在
  // 配置，对外却仍不声明档位。若按「存在即优先」合并就会选中这种条目，等于没修。
  //
  // ⚠️ 两条夹具**必须在同一个通道**：我第一版分处 solo_work_lite 与 solo_agent，
  // 于是通道优先级（规则 2）独立地就选中了后者 —— 删掉 support_thinking 守卫
  // 之后断言照样绿。一个测试里两条规则同时能解释结果，就等于没测任何一条。
  const models = parseTraeBatchModelList({
    function_configs: [
      {
        // 后到的干扰项：声明了档位，但显式说不支持思考。
        function: "solo_agent",
        config_info_list: [
          entry({
            reasoning_effort_config: {
              options: ["high"],
              support_thinking: false,
            },
          }),
        ],
      },
      {
        // 先到的真档位。
        function: "solo_agent",
        config_info_list: [
          entry({
            reasoning_effort_config: {
              options: ["light", "high"],
              default_level: "high",
            },
          }),
        ],
      },
    ],
  });
  equal(models[0]?.reasoning?.options, ["light", "high"]);
  equal(models[0]?.reasoning?.supportThinking, undefined);
});

Deno.test("two entries that both declare options fall back to channel priority", () => {
  const models = parseTraeBatchModelList({
    function_configs: [
      {
        function: "solo_agent_remote",
        config_info_list: [
          entry({ reasoning_effort_config: { options: ["high"] } }),
        ],
      },
      {
        function: "solo_agent",
        config_info_list: [
          entry({
            reasoning_effort_config: { options: ["high", "extra_high"] },
          }),
        ],
      },
    ],
  });
  equal(models[0]?.function, "solo_agent", "solo_agent ranks first");
  equal(models[0]?.reasoning?.options, ["high", "extra_high"]);
});

Deno.test("a free model keeps rate 0 instead of being filtered out", () => {
  const free = JSON.stringify({
    consumption_rate: { enable: true, data: { rate: 0 } },
  });
  const models = parseTraeBatchModelList({
    function_configs: [{
      function: "solo_agent",
      config_info_list: [entry({ display_contact_config: free })],
    }],
  });
  equal(models[0]?.creditsRate, 0, "rate 0 is legal (free) and must survive");
});

Deno.test("a disabled consumption rate means no rate, not zero", () => {
  const off = JSON.stringify({
    consumption_rate: { enable: false, data: { rate: 0.5 } },
  });
  const models = parseTraeBatchModelList({
    function_configs: [{
      function: "solo_agent",
      config_info_list: [entry({ display_contact_config: off })],
    }],
  });
  equal(models[0]?.creditsRate, undefined);
});
// ── 入向：OpenAI → SOLO ──

Deno.test("string content becomes an array, because a string is a hard 400", () => {
  // 实测：传字符串 → "cannot unmarshal string into Go struct field
  // LLMRawMessage.messages.content of type []*idecopilot.LLMRawMessageContent"。
  const out = transformToSOLOBody({
    model: "demo",
    messages: [{ role: "user", content: "hello" }],
  }, "solo_agent");
  const msg = (out.messages as Array<Record<string, unknown>>)[0];
  equal(msg?.content, [{ type: "text", text: "hello" }]);
});

Deno.test("array content passes through untouched", () => {
  const parts = [{ type: "text", text: "a" }, { type: "text", text: "b" }];
  const out = transformToSOLOBody({
    model: "demo",
    messages: [{ role: "user", content: parts }],
  }, "solo_agent");
  const msg = (out.messages as Array<Record<string, unknown>>)[0];
  equal(msg?.content, parts);
});

Deno.test("tool parameters are serialized to a JSON string", () => {
  const out = transformToSOLOBody({
    model: "demo",
    messages: [],
    tools: [{
      type: "function",
      function: {
        name: "read",
        parameters: { type: "object", properties: { p: { type: "string" } } },
      },
    }],
  }, "solo_agent");
  const tools = out.tools as Array<Record<string, unknown>>;
  const fn = tools[0]?.function as Record<string, unknown>;
  equal(typeof fn.parameters, "string");
  equal(JSON.parse(fn.parameters as string).type, "object");
});

Deno.test("an already-serialized parameters string is not serialized twice", () => {
  // 双重序列化会把 {"a":1} 变成 "{\"a\":1}" —— 模型看到的是一份坏工具定义。
  const out = transformToSOLOBody({
    model: "demo",
    messages: [],
    tools: [{
      type: "function",
      function: { name: "read", parameters: '{"a":1}' },
    }],
  }, "solo_agent");
  const tools = out.tools as Array<Record<string, unknown>>;
  const fn = tools[0]?.function as Record<string, unknown>;
  equal(fn.parameters, '{"a":1}');
});

Deno.test("tool_choice none also drops tools", () => {
  for (const choice of ["none", { type: "none" }]) {
    const out = transformToSOLOBody({
      model: "demo",
      messages: [],
      tools: [{ type: "function", function: { name: "read", parameters: {} } }],
      tool_choice: choice,
    }, "solo_agent");
    equal(
      out.tools,
      undefined,
      "tools must go with none: " + JSON.stringify(choice),
    );
    equal(out.tool_choice, undefined);
  }
});

Deno.test("a named tool_choice is reduced to the bare name", () => {
  const out = transformToSOLOBody({
    model: "demo",
    messages: [],
    tools: [{ type: "function", function: { name: "read", parameters: {} } }],
    tool_choice: { type: "function", function: { name: "read" } },
  }, "solo_agent");
  equal(out.tool_choice, "read");
});

Deno.test("assistant tool_calls travel as function_call and keep their id", () => {
  // 丢 tool_call_id 就是悬空 tool call，下游会以 400 拒。
  const out = transformToSOLOBody({
    model: "demo",
    messages: [{
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: { name: "read", arguments: '{"p":"a"}' },
      }],
    }],
  }, "solo_agent");
  const msg = (out.messages as Array<Record<string, unknown>>)[0];
  const calls = msg?.tool_calls as Array<Record<string, unknown>>;
  equal(calls[0]?.function_call, { name: "read", arguments: '{"p":"a"}' });
  equal(calls[0]?.function, undefined, "the OpenAI field name must be gone");
  equal(calls[0]?.id, "call_1", "tool_call_id must survive");
});

Deno.test("the channel comes from the caller and streaming is forced on", () => {
  const out = transformToSOLOBody({
    model: "demo",
    messages: [],
    stream: false,
  }, "solo_agent_remote");
  equal(out.function, "solo_agent_remote");
  equal(out.config_name, "demo");
  equal(out.model, "demo");
  equal(out.stream, true, "upstream has no non-streaming path");
});
// ── 出向：SOLO → OpenAI ──

Deno.test("the prose field is response, not content", () => {
  // 实测：output 的形状是 {response, reasoning_content, tool_calls, ...}，
  // 没有 delta 也没有 content。读错字段名 → 流通了但正文读不到。
  const ev = parseTraeSSELine(
    "output",
    JSON.stringify({ response: "hi", reasoning_content: "thinking" }),
  );
  equal(ev.response, "hi");
  equal(ev.reasoningContent, "thinking");
});

Deno.test("function_call becomes function and SOLO-only fields are dropped", () => {
  const ev = parseTraeSSELine(
    "output",
    JSON.stringify({
      tool_calls: [{
        index: 0,
        id: "call_1",
        function_call: {
          name: "read",
          arguments: "{}",
          namespace: "internal",
          partial_arguments: "{}",
        },
      }],
    }),
  );
  const call = (ev.toolCalls as Array<Record<string, unknown>>)[0];
  const fn = call?.function as Record<string, unknown>;
  equal(fn?.name, "read");
  equal(fn?.namespace, undefined, "SOLO-only field must not reach the client");
  equal(fn?.partial_arguments, undefined);
  equal(call?.function_call, undefined);
});

Deno.test("a frame that is not JSON does not kill the stream", () => {
  const ev = parseTraeSSELine("output", "{not json");
  equal(ev.event, "output", "the event name still arrives");
  equal(ev.response, undefined);
});

Deno.test("done carries the finish reason and error carries its code", () => {
  equal(
    parseTraeSSELine("done", JSON.stringify({ finish_reason: "tool_calls" }))
      .finishReason,
    "tool_calls",
  );
  const err = parseTraeSSELine(
    "error",
    JSON.stringify({ code: 9074, message: "busy" }),
  );
  equal(err.errorCode, 9074);
  equal(err.errorMessage, "busy");
});

Deno.test("a chunk is a valid OpenAI frame with the done terminator separate", () => {
  const raw = buildOpenAIChunk("id1", 100, "demo", { content: "hi" });
  assert(raw.startsWith("data: "), "must be a data frame");
  const parsed = JSON.parse(raw.slice(6));
  equal(parsed.object, "chat.completion.chunk");
  equal(parsed.choices[0].delta.content, "hi");
  equal(parsed.choices[0].finish_reason, null);
});

Deno.test("usage omits what the upstream did not report", () => {
  // 填 0 是「断言没有消耗」，与「上游没报」不是一回事。
  const usage = mapTraeUsage({ input_tokens: 100, output_tokens: 20 });
  equal(usage.total_tokens, 120);
  equal("prompt_tokens_details" in usage, false);
  const withCache = mapTraeUsage({
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 80,
    reasoning_tokens: 7,
  });
  equal(
    (withCache.prompt_tokens_details as Record<string, number>).cached_tokens,
    80,
  );
  equal(
    (withCache.completion_tokens_details as Record<string, number>)
      .reasoning_tokens,
    7,
  );
});

// ── 对外卡片 ──

Deno.test("efforts are mapped to what the harness accepts", () => {
  const card = toModelCard({
    id: "m",
    name: "M",
    function: "solo_agent",
    contextWindow: 200000,
    maxOutputTokens: 64000,
    reasoning: {
      options: ["light", "high", "extra_high"],
      defaultLevel: "high",
    },
  });
  equal(card.reasoning?.efforts.map((e) => e.id), ["low", "high", "xhigh"]);
  equal(card.reasoning?.defaultEffort, "high");
  // name 保留上游的档位名（面板显示用），id 是发出去的值。
  equal(card.reasoning?.efforts[0].name, "light");
});

Deno.test("no published ladder means no reasoning field at all", () => {
  // 空数组会被 harness 整个拒绝（INVALID_MODEL_REASONING）。
  const none = toModelCard({
    id: "m",
    name: "M",
    function: "solo_agent",
    contextWindow: 200000,
    maxOutputTokens: 64000,
  });
  equal("reasoning" in none, false);

  // support_thinking: false 也是不声明 —— 发了上游也不会用。
  const off = toModelCard({
    id: "m",
    name: "M",
    function: "solo_agent",
    contextWindow: 200000,
    maxOutputTokens: 64000,
    reasoning: { options: ["high"], supportThinking: false },
  });
  equal("reasoning" in off, false);
});

Deno.test("an unmappable upstream level does not become a fake effort", () => {
  // 只发上游真的发布、且本项目 harness 认的档位。
  const card = toModelCard({
    id: "m",
    name: "M",
    function: "solo_agent",
    contextWindow: 200000,
    maxOutputTokens: 64000,
    reasoning: { options: ["extreme"], defaultLevel: "extreme" },
  });
  equal("reasoning" in card, false);
});

Deno.test("the output ceiling is clamped to what upstream accepts", () => {
  // 客户端索要 131072 会把上游直接打成 4xx。
  const card = toModelCard({
    id: "m",
    name: "M",
    function: "solo_agent",
    contextWindow: 1000000,
    maxOutputTokens: 131072,
  });
  equal(card.max_output_tokens, 64000);
});

// ── 头 ──

Deno.test("the agent path uses Cloud-IDE-JWT and the full identity header set", () => {
  const headers = traeAgentHeaders({
    access_token: "TOK",
    uid: "U",
    machine_id: "M",
    device_id: "D",
  });
  equal(headers.authorization, "Cloud-IDE-JWT TOK");
  equal(headers["x-cloudide-token"], "TOK");
  equal(headers["x-ide-token"], "TOK");
  equal(headers["x-uid"], "U");
  equal(headers["x-machine-id"], "M");
  equal(headers["x-device-id"], "D");
  // 缺了这些会被按另一个形状处理，症状是流内 4001。
  equal(headers["x-app-id"], "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8");
  equal(headers["x-ide-version"], "0.1.52");
});
