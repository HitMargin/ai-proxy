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

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROUTE = 'ai-proxy-commandcode';
const PROJECT_ROUTE = 'ai-proxy';
const DEFAULT_MAX_TOKENS = 64000;
const EXTRA_MODEL_ROUTES = [
  { prefix: 'deepseek-web', basePath: '/deepseek-web/v1' },
  { prefix: 'tokenharbor', basePath: '/tokenharbor/v1' },
  { prefix: 'openrouter', basePath: '/openrouter/v1' },
  { prefix: 'anthropic', basePath: '/anthropic/v1' },
  { prefix: 'gemini', basePath: '/gemini/v1' },
];

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

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 8000;
const DEFAULT_SETTINGS = {
  mode: 'local',
  projectRoot: '',
  port: DEFAULT_PORT,
  denoPath: 'deno',
  externalUrl: '',
  apiKeyEnv: 'LOCAL_AGGREGATION_API_KEY',
};

function dataDir() {
  const home = envValue('DSH_HOME') || path.join(os.homedir(), '.dsh');
  return path.join(home, 'ai-proxy-dsh-bridge');
}

function loadSettings(config = {}) {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(path.join(dataDir(), 'settings.json'), 'utf8'));
  } catch {}
  const merged = { ...DEFAULT_SETTINGS, ...(isRecord(stored) ? stored : {}), ...config };
  const port = Number(merged.port);
  return {
    ...merged,
    mode: merged.mode === 'external' ? 'external' : 'local',
    port: Number.isSafeInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT,
  };
}

