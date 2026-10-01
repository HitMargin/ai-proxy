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
import {
  applyRecord,
  byModel,
  emptyState,
  heatmap,
  StatsStore,
  summarize,
  trend,
} from './stats.mjs'

const ROUTE = 'ai-proxy-commandcode';
const PROJECT_ROUTE = 'ai-proxy';
const DEFAULT_MAX_TOKENS = 64000;
// The DSH picker groups strictly by provider route, so a channel that cannot
// serve a real turn does not belong in the roster at all. OpenRouter, Anthropic
// and Gemini need per-user keys this proxy never holds, and their listings
// answered with an empty or error body; keeping them out of the model list is
// what stops the picker from offering models that can only fail.
//
// deepseek-web is blocked at the user's request rather than for being broken:
// it answers correctly (measured HTTP 200 with real text), so this is a choice
// to stop it appearing in the picker, not a capability claim. Its route is also
// unreachable from the aggregate entry, since V1_AGGREGATE_MEMBERS in main.ts
// lists only kilo/zen/cnb/commandcode.
//
// cnb needs an account this machine does not have: the upstream answers
// `401 [NOT_LOGIN]` and the two listed models are unusable until a login
// cookie is pasted into cnb-login.txt.
//
// Matched against the first path segment, which is the channel this proxy
// routes by — see isBlockedModelId for why a substring test is not enough.
const BLOCKED_CHANNELS = new Set([
  'openrouter',
  'anthropic',
  'gemini',
  'deepseek-web',
  'cnb',
]);

/** Why a channel is withheld, so the refusal can say something true. */
const BLOCK_REASON = {
  openrouter:
    'this channel needs a per-user upstream key and is not served by ai-proxy',
  anthropic:
    'this channel needs a per-user upstream key and is not served by ai-proxy',
  gemini:
    'this channel needs a per-user upstream key and is not served by ai-proxy',
  'deepseek-web': 'deepseek-web is switched off in the ai-proxy panel',
  cnb: 'cnb needs a login cookie; paste one into cnb-login.txt to re-enable it',
};

/**
 * Channels reached by their own route rather than through the aggregate one.
 *
 * A blocked channel is not listed here. The panel re-reads this list on every
 * snapshot, and keeping a withheld channel in it meant asking the proxy for a
 * listing whose rows were all going to be thrown away — a request per poll,
 * forever, for a channel the user had switched off. A channel that is blocked
 * after being added here is still refused at call time and still filtered if it
 * arrives from the aggregate listing, so nothing reaches it either way.
 */
const EXTRA_MODEL_ROUTES = [
  { prefix: 'tokenharbor', basePath: '/tokenharbor/v1' },
];

/**
 * Every channel's own route, blocked or not.
 *
 * Kept separately from {@link EXTRA_MODEL_ROUTES} because the two answer
 * different questions. That list is "which listings should the panel fetch";
 * this one is "how is an id of this shape addressed". Dropping a blocked channel
 * from the second would leave `resolveModel` unable to say where its call would
 * have gone, which is exactly the information a caller inspecting a refusal
 * needs.
 */
const CHANNEL_ROUTES = [
  { prefix: 'deepseek-web', basePath: '/deepseek-web/v1' },
  ...EXTRA_MODEL_ROUTES,
];

function blockReasonFor(modelId) {
  const id = String(modelId ?? '');
  const channel = (id.includes('/') ? id.slice(0, id.indexOf('/')) : id).toLowerCase();
  return BLOCK_REASON[channel] ?? `${channel} is not served by ai-proxy`;
}

/**
 * Whether an id belongs to a blocked channel.
 *
 * A plain `startsWith` test only catches a block named at the front of the id. A
 * per-channel listing prefixes the same model again, so `tokenharbor/` answering
 * with a copy of the aggregate produced `tokenharbor/openrouter/paid/model` — a
 * blocked channel laundered back in through a different discovery path.
 *
 * The test is therefore on the *first* path segment, which is the channel this
 * proxy routes by. Matching any segment would also catch `kilo/openrouter/free`,
 * a real Kilo-hosted model whose name happens to say OpenRouter.
 */
function isBlockedModelId(modelId) {
  const id = String(modelId ?? '');
  const channel = (id.includes('/') ? id.slice(0, id.indexOf('/')) : id).toLowerCase();
  return BLOCKED_CHANNELS.has(channel);
}

