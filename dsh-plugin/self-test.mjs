import assert from 'node:assert/strict';
import { apply, AiProxyAdapter, healthIndex } from './index.js';

process.env.TEST_BRIDGE_KEY = 'local-test-key';
const originalFetch = globalThis.fetch;
let modelCalls = 0;
let chatCalls = 0;
let lastRequestHeaders = new Headers();
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const headers = new Headers(init.headers || {});
  lastRequestHeaders = headers;
  assert.equal(headers.get('authorization'), 'Bearer local-test-key');
  if (url.endsWith('/health')) {
    // Per-model verdicts are keyed by provider and use the *unprefixed* id, so
    // the panel has to match `kilo/stealth/…` against `kilo` + `stealth/…`.
    // Without that join every row stayed `unknown`.
    return new Response(JSON.stringify({
      status: 'degraded',
      providers: {
        kilo: { state: 'degraded', modelCount: 2, availableModels: 1, degradedModels: 1, unavailableModels: 0 },
      },
      models: {
        kilo: {
          'stealth/space-bunny-alpha': { state: 'available', latencyMs: 1247 },
          'kilo-auto/free': { state: 'degraded', latencyMs: 300, reason: 'HTTP 429' },
        },
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (url.includes('/health/probe')) {
    // The explicit probe endpoint answers with routed ids, so the panel has
    // to accept both spellings when joining back onto the roster.
    const channel = new URL(url).searchParams.get('provider') || 'unknown';
    return new Response(JSON.stringify({
      provider: channel,
      probed: 1,
      models: { [`${channel}/probed-model`]: { state: 'available', latencyMs: 900 } },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (url.endsWith('/panel')) {
    return new Response(JSON.stringify({ error: 'Command Code route not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (url.endsWith('/status')) {
    return new Response(JSON.stringify({
      provider: 'commandcode',
      modelCount: 1,
      activeAccounts: 1,
      accounts: [{ id: 'test', enabled: true, cooling: false, keyName: 'must-not-leak' }],
      cache: { total: 1, sessions: 0 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.endsWith('/models')) {
    modelCalls++;
    if (url.includes('/openrouter/')) {
      return new Response(JSON.stringify({ data: [{ id: 'blocked/channel', name: 'Blocked' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/v1/models')) {
      return new Response(JSON.stringify({
        data: [
          { id: 'openrouter/paid/model', name: 'Paid', context_window: 128000, max_output_tokens: 32000 },
          {
            id: 'deepseek/test',
            name: 'DeepSeek Test',
            context_window: 1000000,
            max_output_tokens: 64000,
            input_modalities: ['text', 'image'],
            reasoning_efforts: ['off', 'high', 'max'],
          },
          {
            // Kilo publishes the models.models.dev shape, not the flat OpenAI
            // one: modalities nest under `architecture` and context under
            // `top_provider`. Reading only flat keys turned this into text-only.
            id: 'kilo/stealth/space-bunny-alpha',
            name: 'Space Bunny Alpha',
            architecture: {
              modality: 'text+image+video->text',
              input_modalities: ['text', 'image', 'video'],
              output_modalities: ['text'],
            },
            context_length: 1000000,
            top_provider: { context_length: 1000000, max_completion_tokens: 524288 },
          },
          {
            // The id itself contains a slash yet is still relative to `kilo`,
            // so treating "has a slash" as "already prefixed" misses the join.
            id: 'kilo/kilo-auto/free',
            name: 'Auto Free',
            architecture: { input_modalities: ['text'] },
            context_length: 256000,
          },
          {
            // No modality list at all: the `modality` shorthand is the only
            // signal, so it has to be parsed rather than defaulted to text.
            id: 'kilo/shorthand-only',
            name: 'Shorthand Only',
            architecture: { modality: 'text+image->text' },
            context_length: 256000,
          },
          {
            // Kilo appends a scheduling note to the name. It is the upstream
            // telling the user something they need, so it is passed through
            // verbatim — stripping it to tidy a list would hide a warning.
            id: 'kilo/retiring-model',
            name: 'Retiring Model (retires Oct 5)',
            architecture: { input_modalities: ['text'] },
            context_length: 256000,
          },
          {
            // CommandCode's suffixes name the variant, so they must survive.
            id: 'commandcode/deepseek/deepseek-v4-flash',
            name: 'DeepSeek V4 Flash (latest)',
            context_window: 1000000,
          },
          {
            // Zen publishes only `id`; the display name used to collapse to the
            // raw prefixed id, which is what made the roster read as
            // `zen/jev-1.13-free` instead of a readable label.
            id: 'zen/jev-1.13-free',
            object: 'model',
            owned_by: 'opencode',
          },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/zen/')) {
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      data: [{
        id: 'deepseek/test',
        name: 'DeepSeek Test',
        contextWindow: 1000000,
        maxTokens: 64000,
        inputModalities: ['text'],
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  chatCalls++;
  return new Response([
    'data: {"choices":[{"delta":{"content":"pong"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
    'data: [DONE]\n\n',
  ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
};

try {
  let adapter;
  let discovery;
  let panelRoute;
  let registeredRoutes;
  const ctx = {
    fiber: { entry: { options: { id: 'bridge-test' } } },
    llm: {
      registerAdapter(routes, value) { registeredRoutes = routes; adapter = value; return { dispose() {} }; },
      registerConfigurableProviders() {},
      registerModelDiscovery(_id, callback) { discovery = callback; },
    },
    inject(deps, callback) {
      assert.deepEqual(deps, ['webServer']);
      callback({
        effect(fn) { fn(); },
        webServer: { register(route) { panelRoute = route; } },
      });
    },
  };
  const dispose = apply(ctx, {
    mode: 'external',
    externalUrl: 'http://127.0.0.1:8000/commandcode/v1',
    apiKeyEnv: 'TEST_BRIDGE_KEY',
  });
  assert.equal(typeof dispose, 'function');
  assert.deepEqual(registeredRoutes, ['ai-proxy']);
  assert.equal(modelCalls, 0);
  const models = await discovery();
  assert.equal(models[0].id, 'deepseek/test');
  assert.equal(models.some((model) => model.id.startsWith('openrouter/')), false);
  assert.equal(models.some((model) => model.id === 'blocked/channel'), false);
  assert.equal(modelCalls, 3);
  // The aggregate route answers in snake_case; reading only the camelCase
  // spelling silently downgraded every image-capable model to text-only.
  const listed = models.find((model) => model.id === 'deepseek/test');
  assert.equal(listed.contextWindow, 1000000);
  assert.equal(listed.maxTokens, 64000);
  assert.deepEqual(listed.inputModalities, ['text', 'image']);
  // Kilo nests modalities and context; reading only flat keys made 18 models
  // text-only with a default context.
  const kilo = models.find((model) => model.id === 'kilo/stealth/space-bunny-alpha');
  assert.deepEqual(kilo.inputModalities, ['text', 'image', 'video']);
  assert.equal(kilo.contextWindow, 1000000);
  assert.equal(kilo.maxTokens, 524288);
  const shorthand = models.find((model) => model.id === 'kilo/shorthand-only');
  assert.deepEqual(shorthand.inputModalities, ['text', 'image']);
  assert.equal(shorthand.contextWindow, 256000);
  // A channel that publishes only `id` must still get a readable display name.
  const zenModel = models.find((model) => model.id === 'zen/jev-1.13-free');
  assert.equal(zenModel.name, 'Jev 1.13');
  assert.equal(zenModel.name.startsWith('zen/'), false);
  // Every upstream name is passed through verbatim, including Kilo's
  // retirement note. The note is the upstream warning the user needs; removing
  // it to tidy a list would hide information the user was deliberately given.
  assert.equal(
    models.find((model) => model.id === 'kilo/retiring-model').name,
    'Retiring Model (retires Oct 5)',
  );
  // CommandCode's variant suffix is part of the name and survives the same way.
  assert.equal(
    models.find((model) => model.id === 'commandcode/deepseek/deepseek-v4-flash').name,
    'DeepSeek V4 Flash (latest)',
  );
  const blockedEvents = [];
  const blockedResolved = await adapter.resolveModel('ai-proxy', 'openrouter/paid/model');
  for await (const event of adapter.stream({
    model: blockedResolved.id,
    messages: [{ role: 'user', content: 'ping' }],
    maxTokens: 32,
  }, blockedResolved)) blockedEvents.push(event);
  assert.equal(blockedEvents.length, 1);
  assert.equal(blockedEvents[0].reason.kind, 'error');
  assert.equal(blockedEvents[0].reason.failure.code, 'CONFIG_DISABLED');
  const resolved = await adapter.resolveModel('ai-proxy-commandcode', 'deepseek/test');
  const projectResolved = await adapter.resolveModel('ai-proxy', 'deepseek/test');
  // Only the efforts the channel actually published may be declared; a rung the
  // upstream never offered is what produced the duplicate-effort rejection.
  assert.deepEqual(projectResolved.reasoning.efforts.map((effort) => effort.id), ['off', 'high', 'max']);
  assert.equal(new Set(projectResolved.reasoning.efforts.map((effort) => effort.id)).size, 3);
  assert.deepEqual(projectResolved.inputModalities, ['text', 'image']);
  assert.equal(projectResolved.context.contextWindow, 1000000);
  assert.equal(projectResolved.defaultMaxTokens, 64000);
  const events = [];
  for await (const event of adapter.stream({
    model: resolved.id,
    messages: [{ role: 'user', content: 'ping' }],
    maxTokens: 32,
  }, resolved)) events.push(event);
  assert.equal(chatCalls, 1);
  const zenResolved = await adapter.resolveModel('ai-proxy', 'zen/test');
  for await (const _event of adapter.stream({
    model: zenResolved.id,
    messages: [{ role: 'user', content: 'ping' }],
    sessionId: 'dsh-session-123',
    maxTokens: 32,
  }, zenResolved)) { /* stream shape is covered above */ }
  assert.equal(lastRequestHeaders.get('x-session-id'), 'dsh-session-123');
  assert.match(lastRequestHeaders.get('user-agent') || '', /opencode\//);
  assert.ok(events.some((event) => event.type === 'block-start' && event.blockType === 'text'));
  assert.ok(events.some((event) => event.type === 'text-delta' && event.text === 'pong'));
  assert.ok(events.some((event) => event.type === 'usage'));
  assert.deepEqual(events.at(-1), { type: 'finish', reason: { kind: 'stop' } });
  assert.equal(panelRoute.path, '/api/ai-proxy-commandcode');
  let panelBody = '';
  let panelStatus = 0;
  await panelRoute.handler({
    method: 'GET',
    headers: { host: 'dsh.local' },
  }, {
    writeHead(status) { panelStatus = status; },
    end(body) { panelBody = body; },
  });
  assert.equal(panelStatus, 200);
  const panel = JSON.parse(panelBody);
  assert.equal(panel.provider, 'commandcode');
  assert.equal(panel.panelSource, 'status-fallback');
  assert.equal(panel.accounts[0].keyName, undefined);
  assert.ok(Object.keys(panel.channels).length >= 2);
  assert.ok(panel.projectModels.some((model) => model.id.startsWith('deepseek-web/')));
  // The panel only shows 可用/限流/不可用 if the per-model verdicts are joined
  // onto the rows: /health keys samples by provider + unprefixed id, while the
  // roster uses `kilo/…`.
  const probed = panel.projectModels.find((model) => model.id === 'kilo/stealth/space-bunny-alpha');
  assert.equal(probed.state, 'available');
  assert.equal(probed.latencyMs, 1247);
  const throttled = panel.projectModels.find((model) => model.id === 'kilo/kilo-auto/free');
  assert.equal(throttled.state, 'degraded');
  assert.equal(throttled.reason, 'HTTP 429');
  assert.equal(panel.modelHealth.available, 1);
  assert.equal(panel.modelHealth.degraded, 1);
  assert.equal(panel.modelHealth.total, 2);
  // An unprobed channel must stay visible rather than being counted as broken.
  const unprobed = panel.projectModels.find((model) => model.id === 'deepseek/test');
  assert.equal(unprobed.state, undefined);

  const invoke = async (method, path) => {
    let status = 0;
    let body = '';
    await panelRoute.handler({
      method,
      url: path,
      headers: { host: 'dsh.local' },
    }, {
      writeHead(value) { status = value; },
      end(value) { body = value; },
    });
    return { status, body: JSON.parse(body) };
  };
  const settings = await invoke('GET', '/api/ai-proxy-commandcode/settings');
  assert.equal(settings.status, 200);
  assert.equal(settings.body.mode, 'external');
  const started = await invoke('POST', '/api/ai-proxy-commandcode/start');
  assert.equal(started.status, 200);
  const stopped = await invoke('POST', '/api/ai-proxy-commandcode/stop');
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.state, 'stopped');

  // Status checking must be something the user can start on demand.
  const originalFetchForProbe = globalThis.fetch;
  const probeCalls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('/health/probe')) {
      probeCalls.push({ url, body: init.body });
      const channel = new URL(url).searchParams.get('provider') || 'unknown';
      return new Response(JSON.stringify({
        provider: channel,
        probed: 1,
        models: { [`${channel}/probed-model`]: { state: 'available', latencyMs: 820 } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return originalFetchForProbe(input, init);
  };
  let probeStatus = 0;
  let probePayload = '';
  // readBody listens for stream events, so the fake request has to emit them
  // the way a real one would.
  const probeReq = {
    method: 'POST',
    url: '/api/ai-proxy/probe',
    headers: { host: 'dsh.local' },
    listeners: {},
    on(event, handler) { this.listeners[event] = handler; return this; },
    emit(event, value) { this.listeners[event]?.(value); },
  };
  const probeDone = panelRoute.handler(probeReq, {
    writeHead(value) { probeStatus = value; },
    end(value) { probePayload = value; },
  });
  probeReq.emit('data', Buffer.from(JSON.stringify({ channels: ['kilo'], limit: 0 })));
  probeReq.emit('end');
  await probeDone;
  globalThis.fetch = originalFetchForProbe;
  const probeOne = { status: probeStatus, body: JSON.parse(probePayload) };
  assert.equal(probeOne.status, 200);
  assert.deepEqual(probeOne.body.probed, ['kilo']);
  assert.equal(probeOne.body.models.kilo['kilo/probed-model'].state, 'available');
  // A single-channel request must not fan out to the whole roster.
  assert.equal(probeCalls.length, 1);
  assert.match(probeCalls[0].url, /provider=kilo/);

  // A routed id and a bare id must both resolve to the same roster row.
  const both = healthIndex({
    models: {
      kilo: {
        'kilo-auto/free': { state: 'degraded', latencyMs: 300 },
        'kilo/kilo-auto/free': { state: 'degraded', latencyMs: 300 },
        'stealth/space-bunny-alpha': { state: 'available', latencyMs: 900 },
      },
    },
  });
  assert.equal(both.get('kilo/kilo-auto/free').state, 'degraded');
  assert.equal(both.get('kilo/stealth/space-bunny-alpha').state, 'available');

  console.log('dsh bridge self-test ok');
} finally {
  globalThis.fetch = originalFetch;
}
