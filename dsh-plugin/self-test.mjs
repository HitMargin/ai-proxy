import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Settings live in a file under the DSH home, so without this the suite reads the
// real ~/.dsh/ai-proxy-dsh-bridge/settings.json and its results depend on whatever
// the user last saved in the panel. It already did once: a hand-written
// hiddenChannels turned a blocked-channel assertion red on a machine whose state
// had nothing to do with the code under test. Redirected before the import so the
// module's first settings read already lands in the sandbox.
const sandboxHome = path.join(os.tmpdir(), `ai-proxy-self-test-${process.pid}`);
process.env.DSH_HOME = sandboxHome;
// The channel gates read `projectCandidates`, which ends in fallbacks - the
// plugin's parent directory, then process.cwd(). Running from a checkout that
// holds real credential files therefore let a gate pass on the *user's* files
// instead of the fixture's, and every assertion written against such a gate
// stayed green with its own fixture line deleted. This removes the one of the two
// fallbacks a test can control; the plugin's parent is out of reach from here,
// which is why the credential predicate is also exported root-scoped.
const emptyCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-proxy-self-test-cwd-'));
const originalCwd = process.cwd();
process.chdir(emptyCwd);
process.on('exit', () => {
  try { process.chdir(originalCwd); } catch {}
  try { fs.rmSync(emptyCwd, { recursive: true, force: true }); } catch {}
});
process.on('exit', () => {
  try { fs.rmSync(sandboxHome, { recursive: true, force: true }); } catch {}
});

const { apply, AiProxyAdapter, CatalogGate, ProxyRuntime, healthIndex, CHANNEL_GROUPS, PROBE_CHANNELS, workBuddyCredentialIn } = await import('./index.js');

