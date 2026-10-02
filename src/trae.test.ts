/**
 * TRAE 推理：目录合并、协议双向翻译、流式帧。
 *
 * 全部用假件，不碰磁盘也不发网络请求（deno task test 只开 --allow-env）。
 */

import {
  buildOpenAIChunk,
  createFrameWriter,
  handleTraeChat,
  mapTraeUsage,
  parseTraeBatchModelList,
  parseTraeSSELine,
  toModelCard,
  traeAgentHeaders,
  type TraeModel,
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
  // 这是原实现最隐蔽的 bug：上游把空档位条目排在最后，「后覆盖前」
  // 于是用更空的条目覆盖信息更全的，13 个模型丢掉 reasoning_effort_config。
  const models = parseTraeBatchModelList({
    function_configs: [
      {
        function: "solo_work_lite",
        // 先来：空档位
        config_info_list: [
          entry({
            reasoning_effort_config: { options: [], support_thinking: false },
          }),
        ],
      },
      {
        function: "solo_agent",
        // 后到：真档位
        config_info_list: [
          entry({
            reasoning_effort_config: {
              options: ["light", "high"],
              default_level: "light",
            },
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
// ── 流式整链：一个假上游驱动 handleTraeChat ──

/**
 * 造一个按脚本吐帧的假上游。
 */
function fakeUpstream(frames: string[]): typeof fetch {
  return (async () => {
    const encoder = new TextEncoder();
    let index = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (index >= frames.length) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(frames[index++]));
      },
    });
    return new Response(stream, { status: 200 });
  }) as unknown as typeof fetch;
}

async function collect(
  response: Response,
): Promise<Array<Record<string, any>>> {
  const chunks: Array<Record<string, any>> = [];
  const text = await response.text();
  let sawDone = false;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6);
    if (payload === "[DONE]") {
      sawDone = true;
      continue;
    }
    chunks.push(JSON.parse(payload));
  }
  // harness 判截断的依据就是终止帧，而收集器本来就要跳过它 —— 跳过就等于没人
  // 断言它发出去了，于是「少发 [DONE]」会是个照样绿的缺陷。
  assert(
    sawDone,
    "the stream must end with [DONE] or the harness reads it as cut",
  );
  return chunks;
}

const CREDENTIAL = {
  access_token: "TOK",
  uid: "U",
  machine_id: "M",
  device_id: "D",
};

const DEMO: TraeModel = {
  id: "demo",
  name: "Demo",
  function: "solo_agent",
  contextWindow: 200000,
  maxOutputTokens: 64000,
};
Deno.test("a round that emitted a tool call reports tool_calls, not stop", async () => {
  // 实测（2026-10-02）：上游在这一轮仍然回 finish_reason:"stop"。照抄就等于
  // 告诉下游「模型说完了」——agent loop 于是跳过工具执行。
  const fetcher = fakeUpstream([
    "event:output\ndata:" + JSON.stringify({
      tool_calls: [{
        index: 0,
        id: "call_1",
        function_call: { name: "get_weather", arguments: '{"city"' },
      }],
    }) + "\n\n",
    "event:output\ndata:" + JSON.stringify({
      tool_calls: [{
        index: 0,
        function_call: { name: "get_weather", arguments: ':"Beijing"}' },
      }],
    }) + "\n\n",
    "event:done\ndata:" + JSON.stringify({ finish_reason: "stop" }) + "\n\n",
  ]);

  const response = await handleTraeChat(
    CREDENTIAL,
    DEMO,
    { model: "demo", messages: [] },
    fetcher,
  );
  const chunks = await collect(response);
  const tail = chunks[chunks.length - 1];
  equal(
    tail.choices[0].finish_reason,
    "tool_calls",
    "a round that carried a tool call must not claim it just stopped",
  );
  // 参数是分片到达的，必须按 index 累加成一份。
  const merged = chunks
    .flatMap((chunk) => chunk.choices[0].delta.tool_calls ?? [])
    .reduce(
      (acc: string, call: Record<string, any>) =>
        acc + (call.function?.arguments ?? ""),
      "",
    );
  equal(merged, '{"city":"Beijing"}');
});

Deno.test("a tool call with no name is held back, not emitted broken", async () => {
  // name:"" 的 tool call 会污染会话，下一轮回放时被 400 拒。
  const fetcher = fakeUpstream([
    "event:output\ndata:" + JSON.stringify({
      tool_calls: [{
        index: 0,
        id: "call_1",
        function_call: { arguments: "{}" },
      }],
    }) + "\n\n",
    "event:done\ndata:" + JSON.stringify({ finish_reason: "stop" }) + "\n\n",
  ]);

  const chunks = await collect(
    await handleTraeChat(
      CREDENTIAL,
      DEMO,
      { model: "demo", messages: [] },
      fetcher,
    ),
  );
  const emitted = chunks.flatMap((chunk) =>
    chunk.choices[0].delta.tool_calls ?? []
  );
  equal(emitted, [], "a nameless tool call must not be emitted");
  // 没发出任何工具调用，finish 仍照上游说的走。
  equal(chunks[chunks.length - 1].choices[0].finish_reason, "stop");
});

Deno.test("an in-stream error surfaces as a frame instead of a clean stop", async () => {
  // 静默收尾 = 「完整结束但什么都没说」，是本项目反复在删的故障形态。
  const fetcher = fakeUpstream([
    "event:error\ndata:" +
    JSON.stringify({ code: 4001, message: "param is invalid" }) + "\n\n",
  ]);

  const chunks = await collect(
    await handleTraeChat(
      CREDENTIAL,
      DEMO,
      { model: "demo", messages: [] },
      fetcher,
    ),
  );
  const withError = chunks.find((chunk) => chunk.error !== undefined);
  assert(withError !== undefined, "the error must be delivered as a frame");
  assert(
    String(withError.error.message).includes("4001"),
    "the business code must survive into the frame",
  );
});

Deno.test("token_usage lands in the tail frame when upstream sends it", async () => {
  // 实测：纯文本轮次没出现过，带工具那一轮出现了。
  const fetcher = fakeUpstream([
    "event:output\ndata:" + JSON.stringify({ response: "ok" }) + "\n\n",
    "event:token_usage\ndata:" + JSON.stringify({
      prompt_tokens: 169,
      completion_tokens: 40,
      cache_read_input_tokens: 64,
      reasoning_tokens: 27,
    }) + "\n\n",
    "event:done\ndata:" + JSON.stringify({ finish_reason: "stop" }) + "\n\n",
  ]);

  const chunks = await collect(
    await handleTraeChat(
      CREDENTIAL,
      DEMO,
      { model: "demo", messages: [] },
      fetcher,
    ),
  );
  const tail = chunks[chunks.length - 1];
  equal(tail.usage.total_tokens, 209);
  equal(tail.usage.prompt_tokens_details.cached_tokens, 64);
  equal(tail.usage.completion_tokens_details.reasoning_tokens, 27);
});

Deno.test("no usage frame means no usage field, not zeros", async () => {
  const fetcher = fakeUpstream([
    "event:output\ndata:" + JSON.stringify({ response: "ok" }) + "\n\n",
    "event:done\ndata:" + JSON.stringify({ finish_reason: "stop" }) + "\n\n",
  ]);

  const chunks = await collect(
    await handleTraeChat(
      CREDENTIAL,
      DEMO,
      { model: "demo", messages: [] },
      fetcher,
    ),
  );
  equal("usage" in chunks[chunks.length - 1], false);
});

// ── 帧写入器：客户端已经走了 ──
//
// 报错路径的最后一步也是写帧，所以一个不设防的 send 会在 catch 里**再抛一次**：
// 第一次抛出被 catch 接住，catch 里的这次抛出就没人接了，变成 unhandled rejection
// 把进程带走。日志里的 `TypeError: The stream controller cannot close or enqueue`
// 就是它。

Deno.test("a write to a client that already went away is swallowed, not thrown", () => {
  let attempts = 0;
  const writer = createFrameWriter({
    enqueue(): void {
      attempts += 1;
      throw new TypeError("The stream controller cannot close or enqueue");
    },
  });
  // 调用者正在 catch 块里收尾：这里再抛就是进程级事故。
  writer.send("data: [DONE]\n\n");
  equal(writer.closed, true, "a refused write must mark the writer closed");
  // 而且后续每一次写都必须是空操作，不能是第二次抛出。
  writer.send("data: [DONE]\n\n");
  equal(attempts, 1, "a closed writer must stop touching the sink");
});

Deno.test("a writer emits until the sink refuses, then emits nothing more", () => {
  const frames: string[] = [];
  let refuse = false;
  const decoder = new TextDecoder();
  const writer = createFrameWriter({
    enqueue(chunk: Uint8Array): void {
      if (refuse) throw new TypeError("closed");
      frames.push(decoder.decode(chunk));
    },
  });
  writer.send("a");
  writer.send("b");
  refuse = true;
  writer.send("c");
  equal(frames, ["a", "b"], "only the frames the sink accepted");
  equal(writer.closed, true);
});

Deno.test("an explicitly closed writer writes nothing at all", () => {
  const frames: string[] = [];
  const decoder = new TextDecoder();
  const writer = createFrameWriter({
    enqueue(chunk: Uint8Array): void {
      frames.push(decoder.decode(chunk));
    },
  });
  writer.close();
  writer.send("x");
  equal(frames, [], "close() must pre-empt every later write");
  equal(writer.closed, true);
});

Deno.test("a client that cancels mid-stream does not raise an unhandled rejection", async () => {
  const encoder = new TextEncoder();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let pulled = 0;
  const fetcher = (async () => {
    const stream = new ReadableStream({
      async pull(controller) {
        pulled += 1;
        if (pulled === 1) {
          controller.enqueue(
            encoder.encode(
              "event:output\ndata:" + JSON.stringify({ response: "hi" }) +
                "\n\n",
            ),
          );
          return;
        }
        if (pulled === 2) {
          // 上游说到一半就停住，等我们把客户端放掉。
          await gate;
          controller.enqueue(
            encoder.encode(
              "event:done\ndata:" +
                JSON.stringify({ finish_reason: "stop" }) + "\n\n",
            ),
          );
          return;
        }
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }) as unknown as typeof fetch;

  const rejections: unknown[] = [];
  const onRejection = (event: PromiseRejectionEvent) => {
    rejections.push(event.reason);
    event.preventDefault();
  };
  globalThis.addEventListener("unhandledrejection", onRejection);
  try {
    const response = await handleTraeChat(
      CREDENTIAL,
      DEMO,
      { model: "demo", messages: [] },
      fetcher,
    );
    const reader = response.body!.getReader();
    await reader.read();
    // 关标签页：正文被取消，之后每一次 enqueue 都会抛。
    await reader.cancel();
    release();
    for (let i = 0; i < 30; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  } finally {
    globalThis.removeEventListener("unhandledrejection", onRejection);
  }
  equal(
    rejections.map((reason) => String(reason)),
    [],
    "a cancelled client must not surface as an unhandled rejection",
  );
});
