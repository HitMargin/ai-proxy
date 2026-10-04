/**
 * 自定义供应商：用户在面板里填的任意 OpenAI 兼容上游。
 *
 * ## 为什么是「一个前缀 + 名字在第二段」而不是一家一个前缀
 *
 * provider 的**前缀表在进程启动时就定死了**——\`main.ts\` 的 \`channelPrefixes\`、
 * \`V1_AGGREGATE_MEMBERS\`、\`src/core.ts\` 的 \`providers\` 都是模块级常量，插件的
 * \`CHANNEL_GROUPS\` 更是只在 \`apply()\` 时被注册进 harness。也就是说「每加一个供应商
 * 就多一个前缀」等于「每加一个就要重启 DSH Host」，而面板上点一下就生效才是这个功能
 * 存在的理由。
 *
 * 所以所有自定义供应商共用 \`custom\` 这一个前缀，供应商名作为路由的第二段：
 *
 *     custom/<供应商名>/<上游模型 id>
 *
 * 前缀是静态的（启动时就在表里），只有「名字 → {baseUrl, apiKey}」这张映射是运行时的，
 * 可以随 settings 变。这是本模块唯一的设计取舍。
 *
 * ## 凭据只在环境里
 *
 * 代理只从环境读凭据（见 \`src/core.ts\` 的注释），所以插件把整个供应商表序列化成
 * \`AI_PROXY_CUSTOM_PROVIDERS\` 注入到 spawn 的环境里。这个变量**含 apiKey**，因此
 * 它绝不能出现在任何日志、错误消息或 API 响应里——下面每一条错误路径都只报供应商名。
 */

/** 所有自定义供应商共用的路径前缀。 */
export const CUSTOM_PREFIX = "custom";

/** 单个供应商在 \`custom/<name>/<model>\` 里那一段的合法形状。 */
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;

export interface CustomProvider {
  /** 路由第二段，同时也是面板上的标识。 */
  name: string;
  /** 上游根地址，必须 https（回环例外，见 validateBaseUrl）。 */
  baseUrl: string;
  /** 上游凭据。只进请求头，不进任何日志或响应。 */
  apiKey?: string;
  /** 凭据放在哪个头。默认 Authorization: Bearer。 */
  authHeader?: string;
  /** 亮给面板的名称，缺省用 name。 */
  label?: string;
  /** 关掉的供应商仍在表里，但不出现在任何列表里，调用时被拒。 */
  enabled?: boolean;
}

interface ParsedProvider {
  name: string;
  baseUrl: string;
  apiKey: string;
  authHeader: string;
  label: string;
  enabled: boolean;
}

/** 一次解析的结果：能用的、以及每个被丢掉的原因。 */
export interface ParsedCustomProviders {
  providers: ParsedProvider[];
  /** 被拒绝的条目，附原因。面板据此告诉用户哪一条没进去。 */
  rejected: { name: string; reason: string }[];
}

/**
 * 一个供应商的 baseUrl 是否可用。
 *
 * 规则和内置渠道一致：必须 https，回环地址例外（本机自架的上游，比如另一个
 * 反代，没有证书是常态）。**不校验返回的 URL 里有没有 /v1**——上游可能挂在
 * 任意子路径上，凭据由用户自己填，猜错了是他自己的配置错误，代理照实转发比
 * 替他改一个路径更可预期。
 */
export function validateBaseUrl(raw: unknown): string | null {
  const text = String(raw ?? "").trim().replace(/\/+$/, "");
  if (text === "") return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol === "https:") return text;
  if (
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname)
  ) {
    return text;
  }
  return null;
}

/**
 * 名字能否作为路由的一段。
 *
 * 它进 URL 路径，所以按路径段的严格度校验而不是「反正能用就行」：大写、空格、
 * 斜杠、百分号一律拒绝。这与插件 \`cleanSettings\` 里那条正则同源，两处必须一起改。
 */
export function validateProviderName(raw: unknown): string | null {
  const text = String(raw ?? "").trim().toLowerCase();
  return NAME_PATTERN.test(text) ? text : null;
}

