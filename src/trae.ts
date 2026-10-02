/**
 * TRAE 推理模块：多通道模型目录 + SOLO 协议双向翻译。
 *
 * 协议取自 deepseek-harness-codearts（MIT）的 src/trae*.ts，按其注释里的实测
 * 结论实现。凡本文与那份实现不一致处均在注释里标明理由。
 *
 * ## 这是本项目里唯一「进出两个方向都要翻译」的 provider
 *
 * - 进去（OpenAI → SOLO）：messages.content 必须变成数组、tools[].parameters
 *   必须序列化成 JSON 字符串、tool_calls[].function → function_call、tool_choice
 *   归一化、model → config_name + model、新增 function（通道）。
 * - 出来（SOLO → OpenAI）：output 事件的正文字段叫 response（**不是 content，
 *   也没有 delta 这一层**）、function_call → function、done 带 finish_reason。
 *
 * ## 目录必须携带通道，这是本模块存在的结构性理由
 *
 * 模型**只在列出它的通道里可调用**（实测：glm-5.1 在 solo_agent_remote 正常，
 * 在 solo_work_lite 回流内 4001；glm-5-turbo/sagitta 相反）。
 *
 * 所以本项目的**前缀式**路由（trae/<model> → 剥前缀 → 上游）表达不了这件事：
 * 同一个 id 在不同通道的可调用性不同，路由表本身就得携带通道。
 *
 * 因此 TraeModel 带 function，目录是 Map<id, TraeModel> 而不是字符串数组；
 * 派发时用目录里的通道，不看用户选了哪个前缀。
 */

/** 推理链路主机（与积分链路主机不同）。 */
export const AGENT_HOST = "https://trae-api-cn.mchost.guru";

/** 对话端点（SOLO 自定义 SSE，不是 OpenAI 形状）。 */
export const TRAE_CHAT_PATH = "/api/agent/v3/llm_utils_chat";
/** 模型列表（多通道，一次传全部 functions）。 */
export const TRAE_BATCH_MODELS_PATH = "/api/ide/v1/batch_get_detail_param";

export const APP_ID = "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8";
/**
 * IDE 版本是**模型可用性的准入条件**：上游按 X-Ide-Version 决定返回哪些模型，
 * 版本过低时新模型报 4001。0.1.52 是实测可用 glm-5.3 的最低版本。
 */
export const IDE_VERSION = "0.1.52";
export const IDE_VERSION_CODE = "20260811";

/**
 * 通道优先级，**顺序即优先级**。
 *
 * - solo_agent：模型最多（约 66 条）且配置最全（倍率、折扣、思考档位）。
 * - solo_work_lite：glm-5-turbo/sagitta 只在这里可用。
 * - solo_agent_remote：补上 agent 专有模型（glm-5.1/qwen-3.5）。
 */
export const TRAE_CHANNELS: readonly string[] = [
  "solo_agent",
  "solo_work_lite",
  "solo_agent_remote",
];

/**
 * 单次响应输出上限的安全值。参考实现按 Trae2api-cn 的实测
 * （solo_agent_remote max_tokens=64000）收敛，并明写「客户端索要 131072
 * 会把上游直接打成 4xx」。TRAE_MAX_COMPLETION_TOKENS=0 关闭收敛。
 */
export const TRAE_DEFAULT_MAX_COMPLETION_TOKENS = 64_000;

export interface TraeReasoningConfig {
  /** 上游发布的档位（wire 值），可能为空。 */
  options: string[];
  defaultLevel?: string;
  supportThinking?: boolean;
}

export interface TraeModel {
  id: string;
  name: string;
  /**
   * **本模型可用的通道（SOLO 的 function）。** 派发时用它，不能用默认值——
   * 发错通道会得到流内 4001，且症状与「模型不存在」相同。
   */
  function: string;
  contextWindow: number;
  maxOutputTokens: number;
  reasoning?: TraeReasoningConfig;
  /** 消耗倍率；0 是合法值（免费），不能用 > 0 过滤。 */
  creditsRate?: number;
  multimodal?: boolean;
}

// ── 目录解析 ──

function readString(
  source: Record<string, unknown>,
  ...keys: string[]
): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

