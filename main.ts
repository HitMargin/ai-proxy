import { ENV, providers, safeJsonParse, cloneHeadersForUpstream, filterHealthyModels, tryParseResponse, createStreamTransformer } from "./src/core.ts";
export { ENV } from "./src/core.ts";
import { CNB_MODELS, handleCnb } from "./src/cnb.ts";
import { handleDeepseekWeb } from "./src/deepseek-web.ts";
// ---------- 鉴权 ----------
function checkAuth(request: Request) {
  const authHeader = request.headers.get("authorization");
  const apiKeyHeader = request.headers.get("x-api-key");
  const allowedKeys = ENV.API_KEYS.split(",").map((k) => k.trim()).filter(Boolean);
  if (allowedKeys.length === 0) return true;
  let providedKey: string | null = null;
  if (authHeader && authHeader.startsWith("Bearer ")) providedKey = authHeader.slice(7);
  else if (apiKeyHeader) providedKey = apiKeyHeader;
  return !!providedKey && allowedKeys.includes(providedKey);
}

// ---------- 缓存 ----------
const cache: any = { data: {}, TTL: 5 * 60 * 1000 };

// ---------- 主处理 ----------
// 反向代理模式：BACKEND_URL 有值时纯转发（流式进出，不解析），重活由后端干
async function proxyToBackend(request: Request): Promise<Response> {
  const base = ENV.BACKEND_URL.replace(/\/+$/, "");
  const url = new URL(request.url);
  const target = base + url.pathname + url.search;
  const headers = new Headers();
  for (const name of ["content-type", "authorization", "accept", "user-agent", "x-api-key"]) {
    const v = request.headers.get(name);
    if (v) headers.set(name, v);
  }
  // 缓冲请求体以支持重试（免费隧道约 10% 随机连接抖动；纯拷贝不产生解析 CPU）
  let body: ArrayBuffer | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    body = await request.arrayBuffer();
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch(target, {
        method: request.method,
        headers,
        body: body === undefined ? undefined : new Uint8Array(body.slice(0)),
        // @ts-ignore 流式请求体需要
        duplex: body === undefined ? "half" : undefined,
      });
      return resp;
    } catch (e: any) {
      if (attempt === 0) {
        console.warn(`[proxy] fetch to backend failed (${e?.message || e}), retrying once`);
        continue;
      }
      throw e;
    }
  }
  throw new Error("unreachable");
}

// ---------- /v1 聚合端点：一个入口用多个上游（kilo / zen / cnb） ----------
// 模型 id 带命名空间前缀（如 "cnb/deepseek-v4-flash"），GET /v1/models 聚合列出全部成员模型；
// POST 按 model 前缀重写成成员自己的路由前缀后递归走 handler，完整复用各成员的处理链
// （cnb 的串行闸/预检/重试、zen/kilo 的透传与鉴权）。裸 id（无前缀）按 [kilo, zen, cnb]
// 顺序解析以保持旧行为，但列表冷启动时需要先 GET 一次 /v1/models 暖缓存。
const V1_AGGREGATE_MEMBERS = ["kilo", "zen", "cnb"];

function v1MemberModelIds(key: string): string[] {
  if (key === "cnb") return CNB_MODELS.map((m: any) => m.id);
  return (cache.data[key]?.data?.data || []).map((m: any) => m.id);
}

function v1ResolveModel(model: string): { key: string; raw: string } | null {
  const slash = model.indexOf("/");
  if (slash > 0) {
    const key = model.slice(0, slash);
    if (V1_AGGREGATE_MEMBERS.includes(key)) return { key, raw: model.slice(slash + 1) };
    return null;
  }
  for (const key of V1_AGGREGATE_MEMBERS) {
    if (v1MemberModelIds(key).includes(model)) return { key, raw: model };
  }
  return null;
}

async function v1FetchMemberModels(): Promise<Record<string, any[]>> {
  const out: Record<string, any[]> = {};
  const now = Date.now();
  // 干净请求：手动携带各成员需要的默认凭据（zen 要 Bearer public），避免被客户端 token 污染
  const shimReq = new Request("http://internal/", { headers: { "content-type": "application/json", "authorization": "Bearer public" } });
  await Promise.allSettled(V1_AGGREGATE_MEMBERS.map(async (key) => {
    if (key === "cnb") { out[key] = CNB_MODELS; return; }
    const fresh = cache.data[key];
    if (fresh && now - fresh.timestamp < cache.TTL) { out[key] = fresh.data?.data || []; return; }
    const p: any = (providers as any)[key];
    let modelsPath = p.endpoints.models;
    if (p.pathRewrite) modelsPath = p.pathRewrite(p.prefix + "/models");
    const headers = cloneHeadersForUpstream(shimReq, p, ENV);
    if (p.extraHeaders) for (const [k, v] of Object.entries(p.extraHeaders)) headers.set(k, v as string);
    const resp = await fetch(p.baseUrl + modelsPath, { headers });
    const parsed = await tryParseResponse(resp);
    if (parsed.error || !parsed.data) return;
    let filtered = parsed.data;
    if (p.filterModels) filtered = p.filterModels(parsed.data);
    const arr = filtered?.data || [];
    if (arr.length) cache.data[key] = { timestamp: now, data: filtered }; // 顺手暖成员缓存（裸 id 解析要用）
    out[key] = arr;
  }));
  return out;
}

