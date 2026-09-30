import assert from 'node:assert/strict';
import { apply, AiProxyAdapter } from './index.js';

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
    return new Response(JSON.stringify({ status: 'ok' }), {
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
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
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
  console.log('dsh bridge self-test ok');
} finally {
  globalThis.fetch = originalFetch;
}
