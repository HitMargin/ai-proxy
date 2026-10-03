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
 * 探测单个模型的可调性。**任何异常都归为 unknown**，绝不抛出。
 *
 * ⚠️ 用聊天头而不是目录头：判据是「聊天路由认不认它」，而 /v3/config 与
 * scoped 端点用的是另一套 X-Product 语义（见 workBuddyCatalogHeaders）。
 */
async function probeOneModel(
  credential: WorkBuddyCredential,
  modelId: string,
  fetcher: WorkBuddyFetcher,
  signal: AbortSignal | undefined,
): Promise<WorkBuddyVerdict> {
  try {
    const { status, body } = await requestWorkBuddy(
      "POST",
      `${WORKBUDDY_ENDPOINT}${CHAT_COMPLETIONS_PATH}`,
      workBuddyChatHeaders(credential),
      {
        fetcher,
        // 单个模型只要 300ms 量级就能判死；用 10s 而不是通用 60s，否则一批
        // 卡住的模型会把整轮目录拉取拖成分钟级 —— 上层有 5 分钟 TTL，用户在
        // 这期间看到的还是上一份列表（可接受），但首屏不该等这么久。
        timeoutMs: 10_000,
        ...signal === undefined ? {} : { signal },
        body: JSON.stringify(buildModelProbeBody(modelId)),
      },
    );
    // 401/5xx 都不代表模型不可用：前者是令牌问题，会走续期；后者是上游
    // 暂时故障。把它们算成 dead 会在一次抖动里清空选择器。
    if (status === 401 || status >= 500) return "unknown";
    return classifyModelProbe(body);
  } catch {
    return "unknown";
  }
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

/** 同名 id 以 primary（企业端点）为准，extra 独有的追加在后。 */
function mergeRemoteModels(
  primary: WorkBuddyModel[],
  extra: WorkBuddyModel[],
): WorkBuddyModel[] {
  const known = new Set(primary.map((model) => model.id));
  return [...primary, ...extra.filter((model) => !known.has(model.id))];
}

/**
 * 一次对话的目录：`/console/enterprises/personal/models` 与 `/v3/config` 的**并集**。
 *
 * ⚠️ 必须并集而不是「谁先成功用谁」：两个端点的 id 集合并不相同，促销的 modelIds
 * 也只挂在其中一侧。先到先得的写法会让 hy4-preview-f（新用户限时免费变体，
 * 只由 /v3/config 下发且被 agent 引用）在另一个端点可用时整批消失 —— 用户看不到
 * 那个免费变体，而服务端照常按它计费。
 *
 * 两个端点都空才回退静态表（中国版那张表是空的，见 STATIC_FALLBACK_MODELS 注释：
 * 与其给一份「选得到、调不通」的国际版别名，不如让渠道如实为空）。
 */
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
