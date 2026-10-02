import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Settings live in a file under the DSH home, so without this the suite reads the
// real ~/.dsh/ai-proxy-dsh-bridge/settings.json and its results depend on whatever
// the user last saved in the panel. It already did once: a hand-written
// hiddenChannels turned a blocked-channel assertion red on a machine whose state
// had nothing to do with the code under test. Redirected before the import so the
// module's first settings read already lands in the sandbox.
const sandboxHome = path.join(os.tmpdir(), `ai-proxy-self-test-${process.pid}`);
process.env.DSH_HOME = sandboxHome;
process.on('exit', () => {
  try { fs.rmSync(sandboxHome, { recursive: true, force: true }); } catch {}
});

const { apply, AiProxyAdapter, healthIndex } = await import('./index.js');

process.env.TEST_BRIDGE_KEY = 'local-test-key';
const originalFetch = globalThis.fetch;
let modelCalls = 0;
let loginCalls = 0;
let chatCalls = 0;
let lastRequestHeaders = new Headers();
let lastChatBody = null;
// Controls the shape of the streamed reply so the terminal-marker handling can be
// exercised: a complete stream, one cut mid-answer, and one cut with nothing sent.
let streamMode = 'normal';
// Which listing routes were asked for, so a test can assert that a channel the
// user switched off is not being polled at all.
const modelCallsByPath = {};
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
      // A member whose listing failed is absent from the channel roster, so the
      // panel needs the proxy to name it or a shrinking roster looks uneventful.
      catalogIssues: {
        tokenharbor: {
          state: 'failed',
          checkedAt: 1,
          listedModels: 0,
          keptModels: 0,
          reason: 'listing request failed: connection reset',
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
  if (url.endsWith('/login')) {
    loginCalls++;
    return new Response(JSON.stringify({
      ok: true,
      authUrl: 'https://commandcode.test/studio/auth/cli?state=test',
      callbackUrl: 'http://localhost:5959/callback',
      status: { status: 'waiting', authUrl: 'https://commandcode.test/studio/auth/cli?state=test', callbackUrl: 'http://localhost:5959/callback' },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.endsWith('/status')) {
    return new Response(JSON.stringify({
      provider: 'commandcode',
      modelCount: 1,
      activeAccounts: 1,
      accounts: [{ id: 'test', enabled: true, cooling: false, keyName: 'must-not-leak' }],
      login: { status: 'idle' },
      cache: { total: 1, sessions: 0 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.endsWith('/models')) {
    modelCalls++;
    {
      const { pathname } = new URL(url);
      modelCallsByPath[pathname] = (modelCallsByPath[pathname] ?? 0) + 1;
    }
    if (url.includes('/openrouter/')) {
      return new Response(JSON.stringify({ data: [{ id: 'blocked/channel', name: 'Blocked' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/deepseek-web/')) {
      // The per-channel route answers with bare ids; the panel prefixes them.
      return new Response(JSON.stringify({
        data: [
          { id: 'deepseek-chat', name: 'DeepSeek 网页 · 快速模式', context_window: 1048576, max_output_tokens: 16384 },
          { id: 'deepseek-reasoner', name: 'DeepSeek 网页 · 深度思考', context_window: 1048576, max_output_tokens: 32768 },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/v1/models')) {
      return new Response(JSON.stringify({
        data: [
          { id: 'openrouter/paid/model', name: 'Paid', context_window: 128000, max_output_tokens: 32000 },
          { id: 'cnb/deepseek-v4-flash', name: 'CNB Flash', context_window: 131072, max_output_tokens: 8192 },
          { id: 'cnb/deepseek-v4-pro', name: 'CNB Pro', context_window: 131072, max_output_tokens: 8192 },
          {
            id: 'deepseek/test',
            name: 'DeepSeek Test',
            context_window: 1000000,
            max_output_tokens: 64000,
            input_modalities: ['text', 'image'],
            reasoning_efforts: ['off', 'high', 'max'],
          },
          {
            // The shape /v1/models documents for `reasoning_efforts`, which is
            // what the Zen models endpoint returns. Reading only strings made
            // this come back empty and took the whole provider down with
            // INVALID_MODEL_REASONING.
            id: 'zen/object-shape',
            name: 'Zen object shape',
            context_window: 1048576,
            max_output_tokens: 131072,
            input_modalities: ['text'],
            reasoning_efforts: [
              { id: 'minimal', name: 'minimal' },
              { id: 'low', name: 'low' },
              { id: 'medium', name: 'medium' },
              { id: 'high', name: 'high' },
              { id: 'xhigh', name: 'xhigh' },
            ],
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
            // A blocked word inside a channel's own model name is not a blocked
            // channel. Kilo really does host this router, and a block that
            // matched any path segment would take a working model out.
            id: 'kilo/openrouter/free',
            name: 'OpenRouter Free Models Router',
            architecture: { input_modalities: ['text'] },
            context_length: 200000,
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
    if (url.includes('/tokenharbor/')) {
      // One row, as the real channel answers. Letting it fall through to the
      // default branch would hand it a copy of the whole aggregate listing,
      // which is how a blocked channel can look discovered twice.
      return new Response(JSON.stringify({
        data: [{ id: 'token-test', name: 'Token Test', context_window: 32768, max_output_tokens: 4096 }],
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
  lastChatBody = init.body ? JSON.parse(String(init.body)) : null;
  if (streamMode === 'cut') {
    return new Response([
      'data: {"choices":[{"delta":{"content":"half an ans"},"finish_reason":null}]}\n\n',
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  if (streamMode === 'kilo-variants') {
    return new Response(
      [
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ].join(''),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }
  if (streamMode === 'usage-cached') {
    return new Response(
      [
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":880,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":149,"cache_write_tokens":12},"completion_tokens_details":{"reasoning_tokens":0}}}\n\n',
        'data: [DONE]\n\n',
      ].join(''),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }
  if (streamMode === 'reasoning-kilo') {
    return new Response([
      'data: {"choices":[{"delta":{"reasoning":"kilo spells it "},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning":"reasoning"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  if (streamMode === 'cut-empty') {
    return new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
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
  // The aggregate listing plus the one channel that has its own route and is
  // not blocked. deepseek-web used to be the third, which is what the poller's
  // log was full of.
  assert.equal(modelCalls, 1, `paths: ${JSON.stringify(modelCallsByPath)}`);
  // tokenharbor is held back with no key. Its filterModels drops every id without
  // a `:free` suffix, so a 401 came back as an empty list and the panel read it as
  // "no free models here" - the same thing a working channel looks like.
  assert.equal(modelCallsByPath['/tokenharbor/v1/models'], undefined);
  // Hidden, so not fetched - the log-noise rule. The panel's switch decides this,
  // which is the test that follows.
  assert.equal(modelCallsByPath['/deepseek-web/v1/models'], undefined);
  dispose();
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

  // The block is judged on the caller's id, never on `wireModel`. Routing has
  // already stripped the channel prefix, so a block tested against the wire
  // spelling would let `deepseek-web/deepseek-chat` through as `deepseek-chat`
  // and the channel would stay reachable behind a block that looked like it
  // was holding.
  const dwResolved = await adapter.resolveModel('ai-proxy', 'deepseek-web/deepseek-chat');
  assert.equal(
    dwResolved.wireModel,
    'deepseek-chat',
    'routing must still know how to address a blocked channel',
  );
  const dwEvents = [];
  for await (const event of adapter.stream({
    model: dwResolved.id,
    messages: [{ role: 'user', content: 'ping' }],
    maxTokens: 32,
  }, dwResolved)) dwEvents.push(event);
  assert.equal(dwEvents.length, 1, 'a blocked channel must not reach the upstream');
  assert.equal(dwEvents[0].reason.failure.code, 'CONFIG_DISABLED');
  // The panel owns the hidden-channel list now, so the wording is the shared one.
  // What still has to hold is that it says "switched off" and not "needs a key":
  // deepseek-web works, and telling the user to add credentials sends them chasing
  // a problem they do not have.
  assert.match(
    dwEvents[0].reason.failure.message,
    /switched off/,
    'the refusal must name the real reason, not a missing-key story',
  );
  assert.doesNotMatch(dwEvents[0].reason.failure.message, /per-user upstream key/);
  assert.equal(
    blockedEvents[0].reason.failure.message.includes('per-user upstream key'),
    true,
    'a key-only channel still gets the key explanation',
  );
  // The withheld count describes rows that were actually seen and dropped: the 3
  // blocked rows inside the aggregate listing (1 openrouter, 2 cnb). A blocked
  // channel that has its own route is never fetched at all, so it contributes
  // nothing here - asking the proxy for a listing whose rows would all be discarded
  // cost one request per poll for nothing.
  assert.equal(adapter.blockedModelCount, 3);
  for (const prefix of ['deepseek-web/', 'cnb/', 'openrouter/']) {
    assert.equal(
      models.some((model) => model.id.startsWith(prefix)),
      false,
      `${prefix} must not reach the roster`,
    );
  }
  // deepseek-web is blocked *and* has its own route, so it must not be asked
  // about at all. A poll that keeps requesting a channel the user switched off
  // is the log noise this guards against.
  assert.equal(
    modelCallsByPath['/deepseek-web/v1/models'] ?? 0,
    0,
    'a blocked channel must not be polled',
  );
  // A blocked channel must not come back under another channel's prefix: the
  // block is read off the first path segment, so a row whose *channel* is
  // blocked is withheld however many prefixes were stacked in front of it.
  assert.equal(
    models.some((model) => ['openrouter', 'cnb', 'deepseek-web']
      .includes(String(model.id).split('/')[0])),
    false,
    'a blocked channel must not be laundered through another prefix',
  );
  // The converse also holds: a blocked word inside a channel's own model name is
  // not a blocked channel. `kilo/openrouter/free` is a real Kilo-hosted router
  // and must survive the block.
  assert.ok(
    models.some((model) => model.id === 'kilo/openrouter/free'),
    'a working model whose name contains a blocked word must stay in the roster',
  );

  // cnb needs a login cookie, which is a different remedy from a missing key,
  // so the refusal has to name the one that would actually re-enable it.
  const cnbResolved = await adapter.resolveModel('ai-proxy', 'cnb/deepseek-v4-flash');
  const cnbEvents = [];
  for await (const event of adapter.stream({
    model: cnbResolved.id,
    messages: [{ role: 'user', content: 'ping' }],
    maxTokens: 8,
  }, cnbResolved)) cnbEvents.push(event);
  assert.equal(cnbEvents.length, 1);
  assert.equal(cnbEvents[0].reason.failure.code, 'CONFIG_DISABLED');
  assert.match(cnbEvents[0].reason.failure.message, /cnb-login\.txt/);
  const resolved = await adapter.resolveModel('ai-proxy-commandcode', 'deepseek/test');
  const projectResolved = await adapter.resolveModel('ai-proxy', 'deepseek/test');
  // Only the efforts the channel actually published may be declared; a rung the
  // upstream never offered is what produced the duplicate-effort rejection.
  assert.deepEqual(projectResolved.reasoning.efforts.map((effort) => effort.id), ['off', 'high', 'max']);
  assert.equal(new Set(projectResolved.reasoning.efforts.map((effort) => effort.id)).size, 3);
  // The object spelling must yield the same treatment, ladder order included, and
  // `minimal` - which the Zen catalog publishes for muse spark - has to survive.
  const objectResolved = await adapter.resolveModel('ai-proxy', 'zen/object-shape');
  assert.deepEqual(
    objectResolved.reasoning.efforts.map((effort) => effort.id),
    ['minimal', 'low', 'medium', 'high', 'xhigh'],
  );
  assert.equal(objectResolved.reasoning.defaultEffort, 'high');
  assert.ok(objectResolved.reasoning.efforts.length > 0);
  // The display name is the id the upstream published. Inventing spellings
  // (e.g. `Very high`) advertised a rung no channel serves, and a translated
  // label reads wrong outside that locale.
  assert.deepEqual(
    projectResolved.reasoning.efforts.map((effort) => effort.name),
    ['off', 'high', 'max'],
  );
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

  // A stream that dies mid-answer used to report finish: stop, because the loop
  // ended normally and `finish` stayed undefined. The agent loop read that as a
  // finished turn and moved on, so the cut left no trace anywhere.
  streamMode = 'cut';
  const cutEvents = [];
  for await (const event of adapter.stream({
    model: resolved.id,
    messages: [{ role: 'user', content: 'do the thing' }],
    maxTokens: 32,
  }, resolved)) cutEvents.push(event);
  const cutFinish = cutEvents.find((e) => e.type === 'finish');
  assert.equal(cutFinish?.reason?.kind, 'error');
  assert.equal(cutFinish?.reason?.failure?.code, 'stream_cut');
  assert.match(cutFinish?.reason?.failure?.message ?? '', /after partial output/);
  // Whatever arrived is still closed out, so the text is not thrown away with
  // the failure.
  assert.ok(cutEvents.some((e) => e.type === 'block-end' && e.block?.text === 'half an ans'));

  // A cut before anything was produced is the one a retry can actually help, so
  // it keeps the retryable code rather than claiming the turn was partial.
  streamMode = 'cut-empty';
  const emptyEvents = [];
  for await (const event of adapter.stream({
    model: resolved.id,
    messages: [{ role: 'user', content: 'do the thing' }],
    maxTokens: 32,
  }, resolved)) emptyEvents.push(event);
  const emptyFinish = emptyEvents.find((e) => e.type === 'finish');
  assert.equal(emptyFinish?.reason?.kind, 'error');
  assert.equal(emptyFinish?.reason?.failure?.code, 'TRANSPORT');
  assert.match(emptyFinish?.reason?.failure?.message ?? '', /no output delivered/);

  // A stream that carried its terminal marker is still reported as a stop.
  streamMode = 'normal';
  const doneEvents = [];
  for await (const event of adapter.stream({
    model: resolved.id,
    messages: [{ role: 'user', content: 'ping' }],
    maxTokens: 32,
  }, resolved)) doneEvents.push(event);
  assert.equal(doneEvents.find((e) => e.type === 'finish')?.reason?.kind, 'stop');

  // The harness history is provider-neutral: a tool result is `role: 'tool'`
  // with a `toolCallId`, and an assistant turn holds `tool-call` blocks. Both
  // used to be flattened into plain user/assistant text, so the model was told a
  // tool had spoken and had no tool_calls of its own - it answered whatever was
  // in front of it and stopped, which is the whole reported symptom.
  const toolResolved = await adapter.resolveModel('ai-proxy', 'deepseek/test');
  for await (const _e of adapter.stream({
    model: toolResolved.id,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'fix OnGui.cs' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'reading the file:' },
          { type: 'tool-call', id: 'call_1', name: 'edit', arguments: '{"path":"OnGui.cs"}' },
        ],
      },
      { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: '<file contents>' }] },
    ],
    maxTokens: 32,
  }, toolResolved)) { /* shape asserted below */ }
  const sent = lastChatBody?.messages ?? [];
  assert.equal(sent[1].role, 'assistant');
  assert.equal(sent[1].tool_calls?.[0]?.id, 'call_1');
  assert.equal(sent[1].tool_calls?.[0]?.function?.name, 'edit');
  assert.equal(sent[2].role, 'tool');
  assert.equal(sent[2].tool_call_id, 'call_1');
  assert.equal(sent[2].content, '<file contents>');
  assert.equal(sent.filter((m) => m.role === 'user').length, 1, 'the tool result must not arrive as a user turn');

  // An empty or failed tool result used to arrive as a bare empty string, so
  // the model could not tell a failed tool from one that had nothing to say.
  for await (const _e of adapter.stream({
    model: toolResolved.id,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'tool', toolCallId: 'call_empty', content: [] },
      { role: 'tool', toolCallId: 'call_err', content: [], isError: true },
      { role: 'assistant', content: [{ type: 'reasoning', text: 'thinking only' }] },
    ],
    maxTokens: 32,
  }, toolResolved)) { /* asserted below */ }
  const marked = lastChatBody.messages;
  assert.equal(marked.find((m) => m.tool_call_id === 'call_empty')?.content, '(no tool output)');
  assert.match(marked.find((m) => m.tool_call_id === 'call_err')?.content ?? '', /^\[tool error\]/);
  // Reasoning-only turns produce neither prose nor a call once reasoning is
  // dropped, and 'either content or tool_calls, but not none' is what a strict
  // channel rejects.
  assert.equal(marked.some((m) => m.role === 'assistant'), false, 'an empty assistant turn must be skipped');

  // store defaults to true on OpenAI, asking the gateway to retain the
  // conversation; the built-in client sends false and so must this one.
  for await (const _e of adapter.stream({
    model: toolResolved.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    maxTokens: 32,
    sessionId: 'dsh-session-abc',
  }, toolResolved)) { /* asserted below */ }
  assert.equal(lastChatBody.store, false);
  assert.equal(lastRequestHeaders.get('x-session-affinity'), 'dsh-session-abc');
  assert.equal(lastRequestHeaders.get('prompt_cache_key'), 'dsh-session-abc');

  // A title is not worth reasoning about, and the built-in client forces the
  // effort off for this purpose.
  for await (const _e of adapter.stream({
    model: toolResolved.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    maxTokens: 32,
    reasoningEffort: 'high',
    purpose: 'session-title',
  }, toolResolved)) { /* asserted below */ }
  assert.equal(lastChatBody.reasoning_effort, undefined, 'a session title must not spend reasoning tokens');

  // kilo publishes its ladder in opencode.variants, not reasoning_efforts, so
  // this path used to publish the fallback table instead: an `off` the upstream
  // never offered and no `medium` or `xhigh` at all. `enabled: false` is the rung
  // that turns reasoning off, not a missing one - kilo names it `instant`/`none`
  // and pairs it with `thinking`.
  streamMode = 'kilo-variants';
  let variantEfforts = null;
  for await (const _e of adapter.stream({
    model: toolResolved.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    maxTokens: 32,
  }, { ...toolResolved, reasoning: undefined })) { /* asserted below */ }
  assert.equal(lastChatBody.max_tokens > 0, true, 'the variant route still sends a request');

  // TokenUsage carries cacheReadTokens / cacheWriteTokens, and mapUsage used to
  // drop both - so a call that really did read 149 of 880 tokens from cache was
  // reported to the composer as a 0% hit rate.
  streamMode = 'usage-cached';
  let cachedUsage = null;
  for await (const event of adapter.stream({
    model: toolResolved.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    maxTokens: 32,
  }, toolResolved)) {
    if (event.type === 'usage') cachedUsage = event.usage;
  }
  assert.equal(cachedUsage.inputTokens, 880);
  assert.equal(cachedUsage.cacheReadTokens, 149, 'a reported cache read must survive into TokenUsage');
  assert.equal(cachedUsage.cacheWriteTokens, 12, 'a reported cache write must survive into TokenUsage');

  // Images reach the wire now. The block shape is { type:'image', attachment }
  // - the old code read `part.source`, which does not exist in the harness, so
  // this path could never match and no image ever reached a plugin model.
  const fakeImage = {
    attachment: { attachmentId: 'att_1', mediaType: 'image/png' },
  };
  const resolveImage = (ref) =>
    ref?.attachmentId === 'att_1' ? 'data:image/png;base64,AAAA' : undefined;
  adapter.resolveImage = resolveImage;
  for await (const _e of adapter.stream({
    model: toolResolved.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', ...fakeImage }] }],
    maxTokens: 32,
  }, { ...toolResolved, resolveImage, inputModalities: ['text', 'image'] })) { /* asserted below */ }
  assert.equal(lastChatBody.messages[0].content[1]?.image_url?.url, 'data:image/png;base64,AAAA');

  // A text-only model must not be sent image_url at all: that is a 400 for the
  // whole turn, not a dropped image.
  for await (const _e of adapter.stream({
    model: toolResolved.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', ...fakeImage }] }],
    maxTokens: 32,
  }, { ...toolResolved, resolveImage, inputModalities: ['text'] })) { /* asserted below */ }
  const textOnly = lastChatBody.messages[0].content;
  assert.equal(textOnly.some((part) => part.type === 'image_url'), false);
  assert.match(textOnly.at(-1)?.text ?? '', /does not support images/);

  // role 'tool' is text-only on this wire, so an image a tool returned travels
  // as the user turn right after - otherwise a read_image result is lost.
  for await (const _e of adapter.stream({
    model: toolResolved.id,
    messages: [
      { role: 'tool', toolCallId: 'call_img', content: [{ type: 'image', ...fakeImage }] },
    ],
    maxTokens: 32,
  }, { ...toolResolved, resolveImage, inputModalities: ['text', 'image'] })) { /* asserted below */ }
  const withImage = lastChatBody.messages;
  assert.equal(withImage[0].role, 'tool');
  assert.equal(withImage[0].content, '(see attached images)');
  assert.equal(withImage[1].role, 'user');
  assert.ok(withImage[1].content.some((part) => part.type === 'image_url'));

  // Thinking arrives under whichever field the gateway chose. Measured against
  // space-bunny-alpha: 126 tokens under `reasoning`, and `reasoning_content`
  // never appeared once - so reading only the DeepSeek spelling discarded every
  // kilo turn's thinking without a trace.
  streamMode = 'reasoning-kilo';
  let reasoningText = '';
  let reasoningBlocks = 0;
  for await (const event of adapter.stream({
    model: toolResolved.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'think' }] }],
    maxTokens: 32,
  }, toolResolved)) {
    if (event.type === 'reasoning-delta') reasoningText += event.text;
    if (event.type === 'block-start' && event.blockType === 'reasoning') reasoningBlocks++;
  }
  assert.equal(reasoningBlocks, 1, 'the reasoning block must open exactly once');
  assert.equal(reasoningText, 'kilo spells it reasoning');

  // A model's output ceiling is not a request size. kilo publishes
  // top_provider.max_completion_tokens = 524288 against a 1,000,000 window, so the
  // ceiling alone left less room than the conversation had already used - the
  // gateway answered 400 with 467563 + 8282 + 524288 = 1000133.
  const tightResolved = {
    ...toolResolved,
    context: { contextWindow: 1000 },
    defaultMaxTokens: 524288,
  };
  for await (const _e of adapter.stream({
    model: toolResolved.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(3200) }] }],
  }, tightResolved)) { /* asserted below */ }
  const fitInput = Math.ceil('x'.repeat(3200).length / 4);
  assert.ok(lastChatBody.max_tokens < 524288, 'the output ceiling must not be sent as the request size');
  assert.equal(
    lastChatBody.max_tokens,
    Math.max(1024, 1000 - fitInput - 2048),
    `clamped budget must be window minus input minus headroom (input=${fitInput})`,
  );
  assert.equal(lastChatBody.max_tokensClamped, undefined, 'the marker must not reach the wire');
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
  // deepseek-web is listed by the channel and then withheld, so it must be
  // absent here — and the panel must say it withheld ten rows rather than
  // quietly presenting a shorter roster.
  assert.equal(panel.projectModels.some((model) => model.id.startsWith('deepseek-web/')), false);
  assert.equal(panel.blockedModelCount > 0, true);
  // Every channel the proxy serves needs a switch, whether or not it currently
  // answers. Deriving the list from the roster plus the hidden set meant a
  // channel that was on but silent - openrouter with no key, deepseek-web with no
  // login state - fell out of both, and the only way to switch it back off was to
  // edit settings.json by hand.
  for (const channel of ['kilo', 'zen', 'commandcode', 'cnb', 'openrouter', 'deepseek-web', 'tokenharbor']) {
    assert.ok(
      panel.allChannels.includes(channel),
      `${channel} must keep its switch whether or not it lists models right now`,
    );
  }
  assert.equal(panel.hiddenChannels.includes('deepseek-web'), true);

  // Everything the panel renders has to come from the panel snapshot, which is
  // computed per request. The runtime snapshot is built once per apply() and kept
  // by an instance that outlives a window reload, so a field placed there is stale
  // until the Host restarts - which is exactly how channelKeySet went missing
  // while the rest of the panel showed new data.
  for (const field of ['hiddenChannels', 'allChannels', 'keyedChannels', 'channelKeySet', 'deepseekWeb', 'projectModels']) {
    assert.ok(field in panel, `${field} must be on the panel snapshot`);
  }
  const settingsBody = await (async () => {
    let status = 0;
    let payload = '';
    await panelRoute.handler({ method: 'GET', url: '/api/ai-proxy-commandcode/settings', headers: { host: 'dsh.local' } }, {
      writeHead(value) { status = value; },
      end(value) { payload = value; },
    });
    assert.equal(status, 200);
    return JSON.parse(payload);
  })();
  assert.equal('channelKeySet' in settingsBody, false, 'the runtime snapshot is not where the panel reads it from');

  // CommandCode signs in through the browser, so the button needs two things: the
  // flow's state on the panel, and a route that starts it. The proxy answers
  // POST /login with {authUrl, callbackUrl, status: {...}} while the panel carries
  // login: {status: 'idle'} - handing the panel both would make `status === 'waiting'`
  // mean two different things depending on which arrived.
  assert.deepEqual(panel.login, { status: 'idle' }, 'the fallback panel must carry the login state');
  const beforeLogin = loginCalls;
  const loginBody = await (async () => {
    let status = 0;
    let payload = '';
    await panelRoute.handler({ method: 'POST', url: '/api/ai-proxy-commandcode/commandcode/login', headers: { host: 'dsh.local' } }, {
      writeHead(value) { status = value; },
      end(value) { payload = value; },
    });
    assert.equal(status, 200);
    return JSON.parse(payload);
  })();
  assert.equal(loginCalls, beforeLogin + 1, 'the button must actually start the flow');
  assert.equal(loginBody.status, 'waiting');
  assert.equal(typeof loginBody.authUrl, 'string');
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
  // The failed member has to reach the panel under its own name, or the channel
  // chips just get shorter and nothing says why.
  assert.equal(panel.catalogIssues.tokenharbor.state, 'failed');
  assert.equal(panel.catalogIssues.tokenharbor.reason, 'listing request failed: connection reset');
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

  // Switching the channel on has to actually put its models in the roster.
  // deepseek-web sat in no listing path at all, so its switch in the panel showed
  // 0 models whatever the switch was set to - the one thing a user cannot fix from
  // the panel. A second apply with the channel left visible is the only way to
  // exercise that, because the default is hidden.
  let enabledDiscovery;
  const enabledCtx = {
    ...ctx,
    llm: {
      ...ctx.llm,
      registerModelDiscovery(_id, callback) { enabledDiscovery = callback; },
    },
  };
  // deepseek-web is held back until its login state exists, and that is read from
  // the project directory - so the fixture supplies one. Without this the suite's
  // result depended on whether the checkout it ran from happened to have those
  // files, which is how a passing run in the repo failed in the installed copy.
  const fixtureRoot = path.join(sandboxHome, 'project');
  fs.mkdirSync(fixtureRoot, { recursive: true });
  for (const name of ['deepseek-cookies.txt', 'deepseek-auth.txt', 'deepseek-headers.json']) {
    fs.writeFileSync(path.join(fixtureRoot, name), 'fixture');
  }
  const disposeEnabled = apply(enabledCtx, {
    mode: 'external',
    externalUrl: 'http://127.0.0.1:8000/commandcode/v1',
    apiKeyEnv: 'TEST_BRIDGE_KEY',
    projectRoot: fixtureRoot,
    hiddenChannels: ['cnb', 'openrouter'],
    channelKeys: { tokenharbor: 'test-tokenharbor-key' },
  });
  const afterSwitch = await enabledDiscovery();
  assert.equal(modelCallsByPath['/deepseek-web/v1/models'], 1, 'a visible channel must be listed');
  // A key is what lifts the hold, and it is the channel's own key: sharing one
  // variable across keyed channels means a key for one is silently used for the
  // other, which fails as a 401 at the far end with nothing in the logs.
  assert.equal(modelCallsByPath['/tokenharbor/v1/models'], 1, 'a keyed channel must be listed once keyed');
  assert.ok(
    afterSwitch.some((model) => model.id.startsWith('deepseek-web/')),
    'enabling the channel must put its models in the roster',
  );
  disposeEnabled();
  console.log('dsh bridge self-test ok');
} finally {
  globalThis.fetch = originalFetch;
}