/**
 * 把注入的环境变量解析成一张可用的供应商表。
 *
 * 逐条校验、逐条给出被拒的原因，**不因为一条坏就丢掉整张表**：用户手写的 JSON
 * 里有一个错字是常事，让其余四条仍然可用比让他自己找错更合理。被拒的条目带原因
 * 返回，面板能照着说。
 *
 * @param raw \`AI_PROXY_CUSTOM_PROVIDERS\` 的原始文本
 */
export function parseCustomProviders(raw: unknown): ParsedCustomProviders {
  const text = String(raw ?? "").trim();
  if (text === "") return { providers: [], rejected: [] };
  let list: unknown;
  try {
    list = JSON.parse(text);
  } catch {
    return {
      providers: [],
      rejected: [{
        name: "(env)",
        reason: "AI_PROXY_CUSTOM_PROVIDERS is not valid JSON",
      }],
    };
  }
  if (!Array.isArray(list)) {
    return {
      providers: [],
      rejected: [{
        name: "(env)",
        reason: "AI_PROXY_CUSTOM_PROVIDERS is not an array",
      }],
    };
  }

  const providers: ParsedProvider[] = [];
  const rejected: { name: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      rejected.push({ name: "(entry)", reason: "not an object" });
      continue;
    }
    const row = entry as Record<string, unknown>;
    const name = validateProviderName(row.name);
    if (name === null) {
      rejected.push({
        name: String(row.name ?? "(unnamed)"),
        reason: "name must match ^[a-z0-9][a-z0-9._-]{0,31}$",
      });
      continue;
    }
    if (seen.has(name)) {
      rejected.push({ name, reason: "duplicate name" });
      continue;
    }
    const baseUrl = validateBaseUrl(row.baseUrl);
    if (baseUrl === null) {
      rejected.push({
        name,
        reason: "baseUrl must be an https URL (loopback may use http)",
      });
      continue;
    }
    seen.add(name);
    providers.push({
      name,
      baseUrl,
      apiKey: typeof row.apiKey === "string" ? row.apiKey.trim() : "",
      authHeader:
        typeof row.authHeader === "string" && row.authHeader.trim() !== ""
          ? row.authHeader.trim()
          : "authorization",
      label: typeof row.label === "string" && row.label.trim() !== ""
        ? row.label.trim()
        : name,
      // 缺省即启用：用户填完就期望它能用，让他再点一次开关是多余的。
      enabled: row.enabled !== false,
    });
  }
  return { providers, rejected };
}

/**
 * 配置文件里的一行：与 env 形状相同，只是来源不同。
 *
 * 文件与环境的**区别只在于谁写它**，所以两者共用同一套校验。合并时环境优先：
 * 它是进程启动时显式给的那份，而文件是持久化的默认值——和命令行参数覆盖配置文件
 * 是同一条规矩。
 */
export interface MergeInput {
  /** `AI_PROXY_CUSTOM_PROVIDERS` 的原文，可能为空。 */
  envText?: unknown;
  /** `custom-providers.json` 的原文，可能为空或坏。 */
  fileText?: unknown;
}

/**
 * 把环境与文件两个来源合成一张表。
 *
 * 为什么两个来源都要有：代理可以完全脱离 DSH 插件运行（直接跑 main.ts、cloudflared
 * 隧道、Cloudflare Worker）。那种部署里没人注入环境变量，于是「自定义供应商」这个
 * 能力存在却没有入口。文件是给那条路径的入口。
 *
 * 反过来，Workers 上没有文件系统，所以文件是**可选**的：读不到就只认环境。
 * 两个都空就是「没配」，不是错误。
 *
 * 同名冲突时**环境赢**，并把被覆盖的那条记进 shadowed——静默让其中一条失效
 * 会让人以为文件写错了。
 */
