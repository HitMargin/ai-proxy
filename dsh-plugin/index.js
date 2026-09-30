/**
 * Optional DSH host bridge for ai-proxy's local CommandCode endpoint.
 *
 * This is deliberately a thin adapter: ai-proxy remains the only component
 * that owns CommandCode credentials, account rotation, quota and protocol
 * conversion. The plugin only advertises /commandcode/v1/models and forwards
 * DSH chat calls to the local proxy.
 *
 * It is not installed automatically. Copy this directory into a DSH profile's
 * node_modules and add the bundle entry only after reviewing the endpoint.
 */

const ROUTE = 'ai-proxy-commandcode';
const DEFAULT_BASE_URL = 'http://127.0.0.1:8000/commandcode/v1';
const DEFAULT_MAX_TOKENS = 64000;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeBaseUrl(value) {
  const url = new URL(value);
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(
    url.hostname.toLowerCase(),
  );
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('ai-proxy-dsh-bridge baseURL must use HTTPS or loopback HTTP');
  }
  return url.href.replace(/\/$/, '');
}

function envValue(name) {
  try {
    return typeof process !== 'undefined' ? process.env[name] || '' : '';
  } catch {
    return '';
  }
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') {
      return part.text;
    }
    return '';
  }).join('');
}

function toOpenAiMessages(options) {
  const output = [];
  if (typeof options.system === 'string' && options.system !== '') {
    output.push({ role: 'system', content: options.system });
  }
  for (const message of Array.isArray(options.messages) ? options.messages : []) {
    if (!isRecord(message)) continue;
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const content = message.content;
    if (role === 'user' && Array.isArray(content)) {
      const parts = [];
      for (const part of content) {
        if (!isRecord(part)) continue;
        if (part.type === 'text' && typeof part.text === 'string') {
          parts.push({ type: 'text', text: part.text });
        } else if (part.type === 'image' && isRecord(part.source) &&
          part.source.type === 'base64' && typeof part.source.media_type === 'string' &&
          typeof part.source.data === 'string') {
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${part.source.media_type};base64,${part.source.data}` },
          });
        }
      }
      output.push({ role, content: parts });
      continue;
    }
    output.push({ role, content: textOf(content) });
  }
  return output;
}

function toOpenAiTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const output = [];
  for (const tool of tools) {
    if (!isRecord(tool) || typeof tool.name !== 'string') continue;
    output.push({
      type: 'function',
      function: {
        name: tool.name,
        ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
        parameters: isRecord(tool.parameters) ? tool.parameters : { type: 'object' },
      },
    });
  }
  return output.length > 0 ? output : undefined;
}

function mapUsage(usage) {
  if (!isRecord(usage)) return undefined;
  const prompt = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const completion = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  if (!Number.isFinite(prompt) && !Number.isFinite(completion)) return undefined;
  return { inputTokens: Math.max(0, prompt), outputTokens: Math.max(0, completion) };
}

function finishKind(reason) {
  if (reason === 'tool_calls' || reason === 'tool_use') return 'tool-calls';
  if (reason === 'length' || reason === 'max_tokens') return 'max-tokens';
  return 'stop';
}

async function* readSse(response) {
  if (!response.body) throw new Error('ai-proxy returned an empty stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() || '';
      for (const frame of frames) {
        for (const line of frame.split(/\r?\n/)) {
          if (line.startsWith('data:')) yield line.slice(5).trim();
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.trim().startsWith('data:')) yield buffer.trim().slice(5).trim();
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
}

export class AiProxyAdapter {
  constructor(options = {}) {
    this.baseUrl = safeBaseUrl(options.baseUrl || envValue('AI_PROXY_BASE_URL') || DEFAULT_BASE_URL);
    this.apiKeyEnv = options.apiKeyEnv || 'LOCAL_AGGREGATION_API_KEY';
    this.provider = ROUTE;
  }

  headers() {
    const headers = { accept: 'application/json, text/event-stream' };
    const key = envValue(this.apiKeyEnv);
    if (key) headers.authorization = `Bearer ${key}`;
    return headers;
  }

  async request(path, init = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init.headers || {}) },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`ai-proxy ${path} returned HTTP ${response.status}: ${text.slice(0, 240)}`);
    }
    return response;
  }

  providerInfo(provider) {
    return { id: provider, name: 'CommandCode via ai-proxy' };
  }

  providerRetryPolicy() {
    return Object.freeze({
      mode: 'normal',
      maxRetries: 2,
      retryableCodes: Object.freeze(['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
      initialDelayMs: 700,
      maxDelayMs: 8000,
      jitterRatio: 0.2,
    });
  }

  async listModels() {
    const response = await this.request('/models');
    const payload = await response.json();
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    return rows.filter((row) => isRecord(row) && typeof row.id === 'string').map((row) => ({
      provider: this.provider,
      id: row.id,
      name: typeof row.name === 'string' ? row.name : row.id,
      contextWindow: Number(row.contextWindow ?? row.context_window ?? 1000000),
      maxTokens: Number(row.maxTokens ?? row.max_tokens ?? DEFAULT_MAX_TOKENS),
      inputModalities: Array.isArray(row.inputModalities) ? row.inputModalities : ['text'],
    }));
  }

  async resolveModel(provider, model) {
    const id = String(model ?? '').replace(/^ai-proxy-commandcode\//, '');
    const rows = await this.listModels();
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) return { provider, id, name: id, context: { contextWindow: 1000000 }, defaultMaxTokens: DEFAULT_MAX_TOKENS };
    return {
      provider,
      id: row.id,
      name: row.name,
      inputModalities: row.inputModalities,
      context: { contextWindow: row.contextWindow },
      defaultMaxTokens: row.maxTokens,
      reasoning: { efforts: ['off', 'low', 'high', 'max'], defaultEffort: 'high' },
    };
  }

  async prepareCall(provider, model) {
    const resolved = await this.resolveModel(provider, model);
    return { model: resolved, stream: (options) => this.stream(options, resolved) };
  }

  async *stream(options, resolved) {
    const body = {
      model: resolved.id,
      messages: toOpenAiMessages(options),
      stream: true,
      max_tokens: Number(options.maxTokens ?? resolved.defaultMaxTokens ?? DEFAULT_MAX_TOKENS),
    };
    const tools = toOpenAiTools(options.tools);
    if (tools) body.tools = tools;
    if (typeof options.reasoningEffort === 'string') body.reasoning_effort = options.reasoningEffort;
    if (typeof options.temperature === 'number') body.temperature = options.temperature;

    let response;
    try {
      response = await this.request('/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: options.signal,
      });
    } catch (error) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: error.message, code: 'TRANSPORT' } } };
      return;
    }

    let textIndex;
    let reasoningIndex;
    let text = '';
    let reasoning = '';
    let usage;
    let finish;
    const toolBlocks = new Map();
    try {
      for await (const data of readSse(response)) {
        if (data === '[DONE]') break;
        let payload;
        try { payload = JSON.parse(data); } catch { continue; }
        if (payload?.error) {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: String(payload.error.message ?? 'ai-proxy stream error'), code: 'SERVER' } } };
          return;
        }
        const choice = Array.isArray(payload?.choices) ? payload.choices[0] : undefined;
        const delta = isRecord(choice?.delta) ? choice.delta : {};
        if (typeof delta.content === 'string' && delta.content !== '') {
          if (textIndex === undefined) {
            textIndex = 0;
            yield { type: 'block-start', index: textIndex, blockType: 'text' };
          }
          text += delta.content;
          yield { type: 'text-delta', index: textIndex, text: delta.content };
        }
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
          if (reasoningIndex === undefined) {
            reasoningIndex = 1;
            yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' };
          }
          reasoning += delta.reasoning_content;
          yield { type: 'reasoning-delta', index: reasoningIndex, text: delta.reasoning_content };
        }
        for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
          if (!isRecord(call)) continue;
          const key = Number(call.index ?? 0);
          let block = toolBlocks.get(key);
          if (!block) {
            block = { index: 100 + key, id: call.id, name: call.function?.name, args: '' };
            toolBlocks.set(key, block);
            yield { type: 'block-start', index: block.index, blockType: 'tool-call' };
          }
          if (typeof call.function?.arguments === 'string' && call.function.arguments !== '') {
            block.args += call.function.arguments;
            yield { type: 'tool-call-delta', index: block.index, id: block.id, name: block.name, argumentsDelta: call.function.arguments };
          }
        }
        if (choice?.finish_reason != null) finish = choice.finish_reason;
        const mappedUsage = mapUsage(payload?.usage);
        if (mappedUsage) usage = mappedUsage;
      }
    } catch (error) {
      yield { type: 'finish', reason: { kind: options.signal?.aborted ? 'aborted' : 'error', failure: { message: error.message, code: 'TRANSPORT' } } };
      return;
    }
    if (textIndex !== undefined) {
      yield { type: 'block-end', index: textIndex, block: { type: 'text', text } };
    }
    if (reasoningIndex !== undefined) {
      yield { type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: reasoning } };
    }
    for (const block of toolBlocks.values()) {
      yield { type: 'block-end', index: block.index, block: { type: 'tool-call', id: block.id, name: block.name, arguments: block.args || '{}' } };
    }
    if (usage) yield { type: 'usage', usage };
    yield { type: 'finish', reason: { kind: finishKind(finish) } };
  }
}

export const name = 'ai-proxy-dsh-bridge';
export const inject = ['llm'];

function sameOrigin(req) {
  if (String(req.headers?.['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false;
  const origin = req.headers?.origin;
  const host = req.headers?.host;
  if (!origin || !host) return true;
  try { return new URL(origin).host === host; } catch { return false; }
}

function panelHandler(adapter) {
  return async (req, res) => {
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(payload));
    };
    if (String(req.method || 'GET').toUpperCase() !== 'GET') return send(405, { error: 'method not allowed' });
    if (!sameOrigin(req)) return send(403, { error: 'forbidden' });
    try {
      const response = await adapter.request('/panel');
      return send(200, await response.json());
    } catch (error) {
      return send(502, { error: error instanceof Error ? error.message : String(error) });
    }
  };
}

export function apply(ctx, config = {}) {
  const adapter = new AiProxyAdapter(config);
  const entryId = ctx.fiber?.entry?.options?.id ?? name;
  const registration = ctx.llm.registerAdapter([ROUTE], adapter);
  ctx.llm.registerConfigurableProviders?.([{
    provider: ROUTE,
    displayName: 'CommandCode via ai-proxy',
    settingsNs: entryId,
    settingsPath: [],
  }]);
  ctx.llm.registerModelDiscovery?.(entryId, () => adapter.listModels());
  ctx.inject?.(['webServer'], (scoped) => {
    scoped.effect(() => scoped.webServer.register({
      kind: 'prefix',
      path: '/api/ai-proxy-commandcode',
      handler: panelHandler(adapter),
    }), 'ai-proxy bridge: panel route');
  });
  return () => registration?.dispose?.();
}
