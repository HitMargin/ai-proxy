/**
 * WorkBuddy（中国版）凭据层：落盘读写 + 静默续期。
 *
 * 与 `src/trae-account.ts` 同构：文件读写是**注入的**，纯函数层（`src/workbuddy.ts`）
 * 不碰磁盘也不发网络，于是 `deno task test`（只开 --allow-env）能跑全部用例。
 *
 * 取自 dsh-codearts-auth（MIT）的 buddy.ts / buddy-oauth.ts，与那份实现不一致处
 * 都在注释里写明理由。
 */

import {
  AUTH_REFRESH_PATH,
  AUTH_REFRESH_SOURCE,
  buildCredential,
  buildModelProbeBody,
  CHAT_COMPLETIONS_PATH,
  classifyModelProbe,
  CONFIG_PATH,
  credentialExpiresAtMs,
  dropUnavailableModels,
  HTTP_HEADER_AUTH_REFRESH_SOURCE,
  HTTP_HEADER_DOMAIN,
  HTTP_HEADER_REFRESH_TOKEN,
  isRecord,
  isWorkBuddyExpired,
  isWorkBuddyRefreshable,
  parseModelsFromConfig,
  parseTokenData,
  readStringField,
  REQUEST_TIMEOUT_MS,
  safeParseJson,
  SCOPED_MODELS_PATH,
  STATIC_FALLBACK_MODELS,
  WORKBUDDY_API_DOMAIN,
  WORKBUDDY_ENDPOINT,
  WORKBUDDY_USER_AGENT,
  type WorkBuddyAccount,
  workBuddyBaseHeaders,
  workBuddyCatalogHeaders,
  workBuddyChatHeaders,
  type WorkBuddyCredential,
  type WorkBuddyModel,
  type WorkBuddyVerdict,
} from "./workbuddy.ts";

/**
 * 可调性探测的并发上限。
 *
 * ⚠️ 刻意保守：限流的症状恰好是 429，而 429 在我们眼里是 unknown —— 那意味
 * 着一整轮探测白跑。慢一点（实测 47 个模型 5.7 秒）比被限流后重来划算得多。
 */
export const WORKBUDDY_PROBE_CONCURRENCY = 6;

/** 凭据文件名。**必须加进 .gitignore** —— 它含可直接调用的 access token。 */
export const WORKBUDDY_CREDENTIAL_FILE = "workbuddy-auth.json";

/**
 * 过期前多久开始主动续期（毫秒）。
 *
 * ⚠️ 这个值目前是**保守猜的**：还没拿到真凭据，测不到 access token 的真实寿命
 * （参考实现那份也没写）。所以刻意取小 —— 真正的安全网是「401 → 续期 → 重试」
 * 那条反应式路径，而不是这里的提前量。猜大的代价是：如果令牌寿命很短（例如 1
 * 小时），提前 1 天续期就等于**每个请求都换一次令牌**，把一次故障放大成持续故障。
 */
export const WORKBUDDY_REFRESH_SKEW_MS = 10 * 60 * 1000;

/**
 * 文件读写是**注入的**，不是为了测试而抽象 —— 而是因为本项目的测试任务
 * `deno task test` 只开 `--allow-env`。不注入的话，碰文件的用例就得靠给 CI 加
 * 权限才能跑，而**给 CI 加权限比改注入点更容易被忽略**：改权限会让整套测试拿到
 * 文件系统写权限，而这个模块之外的代码也会跟着受益。
 */
export type WorkBuddyReadFile = (path: string) => Promise<string>;
export type WorkBuddyWriteFile = (
  path: string,
  data: string,
) => Promise<void>;

export type WorkBuddyFetcher = typeof fetch;

/**
 * 解析凭据文件。
 *
 * 返回 undefined 而不是抛错，是为了让「没登录过」与「文件坏了」走同一条「请先
 * 登录」路径 —— 对用户是同一件事。
 */