export function mergeCustomSources(input: MergeInput): {
  parsed: ParsedCustomProviders;
  /** 被环境里同名条目盖掉的文件条目，供 /health 与日志说明。 */
  shadowed: string[];
  /** 文件读到了但解析不了时的原因（文件存在 ≠ 文件可用）。 */
  fileError: string | null;
  /** 每个供应商来自哪个来源，方便排查「我改的那份没生效」。 */
  origin: Record<string, "env" | "file">;
} {
  const fromEnv = parseCustomProviders(input.envText);
  const hasFile = typeof input.fileText === "string" &&
    input.fileText.trim() !== "";
  const fromFile = hasFile
    ? parseCustomProviders(input.fileText)
    : { providers: [], rejected: [] };

  let fileError: string | null = null;
  // 文件的坏条目单独说：环境那份是命令行给的，文件这份是用户手写的，出错的地方不同。
  if (
    hasFile && fromFile.providers.length === 0 && fromFile.rejected.length > 0
  ) {
    fileError = fromFile.rejected.map((r) => r.name + ": " + r.reason).join(
      "; ",
    );
  }

  const origin: Record<string, "env" | "file"> = {};
  const providers: ParsedProvider[] = [];
  const seen = new Set<string>();
  for (const provider of fromEnv.providers) {
    providers.push(provider);
    seen.add(provider.name);
    origin[provider.name] = "env";
  }
  const shadowed: string[] = [];
  for (const provider of fromFile.providers) {
    if (seen.has(provider.name)) {
      shadowed.push(provider.name);
      continue;
    }
    providers.push(provider);
    seen.add(provider.name);
    origin[provider.name] = "file";
  }

  return {
    parsed: {
      providers,
      rejected: [...fromFile.rejected, ...fromEnv.rejected],
    },
    shadowed,
    fileError,
    origin,
  };
}

/**
 * 从配置文件的内容里取出 providers 数组。
 *
 * 接受两种顶层形状：带 providers 键的对象（推荐，能带别的说明字段）与裸数组。
 * 两种都认是因为这个文件是人手写的，两种写法都很自然，只认一种会让人以为格式错了。
 */
export function customFileTextToEnvText(raw: unknown): string {
  const text = String(raw ?? "");
  if (text.trim() === "") return "";
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    // 交回去让 parseCustomProviders 报「不是合法 JSON」，保持单一错误路径。
    return text;
  }
  if (Array.isArray(doc)) return text;
  if (
    doc !== null && typeof doc === "object" &&
    Array.isArray((doc as Record<string, unknown>).providers)
  ) {
    return JSON.stringify((doc as Record<string, unknown>).providers);
  }
  return text;
}

/**
 * 配置文件的读取器：按 mtime 缓存，保存即生效。
 *
 * 与 cnb-login.txt 同款纪律：这是**明文凭据文件**，所以在 .gitignore 里，
 * 而且只读不写——面板那条路径写的是 settings.json，两条互不干涉。
 *
 * 为什么带 mtime 缓存而不是每次 readFileSync：reading 发生在**每次请求**上
 * （列表 + 每一轮对话），而配置文件改动极少。缓存命中的代价是一次 stat，
 * 未命中的代价是一次读——这个取舍让「保存后立刻生效」不必以每请求 IO 换取。
 */
export class CustomProviderFile {
  private text = "";
  private mtime = -1;
  private missing = false;

  constructor(private readonly path: string) {}

  /** 当前文件内容。文件不存在时返回空串（不是错误——大多数部署没有这个文件）。 */
  read(): string {
    try {
      const stat = Deno.statSync(this.path);
      // Deno 的 FileInfo 上是 Date（没有 mtimeMs），取毫秒是为了让比较不受
      // 纳秒精度在不同文件系统上的差异影响。
      const stamp = stat.mtime === null ? -1 : stat.mtime.getTime();
      if (this.mtime === stamp) return this.text;
      const next = Deno.readTextFileSync(this.path);
      // 只在内容真的变了时说一句：mtime 会因各种原因抖动，而日志一行翻一倍
      // 会把这个项目最该看的那种信息淹掉。
      if (next !== this.text) {
        console.log("[custom] loaded " + this.path);
      }
      this.text = next;
      this.mtime = stamp;
      this.missing = false;
      return this.text;
    } catch {
      if (!this.missing) {
        this.missing = true;
        this.mtime = -1;
        this.text = "";
      }
      return "";
    }
  }