function readBoolean(
  source: Record<string, unknown>,
  ...keys: string[]
): boolean | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function readNumber(
  source: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
} /**
 * display_contact_config 是**一个 JSON 字符串**（不是对象），形如
 *   "{\"consumption_rate\":{\"enable\":true,\"data\":{\"rate\":0.08}}}"
 * 直接读 .consumption_rate 永远得到 undefined。
 *
 * rate: 0 是合法值（免费）——用 > 0 过滤会恰好漏掉用户最关心的免费模型。
 * enable: false 视为「无倍率」（不显示），而不是当成 0。
 */

function readCreditsRate(entry: Record<string, unknown>): number | undefined {
  const raw = entry.display_contact_config;
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const rate = (parsed as Record<string, unknown>).consumption_rate;
  if (typeof rate !== "object" || rate === null) return undefined;
  const record = rate as Record<string, unknown>;
  if (readBoolean(record, "enable") === false) return undefined;
  const data = record.data;
  if (typeof data !== "object" || data === null) return undefined;
  const value = readNumber(data as Record<string, unknown>, "rate");
  if (value === undefined || value < 0) return undefined;
  return value;
}

/**
 * reasoning_effort_config 的真实形状：
 *   { default_level, options: ["light","high","extra_high"], support_thinking }
 *
 * options 兼容字符串数组（实测形态）与对象数组（{level}）—— 防御性兼容，
 * 上游改形状时不会解析成空。
 *
 * 三个字段全缺时返回 undefined 而非空配置：调用方据此**不声明 reasoning**，
 * 避免给用户一个发了也没用的档位选择器（harness 会拒绝空阶梯）。
 */
function readReasoningConfig(
  entry: Record<string, unknown>,
): TraeReasoningConfig | undefined {
  const raw = entry.reasoning_effort_config;
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;

  const options: string[] = [];
  const rawOptions = record.options;
  if (Array.isArray(rawOptions)) {
    for (const item of rawOptions) {
      if (typeof item === "string" && item.trim().length > 0) {
        options.push(item.trim());
      } else if (typeof item === "object" && item !== null) {
        const obj = item as Record<string, unknown>;
        const wire = readString(obj, "openclawLevel", "level") ||
          readString(obj, "Level");
        if (wire.trim().length > 0) options.push(wire.trim());
      }
    }
  }
  const defaultLevel = readString(record, "default_level") ||
    readString(record, "DefaultLevel");
  const supportThinking = readBoolean(record, "support_thinking") ??
    readBoolean(record, "SupportThinking");

  if (
    options.length === 0 && defaultLevel.length === 0 &&
    supportThinking === undefined
  ) {
    return undefined;
  }
  return {
    options,
    ...defaultLevel.length > 0 ? { defaultLevel } : {},
    ...supportThinking === undefined ? {} : { supportThinking },
  };
}

/**
 * 该条目**能否真正声明出思考档位**。
 *
 * 判据必须与对外发布的那份完全一致。只判「配置存在」是不够的：
 * {support_thinking: false, options: []} 存在配置但对外仍不声明档位 ——
 * 若按「存在即优先」合并，就会选中这种条目，等于没修。
 */