export async function readWorkBuddyCredential(
  root: string,
  read: WorkBuddyReadFile = Deno.readTextFile,
): Promise<WorkBuddyCredential | undefined> {
  let raw: string;
  try {
    raw = await read(root + "/" + WORKBUDDY_CREDENTIAL_FILE);
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<WorkBuddyCredential>;
    if (
      typeof parsed.access_token !== "string" ||
      parsed.access_token.length === 0
    ) {
      return undefined;
    }
    return {
      access_token: parsed.access_token,
      refresh_token: typeof parsed.refresh_token === "string"
        ? parsed.refresh_token
        : "",
      // 历史文件里可能是 ISO 字符串或秒级数字，credentialExpiresAtMs 都认，
      // 这里原样带过去，不做二次归一化（少一处可能写坏的地方）。
      expires_at: typeof parsed.expires_at === "string"
        ? parsed.expires_at
        : "",
      refresh_expires_at: typeof parsed.refresh_expires_at === "string"
        ? parsed.refresh_expires_at
        : undefined,
      token_type: typeof parsed.token_type === "string"
        ? parsed.token_type
        : undefined,
      scope: typeof parsed.scope === "string" ? parsed.scope : undefined,
      domain: typeof parsed.domain === "string" ? parsed.domain : undefined,
      user_id: typeof parsed.user_id === "string" ? parsed.user_id : undefined,
      nickname: typeof parsed.nickname === "string"
        ? parsed.nickname
        : undefined,
      enterprise_id: typeof parsed.enterprise_id === "string"
        ? parsed.enterprise_id
        : undefined,
      account_type: typeof parsed.account_type === "string"
        ? parsed.account_type
        : undefined,
    };
  } catch {
    return undefined;
  }
}

export async function writeWorkBuddyCredential(
  root: string,
  credential: WorkBuddyCredential,
  write: WorkBuddyWriteFile = Deno.writeTextFile,
): Promise<void> {
  await write(
    root + "/" + WORKBUDDY_CREDENTIAL_FILE,
    JSON.stringify(credential, null, 2) + "\n",
  );
}

/**
 * 是否需要主动续期。
 *
 * 判定不了（没有 refresh_token / 过期时间解析不出）就返回 false：宁可漏续、交给
 * 401 后的反应式续期，也不要在每次请求前多发一发请求 —— 后者会把「续期接口慢」
 * 变成「每个请求都慢」。
 */
export function needsWorkBuddyRefresh(
  credential: WorkBuddyCredential,
  nowMs: number = Date.now(),
): boolean {
  if (!isWorkBuddyRefreshable(credential)) return false;
  const expiresAt = credentialExpiresAtMs(credential);
  if (expiresAt === undefined) return false;
  return nowMs >= expiresAt - WORKBUDDY_REFRESH_SKEW_MS;
}

/** refresh_token 已失效/被服务端拒绝。调用方据此停止续期并提示重新登录。 */
export class WorkBuddyRefreshTokenExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkBuddyRefreshTokenExpiredError";
  }
}

/** 从 JSON 响应体读业务码（参考实现 responseCode）。 */
function responseCode(body: unknown): number {
  if (!isRecord(body)) return 0;
  const code = body.code;
  return typeof code === "number" && Number.isFinite(code) ? code : 0;
}

/**
 * 从 JSON 响应体读错误文案。
 *
 * ⚠️ **同时**读 `msg` 与 `message`：实测腾讯侧信封用 `msg`
 * （`{"code":0,"msg":"OK","requestId":"…","data":{…}}`），而参考实现只读
 * `message`。只读一个会让「登录中」「已过期」这类提示在真正出错时变成空串 ——
 * 用户看到的是一句没有原因的错误。
 */
function responseMessage(body: unknown): string {
  if (!isRecord(body)) return "";
  const msg = readStringField(body, "msg");
  return msg.length > 0 ? msg : readStringField(body, "message");
}

/** 从 JSON 响应体读 data（null/undefined 视为缺失）。 */
function responseData(body: unknown): unknown {
  if (!isRecord(body)) return undefined;
  const data = body.data;
  return data === null ? undefined : data;
}

/** 发起一次控制面请求，返回 (status, body)。网络失败会抛出。 */
export async function requestWorkBuddy(
  method: "GET" | "POST",
  url: string,
  headers: Record<string, string>,
  options: {
    fetcher: WorkBuddyFetcher;
    timeoutMs?: number;
    signal?: AbortSignal;
    body?: string;
  },
): Promise<{ status: number; body: unknown }> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const signal = options.signal === undefined
    ? timeout
    : AbortSignal.any([timeout, options.signal]);
  let response: Response;
  try {
    response = await options.fetcher(url, {
      method,
      headers,
      signal,
      ...options.body === undefined ? {} : { body: options.body },
    });
  } catch (error) {
    throw new Error(
      `WorkBuddy ${method} ${url} 网络错误: ${String(error)}`,
    );
  }
  // ⚠️ 必须先 text() 再 try-parse，不能直接 await response.json()：网关的 401
  // 是 openresty 的 HTML，直接 json() 会抛解析错，把「令牌无效」伪装成
  // 「网络异常」，续期逻辑因此走进错误的分支。
  const text = await response.text();
  return { status: response.status, body: safeParseJson(text) };
}