async function handleAggregateV1(path: string, request: Request, url: URL): Promise<Response> {
  const json = (obj: any, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });

  if (path.endsWith("/models") && request.method === "GET") {
    const now = Date.now();
    if (!cache.data["v1-aggregate"] || now - cache.data["v1-aggregate"].timestamp >= cache.TTL) {
      const members = await v1FetchMemberModels();
      const data: any[] = [];
      for (const key of V1_AGGREGATE_MEMBERS) {
        for (const m of members[key] || []) data.push({ ...m, id: `${key}/${m.id}`, owned_by: key });
      }
      cache.data["v1-aggregate"] = { timestamp: now, data: { object: "list", data } };
    }
    return json(cache.data["v1-aggregate"].data);
  }

  if (request.method === "POST") {
    const parsed = safeJsonParse(await request.text());
    if (parsed.error) return json({ error: "Invalid JSON body", detail: parsed.error.message }, 400);
    const openaiBody = parsed.data || {};
    const model = String(openaiBody.model || "");
    const resolved = model ? v1ResolveModel(model) : null;
    if (!resolved) {
      return json({
        error: `Unknown model: ${model || "(empty)"}`,
        hint: 'use "kilo/<id>" / "zen/<id>" / "cnb/<id>" / "deepseek-web/<id>" (see GET /v1/models); bare ids resolve kilo→zen→cnb after the list is warm',
      }, 400);
    }
    const rest = path.slice("/v1".length) || "/";
    const target = new URL((providers as any)[resolved.key].prefix + rest, url.origin);
    const h = new Headers();
    h.set("content-type", request.headers.get("content-type") || "application/json");
    const accept = request.headers.get("accept");
    if (accept) h.set("accept", accept);
    // 成员上游各有默认凭据（kilo 无、zen public、cnb 自建 CSRF），剥掉客户端 token 防污染；
    // 仅当本代理自身开了 API_KEYS 才透传（供递归时的 checkAuth 通过）
    if (ENV.API_KEYS) {
      for (const name of ["authorization", "x-api-key"]) {
        const v = request.headers.get(name);
        if (v) h.set(name, v);
      }
    }
    return await handler(new Request(target, { method: "POST", headers: h, body: JSON.stringify({ ...openaiBody, model: resolved.raw }) }));
  }

  return json({ error: "Not found", hint: "GET /v1/models | POST /v1/chat/completions | POST /v1/responses" }, 404);
}