function declaresReasoning(model: TraeModel): boolean {
  const config = model.reasoning;
  if (config === undefined) return false;
  if (config.supportThinking === false) return false;
  return config.options.length > 0;
}
function parseConfigEntry(
  entry: Record<string, unknown>,
  channel: string,
): TraeModel | undefined {
  const id = readString(entry, "config_name") ||
    readString(entry, "ConfigName");
  if (id.length === 0) return undefined;

  const displayRaw = entry.display_config;
  const display = typeof displayRaw === "object" && displayRaw !== null
    ? displayRaw as Record<string, unknown>
    : undefined;

  // ⚠️ 三条硬性过滤在**解析期**执行，不设外部开关。
  // 第 3 条实测代价很大：不滤会有 34 条 is_invisible_to_user 的隐藏模型混进目录
  //（含 glm-5.1 / glm-5-turbo / sagitta），它们在 IDE 里对用户不可见。
  if (readBoolean(entry, "is_invisible_to_user") === true) return undefined;
  // config_switch === false = 上游已停用。
  if (readBoolean(entry, "config_switch") === false) return undefined;
  // usage 非 chat_completion 的条目是 summary / fast_apply / 标题生成等，
  // 混进目录会塞满不可对话的模型。
  const usage = readString(entry, "usage") || readString(entry, "Usage");
  if (usage.length > 0 && usage !== "chat_completion") return undefined;

  const name = display === undefined
    ? id
    : readString(display, "display_name") ||
      readString(display, "DisplayName") || id;

  const contextRaw = entry.context_window_tokens;
  let contextWindow: number | undefined;
  if (typeof contextRaw === "object" && contextRaw !== null) {
    const ctx = contextRaw as Record<string, unknown>;
    contextWindow = readNumber(ctx, "max") ?? readNumber(ctx, "Max");
  } else if (typeof contextRaw === "number") {
    contextWindow = contextRaw;
  }

  const details = Array.isArray(entry.model_detail_list)
    ? entry.model_detail_list
    : [];
  let maxOutputTokens = 0;
  for (const detail of details) {
    if (typeof detail !== "object" || detail === null) continue;
    const value = readNumber(detail as Record<string, unknown>, "max_tokens") ??
      readNumber(detail as Record<string, unknown>, "MaxTokens");
    if (value !== undefined && value > maxOutputTokens) maxOutputTokens = value;
  }

  const reasoning = readReasoningConfig(entry);
  const creditsRate = readCreditsRate(entry);
  const multimodal = display === undefined
    ? undefined
    : readBoolean(display, "multimodal") ?? readBoolean(display, "Multimodal");

  return {
    id,
    name,
    function: channel,
    // 实测主流值 200000。**不编造**：读不到就用这个主流值并在注释里标明，
    // 而不是因为「猜一个大数字」就宣称模型支持更大窗口。
    contextWindow: contextWindow !== undefined && contextWindow > 0
      ? contextWindow
      : 200_000,
    maxOutputTokens: maxOutputTokens > 0
      ? maxOutputTokens
      : TRAE_DEFAULT_MAX_COMPLETION_TOKENS,
    ...reasoning === undefined ? {} : { reasoning },
    ...creditsRate === undefined ? {} : { creditsRate },
    ...multimodal === undefined ? {} : { multimodal },
  };
} /**
 * 解析 batch_get_detail_param（多通道）响应并合并成一份目录。
 *
 * 真实形状：{ function_configs: [{ function, config_info_list: [...] }, ...] }，
 * **每个 function 各自一套模型目录**。
 *
 * ## 合并规则（原实现「后覆盖前」是错的）
 *
 * 上游把**空档位的条目排在最后**（solo_work_lite 等），所以无条件「后覆盖前」
 * 会用更空的条目覆盖信息更全的条目 —— 实测 13 个模型因此丢掉
 * reasoning_effort_config。现在：
 *
 * 1. 空档位不得覆盖有档位；
 * 2. 两侧都有档位时按 channelPriority 取更靠前者（**档位必须与 function 同源**，
 *    否则上游按 support_thinking:false 处理，甚至回流内 4001）；
 * 3. 其余情形保持「后覆盖前」。
 *
 * 候选**始终只来自列出了该模型的通道**，所以无论选中哪条都不会路由到
 * 「未列出该模型」的通道。
 */

export function parseTraeBatchModelList(
  body: unknown,
  channelPriority: readonly string[] = TRAE_CHANNELS,
): TraeModel[] {
  if (typeof body !== "object" || body === null) return [];
  const groups = (body as Record<string, unknown>).function_configs;
  if (!Array.isArray(groups)) return [];

  const rankOf = (channel: string): number => {
    const index = channelPriority.indexOf(channel);
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };

  const byId = new Map<string, TraeModel>();
  const chosenRank = new Map<string, number>();
  for (const group of groups) {
    if (typeof group !== "object" || group === null) continue;
    const record = group as Record<string, unknown>;
    const channel = readString(record, "function") ||
      readString(record, "Function");
    if (channel.length === 0) continue;
    const list = record.config_info_list;
    if (!Array.isArray(list)) continue;

    for (const item of list) {
      if (typeof item !== "object" || item === null) continue;
      const model = parseConfigEntry(item as Record<string, unknown>, channel);
      if (model === undefined) continue;

      const incumbent = byId.get(model.id);
      if (incumbent === undefined) {
        byId.set(model.id, model);
        chosenRank.set(model.id, rankOf(model.function));
        continue;
      }
      const incumbentHas = declaresReasoning(incumbent);
      const candidateHas = declaresReasoning(model);
      // 规则 1
      if (incumbentHas && !candidateHas) continue;
      // 规则 2
      if (incumbentHas && candidateHas) {
        const current = chosenRank.get(model.id) ?? Number.MAX_SAFE_INTEGER;
        // current 为 MAX 表示已选条目不在优先级表内 —— 此时不设限，
        // 退回「后覆盖前」，避免引入与优先级表无关的行为差异。
        if (
          current !== Number.MAX_SAFE_INTEGER &&
          rankOf(model.function) >= current
        ) {
          continue;
        }
      }
      // 规则 3
      byId.set(model.id, model);
      chosenRank.set(model.id, rankOf(model.function));
    }
  }
  return [...byId.values()];
}
// ── 入向：OpenAI → SOLO ──