/**
 * POST /v2/plugin/auth/token/refresh 静默续期。
 *
 * refresh_token 走 `X-Refresh-Token` 头提交（不是 body 字段），另外必须带
 * `X-Auth-Refresh-Source`，否则服务端不认这次续期。
 *
 * ⚠️ X-Domain 用**产品常量**而不是凭据里的 domain：续期请求实际发往
 * WORKBUDDY_ENDPOINT，两个不一致时服务端按错的域解析租户。
 *
 * 终态判定要宽：HTTP 401/403、业务码 401/403、文案含 expired/invalid —— 都算
 * refresh_token 已失效。不区分终态与可重试错误，会让「已失效」被无限重试。
 */
export async function refreshWorkBuddyCredential(
  credential: WorkBuddyCredential,
  fetcher: WorkBuddyFetcher = fetch,
  nowMs: number = Date.now(),
  signal?: AbortSignal,
): Promise<WorkBuddyCredential> {
  if (!isWorkBuddyRefreshable(credential)) {
    throw new WorkBuddyRefreshTokenExpiredError("无 refresh_token，请重新登录");
  }
  const headers: Record<string, string> = {
    ...workBuddyBaseHeaders(credential),
    [HTTP_HEADER_DOMAIN]: WORKBUDDY_API_DOMAIN,
    "User-Agent": WORKBUDDY_USER_AGENT,
    Authorization: "Bearer " + credential.access_token,
    [HTTP_HEADER_REFRESH_TOKEN]: credential.refresh_token,
    [HTTP_HEADER_AUTH_REFRESH_SOURCE]: AUTH_REFRESH_SOURCE,
    "Content-Type": "application/json",
  };
  const { status, body } = await requestWorkBuddy(
    "POST",
    WORKBUDDY_ENDPOINT + AUTH_REFRESH_PATH,
    headers,
    {
      fetcher,
      ...signal === undefined ? {} : { signal },
    },
  );
  if (status !== 200) {
    const code = responseCode(body);
    const message = responseMessage(body);
    const expired = status === 401 || status === 403 || code === 401 ||
      code === 403 ||
      message.includes("expired") || message.includes("invalid");
    if (expired) {
      throw new WorkBuddyRefreshTokenExpiredError(
        message.length > 0 ? message : `HTTP ${status}`,
      );
    }
    throw new Error(
      `刷新 token HTTP ${status} code=${code}: ${message}`,
    );
  }
  const data = responseData(body);
  if (data === undefined) throw new Error("刷新 token 响应缺少 data 字段");
  const token = parseTokenData(data);
  if (token.accessToken.length === 0) {
    throw new Error("刷新 token 响应缺少 accessToken");
  }
  // 续期响应里没有账号信息（uid/nickname/enterprise），逐项回落到原凭据；
  // buildCredential 负责这套回落，喂一份只含已知的 account 即可。
  const account: WorkBuddyAccount = {
    uid: credential.user_id ?? "",
    nickname: credential.nickname ?? "",
    enterpriseId: credential.enterprise_id ?? "",
    accountType: credential.account_type ?? "personal",
  };
  const refreshed = buildCredential(
    {
      ...token,
      // 轮换：响应没带新的 refresh_token 就必须保留旧的，否则下一次续期必失败
      // —— 而那要等到令牌寿命走完才暴露。
      refreshToken: token.refreshToken.length > 0
        ? token.refreshToken
        : credential.refresh_token,
      domain: token.domain.length > 0 ? token.domain : credential.domain ?? "",
    },
    account,
  );
  void nowMs;
  return refreshed;
}

/**
 * 需要时续期并回写。
 *
 * 返回 undefined 表示**不需要续期**（调用方据此跳过写盘，避免无谓 IO 与 mtime
 * 抖动 —— 面板判断「是否已配置」依赖文件内容而非时间戳）。
 */