  /** 文件是否真的被读到过。面板/健康检查据此区分「没配」与「配了空的」。 */
  exists(): boolean {
    try {
      Deno.statSync(this.path);
      return true;
    } catch {
      return false;
    }
  }
}

/** 配置文件相对进程工作目录的路径。可由环境变量改道，测试与多实例部署需要。 */
export const CUSTOM_FILE_NAME = "custom-providers.json";

/**
 * 写进错误消息里的最小示例。
 *
 * 一个把格式写错的人需要的不是「解析失败」，而是「长这样」——所以这份文本直接
 * 出现在 404 的响应体里，复制粘贴就能用。
 */
export const CUSTOM_FILE_EXAMPLE =
  '{\n  "providers": [\n    {\n      "name": "stepfun",\n      "baseUrl": "https://api.stepfun.ai/step_plan/v1",\n      "apiKey": "sk-...",\n      "label": "StepFun"\n    }\n  ]\n}';

export function customFilePath(
  env: Record<string, string | undefined>,
): string {
  const override = String(env.AI_PROXY_CUSTOM_FILE ?? "").trim();
  return override !== "" ? override : "./" + CUSTOM_FILE_NAME;
}

/** 只给面板看的形状——**不含 apiKey**。 */
export function describeCustomProviders(parsed: ParsedCustomProviders) {
  return {
    providers: parsed.providers.map((p) => ({
      name: p.name,
      label: p.label,
      baseUrl: p.baseUrl,
      enabled: p.enabled,
      keySet: p.apiKey !== "",
    })),
    rejected: parsed.rejected,
  };
}

/**
 * 一个模型 id（\`<name>/<model>\`，已剥掉 \`custom/\` 前缀）该发给哪个上游。
 *
 * 名字只在**第一段**取，因为上游模型 id 自己常带斜杠
 * （\`deepseek-ai/deepseek-v4.1-flash\`、\`z-ai/glm-5.3\`）。按最后一段切会
 * 在一半的模型上切错，而上游收到一个不存在的模型名只会回 400。
 *
 * @returns 命中的供应商与要发出去的上游模型 id；未命中返回 null
 */
export function resolveCustomTarget(
  parsed: ParsedCustomProviders,
  wireModel: string,
): { provider: ParsedProvider; upstreamModel: string } | null {
  const id = String(wireModel ?? "");
  const slash = id.indexOf("/");
  if (slash <= 0) return null;
  const name = id.slice(0, slash).toLowerCase();
  const provider = parsed.providers.find((p) => p.name === name);
  if (provider === undefined) return null;
  const upstreamModel = id.slice(slash + 1);
  if (upstreamModel === "") return null;
  return { provider, upstreamModel };
}

/**
 * 一次调用的出站头。
 *
 * 凭据按供应商自己的 \`authHeader\` 放置：绝大多数是 \`Authorization: Bearer\`，
 * 但也有网关用 \`x-api-key\`。两种都支持是因为这是唯一一处**凭据形状**的差异，
 * 而它一旦猜错，表现是一个 401 加一行什么都说明不了的日志。
 */
export function customUpstreamHeaders(
  provider: ParsedProvider,
  model: string,
  incoming: Headers,
  stream: boolean,
): Headers {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  headers.set("accept", stream ? "text/event-stream" : "application/json");
  const header = provider.authHeader.toLowerCase();
  if (provider.apiKey !== "") {
    headers.set(
      header,
      header === "authorization"
        ? "Bearer " + provider.apiKey
        : provider.apiKey,
    );
  }
  // 只转发与本代理无关的元数据头；凭据一律用我们自己的，不跟着客户端走。
  const agent = incoming.get("user-agent");
  if (agent !== null && agent !== "") headers.set("user-agent", agent);
  return headers;
}

/** 拼一个供应商的端点地址。baseUrl 末尾的斜杠已在解析时去掉。 */
export function customEndpoint(
  provider: ParsedProvider,
  endpoint: string,
): string {
  return provider.baseUrl + endpoint;
}

/** 面板/健康检查用的标识。 */
export function customModelId(name: string, upstreamModel: string): string {
  return name + "/" + upstreamModel;
}