/**
 * tool_choice 归一化。SOLO 只收字符串，"none" 还要连 tools 一起删。
 *
 * "none" 删 tools 这条是实测来的：保留 tools 会被上游按「模型该调工具」处理，
 * 于是模型在明确要求不调用工具时仍然发起调用。
 */
function normalizeToolChoice(body: Record<string, unknown>): void {
  const tc = body.tool_choice;
  if (tc === undefined) return;

  const suppress = (): void => {
    delete body.tools;
    delete body.functions;
  };

  if (typeof tc === "string") {
    if (tc.toLowerCase().trim() === "none") {
      delete body.tool_choice;
      suppress();
    }
    return;
  }

  if (typeof tc === "object" && tc !== null) {
    const v = tc as Record<string, unknown>;
    const typ = typeof v.type === "string" ? v.type.toLowerCase().trim() : "";
    switch (typ) {
      case "none":
        delete body.tool_choice;
        suppress();
        break;
      case "auto":
      case "required":
        body.tool_choice = typ;
        break;
      case "function": {
        const fn = v.function as Record<string, unknown> | undefined;
        let name = typeof fn?.name === "string" ? fn.name : "";
        if (name.length === 0) name = typeof v.name === "string" ? v.name : "";
        // 名字为空时退回 auto 而不是删字段：删掉会让模型无视客户端的指定，
        // auto 至少仍是一个上游认的值。
        body.tool_choice = name.trim().length > 0 ? name.trim() : "auto";
        break;
      }
      default:
        delete body.tool_choice;
    }
    return;
  }

  delete body.tool_choice;
}

/**
 * tools[].function.parameters: object → JSON 字符串。
 *
 * SOLO 上游要求 string，OpenAI 标准是 object —— 不序列化直接 400。
 *
 * ⚠️ 已在函数入参里的字符串**原样透传**：重复 JSON.stringify 会把
 *   '{"a":1}' 变成 '"{\\"a\\":1}"'，那是模型看到的一份坏工具定义。
 *
 * 下面两个守卫的行为**只有一个是被测到的**：下面那行（typeof !== "object"）
 * 已经覆盖了字符串，所以删掉上面那行（typeof === "string"）测试**照样绿** ——
 * 我验证过，13 个突变里它不红。上面那行是**给人看的意图**，不是承载行为的分支；
 * 按本项目的纪律，这种断言要么补一条独立可红的用例，要么就承认它没有作用。
 * 这里选择留着显式守卫并在此注明，而不是删掉那行再让注释去解释一个隐式行为。
 */
function normalizeTools(body: Record<string, unknown>): void {
  const raw = body.tools;
  if (!Array.isArray(raw) || raw.length === 0) return;
  body.tools = raw.map((tool) => {
    if (typeof tool !== "object" || tool === null) return tool;
    const fn = (tool as Record<string, unknown>).function;
    if (typeof fn !== "object" || fn === null) return tool;
    const fnRecord = fn as Record<string, unknown>;
    const params = fnRecord.parameters;
    if (typeof params === "string") return tool;
    if (typeof params !== "object" || params === null) return tool;
    return {
      ...(tool as Record<string, unknown>),
      function: { ...fnRecord, parameters: JSON.stringify(params) },
    };
  });
}
/**
 * 单条消息转换：
 *
 * - content 字符串 → [{type:"text",text:...}]（**必须是数组**，传字符串直接
 *   HTTP 400 "cannot unmarshal string into Go struct field ... of type
 *   []*idecopilot.LLMRawMessageContent"）；数组原样透传。
 * - assistant 的 tool_calls[].function → function_call（SOLO 字段名）。
 * - 保留 tool_call_id：丢了就是协议错误（悬空 tool call），下游会以 400 拒。
 */
function transformSOLOMessage(
  msg: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...msg };

  const content = msg.content;
  if (typeof content === "string") {
    result.content = [{ type: "text", text: content }];
  }

  const calls = msg.tool_calls;
  if (Array.isArray(calls)) {
    result.tool_calls = calls.map((call) => {
      if (typeof call !== "object" || call === null) return call;
      const c = call as Record<string, unknown>;
      if (typeof c.function !== "object" || c.function === null) return call;
      return {
        ...c,
        function_call: c.function,
        function: undefined,
      };
    });
  }

  return result;
}