export async function handler(request: Request): Promise<Response> {
  try {
    if (ENV.BACKEND_URL) return await proxyToBackend(request);
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    if (path !== "/" && path !== "") {
      if (!checkAuth(request)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
    }

    if (path === "/" || path === "") {
      return new Response(JSON.stringify({
        message: "Multi-Provider AI Proxy (Deno Deploy)",
        providers: Object.keys(providers),
      }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // /v1 聚合端点（kilo/zen/cnb 多上游一个入口）
    if (path === "/v1" || path.startsWith("/v1/")) return await handleAggregateV1(path, request, url);

    // 匹配 provider
    let matchedProvider: any = null;
    let matchedKey = "";
    for (const [key, provider] of Object.entries(providers)) {
      if (!path.startsWith(provider.prefix)) continue;
      const rest = path.slice(provider.prefix.length);
      if (rest === "" || rest[0] === "/" || rest[0] === "?") {
        matchedProvider = provider;
        matchedKey = key;
        break;
      }
    }

    if (!matchedProvider) {
      return new Response(JSON.stringify({ error: "Unknown provider" }), {
        status: 404,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const provider = matchedProvider;
    const providerKey = matchedKey;
    if (provider.customHandler === "cnb") return await handleCnb(path, request, url);
    if (provider.customHandler === "deepseek-web") return await handleDeepseekWeb(path, request, url);

    const baseUrl = provider.baseUrl;
    const endpoints = provider.endpoints;

    // 模型列表
    if (path.endsWith(endpoints.models) && request.method === "GET") {
      const now = Date.now();
      const cacheKey = providerKey;
      const forceHealth = url.searchParams.get("health") === "true";

      if (!forceHealth && cache.data[cacheKey] && now - cache.data[cacheKey].timestamp < cache.TTL) {
        return new Response(JSON.stringify(cache.data[cacheKey].data), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }

      let modelsPath = endpoints.models;
      if (provider.pathRewrite) modelsPath = provider.pathRewrite(path);
      const targetUrl = baseUrl + modelsPath + url.search;
      const headers = cloneHeadersForUpstream(request, provider, ENV);
      if (provider.extraHeaders) {
        for (const [k, v] of Object.entries(provider.extraHeaders)) headers.set(k, v as string);
      }

      try {
        const resp = await fetch(targetUrl, { headers });
        const parsed = await tryParseResponse(resp);
        if (parsed.error) {
          return new Response(JSON.stringify({ error: "Upstream returned non-JSON response", detail: parsed.error.message }), {
            status: resp.status || 502,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          });
        }
        let filteredData = parsed.data;
        if (provider.filterModels) filteredData = provider.filterModels(parsed.data);

        if (forceHealth && filteredData?.data?.length > 0) {
          const healthy = await filterHealthyModels(filteredData.data, providerKey, baseUrl);
          filteredData.data = healthy;
          cache.data[cacheKey] = { timestamp: Date.now(), data: filteredData };
        } else if (!forceHealth) {
          cache.data[cacheKey] = { timestamp: Date.now(), data: filteredData };
          if (filteredData?.data?.length > 0) {
            // Deno Deploy 支持 EdgeRuntime.waitUntil；没有就 fire-and-forget
            const task = (async () => {
              const healthy = await filterHealthyModels(filteredData.data, providerKey, baseUrl);
              cache.data[cacheKey] = { timestamp: Date.now(), data: { ...filteredData, data: healthy } };
            })().catch(() => {});
            if (typeof (globalThis as any).EdgeRuntime?.waitUntil === "function") {
              (globalThis as any).EdgeRuntime.waitUntil(task);
            }
          }
        }
        return new Response(JSON.stringify(filteredData), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: "Failed to fetch models", detail: e.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
    }

    // 聊天补全
    if (path.endsWith(endpoints.chat) && request.method === "POST") {
      let bodyText = "";
      try { bodyText = await request.text(); }
      catch (e: any) {
        return new Response(JSON.stringify({ error: "Failed to read request body", detail: e.message }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
      const parsed = safeJsonParse(bodyText);
      if (parsed.error) {
        return new Response(JSON.stringify({ error: "Invalid JSON body", detail: parsed.error.message }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
      const openaiBody = parsed.data || {};
      const adapter = provider.adapter;
      let targetBody = openaiBody;
      if (adapter?.request) {
        try { targetBody = adapter.request(openaiBody); }
        catch (e: any) {
          return new Response(JSON.stringify({ error: "Adapter request transform failed", detail: e.message }), {
            status: 500,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          });
        }
      }

      let chatPath = endpoints.chat;
      if (provider.pathRewrite) chatPath = provider.pathRewrite(path);
      const targetUrl = baseUrl + chatPath + url.search;
      const headers = cloneHeadersForUpstream(request, provider, ENV);
      if (provider.extraHeaders) {
        for (const [k, v] of Object.entries(provider.extraHeaders)) headers.set(k, v as string);
      }

      let upstreamResponse: Response;
      try {
        upstreamResponse = await fetch(targetUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(targetBody),
          redirect: "follow",
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: "Proxy error", detail: e.message }), {
          status: 502,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }

      if (targetBody.stream === true) {
        if (adapter.isIdentity) {
          return new Response(upstreamResponse.body, {
            status: upstreamResponse.status,
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }
        const transformer = createStreamTransformer(adapter, openaiBody);
        if (!transformer) {
          return new Response(upstreamResponse.body, {
            status: upstreamResponse.status,
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }
        return new Response(upstreamResponse.body!.pipeThrough(transformer), {
          status: upstreamResponse.status,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      const parsedResp = await tryParseResponse(upstreamResponse);
      if (parsedResp.error) {
        return new Response(JSON.stringify({ error: "Upstream returned non-JSON response", detail: parsedResp.error.message }), {
          status: upstreamResponse.status || 502,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
      let finalResponse = parsedResp.data;
      if (adapter?.response) {
        try { finalResponse = adapter.response(parsedResp.data); }
        catch (e: any) {
          return new Response(JSON.stringify({ error: "Adapter response transform failed", detail: e.message }), {
            status: 500,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          });
        }
      }
      return new Response(JSON.stringify(finalResponse), {
        status: upstreamResponse.status,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: "Server internal error", detail: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
}

// 本地 Deno 直跑入口（Workers 里 Deno 未定义，自动跳过；Workers 入口见 worker.ts）
if (typeof Deno !== "undefined") Deno.serve({ port: Number(Deno.env.get("PORT") ?? 8000) }, handler);