export async function refreshWorkBuddyIfNeeded(
  root: string,
  credential: WorkBuddyCredential,
  fetcher: WorkBuddyFetcher = fetch,
  nowMs: number = Date.now(),
  signal?: AbortSignal,
  write: WorkBuddyWriteFile = Deno.writeTextFile,
): Promise<WorkBuddyCredential | undefined> {
  if (!needsWorkBuddyRefresh(credential, nowMs)) return undefined;
  const refreshed = await refreshWorkBuddyCredential(
    credential,
    fetcher,
    nowMs,
    signal,
  );
  await writeWorkBuddyCredential(root, refreshed, write);
  return refreshed;
}

// ---------- 目录拉取（三层回退 + 并集） ----------

/** 拉取企业模型端点。失败 / 空 / 解析不出都返回 undefined，交给上层回退。 */
async function requestScopedModels(
  credential: WorkBuddyCredential,
  fetcher: WorkBuddyFetcher,
  signal: AbortSignal | undefined,
): Promise<WorkBuddyModel[] | undefined> {
  try {
    const { status, body } = await requestWorkBuddy(
      "GET",
      `${WORKBUDDY_ENDPOINT}${SCOPED_MODELS_PATH}`,
      workBuddyCatalogHeaders(credential),
      { fetcher, ...signal === undefined ? {} : { signal } },
    );
    if (status !== 200) return undefined;
    const models = parseModelsFromConfig(body);
    // 空列表视为「该端点不适用于本账号」：一次空响应不该清空模型选择器。
    return models.length > 0 ? models : undefined;
  } catch {
    return undefined;
  }
}

/** 请求 /v3/config；任何失败都返回**空快照**而不是抛 —— 目录是展示增强，
 * 不该让整个渠道消失。 */
async function requestConfigModels(
  credential: WorkBuddyCredential,
  fetcher: WorkBuddyFetcher,
  signal: AbortSignal | undefined,
): Promise<WorkBuddyModel[]> {
  try {
    const { status, body } = await requestWorkBuddy(
      "GET",
      `${WORKBUDDY_ENDPOINT}${CONFIG_PATH}`,
      workBuddyCatalogHeaders(credential),
      { fetcher, ...signal === undefined ? {} : { signal } },
    );
    if (status !== 200) return [];
    return parseModelsFromConfig(body);
  } catch {
    return [];
  }
}

/**
 * 探测单次请求的超时。
 *
 * 实测（47 个模型 × 2 轮 = 94 次采样）：**不挂起**的探测延迟 p50=702ms、
 * p95=1031ms、max=1138ms；挂起的那几次**顶满整段超时**（8s/8s、60s/60s）——
 * 服务端根本不返回，不是慢。所以 3 秒有 2.6 倍余量，却能让卡死的模型 3 秒就
 * 腾出并发额度，而不是占着 6 个 worker 之一干等 10 秒（实测挂起会把整轮从
 * 5.2 秒拖成 14 秒）。
 */
export const WORKBUDDY_PROBE_TIMEOUT_MS = 3_000;

/** 二次确认的超时。真死模型实测 350–600ms 就回 11102，所以给得更短。 */
const WORKBUDDY_PROBE_CONFIRM_TIMEOUT_MS = 2_000;

/**
 * 「抖动过」的模型 id：进程内记忆，探测超时或结论不一致时记下，之后不再删它。
 *
 * 依据一条实测出来的**判别信号**：确定已死的 12 个模型 6/6 全稳定在
 * 331–1331ms 回 11102/11103，**一次都没挂起**；而 deepseek-v3-1（正在灰度
 * 下线、真实对话仍有约一半能成功）实测挂起率 27–40%，60 秒也不回。
 * 挂起不是「活」的证据，但它是「这个路由不稳定」的证据 —— 对不稳定的东西，
 * 判据必须取「宁可漏杀不可错杀」那一侧。
 *
 * ⚠️ 必须是 Set 而不是「本轮两次都 dead 才删」：后者在 11102 概率 p≈0.73 的
 * 模型上仍有约 53% 的概率误删。选择器会在两次刷新之间来回跳，而用户根本没
 * 改任何东西。记住一次抖动就把结论定死，列表才稳定。
 *
 * 与限流熔断一样是**进程内状态**（见 workBuddy.ts 的 tripWorkBuddyCircuit）：
 * 重启后重新观测即可，不必落盘。
 */
const flakyProbeModels = new Set<string>();

/** 清空抖动记忆。测试与手动重置用。 */
export function resetWorkBuddyProbeFlakiness(): void {
  flakyProbeModels.clear();
}