/**
 * 把 OpenAI 请求体转换成 SOLO 请求体。
 *
 * @param openaiBody 原始 OpenAI 请求体
 * @param channel 聊天通道（function）。**必须传该模型所属通道** ——
 *   发错通道得到的是流内 4001，症状与「模型不存在」无法区分。
 */
export function transformToSOLOBody(
  openaiBody: Record<string, unknown>,
  channel: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...openaiBody };

  // ⚠️ 顺序有硬依赖：tools 必须在 normalizeTools **之前**就位，否则
  // parameters 保持对象形态被拒，**且错误信息不会指向那里**。
  normalizeToolChoice(body);
  normalizeTools(body);

  const msgs = body.messages;
  if (Array.isArray(msgs)) {
    body.messages = msgs.map((msg) =>
      typeof msg === "object" && msg !== null
        ? transformSOLOMessage(msg as Record<string, unknown>)
        : msg
    );
  }

  const model = typeof body.model === "string" ? body.model : "";
  body.config_name = model;
  body.model = model;

  body.function = channel;
  // 非流式由服务端聚合，所以永远请求流式 —— 上游没有非流式路径。
  body.stream = true;

  return body;
}

// ── 出向：SOLO → OpenAI ──

/**
 * 解析一条 SOLO 事件。
 *
 * ⚠️ output 的正文字段叫 **response**，不是 content，也没有 delta 这一层。
 * 我按 OpenAI 习惯连试 delta.content 与 content 都恒为 undefined，而流是通的
 * （帧数、finish=stop 都在）—— 差点误判成「模型没说话」。
 * 判据：读不到字段时先 dump 原始帧，别猜字段名。
 */
export interface TraeSSEEvent {
  event: string;
  response?: string;
  reasoningContent?: string;
  toolCalls?: unknown[];
  usage?: Record<string, unknown>;
  finishReason?: string;
  errorCode?: number;
  errorMessage?: string;
}

export function parseTraeSSELine(
  eventName: string,
  dataLine: string,
): TraeSSEEvent {
  const event = eventName.trim();
  if (dataLine.length === 0) return { event };

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(dataLine) as Record<string, unknown>;
  } catch {
    // 非 JSON 帧不是错误，跳过即可 —— 判据：单帧解析失败不该毁掉整条流。
    return { event };
  }

  const ev: TraeSSEEvent = { event };
  switch (event) {
    case "output":
      if (typeof raw.response === "string") ev.response = raw.response;
      if (typeof raw.reasoning_content === "string") {
        ev.reasoningContent = raw.reasoning_content;
      }
      if (Array.isArray(raw.tool_calls)) {
        ev.toolCalls = normalizeTraeToolCalls(raw.tool_calls);
      }
      break;
    case "token_usage":
      ev.usage = raw;
      break;
    case "done":
      if (typeof raw.finish_reason === "string") {
        ev.finishReason = raw.finish_reason;
      }
      break;
    case "error":
      if (typeof raw.code === "number") ev.errorCode = raw.code;
      if (typeof raw.message === "string") ev.errorMessage = raw.message;
      break;
  }
  return ev;
} /**
 * function_call → function，并清掉 SOLO 专属字段。
 *
 * namespace / partial_arguments 是 SOLO 的内部字段，传给客户端会让工具调用
 * 在回放时被当成参数的一部分。
 */

function normalizeTraeToolCalls(calls: unknown[]): unknown[] {
  return calls.map((call) => {
    if (typeof call !== "object" || call === null) return call;
    const c: Record<string, unknown> = { ...(call as Record<string, unknown>) };
    if (typeof c.function_call === "object" && c.function_call !== null) {
      c.function = { ...(c.function_call as Record<string, unknown>) };
      delete c.function_call;
    }
    if (typeof c.function === "object" && c.function !== null) {
      const fn = { ...(c.function as Record<string, unknown>) };
      delete fn.namespace;
      delete fn.partial_arguments;
      c.function = fn;
    }
    return c;
  });
}

/**
 * 构建一个 OpenAI chat.completion.chunk 帧。
 */