process.env.TEST_BRIDGE_KEY = 'local-test-key';
const originalFetch = globalThis.fetch;
let modelCalls = 0;
let loginCalls = 0;
// The TRAE account routes. A counter per call is what makes the assertions
// falsifiable: "the button posts once and the status read is not a POST" cannot
// pass by accident if the fake records which one was called.
let traeAccountCalls = 0;
let traeCheckinCalls = 0;
let traeCheckinOk = true;
let workBuddyAccountCalls = 0;
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
  if (url.endsWith('/trae/v1/account')) {
    traeAccountCalls++;
    return new Response(JSON.stringify({
      configured: true,
      uid: '2971347912497099',
      nickname: '(1761121491907',
      expired: false,
      balance: { total: 500, packs: [{ name: 'every month', total: 500, used: 0, remaining: 500, expires: '2026-10-31' }] },
      balanceKnown: true,
      checkin: { checkedIn: false, credits: 100, enabled: true },
      checkinKnown: true,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.endsWith('/workbuddy/v1/account')) {
    workBuddyAccountCalls++;
    // Deliberately carries no token of any shape. The proxy's own account route is
    // the boundary that decides what the panel may see, and a fixture that smuggled
    // one in would let a leak pass this suite unnoticed.
    return new Response(JSON.stringify({
      configured: true,
      nickname: 'WorkBuddy Tester',
      userId: 'wb-user-1',
      accountType: 'personal',
      expired: false,
      refreshable: true,
      usable: true,
      models: 14,
      catalogKnown: true,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.endsWith('/trae/v1/checkin')) {
    traeCheckinCalls++;
    return new Response(JSON.stringify({
      ok: traeCheckinOk,
      code: traeCheckinOk ? 0 : 9074,
      message: traeCheckinOk ? 'success' : 'too many users right now',
      credits: traeCheckinOk ? 100 : null,
      throttled: traeCheckinOk ? 0 : 4,
      alreadyClaimed: false,
      balance: { total: traeCheckinOk ? 600 : 500, packs: [] },
      balanceKnown: true,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
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
            // kilo's rungs are named `instant`/`thinking` while the effort each one
            // actually sends is `none`/`high`. Publishing the key put
            // `reasoning_effort: "instant"` on the wire, and kilo's validator answers
            // that with `Invalid option: expected one of
            // "max"|"xhigh"|"high"|"medium"|"low"|"minimal"|"none"` - so every turn on
            // those models failed. The name and the wire value are separate facts.
            id: 'kilo/poolside/laguna-s-2.1:free',
            name: 'Laguna S 2.1 (free)',
            architecture: { input_modalities: ['text'] },
            context_length: 262144,
            opencode: {
              variants: {
                instant: { reasoning: { enabled: false, effort: 'none' } },
                thinking: { reasoning: { enabled: true, effort: 'high' } },
              },
            },
          },
          {
            // Says nothing about reasoning: no `reasoning_efforts`, no
            // `opencode.variants`. The adapter must declare no ladder rather than
            // invent one - an invented rung is a control that either does nothing or
            // is rejected by the upstream.
            id: 'kilo/silent-about-reasoning',
            name: 'Silent About Reasoning',
            architecture: { input_modalities: ['text'] },
            context_length: 128000,
          },
          {
            // The shape `/v1/models` documents: `{reasoning:{efforts:[{id,name}]}}`.
            // TRAE publishes exactly this, and `publishedEfforts` read only the
            // flat spellings plus kilo's variants - so the ladder was present in
            // the response and simply never looked at.
            //
            // `id` is the wire value and `name` is the upstream's own label for
            // it; they differ here on purpose (`light` is what TRAE calls `low`).
            id: 'trae/glm-5.3-flash',
            name: 'GLM-5.3-Flash',
            context_window: 1000000,
            max_output_tokens: 64000,
            input_modalities: ['text', 'image'],
            reasoning: {
              efforts: [
                { id: 'low', name: 'light' },
                { id: 'high', name: 'high' },
                { id: 'xhigh', name: 'extra_high' },
              ],
              defaultEffort: 'xhigh',
            },
          },
          {
            // The channel states which rung applies when the caller names none.
            // Defaulting to `high` instead overrode it.
            id: 'zen/default-off',
            name: 'Default Off',
            context_window: 1048576,
            max_output_tokens: 16384,
            reasoning_efforts: [
              { id: 'off', name: 'Off' },
              { id: 'low', name: 'Low' },
              { id: 'high', name: 'High' },
            ],
            default_reasoning_effort: 'off',
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
  // A well-formed stream: a reason is named and [DONE] arrives, but not a single
  // content, reasoning or tool block was ever opened. This is what the harness
  // reports as "Provider returned an empty response".
  if (streamMode === 'done-empty') {
    return new Response(
      [
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":1}}\n\n',
        'data: [DONE]\n\n',
      ].join(''),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
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
  // The aggregate stays and every channel joins it as its own provider: the Host
  // groups its catalog strictly by provider id, so this list IS the grouping.
  // Dropping the aggregate would break a session that already selected
  // ai-proxy/commandcode/x; dropping a channel would merge its models back into
  // the one undivided list this split exists to divide.
  // Group provider ids are namespaced. Other plugins register providers under
  // the bare channel names - the local llm-pi-ai config does exactly that for
  // commandcode and deepseek-web - and two plugins claiming one id makes the
  // second throw DUPLICATE_ADAPTER, which takes the whole entry down.
  assert.deepEqual(registeredRoutes, [
    'ai-proxy',
    ...Object.keys(CHANNEL_GROUPS),
  ]);
  assert.equal(
    registeredRoutes.includes('commandcode'),
    false,
    'a group must not claim a bare channel name another plugin may register',
  );
  assert.equal(modelCalls, 0);
  const models = await discovery();
  assert.equal(models[0].id, 'deepseek/test');
  assert.equal(models.some((model) => model.id.startsWith('openrouter/')), false);
  assert.equal(models.some((model) => model.id === 'blocked/channel'), false);
  // TRAE must reach the panel AND keep a switch. A channel listed from the
  // account's own catalog still needs to be switchable off, or turning it off is
  // a settings.json edit by hand.
  assert.ok(
    models.some((model) => model.id.startsWith('trae/')),
    'TRAE rows must reach the panel listing',
  );
  assert.equal(modelCallsByPath['/trae/v1/models'] > 0, true, 'the TRAE listing must actually be fetched');
  // The ladder must survive the trip to the panel. `publishedEfforts` only read
  // `reasoningEfforts`/`reasoning_efforts`/`opencode.variants`, and `/v1/models`
  // publishes `reasoning.efforts` - so all 20 TRAE rows lost their ladder and the
  // panel showed no Effort control, with nothing anywhere reporting an error.
  // Asserted on the panel row, because that is where the loss was visible.
  const traeRow = models.find((model) => model.id === 'trae/glm-5.3-flash');
  assert.ok(traeRow !== undefined, 'the TRAE row must be in the panel listing');
  const traeEfforts = traeRow.reasoningEfforts;
  assert.ok(
    Array.isArray(traeEfforts) && traeEfforts.length > 0,
    'a ladder published by the upstream must reach the panel',
  );
  assert.deepEqual(
    Array.from(traeEfforts).map((effort) => effort.id).sort(),
    ['high', 'low', 'xhigh'],
    'the rungs must be the wire values, not the labels',
  );
  // The switch list itself is asserted further down, over the panel snapshot's
  // `allChannels`. Adding a second, inline copy of that check here only perturbed
  // an unrelated request counter - the same "two ways to explain one result" trap
  // as the merge-rule fixtures.
  // The aggregate listing plus each unblocked channel that has its own route, and
  // every one of them must have been polled exactly once.
  //
  // What this guards is a channel being re-polled on the panel's ten-second cadence -
  // it is how TRAE's listing was caught being fetched every tick. A loop over the
  // counter rather than a written-out total, because how many routes are unblocked
  // is not a property of the code: WorkBuddy's gate walks fallback roots (the
  // plugin's parent, then the cwd), so it is open in a checkout holding a real
  // credential file and shut in the installed copy, whose parent is node_modules. A
  // number named for one of those locations failed in the other. "One call each" is
  // the part that holds everywhere.
  //
  // The loop is also the only thing covering a route with no assertion of its own -
  // TRAE has none, and neutering just this line left a re-polled TRAE green.
  //
  // ⚠️ `modelCalls` cannot stand in for the total. It and the per-path counter are
  // incremented on the same branch of the fake fetch, so "the total equals the sum
  // of the per-route counts" holds by construction; that form survived having its
  // right-hand side swapped for `modelCalls`.
  for (const [route, count] of Object.entries(modelCallsByPath)) {
    assert.equal(count, 1, `${route} must be polled once per discovery, not ${count} times`);
  }

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

  // kilo's variant keys are labels and the effort inside each one is the wire
  // value. Collapsing them sent the label: `reasoning_effort: "instant"`, which
  // kilo's validator refuses outright. The picker keeps naming the rung
  // `instant`/`thinking` because that is what kilo calls it.
  const variantResolved = await adapter.resolveModel('ai-proxy', 'kilo/poolside/laguna-s-2.1:free');
  assert.deepEqual(
    variantResolved.reasoning.efforts.map((effort) => effort.id),
    ['none', 'high'],
    'the wire value must be the effort kilo validates, not the variant name',
  );
  assert.deepEqual(
    variantResolved.reasoning.efforts.map((effort) => effort.name),
    ['instant', 'thinking'],
    'the picker keeps the variant name the upstream published',
  );
  assert.equal(variantResolved.reasoning.defaultEffort, 'high');

  // A channel that published no ladder gets no ladder. This used to hand every
  // silent model `off/low/high/max`, an invented table whose `off` is not in the
  // vocabulary kilo accepts at all.
  const silentResolved = await adapter.resolveModel('ai-proxy', 'kilo/silent-about-reasoning');
  assert.equal(
    silentResolved.reasoning,
    undefined,
    'no published ladder means no reasoning metadata, not an invented one',
  );

  // The rung the channel says applies when the caller names none is the one that
  // applies. Picking `high` regardless turned a model whose default is `off` into
  // one that thinks on every turn.
  const defaultedResolved = await adapter.resolveModel('ai-proxy', 'zen/default-off');
  assert.equal(defaultedResolved.reasoning.defaultEffort, 'off');
  assert.deepEqual(
    defaultedResolved.reasoning.efforts.map((effort) => effort.id),
    ['off', 'low', 'high'],
  );

  // One malformed model takes the whole provider group down: the harness resolves
  // every model with no per-item catch and drops the group on the first throw. So
  // the shape it validates is asserted for the whole roster, not for samples -
  // a single non-string effort id is exactly the failure a spot check misses.
  let checkedModels = 0;
  for (const model of models) {
    const resolvedModel = await adapter.resolveModel('ai-proxy', model.id);
    const reasoning = resolvedModel.reasoning;
    if (reasoning === undefined) continue;
    checkedModels += 1;
    assert.ok(reasoning.efforts.length > 0, `${model.id}: an empty ladder is rejected outright`);
    const ids = new Set();
    for (const effort of reasoning.efforts) {
      assert.equal(typeof effort.id, 'string', `${model.id}: effort id must be a string`);
      assert.notEqual(effort.id, '', `${model.id}: effort id must not be empty`);
      assert.equal(typeof effort.name, 'string', `${model.id}: effort name must be a string`);
      assert.notEqual(effort.name, '', `${model.id}: effort name must not be empty`);
      assert.equal(ids.has(effort.id), false, `${model.id}: duplicate effort "${effort.id}"`);
      ids.add(effort.id);
    }
    if (reasoning.defaultEffort !== undefined) {
      assert.equal(
        ids.has(reasoning.defaultEffort),
        true,
        `${model.id}: defaultEffort "${reasoning.defaultEffort}" is not in the ladder`,
      );
    }
  }
  assert.ok(checkedModels >= 4, 'the roster sweep must actually reach the models with a ladder');

  // The token meter reaches `adapter.imageRequestPricing(...)` during compaction.
  // That optional chain guards a route that is not registered, not a method that
  // does not exist - and this class is written from scratch rather than extending
  // the base adapter that supplies a default, so the call threw
  // 'imageRequestPricing is not a function' and a session that needed compacting
  // could not. Declaring no pricing is the honest answer; inventing a figure for an
  // upstream whose vision accounting is unknown is not.
  assert.equal(typeof adapter.imageRequestPricing, 'function');
  assert.equal(adapter.imageRequestPricing('ai-proxy', resolved.id), undefined);
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

  // A stream that ends properly but delivers nothing. This finished cleanly before,
  // and a clean finish with no blocks is exactly what the harness turns into
  // "Provider returned an empty response" - so the agent loop read a broken turn as
  // the model choosing to say nothing. Nothing was delivered, so a retry is safe.
  streamMode = 'done-empty';
  const doneEmptyEvents = [];
  for await (const event of adapter.stream({
    model: resolved.id,
    messages: [{ role: 'user', content: 'do the thing' }],
    maxTokens: 32,
  }, resolved)) doneEmptyEvents.push(event);
  const doneEmptyFinish = doneEmptyEvents.find((e) => e.type === 'finish');
  assert.equal(doneEmptyFinish?.reason?.kind, 'error', 'a stream that delivered nothing is not a clean stop');
  assert.equal(doneEmptyFinish?.reason?.failure?.code, 'TRANSPORT');
  assert.match(doneEmptyFinish?.reason?.failure?.message ?? '', /without delivering any content/);

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
  // ---- TRAE account routes ----
  //
  // Two things have to hold, and neither is visible from the panel side alone:
  // the account read must be a GET to /trae/v1/account, and the claim must be a
  // POST to /trae/v1/checkin that is not answered with a non-2xx. The proxy answers
  // a business failure with 200 on purpose - a 5xx would invite a caller to retry,
  // and replaying a claim is the one thing that must not happen on its own.
  const beforeAccount = traeAccountCalls;
  const traeStatus = await (async () => {
    let status = 0;
    let payload = '';
    await panelRoute.handler({ method: 'GET', url: '/api/ai-proxy-commandcode/trae/status', headers: { host: 'dsh.local' } }, {
      writeHead(value) { status = value; },
      end(value) { payload = value; },
    });
    assert.equal(status, 200);
    return JSON.parse(payload);
  })();
  assert.equal(traeAccountCalls, beforeAccount + 1, 'the status read must reach the proxy account route');
  assert.equal(traeStatus.configured, true);
  assert.equal(traeStatus.balanceKnown, true);
  assert.equal(traeStatus.balance.total, 500);
  assert.equal(traeStatus.checkin.checkedIn, false);
  assert.equal(traeStatus.checkin.credits, 100);
  // A token must never travel to the panel: this response is rendered.
  assert.equal('access_token' in traeStatus, false);
  assert.equal('refresh_token' in traeStatus, false);
  assert.equal('device_id' in traeStatus, false);

  const beforeCheckin = traeCheckinCalls;
  const traeClaim = await (async () => {
    let status = 0;
    let payload = '';
    await panelRoute.handler({ method: 'POST', url: '/api/ai-proxy-commandcode/trae/checkin', headers: { host: 'dsh.local' } }, {
      writeHead(value) { status = value; },
      end(value) { payload = value; },
    });
    assert.equal(status, 200);
    return JSON.parse(payload);
  })();
  assert.equal(traeCheckinCalls, beforeCheckin + 1, 'the button must actually claim');
  // WorkBuddy's account read, and the one thing the panel route must never do:
  // hand a credential back to a page that renders in a browser.
  const beforeWorkBuddy = workBuddyAccountCalls;
  const workBuddyStatusPayload = await (async () => {
    let sent;
    await panelRoute.handler({ method: 'GET', url: '/api/ai-proxy/workbuddy/status', headers: { host: 'dsh.local' } }, {
      writeHead(statusCode, headers) { sent = { statusCode, headers }; },
      end(body) { sent.body = body; },
    });
    return JSON.parse(sent.body);
  })();
  assert.equal(
    workBuddyAccountCalls,
    beforeWorkBuddy + 1,
    'the status read must reach the proxy account route',
  );
  assert.equal(workBuddyStatusPayload.configured, true);
  assert.equal(workBuddyStatusPayload.usable, true);
  assert.equal(workBuddyStatusPayload.models, 14);
  for (const secret of ['access_token', 'refresh_token', 'accessToken', 'refreshToken', 'token', 'credential']) {
    assert.equal(
      secret in workBuddyStatusPayload,
      false,
      `the account route must not answer with "${secret}"`,
    );
  }
  assert.equal(traeClaim.ok, true);
  assert.equal(traeClaim.credits, 100);
  // The balance rides along so the panel does not have to ask again and render a
  // different number than the one the claim just produced.
  assert.equal(traeClaim.balance.total, 600);

  // A throttled claim is still 200: the transport worked, the business did not.
  // The panel renders ok:false with the reason rather than showing a crash.
  traeCheckinOk = false;
  const throttledClaim = await (async () => {
    let status = 0;
    let payload = '';
    await panelRoute.handler({ method: 'POST', url: '/api/ai-proxy-commandcode/trae/checkin', headers: { host: 'dsh.local' } }, {
      writeHead(value) { status = value; },
      end(value) { payload = value; },
    });
    assert.equal(status, 200, 'a business failure must not be reported as a transport error');
    return JSON.parse(payload);
  })();
  assert.equal(throttledClaim.ok, false);
  assert.equal(throttledClaim.code, 9074);
  assert.equal(typeof throttledClaim.message, 'string');
  traeCheckinOk = true;
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
  // WorkBuddy's hold is the same shape for the same reason: the proxy reads a
  // credential file, so with no file the channel's listing answers 502 and the
  // panel renders a channel at zero instead of the command that would fix it.
  // Non-empty is the requirement, not mere existence.
  fs.writeFileSync(path.join(fixtureRoot, 'workbuddy-auth.json'), 'fixture');
  // Asked about the one directory this test controls. The gate itself resolves a
  // list of roots ending in the plugin's parent and the cwd, so inside a checkout
  // that holds real credentials it reads as open whatever happens here - asking
  // about one named root is the only form of the question a fixture can pin down.
  assert.ok(
    workBuddyCredentialIn(fixtureRoot),
    'the fixture must write a credential file the gate can see',
  );
  assert.equal(
    workBuddyCredentialIn(path.join(sandboxHome, 'no-such-project')),
    false,
    'a root without the file must not read as configured',
  );
  // A zero-byte file is what a half-written write leaves behind, and the listing
  // behind it answers 502 - which the panel renders as a channel at zero models.
  const emptyRoot = path.join(sandboxHome, 'empty-project');
  fs.mkdirSync(emptyRoot, { recursive: true });
  fs.writeFileSync(path.join(emptyRoot, 'workbuddy-auth.json'), '');
  assert.equal(
    workBuddyCredentialIn(emptyRoot),
    false,
    'a zero-byte credential file is not a credential',
  );
  const beforeEnabledWorkBuddyCalls = modelCallsByPath['/workbuddy/v1/models'] ?? 0;
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
  // The delta, not the cumulative total. The total also stood at 2 when this apply
  // skipped the gate entirely, because the plugin's parent directory is a
  // fallback root and this checkout holds a real credential file - so the absolute
  // count cannot tell a lifted hold from one that was never applied. A bump
  // *across this apply* is the part the fixture is responsible for.
  assert.equal(
    modelCallsByPath['/workbuddy/v1/models'] - beforeEnabledWorkBuddyCalls,
    1,
    'a channel whose credential file exists must be listed',
  );
  assert.ok(
    afterSwitch.some((model) => model.id.startsWith('workbuddy/')),
    'a captured credential must put WorkBuddy rows in the roster',
  );
  assert.ok(
    afterSwitch.some((model) => model.id.startsWith('deepseek-web/')),
    'enabling the channel must put its models in the roster',
  );
  disposeEnabled();

  // ── The listing gate ──────────────────────────────────────────────────────
  //
  // The Host builds a catalogue by calling `listModels()` once and then
  // `resolveModel()` once per model, concurrently. Both paths need the listing,
  // so without a gate one build costs one full aggregate read per model: 93
  // models here turned into 186 listing requests, every one of them a complete
  // `/v1/models` rather than one cheap answer.
  {
    let clock = 1000;
    const gate = new CatalogGate({ cooldownMs: 5000, now: () => clock });
    let loads = 0;
    const load = async () => { loads += 1; return [{ id: 'a' }]; };

    const concurrent = await Promise.all([gate.read(load), gate.read(load), gate.read(load)]);
    assert.equal(loads, 1, 'concurrent readers share one fetch');
    assert.equal(concurrent[2].length, 1, 'every caller gets the rows');

    await gate.read(load);
    assert.equal(loads, 1, 'a settled listing is reused inside the window');

    clock += 6000;
    await gate.read(load);
    assert.equal(loads, 2, 'the window expires and the proxy is asked again');

    // A failing read must not blank the catalogue, and must not be retried on
    // every model of the same build either.
    clock += 6000;
    await gate.read(async () => { throw new Error('proxy down'); });
    assert.deepEqual(gate.peek(), [{ id: 'a' }], 'the last known rows survive a failure');
    loads = 0;
    await gate.read(load);
    await gate.read(load);
    assert.equal(loads, 0, 'a failure opens a cooldown instead of retrying per model');

    // A forced refresh goes to the proxy even inside the window - this is the
    // panel's own poll, and it must be able to see what just changed.
    clock += 6000;
    gate.refresh();
    await gate.read(load);
    assert.equal(loads, 1, 'a forced refresh bypasses the window');

    // A loader that throws must not leave the gate wedged - a settled promise
    // stuck in the in-flight slot would answer every later read with nothing,
    // forever, with nothing logged. `cooldownMs: 0` with a frozen clock is what
    // makes this measurable: the cooldown cannot be what lets the next read
    // through, so reaching the loader again is the only explanation.
    //
    // The assertion counts loader reaches rather than comparing rows, because a
    // wedged gate and a working one can both answer with the same array once a
    // cooldown is in play. `overlapping` covers the case where the failed read is
    // still in flight when a second reader arrives.
    const racing = new CatalogGate({ cooldownMs: 0, now: () => 0 });
    let racingLoads = 0;
    const racingLoad = async () => { racingLoads += 1; return [{ id: 'fresh' }]; };
    await racing.read(() => { throw new Error('boom'); });
    assert.deepEqual(await racing.read(racingLoad), [{ id: 'fresh' }], 'a throwing load must still answer');
    await racing.read(racingLoad);
    assert.equal(racingLoads, 2, 'and the loader must be reachable again, not a stuck promise');

    // A reader that arrives while a *failing* read is in flight joins that read
    // rather than starting its own, so it gets no rows - correct dedupe, wrong
    // answer for that one caller. What matters is that it is bounded: with the
    // cooldown at zero the very next read has to reach the loader again. A gate
    // holding a settled promise answers every later read with nothing forever.
    const overlapping = new CatalogGate({ cooldownMs: 0, now: () => 0 });
    await Promise.allSettled([
      overlapping.read(() => { throw new Error('boom'); }),
      overlapping.read(async () => [{ id: 'a' }]),
    ]);
    assert.deepEqual(await overlapping.read(async () => [{ id: 'a' }]), [{ id: 'a' }], 'a failed read must not poison later reads');

    // `forget()` is the only way to drop the rows: `refresh()` deliberately keeps
    // them, so a failed panel poll falls back instead of blanking the catalogue.
    gate.forget();
    assert.equal(gate.peek(), undefined, 'forget drops the cached rows');
  }

  // The empty-listing rule belongs to `listModels`, not to the gate: the gate
  // caches whatever a loader returns, and the loader translates "no rows" into
  // "no answer" so a single bad read cannot retire every channel.
  {
    const empty = new AiProxyAdapter({
      runtime: new ProxyRuntime({ mode: 'external', externalUrl: 'http://127.0.0.1:8000/v1' }),
      provider: 'ai-proxy',
      basePath: '/v1',
    });
    const served = ['kilo/a', 'kilo/b'];
    let calls = 0;
    globalThis.fetch = async (input) => {
      if (!String(input).includes('/models')) return new Response('{}', { status: 200 });
      calls++;
      return new Response(JSON.stringify({ data: calls === 1 ? [] : served.map((id) => ({ id })) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const nothing = await empty.listModels();
    assert.deepEqual(nothing, [], 'an empty listing still answers with no rows');
    assert.equal(empty.catalogGate.peek(), undefined, 'but it is not cached as the roster');
    // And it opens the cooldown, so one empty answer is not retried per model -
    // the same rule that stops a dead proxy from being asked 93 times.
    const duringCooldown = await empty.listModels();
    assert.deepEqual(duringCooldown, [], 'an empty answer is not retried inside the cooldown');
    assert.equal(calls, 1, 'the cooldown suppressed the second request');
    // Once it expires the proxy is asked again and the roster comes back.
    empty.catalogGate.retryAt = 0;
    const recovered = await empty.listModels();
    assert.deepEqual(recovered.map((m) => m.id), served, 'after the window the listing is read again');
    assert.equal(calls, 2, 'and that read reached the proxy');
  }

  // Two channels must not share one cache. One gate holding tokenharbor's rows
  // answers deepseek-web's request with them, which produced 105 rows prefixed
  // twice over (`deepseek-web/deepseek-web/…`) the moment the gate was introduced.
  {
    const shared = new AiProxyAdapter({
      runtime: new ProxyRuntime({
        mode: 'external',
        externalUrl: 'http://127.0.0.1:8000/v1',
        hiddenChannels: ['cnb', 'openrouter'],
        channelKeys: { tokenharbor: 'test-tokenharbor-key' },
      }),
      provider: 'ai-proxy',
      basePath: '/v1',
      project: true,
    });
    assert.notEqual(
      shared.routeGate('tokenharbor'),
      shared.routeGate('deepseek-web'),
      'each channel needs its own gate',
    );
    assert.equal(shared.routeGate('tokenharbor'), shared.routeGate('tokenharbor'), 'and it is stable per channel');
  }

  // The groups have to be real, not just registered. Each provider is asked for
  // its own listing and must get only its own rows - one shared gate would answer
  // every group with the first one's, which presents as the same models repeated
  // under seven headings.
  //
  // Asked with a **bare string**, the way the Host's own registry calls it. Every
  // other call in this suite passes an options bag, a shape the Host never uses -
  // and a suite that only ever passes the bag cannot see a provider whose answer
  // is stamped for the wrong group. That is exactly how all seven groups failed at
  // once, with INVALID_CATALOG, while this suite stayed green.
  for (const group of registeredRoutes) {
    const listed = await adapter.listModels(group);
    const rows = listed ?? [];
    // The Host validates model.provider === provider and unique ids per listing.
    // Replayed here so this suite fails on the same rule the Host enforces.
    assert.deepEqual(
      rows.filter((model) => model.provider !== group).map((model) => model.id).slice(0, 3),
      [],
      `the Host rejects "${group}": rows must claim the provider they are listed under`,
    );
    assert.equal(
      new Set(rows.map((model) => model.id)).size,
      rows.length,
      `the Host rejects "${group}": duplicate ids in one listing`,
    );
    // A channel with nothing today still keeps its group: the switch has to
    // survive a channel that lists nothing, which is what the KNOWN_CHANNELS
    // baseline exists for.
    if (rows.length === 0) continue;
    const first = (id) => (id.includes('/') ? id.slice(0, id.indexOf('/')) : id);
    const channel = CHANNEL_GROUPS[group]?.channel;
    if (channel !== undefined) {
      assert.deepEqual(
        rows.filter((model) => first(model.id) !== channel).map((model) => model.id).slice(0, 3),
        [],
        `the "${group}" group must list only ${channel} models`,
      );
    }
  }
  // A group that answers with nothing renders as a heading with an empty list,
  // and every filter bug so far has presented exactly that way. So: whichever
  // channels the aggregate is actually serving, their groups must not be empty.
  // Read from the aggregate rather than assumed, so a channel that is genuinely
  // dormant today does not fail this.
  {
    // force on both reads: this compares two listings of one upstream, and a
    // cached side would silently compare different payloads (the fixture swaps
    // its /models body partway through, which is exactly how it surfaced).
    const served = new Set(
      (await adapter.listProjectModels({ provider: 'ai-proxy', force: true }))
        .map((model) => model.id.split('/')[0]),
    );
    for (const [gid, gg] of Object.entries(CHANNEL_GROUPS)) {
      const rr = await adapter.listModels(gid);
    }
    let checked = 0;
    for (const [id, group] of Object.entries(CHANNEL_GROUPS)) {
      if (!served.has(group.channel)) continue;
      checked += 1;
      // listProjectModels, not listModels: the extras-backed channels
      // (deepseek-web, trae, tokenharbor) are discovered on that path, so
      // listModels answers empty for them even when the group does show rows.
      const rows = (await adapter.listProjectModels({ provider: id, force: true })) ?? [];
      assert.ok(
        rows.length > 0,
        `the aggregate serves "${group.channel}", so group "${id}" must not be empty`,
      );
    }
    assert.ok(checked > 0, 'the fixture must serve at least one channel for this to mean anything');
  }
  // The extras discovery path is a second source of rows, so it has to be
  // checked separately - filtering only the aggregate listing is what let every
  // channel group answer with the whole proxy.
  for (const group of registeredRoutes) {
    const rows = await adapter.listProjectModels({ provider: group });
    if (rows.length === 0) continue;
    const first = (id) => (id.includes('/') ? id.slice(0, id.indexOf('/')) : id);
    const want = CHANNEL_GROUPS[group]?.channel;
    assert.deepEqual(
      want === undefined
        ? []
        : rows.filter((model) => first(model.id) !== want).map((model) => model.id).slice(0, 3),
      [],
      `listProjectModels("${group}") must not leak another channel's rows`,
    );
    assert.deepEqual(
      rows.filter((model) => model.provider !== group).map((model) => model.id).slice(0, 3),
      [],
      `listProjectModels("${group}") rows must claim that provider`,
    );
  }
  // Each group is a heading in the picker, so it needs its own label. Uniform
  // labels render as seven identically-titled sections - the exact complaint the
  // split was meant to fix, and it breaks nothing else, so nothing else catches it.
  {
    const labels = new Map();
    for (const group of registeredRoutes) {
      const info = adapter.providerInfo(group);
      assert.equal(info.id, group, `providerInfo("${group}") must report that provider`);
      labels.set(group, info.name);
    }
    assert.equal(
      labels.get('ai-proxy'),
      'ai-proxy',
      'the aggregate keeps its own heading',
    );
    const channelLabels = [...labels].filter(([g]) => g !== 'ai-proxy').map(([, n]) => n);
    assert.equal(
      new Set(channelLabels).size,
      channelLabels.length,
      `every channel group needs its own heading, got ${JSON.stringify(channelLabels)}`,
    );
    for (const [group, name] of labels) {
      if (group === 'ai-proxy') continue;
      assert.ok(
        name && name !== group,
        `the "${group}" heading must be a readable label, not the raw provider id`,
      );
    }
  }

  // And the aggregate still answers with everything, so a session that already
  // selected `ai-proxy/<channel>/<model>` keeps resolving to the same request.
  {
    const all = await adapter.listProjectModels({ provider: 'ai-proxy' });
    // The channels, not the provider ids: group ids are namespaced while model
    // ids still start with the bare channel name.
    const channels = Object.values(CHANNEL_GROUPS).map((group) => group.channel);
    const present = new Set(all.map((model) => model.id.split('/')[0]));
    assert.ok(
      channels.some((channel) => present.has(channel)),
      'the aggregate must still serve the channels',
    );
  }
  // NOTE: no assertion here covers `KNOWN_CHANNELS` for a channel that lists
  // nothing. The only existing loop is over channels the fixture *does* list, so
  // those also arrive through the roster - deleting one of them from
  // KNOWN_CHANNELS leaves this suite green (verified, not assumed). Covering it
  // needs a hidden set that excludes the channel, and BLOCKED_CHANNELS is
  // module-level state, so it takes a fresh apply() with its own registration.
  // Recorded in AGENTS.md rather than faked with an assertion that cannot fail.


  // The proxy route that answers /health/probe keeps its own copy of the channel
  // names, in main.ts. Two lists answering one question drift the moment a channel
  // is added to one side, and the failure is silent in the expensive direction: the
  // panel filters the unknown name away and then probes every channel, so the user
  // pays for a full roster of upstream calls while the channel they clicked stays
  // unprobed. Reading main.ts here is the only place the two can be compared.
  //
  // An installed plugin copy does not ship main.ts, so the comparison runs only
  // where the file is there; CI always runs it from the checkout. The keys are read
  // line by line and comments are dropped first: a commented-out channel must not
  // count, and a quoted key such as "deepseek-web" must.
  {
    const mainPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'main.ts',
    );
    if (fs.existsSync(mainPath)) {
      const source = fs.readFileSync(mainPath, 'utf8');
      const declaration = 'const channelPrefixes: Record<string, string> = {';
      const start = source.indexOf(declaration);
      assert.notEqual(start, -1, 'main.ts must still declare channelPrefixes');
      const end = source.indexOf('\n      };', start);
      assert.notEqual(end, -1, 'channelPrefixes must still be a plain object literal');
      const keys = source.slice(start, end).split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .map((line) => line.match(/^\s*(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*:/))
        .filter(Boolean)
        .map((match) => match[1] ?? match[2]);
      assert.ok(keys.length > 0, 'channelPrefixes must name at least one channel');
      assert.deepEqual(
        [...PROBE_CHANNELS].sort(),
        [...keys].sort(),
        'the panel probe list and the proxy probe route must name the same channels',
      );
    }
  }

  console.log('dsh bridge self-test ok');
} finally {
  globalThis.fetch = originalFetch;
}