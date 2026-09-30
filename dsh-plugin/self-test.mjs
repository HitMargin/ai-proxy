import assert from 'node:assert/strict';
import { apply, AiProxyAdapter } from './index.js';

process.env.TEST_BRIDGE_KEY = 'local-test-key';
const originalFetch = globalThis.fetch;
let modelCalls = 0;
let chatCalls = 0;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const headers = new Headers(init.headers || {});
  assert.equal(headers.get('authorization'), 'Bearer local-test-key');
  if (url.endsWith('/health')) {
    return new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (url.endsWith('/panel')) {
    return new Response(JSON.stringify({ provider: 'commandcode', state: 'available', models: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (url.endsWith('/models')) {
    modelCalls++;
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
  const ctx = {
    fiber: { entry: { options: { id: 'bridge-test' } } },
    llm: {
      registerAdapter(_routes, value) { adapter = value; return { dispose() {} }; },
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
  assert.equal(modelCalls, 0);
  const models = await discovery();
  assert.equal(models[0].id, 'deepseek/test');
  assert.equal(modelCalls, 1);
  const resolved = await adapter.resolveModel('ai-proxy-commandcode', 'deepseek/test');
  const events = [];
  for await (const event of adapter.stream({
    model: resolved.id,
    messages: [{ role: 'user', content: 'ping' }],
    maxTokens: 32,
  }, resolved)) events.push(event);
  assert.equal(chatCalls, 1);
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
  assert.equal(JSON.parse(panelBody).provider, 'commandcode');

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