export function buildOpenAIChunk(
  id: string,
  created: number,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
  usage?: Record<string, unknown>,
): string {
  const chunk: Record<string, unknown> = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  if (usage !== undefined) chunk.usage = usage;
  return "data: " + JSON.stringify(chunk) + "\n\n";
}

/**
 * token_usage 事件 → OpenAI usage。
 *
 * ⚠️ 实测本账号的 token_usage **一次都没出现过**，token 数只在 extra_info 里。
 * 所以缺 usage 时字段整个省略，而不是填 0 —— 填 0 是「断言没有消耗」，
 * 与「上游没报」不是一回事（与本项目缓存 token 那条同纪律）。
 */
export function mapTraeUsage(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const pick = (...keys: string[]): number => {
    for (const key of keys) {
      const value = raw[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
    return 0;
  };
  const input = pick("input_tokens", "prompt_tokens", "input_token");
  const output = pick("output_tokens", "completion_tokens", "output_token");
  const usage: Record<string, unknown> = {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
  };
  const cached = pick("cache_read_input_tokens", "cached_tokens");
  if (cached > 0) {
    usage.prompt_tokens_details = { cached_tokens: cached };
  }
  const reasoning = pick("reasoning_tokens", "thinking_tokens");
  if (reasoning > 0) {
    usage.completion_tokens_details = { reasoning_tokens: reasoning };
  }
  return usage;
}
/**
 * 推理链路的身份头。
 *
 * 鉴权是 Cloud-IDE-JWT（不是 Bearer），token 在三个头里重复出现；
 * 另有十余个 X-* 身份头。
 *
 * ⚠️ 与积分链路（traeUgHeaders）**不同**：那边只要 3 个头，这边要一整套。
 * 复用会把对话请求发成缺少身份头的形状，症状是流内 4001。
 */
export function traeAgentHeaders(
  credential: {
    access_token: string;
    uid: string;
    machine_id: string;
    device_id: string;
  },
  extra: Record<string, string> = {},
): Record<string, string> {
  const token = credential.access_token;
  return {
    "content-type": "application/json",
    accept: "text/event-stream",
    "user-agent": "TraeAgent/1.0.0",
    authorization: "Cloud-IDE-JWT " + token,
    "x-cloudide-token": token,
    "x-ide-token": token,
    "x-uid": credential.uid,
    "x-app-id": APP_ID,
    "x-app-version": "default",
    "x-ide-version": IDE_VERSION,
    "x-ide-version-code": IDE_VERSION_CODE,
    "x-app-version-code": IDE_VERSION_CODE,
    "x-ide-version-type": "stable",
    "x-device-type": "macos",
    "x-os-version": "macOS 15.7.4",
    "x-device-brand": "Apple",
    "x-machine-id": credential.machine_id,
    "x-device-id": credential.device_id,
    "request-traffic-type": "prod",
    ...extra,
  };
}

/** 拉一次目录。走 IDE 主机，与对话主机不同。 */
export async function fetchTraeCatalog(
  credential: {
    access_token: string;
    uid: string;
    machine_id: string;
    device_id: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<TraeModel[]> {
  const response = await fetcher(
    "https://trae-api-cn.mchost.guru" + TRAE_BATCH_MODELS_PATH,
    {
      method: "POST",
      headers: traeAgentHeaders(credential, { accept: "application/json" }),
      body: JSON.stringify({ functions: TRAE_CHANNELS }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error("TRAE catalog HTTP " + response.status);
  }
  return parseTraeBatchModelList(await response.json());
}
/**
 * 一轮对话：OpenAI 请求 → SOLO → OpenAI SSE。
 *
 * 非流式请求也走这里：**上游没有非流式路径**（transformToSOLOBody 强制
 * stream:true，由服务端聚合），所以调用方想要非流式必须自己聚合。
 */
export async function handleTraeChat(
  credential: {
    access_token: string;
    uid: string;
    machine_id: string;
    device_id: string;
  },
  model: TraeModel,
  body: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  // ⚠️ 通道来自目录，不是调用方，也不是默认值 —— 同一 id 在不同通道的
  // 可调用性不同（实测 glm-5.1 反过来 glm-5-turbo）。
  const soloBody = transformToSOLOBody(body, model.function);

  const upstream = await fetcher(AGENT_HOST + TRAE_CHAT_PATH, {
    method: "POST",
    headers: traeAgentHeaders(credential),
    body: JSON.stringify(soloBody),
    signal: AbortSignal.timeout(600_000),
  });

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    throw new Error(
      "TRAE chat HTTP " + upstream.status + ": " + text.slice(0, 240),
    );
  }
  if (upstream.body === null) {
    throw new Error("TRAE chat returned an empty body");
  }

  const encoder = new TextEncoder();
  const chatId = "chatcmpl-trae-" + Date.now().toString(36);
  const created = Math.floor(Date.now() / 1000);
  const modelName = model.id;

  const stream = new ReadableStream({
    start(controller) {
      (async () => {
        const reader = upstream.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let eventName = "";
        let finish = "stop";
        let usage: Record<string, unknown> | undefined;
        /**
         * 工具调用按上游给的 index 累积：参数是**分片**到达的，
         * 直接转发每帧会得到多个不完整的 tool_calls。
         */
        const toolIndex = new Map<number, {
          id: string;
          name: string;
          args: string;
          emitted: boolean;
        }>();

        const send = (payload: string): void => {
          controller.enqueue(encoder.encode(payload));
        };

        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              if (line.startsWith("event:")) {
                eventName = line.slice(6).trim();
                continue;
              }
              if (!line.startsWith("data:")) continue;
              const dataLine = line.slice(5).trim();
              if (dataLine.length === 0 || dataLine === "[DONE]") continue;
              handleEvent(dataLine);
            }
          }
          // 收尾：先 finish_reason 再 [DONE]。
          //
          // ⚠️ 顺序反了会让 harness 的流截断检测误判（缺终止帧 = stream_cut）。
          //
          // ⚠️ 实测（2026-10-02 抓包）：上游在**发起了工具调用**的那一轮仍然回
          // finish_reason:"stop"。照抄就等于告诉下游「模型说完了」——agent loop
          // 于是跳过工具执行、拿空工具结果继续，症状是「模型好像没在用工具」。
          // 所以 finish_reason 以**我们自己看见了什么**为准：转出过任何工具调用
          // 就是 tool_calls，否则那是在断言一个这一轮没有发生的事。
          // ⚠️ 判据是「**真的发出去了**」，不是「看见了」。一个 nameless 的工具
          // 调用会被扣住不发射（name:"" 会污染会话），若按「看见了」算，
          // 这一轮就会报 tool_calls 而客户端一个工具调用都收不到 —— 反过来撒谎。
          for (const entry of toolIndex.values()) {
            if (entry.emitted) {
              finish = "tool_calls";
              break;
            }
          }
          send(buildOpenAIChunk(chatId, created, modelName, {}, finish, usage));
          send("data: [DONE]\n\n");
        } catch (error) {
          // 报错也要走 [DONE]，否则下游一直等 —— 但内容必须说出来，
          // 不能干净收尾（与本项目「完整结束但什么都没吐」那条同纪律）。
          const message = error instanceof Error
            ? error.message
            : String(error);
          send(
            "data: " + JSON.stringify({
              error: { message, type: "upstream_error" },
            }) + "\n\n",
          );
          send(buildOpenAIChunk(chatId, created, modelName, {}, "stop"));
          send("data: [DONE]\n\n");
        } finally {
          try {
            await reader.cancel();
          } catch {
            /* 上游已断开 */
          }
          try {
            controller.close();
          } catch {
            /* 客户端已断开 */
          }
        }

        function handleEvent(dataLine: string): void {
          const ev = parseTraeSSELine(eventName, dataLine);

          if (ev.event === "error") {
            // 流内业务错误：抛出去走上面的 catch，否则它会被当成一次正常结束
            throw new Error(
              "TRAE " + (ev.errorCode ?? "?") + ": " +
                (ev.errorMessage ?? "unknown"),
            );
          }

          if (ev.event === "done") {
            if (ev.finishReason !== undefined && ev.finishReason.length > 0) {
              finish = normalizeFinishReason(ev.finishReason);
            }
            return;
          }

          if (ev.event === "token_usage" && ev.usage !== undefined) {
            usage = mapTraeUsage(ev.usage);
            return;
          }

          if (ev.event !== "output") return;

          if (
            ev.reasoningContent !== undefined && ev.reasoningContent.length > 0
          ) {
            send(buildOpenAIChunk(chatId, created, modelName, {
              reasoning_content: ev.reasoningContent,
            }));
          }

          if (ev.response !== undefined && ev.response.length > 0) {
            send(buildOpenAIChunk(chatId, created, modelName, {
              content: ev.response,
            }));
          }

          if (ev.toolCalls !== undefined) {
            for (const raw of ev.toolCalls) {
              if (typeof raw !== "object" || raw === null) continue;
              const call = raw as Record<string, unknown>;
              const index = typeof call.index === "number" ? call.index : 0;
              const fn =
                typeof call.function === "object" && call.function !== null
                  ? call.function as Record<string, unknown>
                  : {};
              let entry = toolIndex.get(index);
              if (entry === undefined) {
                const id = typeof call.id === "string" && call.id.length > 0
                  ? call.id
                  : "call_" + index + "_" + Date.now().toString(36);
                entry = { id, name: "", args: "", emitted: false };
                toolIndex.set(index, entry);
              }
              if (typeof fn.name === "string" && fn.name.length > 0) {
                entry.name = fn.name;
              }
              if (typeof fn.arguments === "string") {
                entry.args += fn.arguments;
              }
              // 名字为空前不发射：下游拿到 name:"" 的 tool call 会污染会话，
              // 下一轮回放时被 400 拒绝。
              if (entry.name.length === 0) continue;
              if (!entry.emitted) {
                entry.emitted = true;
                send(buildOpenAIChunk(chatId, created, modelName, {
                  tool_calls: [{
                    index,
                    id: entry.id,
                    type: "function",
                    function: { name: entry.name, arguments: entry.args },
                  }],
                }));
                continue;
              }
              if (typeof fn.arguments === "string" && fn.arguments.length > 0) {
                send(buildOpenAIChunk(chatId, created, modelName, {
                  tool_calls: [{
                    index,
                    function: { arguments: fn.arguments },
                  }],
                }));
              }
            }
          }
        }
      })();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
/**
 * SOLO 的 finish_reason → OpenAI 的。
 *
 * 未识别的值一律映射成 stop 而不是原样透传：客户端拿到不认识的 finish_reason
 * 可能当成「还在继续」，于是整轮卡住。
 */
function normalizeFinishReason(raw: string): string {
  const value = raw.toLowerCase().trim();
  if (value === "tool_calls" || value === "function_call") return "tool_calls";
  if (value === "length" || value === "max_tokens") return "length";
  return "stop";
}

// ── 对外：模型目录 → OpenAI 形状 ──

/**
 * 目录 → OpenAI /models 条目。
 *
 * ⚠️ thinking 档位只发**上游真的发布过的** id。上游的阶梯用 light/high/
 * extra_high，而本项目的 harness 只收 max|xhigh|high|medium|low|minimal|none
 * —— 不做映射就是发了上游不认的值；凭空补齐则是编造能力。
 * 判据：阶梯里每个 id 都要能通过上游自己的校验器，而不是通过自己的读取器。
 */
const EFFORT_FROM_TRAE: Record<string, string> = {
  light: "low",
  high: "high",
  extra_high: "xhigh",
};

export interface TraeModelCard {
  id: string;
  name: string;
  context_window: number;
  max_output_tokens: number;
  input_modalities: string[];
  reasoning?: {
    efforts: Array<{ id: string; name: string }>;
    defaultEffort: string;
  };
}

export function toModelCard(model: TraeModel): TraeModelCard {
  const efforts: Array<{ id: string; name: string }> = [];
  let defaultEffort = "";
  const config = model.reasoning;
  if (config !== undefined && config.supportThinking !== false) {
    for (const option of config.options) {
      const mapped = EFFORT_FROM_TRAE[option];
      if (mapped === undefined) continue;
      if (!efforts.some((effort) => effort.id === mapped)) {
        efforts.push({ id: mapped, name: option });
      }
    }
    const preferred = EFFORT_FROM_TRAE[config.defaultLevel ?? ""];
    if (preferred !== undefined && efforts.some((e) => e.id === preferred)) {
      defaultEffort = preferred;
    } else if (efforts.length > 0) {
      defaultEffort = efforts[0].id;
    }
  }
  return {
    id: model.id,
    name: model.name,
    context_window: model.contextWindow,
    // 收敛到上游的真上限：客户端索要更大值会把上游打成 4xx。
    max_output_tokens: Math.min(
      model.maxOutputTokens,
      TRAE_DEFAULT_MAX_COMPLETION_TOKENS,
    ),
    input_modalities: model.multimodal === true ? ["text", "image"] : ["text"],
    // 空阶梯会**整个 provider 被 harness 拒绝**，所以没有就不声明该字段。
    ...efforts.length === 0 ? {} : {
      reasoning: { efforts, defaultEffort },
    },
  };
}