/**
 * Read one listing row into the shape the harness adapter expects.
 *
 * The proxy answers the aggregate route in OpenAI's snake_case (`input_modalities`,
 * `context_window`, `max_output_tokens`) while the per-channel routes may answer in
 * camelCase, so both spellings have to be accepted here. Reading only one of them
 * is what turned 33 image-capable CommandCode models into text-only rows.
 */
const EFFORT_ORDER = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Keep the efforts a channel actually published, in ladder order.
 *
 * CommandCode models do not all offer the same rungs (some publish only
 * off/high/max), and offering one a channel never advertised produced the
 * harness's duplicate-effort rejection.
 */
function pickEfforts(published) {
  if (!Array.isArray(published) || published.length === 0) {
    return ['off', 'low', 'high', 'max'];
  }
  const seen = new Set(published.filter((value) => typeof value === 'string'));
  return EFFORT_ORDER.filter((effort) => seen.has(effort));
}

const MODALITY_WORDS = ['text', 'image', 'video', 'audio'];

// Zen publishes only `id`, so the display name used to collapse to the raw
// prefixed id (`zen/jev-1.13-free`). Recover a readable label from the id's
// last segment; `owned_by: opencode` also means the model is anonymous and has
// no vendor name to show, so the id is the only honest source.
//
// An upstream name is used verbatim. Kilo appends a scheduling note to it
// (`Space Bunny Alpha (retires Oct 5)`) and that note is the user being told
// something they need; quietly stripping it would hide an upstream warning to
// make a list look tidier. Parentheticals that are part of the name —
// CommandCode's `(latest)` and `(exp)`, Kilo's `(free)` — are identity and
// were never at risk.
function readName(row) {
  if (typeof row.name === 'string' && row.name.trim() !== '') return row.name;
  const id = String(row.id ?? '');
  const segment = id.split('/').pop() ?? id;
  return segment
    .split('-')
    .filter((word) => word !== '' && word !== 'free')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ') || segment;
}

// Kilo publishes models.models.dev shape, where modalities live under
// `architecture.input_modalities` and context under a nested `top_provider`.
// Reading only the flat OpenAI keys silently downgraded every Kilo model to
// `['text']` and to the default context, so `text+image+video` models such as
// space-bunny-alpha were reported as text-only. Walk all three shapes.
function readModalities(row) {
  const architecture = isRecord(row.architecture) ? row.architecture : {};
  const nested = [row.input_modalities, architecture.input_modalities]
    .find((value) => Array.isArray(value) && value.length > 0);
  if (nested) {
    return [...new Set(nested.filter((value) => typeof value === 'string'))];
  }
  // `modality` is "text+image+video->text"; the left side is what we accept.
  const shorthand = typeof architecture.modality === 'string'
    ? architecture.modality.split('->')[0]
    : '';
  const parsed = MODALITY_WORDS.filter((word) =>
    shorthand.split('+').includes(word)
  );
  return parsed.length > 0 ? parsed : ['text'];
}