function saveSettings(settings) {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'settings.json');
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(settings, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function projectCandidates(settings) {
  const candidates = [
    settings.projectRoot,
    envValue('AI_PROXY_HOME'),
    path.resolve(PLUGIN_DIR, '..'),
    process.cwd(),
  ].filter(Boolean);
  return [...new Set(candidates.map((value) => path.resolve(value)))];
}

function resolveProjectRoot(settings) {
  for (const candidate of projectCandidates(settings)) {
    if (fs.existsSync(path.join(candidate, 'main.ts')) &&
      fs.existsSync(path.join(candidate, 'deno.jsonc'))) return candidate;
  }
  return '';
}

function healthUrl(baseUrl) {
  const url = new URL('/health', baseUrl);
  return url.href;
}

export class ProxyRuntime {
  constructor(config = {}) {
    this.settings = loadSettings(config);
    this.state = 'stopped';
    this.child = null;
    this.owned = false;
    this.lastError = '';
    this.startedAt = 0;
    this.logs = [];
    this.startPromise = null;
  }

  originUrl() {
    if (this.settings.mode === 'external') {
      return new URL(safeBaseUrl(this.settings.externalUrl || `http://127.0.0.1:${this.settings.port}/commandcode/v1`)).origin;
    }
    return `http://127.0.0.1:${this.settings.port}`;
  }

  serviceUrl(basePath = '/') {
    const suffix = basePath === '/' ? '' : `/${String(basePath).replace(/^\/+|\/+$/g, '')}`;
    return `${this.originUrl()}${suffix}`;
  }

  baseUrl() {
    return this.serviceUrl('/commandcode/v1');
  }

  snapshot() {
    return {
      state: this.state,
      mode: this.settings.mode,
      projectRoot: this.settings.projectRoot || null,
      port: this.settings.port,
      denoPath: this.settings.denoPath,
      apiKeyEnv: this.settings.apiKeyEnv,
      externalUrl: this.settings.mode === 'external' ? this.settings.externalUrl : null,
      baseUrl: this.baseUrl(),
      originUrl: this.originUrl(),
      ownedProcess: this.owned,
      pid: this.child?.pid ?? null,
      startedAt: this.startedAt || null,
      lastError: this.lastError,
      logs: this.logs.slice(-80),
    };
  }

  record(message) {
    const line = `${new Date().toISOString()} ${message}`.slice(-2000);
    this.logs.push(line);
    if (this.logs.length > 200) this.logs.splice(0, this.logs.length - 200);
  }

  async probe() {
    const urls = [
      healthUrl(this.originUrl()),
      new URL('/v1/models', this.originUrl()).href,
    ];
    for (const url of urls) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      try {
        const response = await fetch(url, { headers: this.headers(), signal: controller.signal });
        if (response.ok) {
          const payload = await response.json().catch(() => ({}));
          if (!isRecord(payload) || payload.status !== 'unavailable') return true;
        }
      } catch {
        // Try the next endpoint; older proxy builds may not expose /health yet.
      } finally {
        clearTimeout(timer);
      }
    }
    return false;
  }

  headers() {
    const key = envValue(this.settings.apiKeyEnv);
    return key ? { authorization: `Bearer ${key}` } : {};
  }

  async start() {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal().finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async startInternal() {
    this.lastError = '';
    if (await this.probe()) {
      this.state = this.settings.mode === 'external' ? 'external' : 'running';
      this.owned = false;
      this.record(`proxy already available at ${this.baseUrl()}`);
      return;
    }
    if (this.settings.mode === 'external') {
      let target = '';
      try { target = this.baseUrl(); } catch (error) {
        this.state = 'error';
        this.lastError = error instanceof Error ? error.message : String(error);
        this.record(this.lastError);
        return;
      }
      this.state = 'error';
      this.lastError = `external proxy is not reachable at ${target}`;
      this.record(this.lastError);
      return;
    }
    const root = resolveProjectRoot(this.settings);
    if (!root) {
      this.state = 'error';
      this.lastError = 'projectRoot does not contain main.ts and deno.jsonc';
      this.record(this.lastError);
      return;
    }
    const deno = this.settings.denoPath || 'deno';
    this.state = 'starting';
    this.record(`starting ${deno} in ${root}`);
    try {
      this.child = spawn(deno, ['run', '-A', 'main.ts'], {
        cwd: root,
        windowsHide: true,
        env: { ...process.env, PORT: String(this.settings.port), DENO_NO_UPDATE_CHECK: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.owned = true;
      this.startedAt = Date.now();
      const onData = (chunk) => this.record(String(chunk).trimEnd());
      this.child.stdout?.on('data', onData);
      this.child.stderr?.on('data', onData);
      this.child.on('error', (error) => {
        this.state = 'error';
        this.lastError = error.message;
        this.record(`spawn error: ${error.message}`);
      });
      this.child.on('exit', (code, signal) => {
        this.record(`deno exited code=${code} signal=${signal ?? ''}`);
        this.child = null;
        this.owned = false;
        if (this.state !== 'stopped') this.state = 'stopped';
      });
      for (let attempt = 0; attempt < 30; attempt++) {
        if (await this.probe()) {
          this.state = 'running';
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      this.state = 'error';
      this.lastError = 'deno started but /health did not become ready within 15s';
      this.record(this.lastError);
    } catch (error) {
      this.state = 'error';
      this.lastError = error instanceof Error ? error.message : String(error);
      this.record(this.lastError);
    }
  }

  async stop() {
    if (!this.owned || !this.child) {
      this.state = 'stopped';
      return;
    }
    this.state = 'stopping';
    const child = this.child;
    this.owned = false;
    this.child = null;
    try { child.kill(); } catch {}
    this.state = 'stopped';
    this.record('local proxy stopped by DSH plugin');
  }

  async update(values = {}) {
    await this.stop();
    this.settings = loadSettings({ ...this.settings, ...values });
    try { saveSettings(this.settings); } catch (error) { this.lastError = error.message; }
    await this.start();
    return this.snapshot();
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
    this.runtime = options.runtime ?? new ProxyRuntime(options);
    this.apiKeyEnv = this.runtime.settings.apiKeyEnv;
    this.provider = options.provider || ROUTE;
    this.basePath = options.basePath || '/commandcode/v1';
    this.displayName = options.displayName || 'CommandCode via ai-proxy';
    this.project = options.project === true;
  }

  get baseUrl() {
    return this.runtime.serviceUrl(this.basePath);
  }

  headers() {
    const headers = { accept: 'application/json, text/event-stream', ...this.runtime.headers() };
    return headers;
  }

  async requestAt(basePath, path, init = {}) {
    if (!['running', 'external'].includes(this.runtime.state)) await this.runtime.start();
    const response = await fetch(`${this.runtime.serviceUrl(basePath)}${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init.headers || {}) },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`ai-proxy ${basePath}${path} returned HTTP ${response.status}: ${text.slice(0, 240)}`);
    }
    return response;
  }

  async request(path, init = {}) {
    return this.requestAt(this.basePath, path, init);
  }

  providerInfo(provider) {
    return { id: provider, name: this.displayName };
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

  async listProjectModels() {
    const models = await this.listModels();
    const extras = await Promise.all(EXTRA_MODEL_ROUTES.map(async (route) => {
      try {
        const response = await this.requestAt(route.basePath, '/models', { signal: AbortSignal.timeout(3000) });
        const payload = await response.json();
        const rows = Array.isArray(payload?.data) ? payload.data : [];
        return rows.filter(isRecord).map((row) => ({
          provider: this.provider,
          id: `${route.prefix}/${row.id}`,
          name: typeof row.name === 'string' ? row.name : `${route.prefix}/${row.id}`,
          contextWindow: Number(row.contextWindow ?? row.context_window ?? 1000000),
          maxTokens: Number(row.maxTokens ?? row.max_tokens ?? DEFAULT_MAX_TOKENS),
          inputModalities: Array.isArray(row.inputModalities) ? row.inputModalities : ['text'],
        }));
      } catch {
        // Optional channels stay absent when their credentials or upstream are unavailable.
        return [];
      }
    }));
    const seen = new Set(models.map((model) => model.id));
    for (const model of extras.flat()) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      models.push(model);
    }
    return models;
  }

  routeForModel(provider, model) {
    const id = String(model ?? '').replace(/^ai-proxy-commandcode\//, '');
    if (provider === ROUTE || this.basePath === '/commandcode/v1') {
      return { basePath: '/commandcode/v1', wireModel: id.replace(/^commandcode\//, '') };
    }
    for (const route of EXTRA_MODEL_ROUTES) {
      const prefix = `${route.prefix}/`;
      if (id.startsWith(prefix)) return { basePath: route.basePath, wireModel: id.slice(prefix.length) };
    }
    return { basePath: this.basePath, wireModel: id };
  }

  async resolveModel(provider, model) {
    const route = this.routeForModel(provider, model);
    const id = String(model ?? '').replace(/^ai-proxy-commandcode\//, '');
    const rows = this.project ? await this.listProjectModels() : await this.listModels();
    const row = rows.find((candidate) => candidate.id === id) ?? rows.find((candidate) => candidate.id === route.wireModel);
    if (!row) {
      return {
        provider,
        id,
        name: id,
        context: { contextWindow: 1000000 },
        defaultMaxTokens: DEFAULT_MAX_TOKENS,
        basePath: route.basePath,
        wireModel: route.wireModel,
      };
    }
    return {
      provider,
      id: row.id,
      name: row.name,
      inputModalities: row.inputModalities,
      context: { contextWindow: row.contextWindow },
      defaultMaxTokens: row.maxTokens,
      reasoning: { efforts: ['off', 'low', 'high', 'max'], defaultEffort: 'high' },
      basePath: route.basePath,
      wireModel: route.wireModel,
    };
  }

  async prepareCall(provider, model) {
    const resolved = await this.resolveModel(provider, model);
    return { model: resolved, stream: (options) => this.stream(options, resolved) };
  }

  async *stream(options, resolved) {
    const body = {
      model: resolved.wireModel ?? resolved.id,
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
      response = await this.requestAt(resolved.basePath ?? this.basePath, '/chat/completions', {
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

export class ProjectAdapter extends AiProxyAdapter {
  constructor(options = {}) {
    super({
      ...options,
      provider: PROJECT_ROUTE,
      basePath: '/v1',
      displayName: 'ai-proxy · 全项目',
      project: true,
    });
  }
}

export const name = 'ai-proxy-dsh-bridge';
export const inject = ['llm'];

function sameOrigin(req) {
  if (String(req.headers?.['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false;
  const origin = req.headers?.origin;
  const host = req.headers?.host;
  if (!origin) return true;
  if (!host) return false;
  try { return new URL(origin).host === host; } catch { return false; }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error('request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function cleanSettings(values) {
  const next = {};
  if (values.mode === 'local' || values.mode === 'external') next.mode = values.mode;
  if (typeof values.projectRoot === 'string' && values.projectRoot.length <= 512) next.projectRoot = values.projectRoot;
  if (typeof values.denoPath === 'string' && values.denoPath.length <= 512) next.denoPath = values.denoPath;
  if (typeof values.externalUrl === 'string' && values.externalUrl.length <= 2048) next.externalUrl = values.externalUrl;
  if (typeof values.apiKeyEnv === 'string' && /^[A-Z_][A-Z0-9_]*$/.test(values.apiKeyEnv)) next.apiKeyEnv = values.apiKeyEnv;
  const port = Number(values.port);
  if (Number.isSafeInteger(port) && port > 0 && port < 65536) next.port = port;
  return next;
}

async function panelSnapshot(adapter) {
  try {
    const response = await adapter.request('/panel', { signal: AbortSignal.timeout(5000) });
    return await response.json();
  } catch (error) {
    const [statusResponse, modelsResponse] = await Promise.all([
      adapter.request('/status', { signal: AbortSignal.timeout(5000) }),
      adapter.request('/models', { signal: AbortSignal.timeout(5000) }),
    ]);
    const status = await statusResponse.json();
    const catalog = await modelsResponse.json();
    const rows = Array.isArray(catalog?.data) ? catalog.data : [];
    const accounts = Array.isArray(status?.accounts) ? status.accounts : [];
    return {
      provider: 'commandcode',
      state: Number(status?.activeAccounts ?? 0) > 0 ? 'available' : 'degraded',
      modelCount: Number(status?.modelCount ?? rows.length),
      models: rows.filter(isRecord).map((row) => ({
        id: String(row.id ?? ''),
        name: String(row.name ?? row.id ?? ''),
        contextWindow: Number(row.contextWindow ?? row.context_window ?? 0),
        maxTokens: Number(row.maxTokens ?? row.max_tokens ?? 0),
        inputModalities: Array.isArray(row.inputModalities) ? row.inputModalities
          : Array.isArray(row.input_modalities) ? row.input_modalities : ['text'],
      })),
      accounts: accounts.filter(isRecord).map((account) => ({
        id: String(account.id ?? ''),
        enabled: account.enabled === true,
        cooling: account.cooling === true,
        failCount: Number(account.failCount ?? 0),
        cooldownUntil: Number(account.cooldownUntil ?? 0),
        lastError: typeof account.lastError === 'string' ? account.lastError : '',
        lastUsedAt: Number(account.lastUsedAt ?? 0),
        source: typeof account.source === 'string' ? account.source : '',
      })),
      cache: isRecord(status?.cache) ? status.cache : {},
      generatedAt: new Date().toISOString(),
      panelSource: 'status-fallback',
    };
  }
}

async function projectPanelSnapshot(adapter, projectAdapter) {
  let base = {};
  try {
    base = await panelSnapshot(adapter);
  } catch (error) {
    base = { error: error instanceof Error ? error.message : String(error) };
  }
  let projectModels = [];
  try {
    projectModels = projectAdapter ? await projectAdapter.listProjectModels() : [];
  } catch (error) {
    base.projectError = error instanceof Error ? error.message : String(error);
  }
  const channels = {};
  for (const model of projectModels) {
    const id = String(model.id ?? '');
    const channel = id.includes('/') ? id.slice(0, id.indexOf('/')) : 'aggregate';
    channels[channel] = (channels[channel] ?? 0) + 1;
  }
  return {
    ...base,
    models: projectModels.length > 0 ? projectModels : (Array.isArray(base.models) ? base.models : []),
    projectModels,
    projectModelCount: projectModels.length,
    channels,
  };
}

function apiHandler(adapter, runtime, projectAdapter) {
  return async (req, res) => {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    const route = url.pathname.replace(/^\/api\/ai-proxy(?:-commandcode)?/, '').replace(/\/+$/, '') || '/';
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'forbidden' });
    try {
      if (method === 'GET' && (route === '/' || route === '/panel')) {
        const panel = await projectPanelSnapshot(adapter, projectAdapter);
        return sendJson(res, 200, { ...panel, runtime: runtime.snapshot() });
      }
      if (method === 'GET' && route === '/settings') {
        return sendJson(res, 200, runtime.snapshot());
      }
      if (method === 'GET' && route === '/logs') {
        return sendJson(res, 200, { logs: runtime.snapshot().logs });
      }
      if (method === 'POST' && route === '/settings') {
        const body = cleanSettings(await readBody(req));
        return sendJson(res, 200, await runtime.update(body));
      }
      if (method === 'POST' && route === '/start') {
        await runtime.start();
        return sendJson(res, 200, runtime.snapshot());
      }
      if (method === 'POST' && route === '/stop') {
        await runtime.stop();
        return sendJson(res, 200, runtime.snapshot());
      }
      if (method === 'POST' && route === '/restart') {
        await runtime.stop();
        await runtime.start();
        return sendJson(res, 200, runtime.snapshot());
      }
      return sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      return sendJson(res, 502, { error: error instanceof Error ? error.message : String(error), runtime: runtime.snapshot() });
    }
  };
}

export function apply(ctx, config = {}) {
  const runtime = new ProxyRuntime(config);
  const adapter = new AiProxyAdapter({ runtime });
  const projectAdapter = new ProjectAdapter({ runtime });
  const entryId = ctx.fiber?.entry?.options?.id ?? name;
  const registration = ctx.llm.registerAdapter([PROJECT_ROUTE, ROUTE], projectAdapter);
  ctx.llm.registerConfigurableProviders?.([
    { provider: PROJECT_ROUTE, displayName: 'ai-proxy · 全项目', settingsNs: entryId, settingsPath: [] },
    { provider: ROUTE, displayName: 'CommandCode via ai-proxy', settingsNs: entryId, settingsPath: [] },
  ]);
  ctx.llm.registerModelDiscovery?.(entryId, () => projectAdapter.listProjectModels());
  ctx.inject?.(['webServer'], (scoped) => {
    const handler = apiHandler(adapter, runtime, projectAdapter);
    for (const path of ['/api/ai-proxy', '/api/ai-proxy-commandcode']) {
      scoped.effect(() => scoped.webServer.register({
        kind: 'prefix',
        path,
        handler,
      }), `ai-proxy bridge: API ${path}`);
    }
  });
  const start = () => {
    void runtime.start();
    return () => { void runtime.stop(); };
  };
  if (typeof ctx.effect === 'function') ctx.effect(start, 'ai-proxy bridge: proxy lifecycle');
  else start();
  return () => {
    void runtime.stop();
    registration?.dispose?.();
  };
}
