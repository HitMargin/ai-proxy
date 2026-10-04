/**
 * 自定义供应商的 HTTP 入口：\`/custom/v1/models\` 与 \`/custom/v1/chat/completions\`。
 *
 * 为什么不复用通用 passthrough 分支：那条路从 \`provider.auth\` 读**静态**凭据，
 * 而自定义供应商的 baseUrl 和 apiKey 是按**请求里的供应商名**变动的
 * （\`custom/<name>/<model>\`）。硬塞进静态表就得为每个供应商伪造一个 provider 条目，
 * 而那张表是启动时定格的——正是本功能要避开的约束。
 *
 * 另一条理由同样重要：**通用分支会把入站请求的 authorization 转发给上游**。
 * 对内置渠道那是对的（客户端自带 key 时用它的），对用户自己填的上游则是把本代理的
 * 入站凭据送给第三方。这里只发我们自己解析出来的那把 key。
 */

import { CUSTOM_PREFIX, type CustomProvider, customEndpoint, customUpstreamHeaders, describeCustomProviders, parseCustomProviders, resolveCustomTarget } from "./custom.ts";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
};

/** 上游列表超时：卡住的上游不该拖住面板轮询。 */
const LISTING_TIMEOUT_MS = 15_000;
/** 推理超时比列表宽，但仍要有上限：没有上限的等待在面板上表现为「一直转」。 */
const TURN_TIMEOUT_MS = 600_000;

/** 代理只从环境读配置，插件把整张表序列化后注入。 */
export function customProvidersFromEnv(
  env: Record<string, string | undefined>,
): ReturnType<typeof parseCustomProviders> {
  return parseCustomProviders(env.AI_PROXY_CUSTOM_PROVIDERS);
}

/** 面板/健康检查想问「现在配了哪些」，本模块自己解析一次环境。 */
export function customProvidersSnapshot(env: Record<string, string | undefined>) {
  return describeCustomProviders(customProvidersFromEnv(env));
}

function jsonError(message: string, status: number, extra?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ error: message, ...extra }), {
    status,
    headers: JSON_HEADERS,
  });
}

/**
 * 代理自定义供应商的请求。
 *
 * @param path 完整路径（\`/custom/v1/...\`）
 * @param request 入站请求
 * @param env 进程环境
 */
export async function handleCustom(
  path: string,
  request: Request,
  env: Record<string, string | undefined>,
): Promise<Response> {
  const parsed = customProvidersFromEnv(env);

  // 没配任何供应商时要说清是「没配」，不是「上游挂了」。面板靠这个区分
  // 「去填一个」和「去检查你的地址」。
  if (parsed.providers.length === 0 && parsed.rejected.length === 0) {
    return jsonError("no custom providers are configured", 404, {
      hint: "add one in the ai-proxy panel (Settings → 自定义供应商)",
    });
  }

  // 列表端点：聚合所有**启用**供应商的 /models，并把模型 id 前置成 <name>/<id>。
  if (path.endsWith("/models") && request.method === "GET") {
    return await listCustomModels(parsed);
  }

  if (!path.endsWith("/chat/completions") || request.method !== "POST") {
    return jsonError("not found", 404, {
      routes: ["GET /" + CUSTOM_PREFIX + "/v1/models", "POST /" + CUSTOM_PREFIX + "/v1/chat/completions"],
    });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch (e: any) {
    return jsonError("Invalid JSON body", 400, { detail: e?.message });
  }
  const body = (raw ?? {}) as Record<string, unknown>;
  const wireModel = String(body.model ?? "");
  const target = resolveCustomTarget(parsed, wireModel);
  if (target === null) {
    // 不猜供应商：猜错等于把请求连同凭据发给另一个上游。
    return jsonError("unknown custom provider", 404, {
      model: wireModel,
      providers: parsed.providers.filter((p) => p.enabled).map((p) => p.name),
    });
  }
  if (!target.provider.enabled) {
    return jsonError("this custom provider is switched off", 403, { provider: target.provider.name });
  }

  const stream = body.stream === true;
  const headers = customUpstreamHeaders(
    target.provider,
    target.upstreamModel,
    request.headers,
    stream,
  );
  const url = customEndpoint(target.provider, "/chat/completions");

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, model: target.upstreamModel }),
      signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
    });
  } catch (e: any) {
    // 只报供应商名和原因，绝不回显 url 里的东西以外的东西——url 是用户自己填的，
    // 而 key 在头里，不在这个字符串里。
    return jsonError("custom upstream is unreachable", 502, {
      provider: target.provider.name,
      detail: String(e?.message ?? e),
    });
  }

  // 流式：原样透传字节。自定义上游发什么就是什么——本代理不替它改写 SSE，
  // 所以它缺终止帧的话，下游会按截断处理（这是对的，不是我们的责任去补）。
  if (stream && upstream.body !== null) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  const text = await upstream.text().catch(() => "");
  return new Response(text, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * 聚合所有启用供应商的模型列表。
 *
 * id 前置成 \`<name>/<model>\`，与调用时的解析规则互为逆运算——这两处必须同改，
 * 否则列表里能选、发出去解析不到（或反过来）。
 *
 * 一个供应商拉不动时**不拖垮其余**：它自己那部分报空并在 \`errors\` 里说明，
 * 其余照常返回。整张列表因为一个坏地址变空，等于让用户以为功能整体坏了。
 */
async function listCustomModels(
  parsed: ReturnType<typeof parseCustomProviders>,
): Promise<Response> {
  const active = parsed.providers.filter((p) => p.enabled);
  const data: Record<string, unknown>[] = [];
  const errors: Record<string, string> = {};

  const results = await Promise.allSettled(
    active.map(async (provider) => {
      const headers = customUpstreamHeaders(provider, "", new Headers(), false);
      const response = await fetch(customEndpoint(provider, "/models"), {
        headers,
        signal: AbortSignal.timeout(LISTING_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error("HTTP " + response.status);
      }
      const payload = await response.json();
      return { provider, payload };
    }),
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const provider = active[i];
    if (result.status === "rejected") {
      errors[provider.name] = String(result.reason?.message ?? result.reason);
      continue;
    }
    const rows = Array.isArray(result.value.payload?.data) ? result.value.payload.data : [];
    // 空列表当「没答上来」而不是「这里什么都没有」：上游正常但没有模型，
    // 与上游没答，在用户眼里都该是「这个供应商现在没货」。
    if (rows.length === 0) continue;
    for (const row of rows) {
      if (row === null || typeof row !== "object") continue;
      const id = String((row as Record<string, unknown>).id ?? "");
      if (id === "") continue;
      data.push({ ...row as Record<string, unknown>, id: provider.name + "/" + id });
    }
  }

  return new Response(
    JSON.stringify({
      object: "list",
      data,
      // 只在非空时出现，沿用 /health 的 catalogIssues 那条纪律。
      ...(Object.keys(errors).length > 0 ? { errors } : {}),
      ...(parsed.rejected.length > 0 ? { rejected: parsed.rejected } : {}),
    }),
    { headers: JSON_HEADERS },
  );
}

/** 供 main.ts 判断一个路径是不是自定义渠道。 */
export function isCustomPath(path: string): boolean {
  return path === "/" + CUSTOM_PREFIX || path.startsWith("/" + CUSTOM_PREFIX + "/");
}

export type { CustomProvider };