function readNumber(row, keys, fallback) {
  for (const key of keys) {
    const value = Number(row[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return fallback;
}

export function normalizeModel(provider, row) {
  const architecture = isRecord(row.architecture) ? row.architecture : {};
  const upstream = isRecord(row.top_provider) ? row.top_provider : {};
  const modalities = Array.isArray(row.inputModalities) && row.inputModalities.length > 0
    ? [...new Set(row.inputModalities)]
    : readModalities(row);
  return {
    provider,
    id: row.id,
    name: readName(row),
    contextWindow: readNumber(
      row,
      ['contextWindow', 'context_window', 'context_length'],
      readNumber(upstream, ['context_window', 'context_length'], 1000000),
    ),
    maxTokens: readNumber(
      row,
      ['maxTokens', 'max_tokens', 'max_output_tokens', 'max_completion_tokens'],
      readNumber(upstream, ['max_output_tokens', 'max_completion_tokens'], DEFAULT_MAX_TOKENS),
    ),
    inputModalities: modalities,
    reasoningEfforts: Array.isArray(row.reasoningEfforts)
      ? row.reasoningEfforts
      : Array.isArray(row.reasoning_efforts)
      ? row.reasoning_efforts
      : undefined,
  };
}

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
  const details = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : {};
  return {
    inputTokens: Math.max(0, prompt),
    outputTokens: Math.max(0, completion),
    reasoningTokens: Math.max(0, Number(details.reasoning_tokens ?? 0) || 0),
  };
}

// Usage is recorded here rather than in the proxy: the harness is the only
// layer that sees both the token counts an upstream reported and the wall
// clock around the stream, so no channel needs its own instrumentation.
//
// The store is a file under the harness home, not a harness service: the
// settings seam differs between kernel lines and the storage domain may not be
// mounted, and usage history is high-cardinality telemetry that does not belong
// in a configuration document. Without the file a DSH restart wiped the
// dashboard, which is what made it look permanently empty.
const usageStore = new StatsStore();

/** Display names for usage rows, filled from the catalog as it is discovered. */
const usageLabels = new Map();

function recordUsage(record) {
  usageStore.set(applyRecord(usageStore.get(), record));
}

export function usageSnapshot(now = Date.now()) {
  const state = usageStore.get();
  return {
    summary: summarize(state, now),
    models: byModel(state, usageLabels),
    heatmap: heatmap(state, 119, now),
    trend: trend(state),
  };
}

/** Flush pending usage to disk; called when the plugin is torn down. */
export function flushUsage() {
  usageStore.flush();
}

/**
 * Only reached for a stream that carried its terminal marker: the cut case is
 * handled before this, so an absent `finish_reason` here means the gateway ended
 * a complete stream without naming a reason, not that the connection died.
 */function finishKind(reason) {
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
    void reader.cancel().catch(() => {});
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
    this.blockedModelCount = 0;
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
    return rows.filter((row) => isRecord(row) && typeof row.id === 'string').map((row) => normalizeModel(this.provider, row));
  }

  async listProjectModels() {
    const discovered = await this.listModels();
    const models = [];
    const seen = new Set();
    let blocked = 0;
    for (const model of discovered) {
      if (isBlockedModelId(model.id)) {
        blocked += 1;
        continue;
      }
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      models.push(model);
    }
    const extras = await Promise.all(EXTRA_MODEL_ROUTES.map(async (route) => {
      try {
        const response = await this.requestAt(route.basePath, '/models', { signal: AbortSignal.timeout(3000) });
        const payload = await response.json();
        const rows = Array.isArray(payload?.data) ? payload.data : [];
        return rows.filter(isRecord).map((row) => {
          const normalized = normalizeModel(this.provider, row);
          return {
            ...normalized,
            id: `${route.prefix}/${row.id}`,
            // normalizeModel already derived a readable name from the bare id;
            // re-deriving it here would prefix the channel and land back on the
            // raw `prefix/id` string this fallback is meant to avoid.
            name: normalized.name || `${route.prefix}/${row.id}`,
          };
        });
      } catch {
        // Optional channels stay absent when their credentials or upstream are unavailable.
        return [];
      }
    }));
    for (const model of extras.flat()) {
      // A channel added by prefix is filtered by the same rule as one that
      // arrived through the aggregate route, so withholding it cannot be
      // undone by which discovery path happened to find it.
      if (isBlockedModelId(model.id)) {
        blocked += 1;
        continue;
      }
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      models.push(model);
    }
    this.blockedModelCount = blocked;
    // Remembered so the usage table can show a model's name instead of its id:
    // Zen publishes only an id, so `space-bunny-free` would otherwise be the
    // only label a user ever sees.
    for (const model of models) {
      if (typeof model.name === 'string' && model.name !== '' && model.name !== model.id) {
        usageLabels.set(model.id, model.name);
      }
    }
    return models;
  }

  routeForModel(provider, model) {
    const id = String(model ?? '').replace(/^ai-proxy-commandcode\//, '');
    if (provider === ROUTE || this.basePath === '/commandcode/v1') {
      return { basePath: '/commandcode/v1', wireModel: id.replace(/^commandcode\//, '') };
    }
    for (const route of CHANNEL_ROUTES) {
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
    const efforts = pickEfforts(row.reasoningEfforts);
    return {
      provider,
      id: row.id,
      name: row.name,
      inputModalities: row.inputModalities,
      context: { contextWindow: row.contextWindow },
      defaultMaxTokens: row.maxTokens,
      reasoning: {
        // The name is the id the upstream published — `off`, `low`, … `max`.
        // Inventing friendlier spellings (e.g. `Very high`) told the picker a
        // rung exists that no channel serves, and a translated `name` reads
        // wrong outside that locale. There is no description: inventing one is
        // how "The default thinking budget" got written for a lane that has no
        // default rung.
        efforts: efforts.map((id) => ({ id, name: id })),
        defaultEffort: efforts.includes('high') ? 'high' : efforts[0],
      },
      basePath: route.basePath,
      wireModel: route.wireModel,
    };
  }

  async prepareCall(provider, model) {
    const resolved = await this.resolveModel(provider, model);
    return { model: resolved, stream: (options) => this.stream(options, resolved) };
  }

  async *stream(options, resolved) {
    // Two ids, because they answer different questions. `modelId` is what goes
    // on the wire: routing has already stripped the channel prefix, so
    // `deepseek-web/deepseek-chat` arrives as `deepseek-chat`. The block must be
    // judged on the caller's id instead, or the prefix test would pass and the
    // channel would be reachable.
    const modelId = String(resolved.wireModel ?? resolved.id ?? '');
    const requestedId = String(resolved.id ?? options.model ?? '');
    if (isBlockedModelId(requestedId)) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: blockReasonFor(requestedId),
            code: 'CONFIG_DISABLED',
          },
        },
      };
      return;
    }
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

    // Timings are taken here so the dashboard can report the real first-token
    // latency and decode speed the user actually experienced, rather than a
    // number re-derived from token counts.
    const startedAt = Date.now();
    let firstDeltaAt;

    const requestHeaders = { 'content-type': 'application/json' };
    const isZenAggregate = modelId.startsWith('zen/') && resolved.basePath === '/v1';
    if (isZenAggregate) {
      const sessionId = typeof options.sessionId === 'string' ? options.sessionId : '';
      if (sessionId) {
        requestHeaders['x-session-id'] = sessionId;
        requestHeaders['x-conversation-id'] = sessionId;
      }
      if (typeof options.requestId === 'string' && options.requestId) {
        requestHeaders['x-request-id'] = options.requestId;
      }
      requestHeaders['user-agent'] = 'deepseek-harness/0.1.7 (+https://github.com/deepseek-ai/deepseek-harness) opencode/1.18.31';
    }

    let response;
    try {
      response = await this.requestAt(resolved.basePath ?? this.basePath, '/chat/completions', {
        method: 'POST',
        headers: requestHeaders,
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
    // The terminal marker. A stream that ends without it was cut, and saying
    // `stop` for that is what made a dead connection look like a finished turn:
    // the agent loop read the answer as complete, marked the goal done and moved
    // on, so a mid-sentence stop was indistinguishable from the model choosing to.
    let sawDone = false;
    const toolBlocks = new Map();
    try {
      for await (const data of readSse(response)) {
        if (data === '[DONE]') { sawDone = true; break; }
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
        // The first frame that carries visible output is what the user waits
        // for, so that is the timestamp latency is measured from.
        if (firstDeltaAt === undefined && (text !== '' || reasoning !== '')) firstDeltaAt = Date.now();
        const mappedUsage = mapUsage(payload?.usage);
        if (mappedUsage) usage = mappedUsage;
      }
    } catch (error) {
      recordUsage({
        at: startedAt,
        model: modelId,
        effort: typeof options.reasoningEffort === 'string' ? options.reasoningEffort : '',
        ok: false,
        input: 0,
        output: 0,
        reasoning: 0,
        decodeTokens: 0,
        origin: 'harness',
        truncated: true,
      });
      yield { type: 'finish', reason: { kind: options.signal?.aborted ? 'aborted' : 'error', failure: { message: error.message, code: 'TRANSPORT' } } };
      return;
    }
    if (!sawDone) {
      // Cut. The partial blocks are still closed so whatever arrived stays visible,
      // but the turn is reported as the failure it is instead of a clean stop.
      const delivered = textIndex !== undefined || reasoningIndex !== undefined ||
        toolBlocks.size > 0;
      recordUsage({
        at: startedAt,
        model: modelId,
        effort: typeof options.reasoningEffort === 'string' ? options.reasoningEffort : '',
        ok: false,
        input: usage?.inputTokens ?? 0,
        output: usage?.outputTokens ?? 0,
        reasoning: usage?.reasoningTokens ?? 0,
        decodeTokens: Math.max(0, (usage?.outputTokens ?? 0) - (usage?.reasoningTokens ?? 0)),
        ttftMs: firstDeltaAt === undefined ? undefined : firstDeltaAt - startedAt,
        decodeMs: firstDeltaAt === undefined ? undefined : Date.now() - firstDeltaAt,
        origin: 'harness',
        truncated: true,
      });
      if (textIndex !== undefined) {
        yield { type: 'block-end', index: textIndex, block: { type: 'text', text } };
      }
      if (reasoningIndex !== undefined) {
        yield { type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: reasoning } };
      }
      for (const block of toolBlocks.values()) {
        yield { type: 'block-end', index: block.index, block: { type: 'tool-call', id: block.id, name: block.name, arguments: block.args } };
      }
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: delivered
              ? 'ai-proxy stream ended before [DONE] after partial output was delivered'
              : 'ai-proxy stream ended before [DONE] with no output delivered',
            // Replaying a turn that already produced output would duplicate the
            // work and pay for it twice, so only the empty case is retryable. The
            // empty one is exactly the case a retry can help.
            code: delivered ? 'stream_cut' : 'TRANSPORT',
          },
        },
      };
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
    recordUsage({
      at: startedAt,
      model: modelId,
      effort: typeof options.reasoningEffort === 'string' ? options.reasoningEffort : '',
      ok: true,
      input: usage?.inputTokens ?? 0,
      output: usage?.outputTokens ?? 0,
      reasoning: usage?.reasoningTokens ?? 0,
      // Reasoning tokens are not something the user waited for, so they are
      // excluded from the decode window that produces the speed figure.
      decodeTokens: Math.max(0, (usage?.outputTokens ?? 0) - (usage?.reasoningTokens ?? 0)),
      ttftMs: firstDeltaAt === undefined ? undefined : firstDeltaAt - startedAt,
      decodeMs: firstDeltaAt === undefined ? undefined : Date.now() - firstDeltaAt,
      origin: 'harness',
      noUsage: usage === undefined,
    });
    yield { type: 'finish', reason: { kind: finishKind(finish) } };
  }
}

export class ProjectAdapter extends AiProxyAdapter {
  constructor(options = {}) {
    super({
      ...options,
      provider: PROJECT_ROUTE,
      basePath: '/v1',
      displayName: 'ai-proxy',
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

const PROBE_CHANNELS = ['kilo', 'zen', 'cnb', 'commandcode', 'deepseek-web', 'tokenharbor'];

function cleanProbeRequest(values) {
  const requested = Array.isArray(values?.channels) ? values.channels : [];
  const channels = requested
    .filter((value) => typeof value === 'string' && PROBE_CHANNELS.includes(value))
    .slice(0, PROBE_CHANNELS.length);
  const limit = Number(values?.limit);
  return {
    // An empty selection means "every channel"; a typo must not silently
    // degrade into probing nothing and reporting success.
    channels: channels.length > 0 ? channels : [...PROBE_CHANNELS],
    limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 60) : 0,
  };
}

async function panelSnapshot(adapter) {
  try {
    const response = await adapter.request('/panel', { signal: AbortSignal.timeout(5000) });
    return await response.json();
  } catch (error) {
    let status = {};
    let catalog = {};
    try {
      const [statusResponse, modelsResponse] = await Promise.all([
        adapter.request('/status', { signal: AbortSignal.timeout(5000) }),
        adapter.request('/models', { signal: AbortSignal.timeout(5000) }),
      ]);
      status = await statusResponse.json();
      catalog = await modelsResponse.json();
    } catch (fallbackError) {
      return {
        provider: 'commandcode',
        state: 'unknown',
        modelCount: 0,
        models: [],
        accounts: [],
        panelError: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        generatedAt: new Date().toISOString(),
      };
    }
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

async function healthSnapshot(adapter) {
  try {
    // `/health` is served at the proxy root, not under a provider basePath.
    // Requesting it through `request()` would ask for `/commandcode/v1/health`
    // and silently return the catalog, leaving every row "unprobed".
    const response = await adapter.requestAt('/', '/health', {
      signal: AbortSignal.timeout(5000),
    });
    const payload = await response.json();
    return isRecord(payload) ? payload : {};
  } catch {
    // Health is advisory: a proxy that cannot report it must not empty the
    // roster, so the panel simply keeps showing every model as unprobed.
    return {};
  }
}

// The proxy keys per-model verdicts by provider, but the picker sees one flat
// list of prefixed ids (`kilo/…`, `zen/…`). Match on the channel segment so a
// row can be labelled from the sample that was already paid for, instead of
// probing again from the browser.
//
// Both key spellings occur: the generic catalog probe stores the bare upstream
// id (`kilo-auto/free`), while the explicit `/health/probe` call stores the
// routed id it actually sent (`kilo/kilo-auto/free`). A kilo id such as
// `kilo-auto/free` contains a slash yet is still *relative* to `kilo`, so the
// channel is matched by prefix rather than by testing for a slash.
export function healthIndex(payload) {
  const index = new Map();
  const models = isRecord(payload?.models) ? payload.models : {};
  for (const [provider, samples] of Object.entries(models)) {
    if (!isRecord(samples)) continue;
    for (const [modelId, sample] of Object.entries(samples)) {
      if (!isRecord(sample)) continue;
      const bare = modelId.startsWith(`${provider}/`)
        ? modelId.slice(provider.length + 1)
        : modelId;
      const verdict = {
        state: String(sample.state ?? 'unknown'),
        latencyMs: Number(sample.latencyMs ?? 0),
        reason: typeof sample.reason === 'string' ? sample.reason : '',
      };
      index.set(`${provider}/${bare}`, verdict);
      index.set(modelId, verdict);
    }
  }
  return index;
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
  const health = await healthSnapshot(adapter);
  const verdicts = healthIndex(health);
  const models = projectModels.length > 0
    ? projectModels.map((model) => {
      const verdict = verdicts.get(String(model.id ?? ''));
      return verdict ? { ...model, ...verdict } : model;
    })
    : (Array.isArray(base.models) ? base.models : []);
  const counts = { available: 0, degraded: 0, unavailable: 0, unknown: 0, total: 0 };
  for (const model of models) {
    const state = String(model?.state ?? 'unknown');
    // Only a probed row has a verdict. Counting unprobed models as `unknown`
    // would report every channel that never ran a probe as broken, so `total`
    // tracks how many rows actually carry a verdict.
    if (model?.state === undefined) continue;
    if (state in counts) counts[state] += 1;
    counts.total += 1;
  }
  return {
    ...base,
    models,
    projectModels: models,
    projectModelCount: models.length,
    blockedModelCount: projectAdapter?.blockedModelCount ?? 0,
    channels,
    health,
    modelHealth: counts,
    // A member whose model list did not come back whole is absent from `channels`
    // precisely because it failed, so the count alone cannot explain a roster that
    // got shorter. The proxy names the ones it could not fetch.
    catalogIssues: isRecord(health?.catalogIssues) ? health.catalogIssues : {},
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
      if (method === 'GET' && route === '/usage') {
        return sendJson(res, 200, usageSnapshot());
      }
      if (method === 'POST' && route === '/probe') {
        // Status checking is an explicit user action, not a side effect of
        // listing models: every channel here is a metered free tier, so the
        // probe has to be something the user starts and can limit.
        const body = cleanProbeRequest(await readBody(req));
        const results = {};
        for (const channel of body.channels) {
          const params = new URLSearchParams({ provider: channel });
          if (body.limit) params.set('limit', String(body.limit));
          const response = await adapter.requestAt('/', `/health/probe?${params}`, {
            method: 'POST',
            signal: AbortSignal.timeout(Math.max(30_000, body.limit * 30_000)),
          });
          const payload = await response.json();
          results[channel] = payload?.models ?? {};
        }
        return sendJson(res, 200, { probed: Object.keys(results), models: results });
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
  const registration = ctx.llm.registerAdapter([PROJECT_ROUTE], projectAdapter);
  ctx.llm.registerConfigurableProviders?.([
    { provider: PROJECT_ROUTE, displayName: 'ai-proxy', settingsNs: entryId, settingsPath: [] },
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
    // A pending usage write is coalesced for 800ms, so a teardown right after
    // a turn would otherwise drop it. Flushing here makes the last call before a
    // restart survive it.
    flushUsage();
  };
}