/** 发一次探测。**任何异常都归为 unknown**，绝不抛出。 */
async function probeOnce(
  credential: WorkBuddyCredential,
  modelId: string,
  fetcher: WorkBuddyFetcher,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<WorkBuddyVerdict> {
  try {
    const { status, body } = await requestWorkBuddy(
      "POST",
      `${WORKBUDDY_ENDPOINT}${CHAT_COMPLETIONS_PATH}`,
      workBuddyChatHeaders(credential),
      {
        fetcher,
        timeoutMs,
        ...signal === undefined ? {} : { signal },
        body: JSON.stringify(buildModelProbeBody(modelId)),
      },
    );
    // ⚠️ 只有 401 才在读报文之前就返回：那是令牌问题，会走续期，与这个模型
    // 能不能调无关。5xx **必须先读报文** —— 网关把「上游供应商故障」表达成
    // HTTP 500，实测 hunyuan-chat / hunyuan-2.0-instruct / hunyuan-2.0-thinking
    // 串行 12/12 稳定 http=500 code=10000，而 10000 是**路由解析成功之后**
    // 才可能出现的码（判 live）。旧的「status >= 500 一律 unknown」在读报文
    // 前就掐死了结论，把三个活模型整轮判成 unknown。
    if (status === 401) return "unknown";
    return classifyModelProbe(body);
  } catch {
    return "unknown";
  }
}

/**
 * 探测单个模型的可调性。**单次 11102 不定罪，要两次一致。**
 *
 * ⚠️ 用聊天头而不是目录头：判据是「聊天路由认不认它」，而 /v3/config 与
 * scoped 端点用的是另一套 X-Product 语义（见 workBuddyCatalogHeaders）。
 *
 * 为什么要二次确认：实测 deepseek-v3-1 **真实对话 6/12 成功**（内容正确、
 * usage 真实计费 prompt 11 / completion 24），空 messages 探测却回 11102 ——
 * 这条路由正在灰度下线，11102 是**概率**的（p≈0.73），不是「服务端没这个
 * 模型」。单次 11102 就删，等于把一个还能用的模型从选择器里抹掉，且用户在
 * 两次 5 分钟刷新之间会看到它时有时无。
 *
 * 反向也不放宽：两次都 dead 才删（对照组 deepseek-v3-1-volc / glm-4.6 在
 * 5 种探测形状下 0 次存活，12/13 真死二次确认仍 dead）；第二次不是 dead 就
 * 按第二次的结论走 —— live 是活证据直接保留，unknown 是「说不准」也保留。
 */
async function probeOneModel(
  credential: WorkBuddyCredential,
  modelId: string,
  fetcher: WorkBuddyFetcher,
  signal: AbortSignal | undefined,
): Promise<WorkBuddyVerdict> {
  if (flakyProbeModels.has(modelId)) return "unknown";
  const first = await probeOnce(
    credential,
    modelId,
    fetcher,
    signal,
    WORKBUDDY_PROBE_TIMEOUT_MS,
  );
  if (first !== "dead") return first;
  const second = await probeOnce(
    credential,
    modelId,
    fetcher,
    signal,
    WORKBUDDY_PROBE_CONFIRM_TIMEOUT_MS,
  );
  if (second === "dead") return "dead";
  // 第一次死、第二次没死：结论自相矛盾，说明这条路由在抖，记住它。
  flakyProbeModels.add(modelId);
  return second;
}

/**
 * 探测整份目录的可调性，返回 id → 结论。
 *
 * 并发压到 6：再高会撞上游限流，而限流的表现正是我们最不想要的形状（429 当
 * unknown 返回 = 白跑一轮）。实测 47 个模型并发 6 整轮 5.7 秒。
 */
export async function probeWorkBuddyModels(
  credential: WorkBuddyCredential,
  models: readonly WorkBuddyModel[],
  fetcher: WorkBuddyFetcher = fetch,
  signal?: AbortSignal,
): Promise<Map<string, WorkBuddyVerdict>> {
  const verdicts = new Map<string, WorkBuddyVerdict>();
  if (models.length === 0) return verdicts;
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < models.length) {
      const model = models[cursor++];
      if (model === undefined) continue;
      verdicts.set(
        model.id,
        await probeOneModel(credential, model.id, fetcher, signal),
      );
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(WORKBUDDY_PROBE_CONCURRENCY, models.length) },
      worker,
    ),
  );
  return verdicts;
}

/**
 * 同名 id 以 primary（企业端点）为准，extra 独有的追加在后。
 *
 * ⚠️ 但「为准」只对**身份与计费**成立，能力字段要**逐字段取并集**。两个端点对
 * 同一 id 下发的 `reasoning` 形状**不同**（实测）：
 *   /console/enterprises/personal/models → { effort, summary }
 *   /v3/config                        → { canDisableThinking, defaultEffort,
 *                                           supportedEfforts, summary }
 * 同名 id 上两边的默认值实测 20 处不一致（glm-5.3 只有 defaultEffort、glm-5.2 是
 * medium vs high）。若整块取 primary，deepseek-v4-pro 会只剩 effort:"high" 而丢掉
 * /v3/config 真实下发的 supportedEfforts:["high","xhigh"] —— 阶梯在选择器里整块消失。
 * 实测 5 个模型中招：hy3 / glm-5.2 / kimi-k3-1 / deepseek-v4-flash /
 * deepseek-v4-pro。
 *
 * 逐字段规则（每边缺失即 undefined，**不拿对方整个对象覆盖**）：能力字段取并集；
 * 计费三件套（creditsRate / discountedCreditsRate / agentReferenced）仍严格以
 * primary 为准 —— 它们描述「这个账号怎么计费」，两边不一致时混搭会算出既不属
 * primary 也不属 extra 的第三种价格。
 */
function mergeRemoteModels(
  primary: WorkBuddyModel[],
  extra: WorkBuddyModel[],
): WorkBuddyModel[] {
  const extraById = new Map(extra.map((model) => [model.id, model]));
  const merged = primary.map((model) => {
    const other = extraById.get(model.id);
    if (other === undefined) return model;
    // 阶梯宁多不少：primary 没给就拿 extra 的，给了就以 primary 为准。
    const efforts = model.reasoningEfforts ?? other.reasoningEfforts;
    const contextWindow = model.contextWindow ?? other.contextWindow;
    const maxOutputTokens = model.maxOutputTokens ?? other.maxOutputTokens;
    const supportsImages = model.supportsImages ?? other.supportsImages;
    const defaultEffort = model.defaultReasoningEffort ??
      other.defaultReasoningEffort;
    return {
      ...model,
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxOutputTokens === undefined ? {} : { maxOutputTokens },
      ...supportsImages === undefined ? {} : { supportsImages },
      ...efforts === undefined ? {} : { reasoningEfforts: efforts },
      ...defaultEffort === undefined
        ? {}
        : { defaultReasoningEffort: defaultEffort },
    };
  });
  const known = new Set(primary.map((model) => model.id));
  return [...merged, ...extra.filter((model) => !known.has(model.id))];
}
/** 可调性探测开关。默认开；测试关掉以免依赖网络。 */
export interface WorkBuddyCatalogOptions {
  /** 默认 true。false 时原样返回目录，不发任何探测请求。 */
  probe?: boolean;
}

export async function fetchWorkBuddyModels(
  credential: WorkBuddyCredential,
  fetcher: WorkBuddyFetcher = fetch,
  signal?: AbortSignal,
  options: WorkBuddyCatalogOptions = {},
): Promise<WorkBuddyModel[]> {
  const [scoped, config] = await Promise.all([
    requestScopedModels(credential, fetcher, signal),
    requestConfigModels(credential, fetcher, signal),
  ]);
  const merged = mergeRemoteModels(scoped ?? [], config);
  if (merged.length === 0) return [...STATIC_FALLBACK_MODELS];
  if (options.probe === false) return merged;
  // 探测只**减**列表。整轮全 unknown（例如上游整体故障）时结果不变 ——
  // 「少列几个」可接受，「一个都列不出」会让渠道看起来挂了。
  const verdicts = await probeWorkBuddyModels(
    credential,
    merged,
    fetcher,
    signal,
  );
  const kept = dropUnavailableModels(merged, verdicts);
  if (kept.length === 0) return merged;
  return kept;
}
/** 凭据是否已经不可用了（没令牌，或已过期且无法续期）。 */
export function isWorkBuddyUsable(
  credential: WorkBuddyCredential,
  nowMs: number = Date.now(),
): boolean {
  if (credential.access_token.length === 0) return false;
  if (!isWorkBuddyExpired(credential, nowMs)) return true;
  return isWorkBuddyRefreshable(credential);
}
