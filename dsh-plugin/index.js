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
import { spawn as nodeSpawn } from 'node:child_process'

// The tunnel's command line is only observable at the spawn, and what it guards
// against is measured: run a named tunnel without `--config`, cloudflared warns
// "No ingress rules were defined" and answers **503 for every request** while
// reporting a healthy connection. Nothing downstream of that says 503, so a test
// that only reads the panel state passes with the flag missing. This seam lets
// the test read the argv; production never calls it.
let spawnOverride = null
function spawn(bin, args, options) {
  return spawnOverride ? spawnOverride(bin, args, options) : nodeSpawn(bin, args, options)
}
export function __setSpawnForTest(fn) {
  spawnOverride = fn
}
export function __getSpawnForTest() {
  return spawnOverride
}
import { fileURLToPath, pathToFileURL } from 'node:url'
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
// Slack left when fitting the request into the window, and the floor an output
// budget is never squeezed below.
const CONTEXT_HEADROOM_TOKENS = 2048;
const MIN_OUTPUT_TOKENS = 1024;
// What one image costs when the gateway cannot tell us. Vision pricing runs from
// roughly 1,100 tokens for a large photo to about 1,600 at high detail, and the
// exact figure depends on the model's tiling - so this is deliberately the high
// end, because under-counting here is what overflows the window.
const IMAGE_TOKEN_ESTIMATE = 1600;
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
/**
 * Every channel the proxy serves, listed so the panel can offer a switch for all
 * of them.
 *
 * Deriving this from the roster does not work. A channel that is switched on but
 * contributes no models - openrouter with no key, deepseek-web with no login state
 * - is in neither the roster nor the hidden list, so the control vanished the moment
 * it was turned on, and the only way to get it back was to edit settings.json by
 * hand. The set of channels the proxy serves does not depend on which of them
 * happen to answer today, so it is written down.
 */
const KNOWN_CHANNELS = [
  'commandcode',
  'cnb',
  // User-added OpenAI-compatible upstreams. One channel however many vendors are
  // configured: the prefix is a single static path segment, so a provider added in
  // the panel appears without restarting the Host (see the comment on
  // CUSTOM_CHANNEL below).
  'custom',
  'deepseek-web',
  'kilo',
  'openrouter',
  'tokenharbor',
  'trae',
  'workbuddy',
  'zen',
  'zlkpro',
];

const DEFAULT_HIDDEN_CHANNELS = [
  'openrouter',
  'deepseek-web',
  'cnb',
];

/**
 * One entry per channel that gets its own group in the model picker.
 *
 * The key is the registered provider id, and therefore also the first segment
 * of every model id that channel serves. The value is only the heading label.
 *
 * The Host groups its catalog strictly by provider id (`buildModelCatalog`)
 * and reads the heading from `providerInfo().name`, so this map is the
 * entire mechanism - the Host has no per-model grouping at all.
 *
 * @type {Record<string, string>}
 */
export const CHANNEL_GROUPS = {
  'ai-proxy-commandcode': { channel: 'commandcode', label: 'CommandCode' },
  'ai-proxy-cnb': { channel: 'cnb', label: 'CNB' },
  'ai-proxy-deepseek-web': { channel: 'deepseek-web', label: 'DeepSeek 网页端' },
  'ai-proxy-kilo': { channel: 'kilo', label: 'Kilo' },
  'ai-proxy-tokenharbor': { channel: 'tokenharbor', label: 'TokenHarbor' },
  'ai-proxy-trae': { channel: 'trae', label: 'TRAE' },
  'ai-proxy-workbuddy': { channel: 'workbuddy', label: 'WorkBuddy' },
  'ai-proxy-zen': { channel: 'zen', label: 'Zen' },
  'ai-proxy-zlkpro': { channel: 'zlkpro', label: 'ZLK Pro' },
  // One group for every user-added upstream. Registering one provider per vendor
  // is impossible without a Host restart: the Host builds its catalog once per
  // generation and this map is read at `apply()` time, so a vendor added in the
  // panel would not have a provider to appear under. A single shared group trades
  // per-vendor headings for zero restarts, and the model rows still carry the
  // vendor name (`custom/<vendor>/<model>`).
  'ai-proxy-custom': { channel: 'custom', label: '自定义供应商' },
};

/**
 * The channel a model id belongs to: the segment before the first slash.
 *
 * Not a shape guess. `deepseek/test` is a model family and
 * `kilo/openrouter/free` is a Kilo model that merely names a vendor, so
 * a leading segment names a channel only when it is one we wrote down.
 *
 * @param modelId a possibly prefixed model id
 * @returns the leading segment
 */
function channelOf(modelId) {
  const id = String(modelId ?? '');
  return id.includes('/') ? id.slice(0, id.indexOf('/')) : id;
}

/**
 * The channels the user has switched off, which the panel owns.
 *
 * Kept as a module-level set because `isBlockedModelId` is a free function reached
 * from the roster builder and the call path, and threading a list through both
 * would only add a way for them to disagree. `applyHiddenChannels` replaces the
 * contents rather than mutating a shared array, so a read in progress keeps
 * seeing one consistent set.
 *
 * **Starts empty, not at the defaults.** The Host builds its model catalog once
 * per generation and does it as soon as the plugin loads - before `loadSettings`
 * has had its say. Seeding this with `DEFAULT_HIDDEN_CHANNELS` meant that window
 * judged cnb (and the other defaults) as switched off, and the Host does not
 * rebuild a catalog: measured 2026-10-05, a session opened right after a restart
 * got `CONFIG_DISABLED / cnb needs a login cookie` while the panel and
 * `settings.json` both showed cnb enabled and `/panel` reported
 * `blockedModelCount: 0`. The list that governs calls is the stored one, so the
 * stored one is what it waits for; nothing is more reachable than before, because
 * `loadSettings()` runs during `apply()` and every caller is downstream of it.
 */
const BLOCKED_CHANNELS = new Set();

function applyHiddenChannels(value) {
  const next = Array.isArray(value)
    ? value.map((entry) => String(entry ?? '').trim().toLowerCase()).filter(Boolean)
    : DEFAULT_HIDDEN_CHANNELS;
  BLOCKED_CHANNELS.clear();
  for (const channel of new Set(next)) BLOCKED_CHANNELS.add(channel);
  return [...BLOCKED_CHANNELS];
}

/** Why a channel is withheld, so the refusal can say something true. */
// Only channels the proxy really serves belong here. anthropic and gemini were
// removed as providers, so an entry for either could never be reached: a block
// reason is looked up by the first path segment, and nothing routes those two.
const BLOCK_REASON = {
  openrouter:
    'this channel needs a per-user upstream key and is not served by ai-proxy',
  'deepseek-web': 'this channel is switched off in the ai-proxy panel',
  cnb: 'cnb needs a login cookie; paste one into cnb-login.txt to re-enable it',
  trae: 'TRAE needs a captured credential; run deno run -A .tmp-trae-login.ts to capture one',
  workbuddy:
    'WorkBuddy needs a captured credential; run deno run -A .tmp-workbuddy-login.ts to capture one',
};

/** Fallback text for a channel the user switched off that has no specific reason. */
const GENERIC_BLOCK_REASON = 'this channel is switched off in the ai-proxy panel';

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
  // tokenharbor is a keyed channel that currently has no way to be given one:
  // upstream answers 401, and its own filterModels drops every model whose id does
  // not end in `:free`, so the 401 becomes an empty list rather than an error. That
  // is why the panel shows it at zero. The honest fix is a key field of its own -
  // openrouter's would be the wrong key - and until then the zero is a masked 401
  // rather than a channel with nothing in it.
  { prefix: 'tokenharbor', basePath: '/tokenharbor/v1', requiresKey: true },
  // Gated on the login state by listProjectModels, for the reason stated there.
  { prefix: 'deepseek-web', basePath: '/deepseek-web/v1', requiresDeepseekLogin: true },
  // TRAE is listed from the account's own remote catalog, which the proxy serves
  // on this prefix. It is not an aggregate-only channel, so it needs its own
  // panel listing like deepseek-web does - otherwise the panel shows a channel the
  // picker has never heard of, which is the mismatch this list exists to prevent.
  { prefix: 'trae', basePath: '/trae/v1' },
  // WorkBuddy is listed from the account's remote catalog, exactly like TRAE, and
  // for the same reason: the panel must not show a channel the picker has never
  // heard of. `requiresCredential` keeps it out of the panel until the login script
  // has run - a listing with no credential behind it answers 502, which renders as
  // an empty channel rather than as the instruction to run the script.
  { prefix: 'workbuddy', basePath: '/workbuddy/v1', requiresCredential: true },
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
  // Static here even though the vendors behind it are not: the *route* is a fixed
  // path segment, and this table answers "how is an id of this shape addressed".
  // Leaving it out would make every custom id fall through to the default route,
  // so a call would be sent to the aggregate with a vendor id the proxy cannot
  // resolve - a 404 for a model the panel just offered.
  { prefix: 'custom', basePath: '/custom/v1' },
];

function blockReasonFor(modelId) {
  const id = String(modelId ?? '');
  const channel = (id.includes('/') ? id.slice(0, id.indexOf('/')) : id).toLowerCase();
  // A channel the user switched off from the panel has no entry here, and the
  // reason must not imply a per-user key is what is missing.
  return BLOCK_REASON[channel] ?? (BLOCKED_CHANNELS.has(channel) ? GENERIC_BLOCK_REASON : `${channel} is not served by ai-proxy`);
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
// `minimal` sits below `low`, and the Zen catalog publishes it for muse spark.
// `none` is kilo's spelling for the same choice `off` names elsewhere - it is what
// the `instant` variant actually puts on the wire - so it sorts next to `off`.
const EFFORT_ORDER = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Keep the efforts a channel actually published, in ladder order.
 *
 * Both spellings reach here, and reading only one broke the provider outright.
 * CommandCode publishes bare strings (`["off","high","max"]`); the Zen models
 * endpoint publishes objects (`[{id, name}]`, the shape `/v1/models` documents for
 * `reasoning_efforts`). Filtering for strings alone returned an empty set for
 * every Zen model, and an empty `efforts` array is rejected by the harness with
 * `INVALID_MODEL_REASONING` - the whole `ai-proxy` provider failed to load over a
 * shape difference, not a capability problem.
 *
 * CommandCode models do not all offer the same rungs (some publish only
 * off/high/max), and offering one a channel never advertised produced the
 * harness's duplicate-effort rejection. An id outside this order is kept after
 * the ordered ones instead of being dropped: the ladder is what the upstream
 * said, not what this table expected.
 *
 * The id and the name are two different facts. The harness persists and sends the
 * `id`; the picker shows the `name`. kilo is the reason they can differ: its
 * variants are called `instant`/`thinking` while the effort they put on the wire is
 * `none`/`high`. Collapsing the two sent the variant's *name* as the effort, which
 * kilo's own validator rejects - see `publishedEfforts`.
 *
 * A channel that published nothing gets no ladder at all rather than a table this
 * file made up. Inventing one was the "hardcoded four rungs for every model" the
 * metadata normalisation was supposed to have removed, and the invented rungs were
 * not even the vocabulary the upstream accepts.
 */
function pickEfforts(published) {
  if (!Array.isArray(published) || published.length === 0) return [];
  const seen = new Set();
  const publishedOrder = [];
  const names = new Map();
  for (const value of published) {
    const id = typeof value === 'string'
      ? value
      : isRecord(value) && typeof value.id === 'string'
      ? value.id
      : '';
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    publishedOrder.push(id);
    const name = isRecord(value) && typeof value.name === 'string' && value.name !== ''
      ? value.name
      : id;
    names.set(id, name);
  }
  const ordered = EFFORT_ORDER.filter((effort) => seen.has(effort));
  const unordered = publishedOrder.filter((id) => !EFFORT_ORDER.includes(id));
  return [...ordered, ...unordered].map((id) => ({ id, name: names.get(id) ?? id }));
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
  if (parsed.length > 0) return parsed;
  // A fifth spelling, and a boolean rather than a list: StepFun says
  // `enable_vision_input: true` on a row that has no modality field at all, so
  // `step-3.7-flash` and `step-5-preview` were read as text-only. The gate is not
  // cosmetic - the adapter refuses to attach `image_url` for a model whose
  // `inputModalities` lacks `image`, so a vision-capable upstream silently dropped
  // every image the user sent.
  if (row.enable_vision_input === true) return ['text', 'image'];
  return ['text'];
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
      // `max_input_tokens` is StepFun's spelling of the same fact, and it is the one
      // that actually constrains a request: `step-3.7-flash` advertises 262144 there
      // while the fallback below would have claimed 1000000. `clampOutputBudget`
      // divides by this number when narrowing `max_tokens`, so an inflated window
      // means an under-clamped request and an upstream 400 - the same class of
      // failure as the 524288-output row in AGENTS.md, arriving through a field that
      // was never read rather than through a wrong value.
      ['contextWindow', 'context_window', 'context_length', 'max_input_tokens'],
      readNumber(upstream, ['context_window', 'context_length'], 1000000),
    ),
    maxTokens: readNumber(
      row,
      ['maxTokens', 'max_tokens', 'max_output_tokens', 'max_completion_tokens'],
      readNumber(upstream, ['max_output_tokens', 'max_completion_tokens'], DEFAULT_MAX_TOKENS),
    ),
    inputModalities: modalities,
    reasoningEfforts: publishedEfforts(row),
    // deepseek-web states which rung it uses when the caller names none
    // (`off` for the fast model, `high` for the reasoner, and each `-off/-low/…`
    // variant pins one). Choosing one here instead overrode that: a model whose
    // published default is `off` was silently made to think.
    defaultReasoningEffort: readDefaultEffort(row),
  };
}

function readDefaultEffort(row) {
  for (const key of ['defaultReasoningEffort', 'default_reasoning_effort']) {
    const value = row[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  // The nested spelling. workbuddy publishes the whole ladder as one object -
  // `reasoning: { efforts: [{id,name}], defaultEffort }` - so the default sits one
  // level below the two flat spellings above and was never read. `publishedEfforts`
  // already walks into that object for the rungs; this reader did not, so every
  // workbuddy model came back with a full ladder and no default.
  //
  // The consequence is not cosmetic: `resolveModel` falls back to `high` when the
  // published default is unknown, so `space-bunny` - which declares `max` - was
  // silently downgraded on every turn. Same failure as the deepseek-web one this
  // reader was written for, arriving through a nested key instead of a flat one.
  if (isRecord(row.reasoning)) {
    const nested = row.reasoning.defaultEffort ?? row.reasoning.default_effort;
    if (typeof nested === 'string' && nested !== '') return nested;
  }
  return undefined;
}

/**
 * The reasoning ladder the upstream actually published.
 *
 * Two shapes carry it, and reading only one made kilo look like it had no ladder
 * at all. kilo puts the rungs in `opencode.variants` - one entry per rung, each
 * naming its effort:
 *
 *   opencode: { variants: { low: { reasoning: { enabled, effort } }, ... } }
 *
 * so `space-bunny-alpha` published low/medium/high/xhigh/max and this code saw
 * nothing, fell through to the fallback table, and published off/low/high/max
 * instead: an `off` the upstream never offered, and no `medium` or `xhigh` at all.
 * 16 of kilo's 18 models carry the field.
 *
 * Both shapes feed one reader, and `pickEfforts` dedupes them, so a gateway that
 * publishes both loses nothing.
 *
 * The variant's key and its `reasoning.effort` are two different facts and only
 * one of them is the wire value. kilo calls the rungs `instant`/`thinking` and
 * `low`/`medium`/…; the effort each one sends is `none`/`high`/`low`/…. Publishing
 * the key sent `reasoning_effort: "instant"`, which the gateway's own validator
 * refuses - measured against Poolside and Cohere it answers
 * `reasoning_effort: Invalid option: expected one of
 * "max"|"xhigh"|"high"|"medium"|"low"|"minimal"|"none"` in ~400 ms, so every turn
 * on those models failed. The variant's own `enabled: false` is not a missing rung
 * either: it is the rung that turns reasoning off (`instant`/`none`), and dropping
 * it removed the only no-thinking option from half the catalogue.
 */
function publishedEfforts(row) {
  const sources = [];
  if (Array.isArray(row.reasoningEfforts)) sources.push(row.reasoningEfforts);
  if (Array.isArray(row.reasoning_efforts)) sources.push(row.reasoning_efforts);
  // A third shape: `{reasoning: {efforts: [{id, name}], defaultEffort}}`, which is
  // the one `/v1/models` documents. Reading only the flat spellings made every
  // model served under that shape lose its whole ladder - TRAE all 20 rows had
  // `reasoning` in the response and the panel showed no Effort control at all.
  // Same failure as the kilo one, one level deeper: a field that is present and
  // simply never looked at.
  if (isRecord(row.reasoning) && Array.isArray(row.reasoning.efforts)) {
    sources.push(row.reasoning.efforts);
  }
  // A fourth shape, and the one a user-configured upstream is most likely to speak:
  // StepFun publishes `reasoning_effort_support_list: ["low","high","medium"]` on
  // each row alongside `enable_reason`. It is not a spelling this reader knew, so
  // every `custom/step/*` model lost its whole ladder and the picker showed no
  // Effort control - the same "field is present and simply never looked at" failure
  // as the three above, on a channel whose listing had no mapping layer at all to
  // rewrite the field into a known name.
  //
  // A custom vendor is why this cannot be solved by normalising upstreams into one
  // spelling: the whole point of that channel is that the user pastes an arbitrary
  // OpenAI-compatible base URL, so the reader has to know the names in the wild
  // rather than the names this project happens to emit.
  //
  // Note the values are accepted verbatim. StepFun does not reject an unknown
  // `reasoning_effort` - measured `off` and `none`, neither of which it advertises,
  // and it answered 200 to both - so the ladder cannot be discovered by probing and
  // must come from this field. Publishing only what it lists is therefore the only
  // honest source; anything else would be this file inventing rungs.
  if (Array.isArray(row.reasoning_effort_support_list)) {
    sources.push(row.reasoning_effort_support_list);
  }
  const variants = isRecord(row.opencode) ? row.opencode.variants : undefined;
  if (isRecord(variants)) {
    // `{id, name}`: id is the effort kilo validates, name is the variant it shows.
    // A variant that carries no effort falls back to its own key, which is what
    // the field looked like before this reader existed.
    sources.push(Object.entries(variants).map(([key, variant]) => {
      const reasoning = isRecord(variant) && isRecord(variant.reasoning) ? variant.reasoning : undefined;
      const effort = typeof reasoning?.effort === 'string' && reasoning.effort !== ''
        ? reasoning.effort
        : key;
      return { id: effort, name: key };
    }));
  }
  // cnb publishes no ladder at all - its /models is a static array with no
  // reasoning metadata (src/cnb.ts:CNB_MODELS). Without this the picker shows no
  // Effort control and every request goes out at the default, which is how "off"
  // came to be sent as `high` for so long.
  //
  // The rungs are **measured, not copied**: each one was sent to the real upstream
  // on 2026-10-06 and observed. `off` produced 0 reasoning characters, the rest
  // produced 80-144, and an unsupported value got
  // `400 code 11150 the reasoning effort value is not supported by the current
  // model` - so the upstream validates, which is what makes this table usable.
  // A ladder this way is only honest when the upstream rejects what it does not
  // accept; where it silently accepts anything (StepFun, above) the published
  // field is the only source.
  const channel = String(row.provider ?? row.owned_by ?? '').toLowerCase();
  if (channel === 'cnb') {
    return [
      { id: 'off', name: 'off' },
      { id: 'minimal', name: 'minimal' },
      { id: 'low', name: 'low' },
      { id: 'medium', name: 'medium' },
      { id: 'high', name: 'high' },
      { id: 'max', name: 'max' },
      { id: 'xhigh', name: 'xhigh' },
    ];
  }
  return sources.length > 0 ? sources.flat() : undefined;
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
  // A stored file with no `hiddenChannels` predates the panel switches, so the
  // defaults apply and nothing that was reachable becomes reachable by accident.
  hiddenChannels: DEFAULT_HIDDEN_CHANNELS,
  channelKeys: {},
  // User-added OpenAI-compatible upstreams. Shapes are validated on write and again
  // on read (the file is editable outside the panel); the proxy re-validates a third
  // time because it is the process that actually spends the credential.
  customProviders: [],
  customKeys: {},
  // ---- cloudflared tunnel ----
  //
  // Off by default, and deliberately so: this is the one setting on the card that
  // makes the proxy reachable from the public internet, so it is opt-in rather than
  // started because a path happened to exist.
  tunnelEnabled: false,
  // Empty means "find cloudflared the same way restart.ps1 does" - PATH first, then
  // the Program Files location the installer uses. Stored only when the user
  // overrides it.
  cloudflaredPath: '',
  // The Worker whose BACKEND_URL secret is pointed at the tunnel. Empty skips the
  // Worker step entirely rather than guessing a name: writing a secret to the wrong
  // Worker is worse than not writing one.
  workerName: '',
  tunnelUrl: '',
  // 'quick' is the account-less trycloudflare tunnel. 'named' uses a tunnel
  // created with `cloudflared tunnel login` + `cloudflared tunnel create`, which
  // is the only way out of the quick tunnel's rate limit: measured 2026-10-05,
  // several starts in one day got `quick tunnel provisioning failed with status
  // 429: error code: 1015` and cloudflared then printed nothing at all.
  tunnelMode: 'quick',
  // The named tunnel to run. Required when tunnelMode is 'named'.
  tunnelName: '',
};

/**
 * Channels the panel can supply a key for, with the variable the proxy reads it
 * from.
 *
 * One entry per upstream. They used to share `DEFAULT_BEARER_TOKEN`, which means a
 * key for one silently becomes the key for the other - the failure is a 401 at the
 * second channel with nothing in the logs to explain it. `envToken` on the provider
 * is the same name, so the two sides cannot drift.
 */
const KEYED_CHANNELS = [
  { channel: 'openrouter', envToken: 'OPENROUTER_API_KEY' },
  { channel: 'tokenharbor', envToken: 'TOKENHARBOR_API_KEY' },
  { channel: 'zlkpro', envToken: 'ZLKPRO_API_KEY' },
];

/**
 * Environment for the proxy process, carrying the keys the panel collected.
 *
 * The proxy reads credentials from the environment and nothing else, so a value
 * typed into the panel has to arrive here to reach an upstream. Empty values are
 * left out entirely rather than exported as empty strings: an empty variable is
 * falsy to the consumer either way, but exporting it would override a real value the
 * process inherited from its own environment.
 */
export function credentialEnv(settings) {
  const env = {};
  for (const entry of KEYED_CHANNELS) {
    const value = settings.channelKeys?.[entry.channel];
    if (typeof value === 'string' && value.trim() !== '') {
      env[entry.envToken] = value.trim();
    }
  }
  // The whole custom table travels as one JSON document, because the proxy cannot
  // read settings.json - it only sees the environment. The list is empty rather
  // than absent when nothing is configured, so the proxy can tell "no custom
  // channel set up" from "this variable was never injected".
  //
  // Only the settings half travels here. The file half reaches the proxy by the
  // proxy reading it, and injecting it too would send the same configuration twice
  // - with the environment copy winning on any later edit to the file, which is
  // the opposite of what a file-backed source should do.
  env.AI_PROXY_CUSTOM_PROVIDERS = JSON.stringify(mergeCustomSources(settings).settingsProviders);
  return env;
}

/**
 * The name a custom upstream is addressed by, and the same rule the proxy enforces.
 *
 * It is a URL path segment, so it is validated as one. This is duplicated with
 * src/custom.ts on purpose rather than shared: the two live in different runtimes
 * (Node plugin vs Deno proxy) and the panel must reject a bad name *before* it is
 * written, not after the proxy refuses it silently at call time.
 */
const CUSTOM_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;

/** Why a vendor entry was refused, so the panel can say which and why. */
function customProviderProblem(entry) {
  if (!isRecord(entry)) return 'not an object';
  const name = String(entry.name ?? '').trim().toLowerCase();
  if (!CUSTOM_NAME_PATTERN.test(name)) {
    return 'name must be lowercase letters, digits, dot, dash or underscore (max 32)';
  }
  const raw = String(entry.baseUrl ?? '').trim().replace(/\/+$/, '');
  let url;
  try { url = new URL(raw); } catch { return 'baseUrl is not a URL'; }
  // Loopback http is allowed so a locally hosted upstream works; anything else in
  // the clear would put the credential and the conversation on the wire in plaintext.
  const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    return 'baseUrl must be https (http is allowed only for loopback)';
  }
  return null;
}

/**
 * Normalise the stored list into what the proxy is given.
 *
 * Invalid entries are dropped here rather than forwarded: the proxy would reject
 * them too, but by then the user has only a channel that silently lost a vendor.
 */
export function customProvidersForEnv(settings) {
  return mergeCustomSources(settings).providers;
}

/**
 * 两个来源合成的全貌：每条来自哪里、谁被谁盖了、文件有没有坏。
 *
 * 语义与代理侧 src/custom.ts 的 mergeCustomSources 一致——**同名时环境赢**。
 * 两边必须一致，否则面板显示的和代理实际用的会不一样，而这正是上一版的毛病。
 * 这边不需要重复实现优先级，因为插件本来就是把 settings 那份**注入成环境**的：
 * 文件通过 env 之外的另一条路到达代理，代理自己再合并一次。所以这里只需要
 * 按同一规则算出「面板该显示什么」。
 */
export function mergeCustomSources(settings) {
  const rows = Array.isArray(settings?.customProviders) ? settings.customProviders : [];
  const keys = isRecord(settings?.customKeys) ? settings.customKeys : {};
  const root = resolveProjectRoot(settings ?? {});
  const file = readCustomProviderFile(root);

  const providers = [];
  const origin = {};
  const seen = new Set();
  const rejected = [];

  for (const entry of rows) {
    const problem = customProviderProblem(entry);
    if (problem !== null) {
      rejected.push({ name: String(entry?.name ?? '(unnamed)'), reason: problem, source: 'settings' });
      continue;
    }
    const normalized = normalizeCustomEntry(entry, keys);
    if (seen.has(normalized.name)) {
      rejected.push({ name: normalized.name, reason: 'duplicate name', source: 'settings' });
      continue;
    }
    seen.add(normalized.name);
    providers.push(normalized);
    origin[normalized.name] = 'env';
  }

  const shadowed = [];
  const fileProviders = [];
  for (const row of file.rows) {
    if (row.rejected !== undefined) {
      rejected.push({ name: row.name, reason: row.rejected, source: 'file' });
      continue;
    }
    if (seen.has(row.name)) {
      // 代理侧也是这个规矩：环境那份是进程启动时显式给的，文件是持久化的默认值。
      shadowed.push(row.name);
      continue;
    }
    seen.add(row.name);
    // 文件里的条目**不进 providers**：它不该被注入环境变量，否则会把同一份配置
    // 送给代理两次（代理自己会读那个文件）。它只用于面板显示。
    fileProviders.push(row);
    origin[row.name] = 'file';
  }

  return {
    providers: [...providers, ...fileProviders],
    settingsProviders: providers,
    fileProviders,
    origin,
    shadowed,
    rejected,
    file: { path: customFilePath(root), exists: file.exists, error: file.error },
  };
}
/**
 * 项目目录里的供应商文件，与代理侧读的是同一个。
 *
 * 为什么插件也要读它：代理有两个配置来源（环境变量 + custom-providers.json），
 * 而插件只认识 settings.json。于是手写文件配的供应商**代理能用、面板与选择器却
 * 完全看不到**——两个界面自相矛盾，正是这个项目反复在删的那类故障。
 *
 * 路径必须与代理一致：那是**工作目录**下的相对路径，而代理由本插件以
 * projectRoot 为 cwd 启动（见 ProxyRuntime.start）。所以这里也按 projectRoot 取，
 * 而不是插件自身所在目录。
 */
const CUSTOM_FILE_NAME = 'custom-providers.json';

function customFilePath(root) {
  return root === '' ? '' : path.join(root, CUSTOM_FILE_NAME);
}

/**
 * 读文件并按代理的语义解析出供应商数组。
 *
 * 按 mtime 缓存：面板每 10 秒拉一次快照，而文件几乎不变。**但必须每请求 stat**
 * ——用户保存文件后要立刻看到，这正是文件这条路径相对面板的好处。
 */
const customFileCache = { path: '', mtime: -1, rows: [], error: null, exists: false };

function readCustomProviderFile(root) {
  const file = customFilePath(root);
  if (file === '') {
    customFileCache.path = '';
    customFileCache.exists = false;
    customFileCache.rows = [];
    customFileCache.error = null;
    return customFileCache;
  }
  let stamp = -1;
  try {
    stamp = fs.statSync(file).mtimeMs;
  } catch {
    // 文件不存在是常态（插件那条路把它注入环境变量），不是错误。
    customFileCache.path = file;
    customFileCache.mtime = -1;
    customFileCache.rows = [];
    customFileCache.error = null;
    customFileCache.exists = false;
    return customFileCache;
  }
  if (customFileCache.path === file && customFileCache.mtime === stamp) return customFileCache;
  let rows = [];
  let error = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    // 两种顶层形状都认，与 src/custom.ts 的 customFileTextToEnvText 一致。
    const list = Array.isArray(parsed) ? parsed : (isRecord(parsed) && Array.isArray(parsed.providers) ? parsed.providers : null);
    if (list === null) {
      error = 'expected an array, or an object with a providers array';
    } else {
      for (const entry of list) {
        const problem = customProviderProblem(entry);
        if (problem === null) {
          rows.push(normalizeCustomEntry(entry, {}));
        } else {
          rows.push({ name: String(entry?.name ?? '(unnamed)'), rejected: problem });
        }
      }
    }
  } catch (reason) {
    error = reason instanceof Error ? reason.message : String(reason);
  }
  customFileCache.path = file;
  customFileCache.mtime = stamp;
  customFileCache.rows = rows;
  customFileCache.error = error;
  customFileCache.exists = true;
  return customFileCache;
}

/** 一条合法条目 → 注入/展示用的规范形状。settings 与文件共用。 */
function normalizeCustomEntry(entry, keys) {
  const name = String(entry.name).trim().toLowerCase();
  const key = typeof entry.apiKey === 'string' && entry.apiKey.trim() !== ''
    ? entry.apiKey.trim()
    : (typeof keys[name] === 'string' ? keys[name].trim() : '');
  return {
    name,
    baseUrl: String(entry.baseUrl).trim().replace(/\/+$/, ''),
    ...key !== '' ? { apiKey: key } : {},
    ...typeof entry.authHeader === 'string' && entry.authHeader.trim() !== ''
      ? { authHeader: entry.authHeader.trim() }
      : {},
    ...typeof entry.label === 'string' && entry.label.trim() !== ''
      ? { label: entry.label.trim() }
      : {},
    enabled: entry.enabled !== false,
  };
}
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
  // Applied on load so a stored choice survives a restart, and normalised here
  // rather than trusted: the file is editable outside the panel.
  const hiddenChannels = applyHiddenChannels(merged.hiddenChannels);
  return {
    ...merged,
    mode: merged.mode === 'external' ? 'external' : 'local',
    port: Number.isSafeInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT,
    hiddenChannels,
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

/**
 * The three files a capture writes, and where their originals are kept.
 *
 * `.bak` is already in .gitignore. The point is not tidiness: a capture that dies
 * after writing the cookie but before the token leaves a set that passes every
 * presence check while being useless, and nothing in the panel can tell the
 * difference - so the originals go back.
 */
const DEEPSEEK_STATE_FILES = ['deepseek-cookies.txt', 'deepseek-auth.txt', 'deepseek-headers.json'];

/**
 * Copy the current state aside. Returns how many files were there to copy.
 *
 * These return what they did rather than logging it. A `record` callback passed in
 * unbound arrives with no `this`, and the first call throws on `this.logs` - which
 * takes the whole route down with it.
 */
function backUpDeepseekState(root) {
  let copied = 0;
  for (const name of DEEPSEEK_STATE_FILES) {
    try {
      fs.copyFileSync(path.join(root, name), path.join(root, `${name}.bak`));
      copied += 1;
    } catch {
      // Absent or unreadable: nothing to preserve for this one.
    }
  }
  return copied;
}

/** Put the originals back after a capture that did not complete. */
function restoreDeepseekState(root) {
  let restored = 0;
  for (const name of DEEPSEEK_STATE_FILES) {
    const backup = path.join(root, `${name}.bak`);
    try {
      fs.copyFileSync(backup, path.join(root, name));
      fs.rmSync(backup, { force: true });
      restored += 1;
    } catch {
      // No backup, so there was nothing to keep.
    }
  }
  return restored;
}

/** Drop the copies once a capture has completed and the new files are the good ones. */
function dropDeepseekBackups(root) {
  for (const name of DEEPSEEK_STATE_FILES) {
    try {
      fs.rmSync(path.join(root, `${name}.bak`), { force: true });
    } catch {
      // Nothing to remove.
    }
  }
}

/**
 * Whether deepseek-web has the three files it reads, and which are missing.
 *
 * It is a logged-in web channel, not an API-key channel: the proxy reads a cookie,
 * a bearer token and a captured browser header set from the project directory. So
 * the panel's job is to say which of the three is absent and offer to run the
 * capture, rather than offering a key field that would not help.
 */
function deepseekWebStatus(settings) {
  const roots = projectCandidates(settings);
  const wanted = [
    { file: 'deepseek-cookies.txt', what: 'cookie' },
    { file: 'deepseek-auth.txt', what: 'bearer token' },
    { file: 'deepseek-headers.json', what: 'browser headers' },
  ];
  const found = [];
  const missing = [];
  for (const entry of wanted) {
    const present = roots.some((root) => {
      try {
        return fs.statSync(path.join(root, entry.file)).size > 0;
      } catch {
        return false;
      }
    });
    (present ? found : missing).push(entry.what);
  }
  return { configured: missing.length === 0, found, missing };
}

/**
 * Whether the WorkBuddy credential file exists and is non-empty.
 *
 * Not read-and-parsed on purpose: the proxy is the one that owns the token, and a
 * truncated or half-written file is exactly the state where a second reader would
 * produce a second verdict. The panel's job is only to decide whether to offer the
 * channel at all.
 */
function workBuddyStatus(settings) {
  return { configured: hasWorkBuddyCredentialFile(settings) };
}

/**
 * One directory's answer: does it hold a non-empty WorkBuddy credential file?
 *
 * Exported and root-scoped on purpose. `projectCandidates` ends in fallbacks
 * (the plugin's parent directory, the cwd), so inside a checkout that holds real
 * credentials the *gate* reads as open regardless of what any fixture does - and
 * an assertion written against the gate then proves nothing. Asking about one
 * named root is the only form of the question a test can actually control.
 */
export function workBuddyCredentialIn(root) {
  try {
    return fs.statSync(path.join(root, 'workbuddy-auth.json')).size > 0;
  } catch {
    return false;
  }
}

function hasWorkBuddyCredentialFile(settings) {
  return projectCandidates(settings).some(workBuddyCredentialIn);
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

/**
 * The hostnames the Worker serves, from `wrangler.jsonc`'s routes.
 *
 * `custom_domain` routes are the ones that matter: Cloudflare refuses to let a
 * hostname be both a Worker custom domain and a tunnel route, so a hostname in
 * this set can never be the tunnel's address. That makes this list the authority
 * for "which hostname must not become BACKEND_URL" - and getting it wrong is not
 * cosmetic, it points the Worker at itself.
 *
 * Read from the file rather than configured separately on purpose: a hand-kept
 * second copy of the routes drifts, and the two probe rosters already showed how
 * that ends. An unreadable or absent file yields an empty set, which restores the
 * old behaviour (first hostname wins) rather than blocking the tunnel.
 */
export function workerCustomDomainsIn(root) {
  try {
    const text = fs.readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8');
    // Comments are stripped first: the routes block is documented inline, and a
    // hostname quoted inside a comment must not count as a route.
    const stripped = text.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const hosts = new Set();
    for (const match of stripped.matchAll(/"pattern"\s*:\s*"([^"]+)"/g)) {
      const pattern = match[1].trim().toLowerCase();
      // A pattern may carry a path (`example.com/*`); the hostname is what is
      // compared, and it is the part before the first slash.
      const host = pattern.split('/')[0].replace(/^\*\./, '');
      if (host.includes('.')) hosts.add(host);
    }
    return hosts;
  } catch {
    return new Set();
  }
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

  /**
   * The hostnames the Worker serves, so the tunnel can avoid them.
   *
   * Read on each call rather than cached in the constructor: the project root is
   * a setting the user can change, and a set captured at construction would keep
   * answering for the old root - the same shape of staleness that made
   * `channelKeySet` report the wrong thing from a snapshot built once per apply().
   */
  workerCustomDomains() {
    const root = resolveProjectRoot(this.settings);
    if (!root) return new Set();
    return workerCustomDomainsIn(root);
  }

  originUrl() {
    if (this.settings.mode === 'external') {
      // The fallback carries no channel path. With one appended, a mode switched to
      // "external" and a left-blank field produced an origin of
      // `.../commandcode/v1`, and every request built on top of it started with
      // `/commandcode/v1/v1/...` - a path that answers nothing.
      return new URL(safeBaseUrl(this.settings.externalUrl || `http://127.0.0.1:${this.settings.port}`)).origin;
    }
    return `http://127.0.0.1:${this.settings.port}`;
  }

  serviceUrl(basePath = '/') {
    const suffix = basePath === '/' ? '' : `/${String(basePath).replace(/^\/+|\/+$/g, '')}`;
    return `${this.originUrl()}${suffix}`;
  }

  /**
   * The address a client should be pointed at: the aggregate, not one channel.
   *
   * This used to return the commandcode prefix, so the panel's settings header
   * advertised `http://127.0.0.1:8000/commandcode/v1` as "the proxy". Copying that
   * into a client sends every turn to a single channel - and the aggregate at `/v1`
   * is the route the `ai-proxy` provider actually registers under.
   */
  baseUrl() {
    return this.serviceUrl('/v1');
  }

  snapshot() {
    // Computed per call, not stored: this snapshot is built once per `apply()` and
    // survives a window reload, so anything baked in here is stale until the Host
    // restarts. Reading the file on every snapshot is exactly what makes saving it
    // take effect without one.
    const customMerge = mergeCustomSources(this.settings);
    return {
      state: this.state,
      mode: this.settings.mode,
      projectRoot: this.settings.projectRoot || null,
      port: this.settings.port,
      denoPath: this.settings.denoPath,
      apiKeyEnv: this.settings.apiKeyEnv,
      // The hidden list and the key presence live in the panel snapshot instead of
      // here. This snapshot is built once per `apply()` and kept by an instance that
      // survives a window reload, so a field added here is stale until the Host is
      // restarted - which is how `channelKeySet` went missing while the rest of the
      // panel showed the new data.
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
        env: { ...process.env, ...credentialEnv(this.settings), PORT: String(this.settings.port), DENO_NO_UPDATE_CHECK: '1' },
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
    // `customKeys` is a patch, not a replacement - merged before the spread so an
    // omitted vendor keeps its stored key.
    //
    // This has to happen here rather than in `cleanSettings`, which is a pure
    // function over the request body alone and therefore cannot see what is already
    // stored. The panel sends only the keys the user typed this session (an
    // untouched field is blank, because the server never sends a key back and
    // client.js deliberately omits it), so a wholesale `{...this.settings, ...values}`
    // replaced the map with just the one entry - typing a second vendor's key
    // deleted the first vendor's. Outside it looked like "only one key can be
    // stored", which is how the user reported it.
    //
    // A same-named entry in `values` still wins, and `{}` stays meaningful: an
    // explicit empty map means "the user removed every vendor", so it clears.
    const patch = { ...values };
    if (isRecord(values.customKeys) && isRecord(this.settings?.customKeys)) {
      const incoming = values.customKeys;
      // Only names the incoming patch actually mentions count as "clear this one";
      // a name it is silent about is not a deletion.
      const merged = { ...this.settings.customKeys };
      for (const [name, value] of Object.entries(incoming)) {
        if (value === '') delete merged[name];
        else merged[name] = value;
      }
      patch.customKeys = merged;
    }
    this.settings = loadSettings({ ...this.settings, ...patch });
    try { saveSettings(this.settings); } catch (error) { this.lastError = error.message; }
    await this.start();
    return this.snapshot();
  }
}

/**
 * The cloudflared quick tunnel, startable from the panel.
 *
 * ## Why this is a sibling of ProxyRuntime rather than part of it
 *
 * They have different lifetimes. The proxy is what the panel starts and stops on
 * every settings save; the tunnel is an outward-facing choice the user flips when
 * they want to be reachable from outside, and bouncing it on every unrelated save
 * would hand out a new trycloudflare hostname each time. Keeping them separate is
 * also what lets `ProxyRuntime.update` keep calling `stop()` without silently
 * dropping the public URL.
 *
 * ## Why the URL is parsed out of stderr
 *
 * `cloudflared tunnel --url` prints its hostname into stderr, not stdout, and has no
 * machine-readable flag for it on the quick-tunnel path. `restart.ps1` already
 * depends on this exact behaviour, so the panel does the same thing rather than
 * inventing a second mechanism that could disagree with it.
 *
 * ## What is deliberately not implemented
 *
 * TLS fingerprinting, Cloudflare account auth and named tunnels are all out: a quick
 * tunnel needs no credentials, which is why it can be a switch. A named tunnel would
 * need a token stored on disk and a domain, and that is a different feature.
 */
export class TunnelRuntime {
  constructor(runtime) {
    this.proxy = runtime;
    this.child = null;
    this.state = 'stopped';
    this.url = '';
    this.lastError = '';
    // cloudflared's own account of why it did not come up, lifted out of its
    // output instead of guessed at. See onData.
    this.failureReason = '';
    this.startedAt = 0;
    this.logs = [];
    this.worker = { state: 'idle', error: '', url: '' };
    this.startPromise = null;
    // Held separately from `runtime.settings` because the tunnel outlives a
    // settings save that does not touch it.
    this.desired = false;
  }

  /**
   * The first ingress hostname the Worker does not own, or ''.
   *
   * A hand-written YAML is not worth a parser here, and guessing at one is how a
   * config with several hostnames silently reports the wrong address: the ingress
   * is scanned in order and the first `- hostname:` line wins, which is the same
   * rule cloudflared itself applies. A config with none is answered with '' rather
   * than a fallback, because inventing a hostname would point the panel at an
   * address nothing serves.
   *
   * **Hostnames the Worker owns are skipped**, and that is the load-bearing part.
   * This value becomes `BACKEND_URL`, so naming a hostname the Worker serves
   * makes the Worker forward to itself. Measured 2026-10-05: the ingress listed
   * `api.hitmargin.dpdns.org` first, it was picked here, the reachability probe
   * against it failed (the Worker answered 522), and the write that follows would
   * have pointed the Worker at its own domain. The chain worked only because the
   * value had been corrected by hand. Depending on file order to avoid that is
   * not a fix - the next edit reorders it and the loop returns - so the check
   * lives here, where the value is chosen.
   */
  hostnameFromConfig(configPath) {
    try {
      const text = fs.readFileSync(configPath, 'utf8');
      const all = [...text.matchAll(
        /^\s*-\s*hostname:\s*([A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,})\s*$/gm,
      )].map((match) => match[1]);
      if (all.length === 0) return '';
      const workerHosts = this.proxy.workerCustomDomains();
      const usable = all.find((host) => !workerHosts.has(host.toLowerCase()));
      if (usable) return usable;
      // Every hostname here belongs to the Worker, so there is no address to hand
      // out. Reporting one anyway is what builds the loop; empty is the honest
      // answer, and the caller then leaves `url` empty instead of poisoning the
      // Worker with its own domain.
      this.record(
        `every ingress hostname (${all.join(', ')}) belongs to the Worker; no tunnel address to use`,
      );
      return '';
    } catch {
      return '';
    }
  }

  record(message) {
    const line = `${new Date().toISOString()} ${message}`.slice(-2000);
    this.logs.push(line);
    if (this.logs.length > 120) this.logs.splice(0, this.logs.length - 120);
  }

  /**
   * Where cloudflared is, in the same order `restart.ps1` looks.
   *
   * An explicit setting wins; then PATH; then the location the Windows installer
   * uses. Anything else is "not installed", reported as such rather than as a generic
   * spawn failure - the fix for the two is different (install it vs. fix the path).
   */
  resolveBinary() {
    const configured = String(this.proxy.settings.cloudflaredPath ?? '').trim();
    if (configured !== '') return configured;
    // Absolute candidates first, and on Windows the `.exe` matters: `spawn` without
    // `shell: true` does no PATHEXT expansion, so a bare `cloudflared` fails with
    // EFTYPE ("Exec format error") even though the command works in a shell. Measured
    // on this machine: the bare name gave EFTYPE while the absolute path ran.
    //
    // Node's own PATH resolution is still allowed as the last resort, because it is
    // the only thing that works when cloudflared lives somewhere neither installer
    // put it - but it is the *last* resort, not the first.
    const candidates = [];
    if (process.platform === 'win32') {
      candidates.push('C:\\Program Files (x86)\\cloudflared\\cloudflared.exe');
      candidates.push('C:\\Program Files\\cloudflared\\cloudflared.exe');
      candidates.push(
        path.join(process.env.LOCALAPPDATA ?? '', 'cloudflared', 'cloudflared.exe'),
      );
    } else {
      candidates.push('/usr/local/bin/cloudflared');
      candidates.push('/usr/bin/cloudflared');
      candidates.push('/opt/homebrew/bin/cloudflared');
    }
    for (const candidate of candidates) {
      try {
        if (candidate !== '' && fs.existsSync(candidate)) return candidate;
      } catch {}
    }
    return 'cloudflared';
  }

  snapshot() {
    return {
      state: this.state,
      enabled: this.proxy.settings.tunnelEnabled === true,
      url: this.url,
      lastError: this.lastError,
      startedAt: this.startedAt || null,
      pid: this.child?.pid ?? null,
      // The address a *client* is pointed at: the tunnel origin plus the aggregate
      // path, not the bare hostname. Handing out the bare hostname is the same
      // mistake the panel made when it advertised `/commandcode/v1` as "the proxy".
      baseUrl: this.url === '' ? '' : this.url.replace(/\/+$/, '') + '/v1',
      worker: { ...this.worker },
      // The mode lives in the snapshot rather than being read from settings by the
      // panel: `tunnelUrl` is already computed per request there (a snapshot field
      // that outlived `apply()` stayed stale and hid a value that had changed), and
      // the mode decides which fields the panel has to show at all.
      mode: this.proxy.settings.tunnelMode === 'named' ? 'named' : 'quick',
      tunnelName: String(this.proxy.settings.tunnelName ?? ''),
      logs: this.logs.slice(-40),
    };
  }

  async start() {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal().finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async startInternal() {
    this.desired = true;
    if (this.state === 'running' && this.child) return;
    this.lastError = '';
    this.failureReason = '';
    this.worker = { state: 'idle', error: '', url: '' };

    // The tunnel forwards to the local proxy, so there has to be one. Checked here
    // rather than left to cloudflared: cloudflared will happily tunnel to a port
    // nothing is listening on and report a healthy connection, and the user finds
    // out when their remote client 502s. A named error now is worth more.
    if (!(await this.proxy.probe())) {
      this.state = 'error';
      this.lastError = 'the local proxy is not answering, so there is nothing to forward';
      this.record(this.lastError);
      return;
    }

    const binary = this.resolveBinary();
    const target = `http://127.0.0.1:${this.proxy.settings.port}`;
    const named = this.proxy.settings.tunnelMode === 'named';
    const tunnelName = String(this.proxy.settings.tunnelName ?? '').trim();
    if (named && tunnelName === '') {
      this.state = 'error';
      this.lastError = 'tunnel mode is "named" but no tunnel name is set';
      this.record(this.lastError);
      return;
    }
    // A named tunnel gets its hostname from the ingress the user configured with
    // `cloudflared tunnel route dns`, so there is no trycloudflare URL to scrape
    // out of the output - readiness is the registered hostname itself.
    //
    // `--config` matters more than it looks: run without one, cloudflared warns
    // "No ingress rules were defined" and answers **503 for every request** while
    // still reporting a healthy connection. Measured 2026-10-05. So the config
    // file is passed whenever there is one, and the tunnel is only called up once
    // its hostname is recorded on the Cloudflare side.
    const configPath = String(this.proxy.settings.cloudflaredConfig ?? '').trim()
      || path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.cloudflared', 'config.yml');
    const hasConfig = fs.existsSync(configPath);
    const args = named
      ? [
          'tunnel',
          ...(hasConfig ? ['--config', configPath] : []),
          '--no-autoupdate',
          'run',
          tunnelName,
        ]
      : ['tunnel', '--url', target, '--no-autoupdate'];
    if (named && !hasConfig) {
      this.record(
        `no cloudflared config at ${configPath}; running without ingress rules would answer 503`,
      );
    }
    this.state = 'starting';
    this.record(`starting tunnel: ${binary} ${args.join(' ')}`);
    try {
      this.child = spawn(binary, args, {
        windowsHide: true,
        env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.state = 'error';
      this.lastError = error instanceof Error ? error.message : String(error);
      this.record(`spawn error: ${this.lastError}`);
      return;
    }
    this.startedAt = Date.now();

    // The hostname arrives on stderr for a quick tunnel, so both streams are
    // scanned. A named tunnel prints its own connected lines but no URL, so the
    // hostname is derived from the tunnel name and confirmed against the output.
    const onData = (chunk) => {
      const text = String(chunk);
      this.record(text.trimEnd());
      // cloudflared names its failures in the output before it gives up:
      // `quick tunnel provisioning failed with status 429: error code: 1015`
      // is the rate limit, and it is a completely different remedy from a
      // missing binary. Leaving it as a log line made the panel blame itself
      // ("never printed a url") and sent the hunt toward EFTYPE instead.
      if (this.failureReason === '' && /failed|error|429|1015|refused|unauthorized/i.test(text)) {
        const line = text.split('\n').find((l) => /failed|error|429|1015|refused|unauthorized/i.test(l));
        if (line) this.failureReason = line.trim().slice(0, 240);
      }
      if (this.url === '') {
        const found = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (found) {
          this.url = found[0];
          this.record(`tunnel url: ${this.url}`);
        }
      }
    };
    this.child.stdout?.on('data', onData);
    this.child.stderr?.on('data', onData);
    this.child.on('error', (error) => {
      // ENOENT here means "cloudflared is not where we looked", which is a
      // configuration problem and is named as one.
      this.state = 'error';
      this.lastError = error.code === 'ENOENT'
        ? `cloudflared was not found (tried ${binary}); set its path above`
        : error.message;
      this.record(`tunnel error: ${this.lastError}`);
    });
    this.child.on('exit', (code, signal) => {
      this.record(`cloudflared exited code=${code} signal=${signal ?? ''}`);
      this.child = null;
      this.url = '';
      // A tunnel does not survive the proxy it forwards to. When the proxy goes
      // down, cloudflared keeps running against a dead port and the public URL
      // starts answering 502 while the panel still shows it as up - so the child is
      // tied to the proxy's fate rather than left as a half-working pair.
      this.state = 'stopped';
      if (this.desired) {
        this.lastError = `cloudflared exited (code ${code ?? signal ?? '?'})`;
      }
    });

    // Up to 60s, the same budget restart.ps1 allows. The URL is the readiness
    // signal: cloudflared's own "connected" line arrives before the edge routes it.
    for (let attempt = 0; attempt < 120; attempt++) {
      if (this.url !== '') break;
      if (this.state === 'error') return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    // A named tunnel never prints a URL - the hostname is configured, not
    // assigned. Take it from the config file so the panel, the reachability
    // probe below and the Worker write all answer with a real address instead
    // of staying empty and looking like a failure to start.
    if (this.url === '' && named) {
      const hostname = this.hostnameFromConfig(configPath);
      if (hostname !== '') {
        this.url = `https://${hostname}`;
        this.record(`tunnel hostname from config: ${this.url}`);
      }
    }
    if (this.url === '') {
      this.state = 'error';
      // cloudflared's own reason beats a guess about what went wrong. It names
      // the rate limit (429 / 1015) and a bad credential in terms the user can
      // act on; "never printed a url" sent the hunt toward the binary.
      //
      // The named case is spelled out separately: that mode never prints a url at
      // all, so the quick-tunnel wording would send the reader looking for a line
      // that was never going to appear. The likely cause there is the ingress
      // listing only hostnames the Worker owns (see hostnameFromConfig).
      this.lastError = this.failureReason !== ''
        ? `cloudflared did not come up: ${this.failureReason}`
        : named
        ? `the named tunnel ${tunnelName} has no usable ingress hostname in ${configPath}` +
          ' (none set, or every one of them belongs to the Worker)'
        : 'cloudflared started but never printed a trycloudflare url';
      this.record(this.lastError);
      return;
    }

    // Wait until the hostname actually routes before calling it up.
    //
    // The URL is printed as soon as cloudflared registers the tunnel, which is
    // *before* the edge will serve it - measured: the first request to a brand-new
    // hostname failed with ECONNRESET and succeeded seconds later. Reporting
    // `running` at the print would hand the user (and the Worker write, which runs
    // right after) an address that 502s, and the failure would look like the proxy's.
    // Retried to a bounded total; a hostname that never routes is reported as a
    // failure rather than left looking healthy.
    let reachable = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const response = await fetch(this.url + '/', {
          method: 'GET',
          signal: AbortSignal.timeout(8000),
        });
        // Any HTTP answer means the edge routed us to the proxy; the status is the
        // proxy's business, not the tunnel's.
        if (response.status > 0) {
          reachable = true;
          response.body?.cancel?.().catch?.(() => {});
          break;
        }
      } catch {
        // Not routed yet. Try again while attempts remain.
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    if (!reachable) {
      this.lastError = `the tunnel url ${this.url} was assigned but the edge never routed it`;
      this.record(this.lastError);
      // Kept `running`: cloudflared is up and the hostname may still come good, so
      // tearing it down would be worse than reporting the uncertainty. The error
      // rides alongside the state rather than replacing it.
    }
    this.state = 'running';

    // Point the Worker at the new hostname. Kept out of `state`: a tunnel that is up
    // but whose Worker write failed is a different, more actionable condition than a
    // tunnel that never came up, and collapsing them would hide which half broke.
    await this.syncWorker();
  }

  /**
   * Write the tunnel URL into the Worker's BACKEND_URL secret.
   *
   * Skipped entirely when no Worker is named - writing a secret to a guessed Worker
   * is worse than not writing one. Failure is reported and never thrown: the tunnel
   * itself is up and usable directly, and failing the whole start over a wrangler
   * problem would take that away.
   */
  async syncWorker() {
    const worker = String(this.proxy.settings.workerName ?? '').trim();
    if (worker === '') {
      this.worker = { state: 'skipped', error: 'no worker name set', url: this.url };
      return;
    }
    const deno = this.proxy.settings.denoPath || 'deno';
    const root = resolveProjectRoot(this.proxy.settings) || PLUGIN_DIR;
    this.worker = { state: 'running', error: '', url: this.url };
    this.record(`updating worker ${worker} BACKEND_URL -> ${this.url}`);
    try {
      // Confirm the Worker exists before writing to it.
      //
      // Measured: `wrangler secret put --name <typo>` does not fail. It **creates**
      // the Worker and exits 0 with "Success! Uploaded secret BACKEND_URL". So the
      // exit code alone cannot tell "I pointed your Worker at the tunnel" from "I
      // just created a stray Worker you did not want and pointed *that* at the
      // tunnel" - and the user's real client is still pointed at the old one, with
      // nothing in the panel to say so. `secret list` is the read-only way to ask,
      // and it answers non-zero for a name that does not exist.
      const listed = await runCapture(
        deno,
        ['run', '-A', 'npm:wrangler@4.130.0', 'secret', 'list', '--name', worker],
        { cwd: root, timeoutMs: 180_000 },
      );
      if (listed.code !== 0) {
        const detail = (listed.stderr || listed.stdout || '').trim().split('\n')
          .filter((line) => line.trim() !== '').slice(-3).join(' ').slice(0, 300);
        this.worker = {
          state: 'error',
          error: `Worker "${worker}" was not found, so nothing was written (${detail || 'secret list failed'})`,
          url: this.url,
        };
        this.record(`worker update skipped: ${this.worker.error}`);
        return;
      }
      // Spawned rather than fetched: wrangler is the tool that owns the secret, and
      // re-implementing its API here would mean storing a Cloudflare API token in
      // settings.json - a credential this feature otherwise never needs.
      const result = await runCapture(
        deno,
        ['run', '-A', 'npm:wrangler@4.130.0', 'secret', 'put', 'BACKEND_URL', '--name', worker],
        { cwd: root, input: this.url + '\n', timeoutMs: 180_000 },
      );
      // wrangler writes its progress to stderr even on success, so the exit code is
      // the verdict and stderr is only evidence.
      if (result.code === 0) {
        this.worker = { state: 'ok', error: '', url: this.url };
        this.record('worker BACKEND_URL updated');
      } else {
        const detail = (result.stderr || result.stdout || '').trim().split('\n')
          .filter((line) => line.trim() !== '').slice(-3).join(' ').slice(0, 300);
        this.worker = { state: 'error', error: detail || `wrangler exited ${result.code}`, url: this.url };
        this.record(`worker update failed: ${this.worker.error}`);
      }
    } catch (error) {
      this.worker = {
        state: 'error',
        error: error instanceof Error ? error.message : String(error),
        url: this.url,
      };
      this.record(`worker update failed: ${this.worker.error}`);
    }
  }

  async stop() {
    this.desired = false;
    const child = this.child;
    this.child = null;
    this.state = 'stopped';
    this.url = '';
    this.worker = { state: 'idle', error: '', url: '' };
    if (child) {
      try { child.kill(); } catch {}
      this.record('tunnel stopped by DSH plugin');
    }
  }
}

/**
 * Run a command and capture its output and exit code.
 *
 * `spawnSync` is used rather than the async form because the only caller is the
 * wrangler secret write, which is already inside an await and needs the exit code
 * and stderr together. A timeout is mandatory: wrangler retries a dead network for
 * minutes, and a promise that never settles would leave the panel's tunnel card
 * stuck on "updating" with no way back.
 */
function runCapture(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      env: { ...process.env, NO_UPDATE_NOTIFIER: '1', DENO_NO_UPDATE_CHECK: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(-1);
    }, options.timeoutMs ?? 60_000);
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => {
      stderr += String(error?.message ?? error);
      finish(-1);
    });
    child.on('close', (code) => finish(code ?? -1));
    if (options.input !== undefined) {
      try { child.stdin?.end(options.input); } catch {}
    } else {
      try { child.stdin?.end(); } catch {}
    }
  });
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

/**
 * Project the harness's provider-neutral history onto the OpenAI chat shape.
 *
 * Two things were wrong here, and both only showed up under agentic work.
 *
 * Every message that was not an assistant became a `user` message, so a tool
 * result reached the model as something the *user* had said, with its
 * `tool_call_id` dropped. The assistant turn that had requested it was flattened
 * to its text too, so the model never saw a `tool_calls` entry at all.
 *
 * The upstream therefore saw:
 *
 *     user:      fix OnGui.cs
 *     assistant: no match, reading the file:    <- no tool_calls
 *     user:      <the file contents>             <- the tool result, as a user turn
 *
 * A model reading that has no idea it is mid-task. It answers the message in
 * front of it and stops - which is the reported "it just stopped instead of doing
 * the thing", and why a config-listed model on the same upstream never did it:
 * that path goes through the harness's own client, which serializes `tool_calls`
 * and `tool` messages properly.
 */
/**
 * An image block's data URL, or undefined when it cannot travel.
 *
 * `offloaded` means the harness decided not to inline it; a bare `url` is taken as
 * given, which is the form an OpenAI-shaped caller produces.
 */
function imageDataUrl(block, resolveImage) {
  if (block?.offloaded === true) return undefined;
  const resolved = resolveImage?.(block?.attachment);
  if (typeof resolved === 'string' && resolved !== '') return resolved;
  const url = block?.attachment?.url;
  return typeof url === 'string' && url !== '' ? url : undefined;
}

/**
 * Read an attachment out of the session store and inline it as a data URL.
 *
 * The adapter contract has no way to turn an `ImageAttachmentRef` into bytes -
 * that path exists only on the built-in DeepSeek adapter, which gets it through
 * constructor dependencies. A cordis service does expose it:
 * `ctx.get('attachments').imageHostPath(ref)` yields the on-disk path.
 *
 * Looked up per call and never cached across calls. A cordis service a plugin
 * loads before it is provided is simply absent at that moment, so reading it
 * once during `apply` yields undefined forever and takes the whole feature with
 * no error anywhere.
 */
function installImageResolver(ctx, logger) {
  if (ctx === null || typeof ctx !== 'object') return undefined;
  const cache = new Map();
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
  return (ref) => {
    const service = typeof ctx.get === 'function' ? ctx.get('attachments') : undefined;
    if (service === undefined || typeof service.imageHostPath !== 'function') return undefined;
    const id = String(ref?.attachmentId ?? '');
    if (id === '') return undefined;
    const cached = cache.get(id);
    if (cached !== undefined) return cached;
    try {
      const hostPath = service.imageHostPath(ref);
      if (typeof hostPath !== 'string' || hostPath === '') return undefined;
      const size = fs.statSync(hostPath).size;
      if (size > MAX_IMAGE_BYTES) {
        logger?.warn?.(`ai-proxy: image ${id} is ${size} bytes, above the ${MAX_IMAGE_BYTES} send limit`);
        return undefined;
      }
      const media = typeof ref.mediaType === 'string' ? ref.mediaType : 'image/png';
      const url = `data:${media};base64,${fs.readFileSync(hostPath).toString('base64')}`;
      if (cache.size > 48) cache.clear();
      cache.set(id, url);
      return url;
    } catch (error) {
      logger?.warn?.(`ai-proxy: could not read image ${id} (${error instanceof Error ? error.message : String(error)})`);
      return undefined;
    }
  };
}
/**
 * The thinking text in one streaming delta, whichever field this gateway calls it.
 *
 * There is no single name. DeepSeek streams `reasoning_content`, OpenRouter and
 * kilo stream `reasoning`, and others use `thinking`. Reading only the first meant
 * every kilo turn threw its thinking away: measured against space-bunny-alpha,
 * the model produced 126 tokens of reasoning under `delta.reasoning` while
 * `delta.reasoning_content` never appeared once. The composer showed no thinking
 * block at all, and the usage panel reported zero reasoning tokens - which I had
 * read as "kilo returns none" instead of "the plugin never looked".
 *
 * Only one of them is taken per delta. A gateway that sets two is not concatenating
 * them; it is describing the same thinking twice.
 */
function reasoningTextOf(delta) {
  for (const key of ['reasoning_content', 'reasoning', 'thinking']) {
    const value = delta[key];
    if (typeof value === 'string' && value !== '') return value;
    // Some gateways ship an array of typed reasoning parts.
    if (Array.isArray(value)) {
      const joined = value
        .map((part) => (typeof part === 'string' ? part : isRecord(part) ? String(part.text ?? part.content ?? '') : ''))
        .join('');
      if (joined !== '') return joined;
    }
  }
  return '';
}
function toOpenAiMessages(options, resolveImage, supportsImages, warnings) {
  const output = [];
  if (typeof options.system === 'string' && options.system !== '') {
    output.push({ role: 'system', content: options.system });
  }
  for (const message of Array.isArray(options.messages) ? options.messages : []) {
    if (!isRecord(message)) continue;
    const role = message.role;
    const content = message.content;

    if (role === 'tool') {
      // An empty result still keeps its id: dropping it would leave an
      // unanswered tool call, which is a protocol error rather than a tidy
      // transcript.
      const callId = typeof message.toolCallId === 'string' ? message.toolCallId : '';
      if (callId === '') continue;
      // A bare empty string told the model nothing. It could not tell a tool
      // that failed from one that legitimately produced nothing, and would
      // answer a question the transcript never answered. The harness client
      // marks both cases, so the shapes match again.
      let body = textOf(content);
      // `role: 'tool'` is text-only on the OpenAI wire, so an image the tool
      // returned cannot ride along with it. It travels as the user turn right
      // after, which is what the harness's own adapter does - the alternative
      // is a screenshot no model ever sees.
      const images = [];
      for (const part of Array.isArray(content) ? content : []) {
        if (!isRecord(part) || part.type !== 'image') continue;
        const url = supportsImages ? imageDataUrl(part, resolveImage) : undefined;
        if (url !== undefined) images.push({ type: 'image_url', image_url: { url } });
        else warnings?.push('image-dropped');
      }
      if (body === '') body = images.length > 0 ? '(see attached images)' : '(no tool output)';
      if (message.isError === true) body = `[tool error] ${body}`;
      output.push({
        role: 'tool',
        tool_call_id: callId,
        content: body,
      });
      if (images.length > 0) {
        output.push({
          role: 'user',
          content: [
            { type: 'text', text: `The result of tool call ${callId} is ${images.length} image(s).` },
            ...images,
          ],
        });
      }
      continue;
    }

    if (role === 'assistant') {
      const text = [];
      const calls = [];
      for (const part of Array.isArray(content) ? content : []) {
        if (!isRecord(part)) continue;
        if (part.type === 'text' && typeof part.text === 'string') {
          text.push(part.text);
        } else if (part.type === 'tool-call' && typeof part.id === 'string') {
          const args = typeof part.arguments === 'string'
            ? part.arguments
            : JSON.stringify(part.arguments ?? {});
          calls.push({
            id: part.id,
            type: 'function',
            function: { name: String(part.name ?? ''), arguments: args },
          });
        }
        // Reasoning blocks are dropped on the way out: replaying them needs the
        // upstream's own signature format, and a stale signature is a 400.
      }
      const joined = text.join('');
      // Dropping reasoning blocks upstream can leave a turn with neither prose
      // nor a call - the model thought and said nothing. "Some providers require
      // either content or tool_calls, but not none", which is why the harness
      // client skips these; sending one is what a strict channel answers 400.
      if (joined === '' && calls.length === 0) continue;
      output.push({
        role: 'assistant',
        content: joined,
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      });
      continue;
    }

    if (Array.isArray(content)) {
      const parts = [];
      let sawImage = false;
      for (const part of content) {
        if (!isRecord(part)) continue;
        if (part.type === 'text' && typeof part.text === 'string') {
          parts.push({ type: 'text', text: part.text });
        } else if (part.type === 'image') {
          sawImage = true;
          // `attachment`, not `source`: the block shape is { type:'image',
          // attachment: ImageAttachmentRef }, and `part.source` does not exist
          // anywhere in the harness - that check could never match, which is
          // why images never reached a plugin-routed model at all.
          const url = supportsImages ? imageDataUrl(part, resolveImage) : undefined;
          if (url !== undefined) parts.push({ type: 'image_url', image_url: { url } });
          else warnings?.push('image-dropped');
        }
      }
      if (parts.length === 0) {
        // Text-only route: the harness projects images to a description before
        // this point when the model cannot see them, but say so if one arrives
        // anyway rather than sending a message with an empty content array.
        const fallback = textOf(content);
        if (fallback !== '') output.push({ role: role === 'system' ? 'system' : 'user', content: fallback });
        continue;
      }
      if (sawImage && !supportsImages && parts.every((p) => p.type === 'text')) {
        parts.push({ type: 'text', text: '(image omitted: model does not support images)' });
      }
      output.push({ role: role === 'system' ? 'system' : 'user', content: parts });
      continue;
    }
    output.push({ role: role === 'system' ? 'system' : 'user', content: textOf(content) });
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
  // TokenUsage is { inputTokens, outputTokens, totalTokens?, cacheReadTokens?,
  // cacheWriteTokens?, reasoningTokens? }. Only the first two and reasoning were
  // ever populated, so every gateway's prompt-cache accounting arrived as zero:
  // a call that really did read 138 of 167 tokens from cache reported a 0% hit
  // rate. The upstream numbers were there the whole time, under the OpenAI
  // spelling; Anthropic-style gateways spell it cache_read_input_tokens.
  const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  const cacheRead = Number(
    promptDetails.cached_tokens ?? usage.cache_read_input_tokens ?? usage.cached_tokens ?? 0,
  ) || 0;
  const cacheWrite = Number(
    promptDetails.cache_write_tokens ?? usage.cache_creation_input_tokens ?? 0,
  ) || 0;
  // ★ inputTokens 必须**扣掉缓存部分**，否则命中率有 50% 的天花板。
  //
  // harness 的判据（2026-10-05 从 app.asar 读出，offset 19498839 / 19369104 /
  // 19336758）：它把TokenUsage.inputTokens 映射成 uncachedInputTokens，而
  //   * 面板那一行的 i18n 原文是「未缓存输入」（message.turnUsage.input）
  //   * 分母 = uncachedInputTokens + cacheReadTokens + cacheWriteTokens
  //   * 命中率 = cacheRead / 分母，missed === 0 时直接显示 "100"
  // 所以 inputTokens 的语义是"扣掉缓存后的未命中输入"，不是 OpenAI 的
  // prompt_tokens。原样传 prompt_tokens 等于把缓存算两遍：
  //     分母 ≈ cacheRead + (cacheRead + 未命中) ≈ 2×cacheRead
  // 高命中时命中率必然收敛到 50%——那不是缓存坏了，是双重计数的天花板。
  // 实测用户 14,891 次请求里六个渠道的 cacheRead/input 中位数在 0.97~0.999
  // （真实命中率 93%~99.7%），面板却一律显示 ~49%。
  //
  // 减法的条件由**这个数从哪来**决定，不由"看起来像哪种形状"决定：
  //   * cached_tokens 在 prompt_tokens_details 里（OpenAI）→ 它已被包含在
  //     prompt_tokens 中，必须减。
  //   * cache_read_input_tokens（Anthropic）→ 它的 input_tokens 本身就不含
  //     缓存，减了会把未命中压成 0，命中率反而显示成 100%（missed===0 的短路）。
  //     那等于用一个假 100% 换一个假 49%，不是修复。
  const readCameFromOpenAiDetails = promptDetails.cached_tokens !== undefined;
  const uncachedInput = readCameFromOpenAiDetails
    ? Math.max(0, prompt - cacheRead - cacheWrite)
    : Math.max(0, prompt);
  return {
    inputTokens: uncachedInput,
    outputTokens: Math.max(0, completion),
    reasoningTokens: Math.max(0, Number(details.reasoning_tokens ?? 0) || 0),
    // Omitted rather than zeroed: a gateway that does not report a cache is
    // saying nothing, and 0 is a claim.
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
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

/** Gateways word the overflow several ways; they all mean the same thing. */
const CONTEXT_OVERFLOW = /maximum context length|context_length_exceeded|context window|too many tokens|reduce the length/i;

/**
 * Rough prompt size in tokens. The chars/4 approximation is the one this project
 * already uses for Zen compaction; it is only ever used to leave headroom, never
 * to claim a precise budget.
 *
 * Images cost a flat estimate rather than nothing. A base64 string is not prose, so
 * counting its characters would inflate this wildly - but counting it as zero
 * under-counts just as badly, because the gateway bills a vision model by pixels
 * and not by bytes. Skipping them entirely is what made the first clamp fail to
 * clamp: a session carrying 13,005 tokens of image input was estimated 13,005
 * tokens light, so the budget that appeared to fit still overflowed.
 */
function estimateMessageTokens(messages) {
  let chars = 0;
  let images = 0;
  const walk = (value) => {
    if (typeof value === 'string') { chars += value.length; return; }
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    if (isRecord(value)) {
      for (const [key, item] of Object.entries(value)) {
        if (key === 'image_url') { images += 1; continue; }
        if (key === 'url') continue;
        walk(item);
      }
    }
  };
  walk(messages);
  return Math.ceil(chars / 4) + images * IMAGE_TOKEN_ESTIMATE;
}

/**
 * Keep `input + max_tokens` inside the model's context window.
 *
 * A model's output ceiling is not a request size. kilo publishes
 * `top_provider.max_completion_tokens: 524288` against a 1,000,000 window, so the
 * ceiling alone left 475,712 for a conversation that had already used 475,845 -
  and the gateway answered 400 with the arithmetic laid out: 467,563 text input +
  8,282 tool input + 524,288 output = 1,000,133.
 *
 * The turn then failed *twice* more: the thrown Error was reported as a transport
  failure, which is in the retry set, so it replayed an over-budget request until
  the budget ran out.
 */
function clampOutputBudget(body, contextWindow) {
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) return;
  const input = estimateMessageTokens(body.messages);
  const room = contextWindow - input - CONTEXT_HEADROOM_TOKENS;
  if (room >= body.max_tokens) return;
  body.max_tokens = Math.max(MIN_OUTPUT_TOKENS, room);
  body.max_tokensClamped = true;
}
/**
 * Deduplicates the model-listing fetch and cools down after a failure.
 *
 * The Host builds a catalog by calling `listModels()` once and then
 * `resolveModel()` once per model, concurrently. Both paths need the listing, so
 * a fetch per call turns one catalog build into one request per model - 93 here,
 * and every one of them a full aggregate listing rather than one cheap answer.
 *
 * Three rules, each answering a specific way that naive caching fails:
 *
 * 1. **One in-flight fetch.** Concurrent callers share a promise instead of
 *    racing. The loader's `catch` turns any throw into a *resolved* `undefined`
 *    and the async IIFE settles before the assignment below can be observed by
 *    anyone else, so the slot is cleared for every outcome - measured with a
 *    synchronous throw and with two overlapping reads, both of which recover.
 *    The clearing is inside a `finally` for that reason: without it a settled
 *    `task` would stay in the slot and every later reader would attach to it.
 * 2. **A settled listing is reused for the rest of the generation.** The panel
 *    needs a live list, so the cache is short-lived rather than permanent, and
 *    `refreshCatalog()` drops it whenever the user asks for fresh data. Without
 *    this the 93 `resolveModel` calls above would still each run `run`, just
 *    under a lock, and a listing that failed once would retry 93 times.
 * 3. **Failure cools down.** A proxy that is down must not be asked 93 times per
 *    keystroke; the last failure is remembered for a short window and the
 *    previous rows are reused so the panel shows the last known catalog instead of
 *    going blank.
 *
 * The window is bounded by how long the host keeps a catalog, so a stale row can
 * outlive a restart that would otherwise fix it - `refreshCatalog()` exists so
 * the restart path and the panel's own refresh can bypass it.
 */
export class CatalogGate {
  constructor(options = {}) {
    this.cooldownMs = options.cooldownMs ?? 5000;
    this.now = options.now ?? (() => Date.now());
    this.rows = undefined;
    this.loadedAt = 0;
    this.inFlight = undefined;
    this.retryAt = undefined;
  }

  /** Rows from the last successful read, or undefined if there has never been one. */
  peek() {
    return this.rows;
  }

  /**
   * Let the next read bypass the cache, keeping the current rows in place.
   *
   * Deliberately not "drop the cache": a panel poll that forces a refresh must
   * still fall back to the last known roster when the proxy is unreachable, or
   * the catalogue blanks out exactly when the user is looking at it to work out
   * why. Only `forget()` actually discards the rows.
   */
  refresh() {
    this.loadedAt = 0;
    this.retryAt = undefined;
  }

  /** Drop the cached rows entirely, so the next read has no fallback. */
  forget() {
    this.rows = undefined;
    this.loadedAt = 0;
    this.retryAt = undefined;
  }

  /**
   * Call `load` at most once for concurrent callers, honouring both the cache
   * window and the failure cooldown. Never throws: a caller that wanted a
   * listing gets the previous rows (possibly none) instead of an exception.
   */
  async read(load) {
    if (this.rows !== undefined && this.now() - this.loadedAt < this.cooldownMs) return this.rows;
    if (this.inFlight !== undefined) {
      await this.inFlight;
      return this.rows ?? [];
    }
    if (this.retryAt !== undefined && this.now() < this.retryAt) return this.rows ?? [];
    const task = (async () => {
      try {
        return await load();
      } catch {
        return undefined;
      }
    })();
    this.inFlight = task;
    try {
      const loaded = await task;
      if (loaded !== undefined) {
        // A successful read always supersedes both the rows and any pending retry,
        // and starts a fresh window.
        this.rows = loaded;
        this.loadedAt = this.now();
        this.retryAt = undefined;
      } else {
        // A failure opens the cooldown whether or not there are rows to fall back
        // on. With rows, callers keep the previous roster - the panel showing the
        // last known catalogue beats a blank one while the proxy is down. Without
        // rows there is nothing to show, but the cooldown still stops one dead
        // proxy from being asked once per model.
        this.retryAt = this.now() + this.cooldownMs;
      }
    } finally {
      // Identity check: only the fetch that installed this promise clears it.
      if (this.inFlight === task) this.inFlight = undefined;
    }
    return this.rows ?? [];
  }
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
    // Set once during apply; the function itself re-reads the cordis service on
    // every call, because a service loaded before it is provided is absent until
    // later and a one-shot read would disable images for the whole process with
    // nothing logged.
    this.resolveImage = options.resolveImage;
    // Ids seen by the last roster read, so a restart can report what moved.
    this.lastRoster = [];
    this.blockedModelCount = 0;
    // Guards the listing fetch behind `listModels`. `resolveModel` needs the same
    // rows, and the Host asks for one per model - without this it refetched the
    // whole roster 93 times for a single catalog build.
    this.catalogGate = new CatalogGate();
    // Read in the constructor, never assigned in apply(): a capability set
    // afterwards leaves every call outside apply() answering with the whole
    // aggregate, which looks exactly like the split not existing. One gate per
    // provider, so no group answers with another group's rows.
    this.channelGroups = options.channelGroups ?? null;
    // No separate displayNames map: headings live on the roster entries, so a
    // group has exactly one source for its id and its label.
    this.groupGates = new Map();
    // One gate per per-channel route. A single shared cache would answer one
    // channel's request with another channel's rows.
    this.routeGates = new Map();
  }

  /** The gate for one channel's own listing, created on first use. */
  routeGate(prefix) {
    let gate = this.routeGates.get(prefix);
    if (gate === undefined) {
      gate = new CatalogGate();
      this.routeGates.set(prefix, gate);
    }
    return gate;
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
      const error = new Error(`ai-proxy ${basePath}${path} returned HTTP ${response.status}: ${text.slice(0, 240)}`);
      // The retry decision is made on the code, and a thrown Error arrives at the
      // caller as a generic transport failure - which is retryable. A context
      // overflow is a 400 that fails identically forever, so replaying it only
      // burns quota before failing the same way. Naming it with the code the
      // harness recognises keeps it out of the retry set and lets the harness's
      // own overflow recovery see it.
      error.status = response.status;
      if (response.status === 400 && CONTEXT_OVERFLOW.test(text)) error.code = 'CONTEXT_WINDOW_EXCEEDED';
      else if (response.status === 429) error.code = 'RATE_LIMIT';
      else if (response.status >= 500) error.code = 'SERVER';
      else error.code = 'CONFIG_DISABLED';
      throw error;
    }
    return response;
  }

  async request(path, init = {}) {
    return this.requestAt(this.basePath, path, init);
  }

  providerInfo(provider) {
    // The Host asks once per registered provider, including every channel
    // group, so the name has to be that group's own label. Handing all of them
    // this adapter's single displayName is what makes every group look
    // identical in the picker.
    const channel = this.channelFor(provider);
    return {
      id: provider,
      name: channel === null ? this.displayName : this.displayNameFor(provider),
    };
  }

  /**
   * The provider that is answering, from whichever shape the caller used.
   *
   * The Host's own registry calls `adapter.listModels(provider)` - the
   * contract's parameter is named `provider` and it is a **bare string**,
   * not an options bag. This adapter's own callers pass a bag. Both are
   * accepted because the two shapes are indistinguishable at the call site, and
   * reading only one made every channel group answer with the whole aggregate
   * stamped `ai-proxy`, which the Host rejected for all seven groups at
   * once (INVALID_CATALOG).
   *
   * @param input either a provider string or an options bag carrying one
   * @returns the answering provider; this adapter's own route by default
   */
  providerFor(input) {
    const asked = typeof input === 'string'
      ? input
      : (isRecord(input) && typeof input.provider === 'string' ? input.provider : '');
    return asked !== '' ? asked : this.provider;
  }

  /**
   * The channel group this provider stands for, or null for the aggregate.
   *
   * Grouping is the Host's: `buildModelCatalog` buckets strictly by
   * provider id, so splitting the picker means registering one provider per
   * channel. The aggregate keeps its own provider so a session that already
   * selected `ai-proxy/<channel>/<model>` still resolves unchanged.
   */
  channelFor(provider) {
    // Answers the CHANNEL, not the provider id. The id is namespaced
    // (ai-proxy-kilo) while rows are filtered on the leading segment of the
    // model id (kilo); conflating the two was how a group first listed
    // everything, and how two plugins came to claim one provider id.
    return this.channelGroups?.[this.providerFor(provider)]?.channel ?? null;
  }

  /**
   * The heading to show for one group provider. Read off the roster entry,
   * which is why an entry is an object: the id is namespaced for collision
   * safety while the heading stays the readable channel name.
   *
   * @param provider a registered group provider id
   * @returns the label, or the id itself when it is not a group
   */
  displayNameFor(provider) {
    return this.channelGroups?.[provider]?.label ?? provider;
  }

  /**
   * One catalog gate per provider.
   *
   * The gate's key is `which batch did these rows come from`. Sharing one
   * across providers answers every channel with the first one's rows - the same
   * mistake the per-channel route gates prevent, one level up.
   */
  gateFor(provider) {
    if (this.channelGroups === null) return this.catalogGate;
    let gate = this.groupGates.get(provider);
    if (gate === undefined) {
      gate = new CatalogGate();
      this.groupGates.set(provider, gate);
    }
    return gate;
  }

  /**
   * Declare no provider-side image pricing.
   *
   * The base adapter this contract expects has it as an optional method whose
   * default returns nothing, and consumers fall back to their own neutral
   * estimate. This class is written from scratch rather than extending that
   * base, so the method was simply absent - and the token meter reaches it as
   * `adapter.imageRequestPricing(...)`, where the optional chain guards a route
   * that is not registered, not a method that does not exist. The result was
   * `... .imageRequestPricing is not a function` thrown from the meter, which
   * runs during compaction - so a session that needed compacting could not.
   *
   * Returning undefined is the honest answer: this proxy does not know how the
   * upstream meters vision, so it must not invent a figure. It has to answer
   * synchronously and without I/O, as the contract requires.
   */
  imageRequestPricing(_provider, _model) {
    return undefined;
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

  /**
   * List the models this provider serves.
   *
   * @param input the Host passes a **bare provider string**; this adapter's own
   *   callers pass `{ provider, force }`. Both are accepted - see providerFor.
   * @returns rows for that provider, each stamped with the provider it is listed
   *   under: the Host validates `model.provider === provider` per listing.
   */
  async listModels(input = {}) {
    // providerFor is the single place that accepts both shapes, on purpose:
    // normalising here as well looked harmless but meant the string case was
    // handled twice, and a test that broke only the second copy still passed.
    const options = isRecord(input) ? input : { provider: input };
    const provider = this.providerFor(options);
    const channel = this.channelFor(provider);
    // Every reader goes through one gate: `resolveModel` asks per model, and the
    // panel asks on a ten-second poll. Uncached, a catalog build alone asked the
    // proxy 186 times for 93 models.
    if (options.force) this.gateFor(provider).refresh();
    return this.gateFor(provider).read(async () => {
      const response = await this.request('/models');
      const payload = await response.json();
      const rows = Array.isArray(payload?.data) ? payload.data : [];
      const normalized = rows
        .filter((row) => isRecord(row) && typeof row.id === 'string')
        // A channel group sees only its own models. Ids are already
        // `channel/model`, so the channel is the first segment - no renaming
        // needed, and an old `ai-proxy/kilo/x` id still resolves unchanged.
        .filter((row) => channel === null || channelOf(row.id) === channel)
        // Stamped with the provider that asked, NOT with the channel the row
        // belongs to. The Host checks `model.provider === provider` against
        // the provider being listed, so claiming the channel instead fails
        // validation and takes the whole catalog down with it.
        .map((row) => normalizeModel(provider, row));
      // An empty listing is reported as "no answer" rather than as a roster, so
      // one bad read cannot retire every channel: the gate keeps the previous rows
      // and, with nothing cached, opens its cooldown so a dead proxy is not asked
      // once per model. The next read after that window tries again.
      return normalized.length === 0 ? undefined : normalized;
    });
  }

  async listProjectModels(options = {}) {
    // Carried through, not dropped: a per-channel group has to get its own rows
    // here too, or the panel keeps showing one undivided list.
    const provider = this.providerFor(options);
    const group = this.channelFor(provider);
    if (options.force) this.gateFor(provider).refresh();
    const discovered = await this.listModels(options);
    // Remembered so a restart can say what changed. The roster itself is never
    // cached - every call reads it fresh, which is what makes the panel's list live.
    const models = [];
    const seen = new Set();
    let blocked = 0;
    for (const model of discovered) {
      if (isBlockedModelId(model.id)) {
        blocked += 1;
        continue;
      }
      // No channel filter here: the extras loop below already skips every route
      // that is not this group (see its guard), and the aggregate rows reaching
      // this point were filtered by listModels. Kept as a note because deleting
      // the guard below does not turn any test red - it is defence in depth,
      // not load-bearing.
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      models.push(model);
    }
    // deepseek-web is listed only once its login state exists. The proxy serves the
    // listing either way - a fixed set of variants, not a read of the account - so
    // without this gate the panel would offer ten models whose every call answers
    // 400 "deepseek-cookies.txt missing". An unusable row is the dead control this
    // project has been removing all evening.
    // One extra route, computed per call rather than stored in the module-level
    // list above: the custom channel exists only because vendors can be added
    // without a restart, so its routes cannot be frozen at import time either.
    // It is a single route however many vendors are configured - the proxy
    // aggregates them - so the id prefix stays `custom/<vendor>/<model>`.
    const activeRoutes = [...EXTRA_MODEL_ROUTES];
    // Both sources count: a vendor the user wrote into custom-providers.json is one
    // the proxy serves, so the panel must ask for its listing too. Counting only
    // the settings half is what made a file-configured channel invisible in both
    // the panel and the picker while the proxy was serving it perfectly well.
    const customRows = mergeCustomSources(this.runtime?.settings ?? {}).providers;
    if (customRows.length > 0 && !isBlockedModelId('custom/x')) {
      activeRoutes.push({ prefix: 'custom', basePath: '/custom/v1' });
    }
    const extras = await Promise.all(activeRoutes.map(async (route) => {
      // Two conditions, and both have to hold before this listing is worth a
      // request: the channel is switched on, and it can actually answer. A hidden
      // channel's rows would be discarded, so polling it every snapshot was pure
      // log noise; an unconfigured one would list models that 400 on use.
      if (isBlockedModelId(`${route.prefix}/x`)) return [];
      // A channel group must not see another channel's extras. This route is a
      // second, independent source of rows, so filtering only the aggregate
      // listing above leaves every group listing the whole proxy.
      if (group !== null && route.prefix !== group) return [];
      if (route.requiresDeepseekLogin && !deepseekWebStatus(this.runtime?.settings ?? {}).configured) {
        return [];
      }
      // A keyed channel with no key. Without this the panel showed tokenharbor at
      // zero forever: upstream answers 401, and that channel's own filter drops every
      // id without a `:free` suffix, so a 401 comes back as an empty list - exactly
      // what a working channel with no free models looks like. Held back the same way
      // openrouter is, keyed on its own variable.
      if (route.requiresKey) {
        const keys = this.runtime?.settings?.channelKeys;
        if (!keys?.[route.prefix]?.trim()) return [];
      }
      // A file-backed credential, not an env var: the same reasoning as
      // requiresDeepseekLogin above, and the same check - asking the proxy for a
      // listing with nothing behind it returns 502, which renders as a channel at
      // zero rather than as the one command that would fix it.
      if (route.requiresCredential && !workBuddyStatus(this.runtime?.settings ?? {}).configured) {
        return [];
      }

      try {
        // A gate per route, not one shared with the aggregate: the rows are keyed
        // by what they came from, and one cache holding tokenharbor's listing
        // would answer deepseek-web's request with it - which showed up as 105
        // rows prefixed twice over (`deepseek-web/deepseek-web/…`). Each route is
        // still one request per call, and `resolveModel` walks this method once per
        // model, so each needs its own.
        const rows = await this.routeGate(route.prefix).read(async () => {
          const response = await this.requestAt(route.basePath, '/models', { signal: AbortSignal.timeout(3000) });
          const payload = await response.json();
          const rows = Array.isArray(payload?.data) ? payload.data : [];
          // Same rule as the aggregate: no rows means "no answer", not "nothing
          // is served". Caching that would silently retire a channel.
          return rows.length === 0 ? undefined : rows;
        });
        return rows.filter(isRecord).map((row) => {
          // Stamped with the provider that asked, like every other row in this
          // listing. The Host checks model.provider === provider per listing, so a
          // row found through a per-channel route still has to claim the group it
          // is being listed under. Which route found it does not change that.
          const normalized = normalizeModel(provider, row);
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
    this.lastRoster = models.map((model) => model.id);
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
    // Omitted entirely when the channel published no ladder. The harness accepts
    // `reasoning === undefined` and then offers no effort control; an empty
    // `efforts` array is the one shape it rejects outright. Inventing a table here
    // is what put rungs no upstream serves into the picker.
    const advertised = row.defaultReasoningEffort;
    const defaultEffort = efforts.some((effort) => effort.id === advertised)
      ? advertised
      : efforts.some((effort) => effort.id === 'high')
      ? 'high'
      : efforts[0]?.id;
    return {
      provider,
      id: row.id,
      name: row.name,
      inputModalities: row.inputModalities,
      context: { contextWindow: row.contextWindow },
      defaultMaxTokens: row.maxTokens,
      // The id is what the harness persists and what this adapter puts on the wire
      // as `reasoning_effort`; the name is what the picker shows. kilo's variants
      // are called `instant`/`thinking` while the effort they actually send is
      // `none`/`high`, so the two are kept apart rather than collapsed.
      ...efforts.length === 0 ? {} : {
        reasoning: {
          efforts,
          ...defaultEffort === undefined ? {} : { defaultEffort },
        },
      },
      basePath: route.basePath,
      wireModel: route.wireModel,
    };
  }

  async prepareCall(provider, model) {
    const resolved = await HOT.resolveModel.call(this, provider, model);
    return { model: resolved, stream: (options) => HOT.stream.call(this, options, resolved) };
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
    const imageWarnings = [];
    const body = {
      model: resolved.wireModel ?? resolved.id,
      // Capability gate: sending `image_url` to a model that cannot see one is
      // a 400 for the whole turn, not a dropped image.
      messages: toOpenAiMessages(
        options,
        this.resolveImage,
        Array.isArray(resolved.inputModalities) && resolved.inputModalities.includes('image'),
        imageWarnings,
      ),
      stream: true,
      max_tokens: Number(options.maxTokens ?? resolved.defaultMaxTokens ?? DEFAULT_MAX_TOKENS),
    };
    clampOutputBudget(body, resolved.context?.contextWindow);
    if (body.max_tokensClamped) {
      // Never silent: a request that used to be rejected should say it was
      // narrowed, or the shorter answers look like a model change.
      const clamped = body.max_tokens;
      delete body.max_tokensClamped;
      this.runtime?.record?.(
        `${requestedId}: output budget clamped to ${clamped} to fit a ${resolved.context.contextWindow} window`,
      );
    }
    const tools = toOpenAiTools(options.tools);
    if (tools) body.tools = tools;
    if (imageWarnings.length > 0) {
      // Never silent. An image that could not travel is exactly the class of
      // failure this plugin has been guilty of all day: the turn looks fine and
      // the operator learns nothing until they notice the model never saw it.
      this.runtime?.record?.(`dropped ${imageWarnings.length} image(s) on ${requestedId}`);
    }
    // OpenAI defaults this to true, which asks the gateway to retain the
    // conversation server-side. The harness client sends false explicitly and
    // a config-listed model on the same upstream therefore did too; omitting
    // it left the plugin path asking for retention nobody wanted.
    body.store = false;
    // A session title is not worth thinking about. The built-in client forces
    // the effort off for purpose 'session-title', so without this every
    // auto-named conversation spent reasoning tokens on a title.
    const purpose = typeof options.purpose === 'string' ? options.purpose : '';
    if (purpose === 'session-title') {
      delete body.reasoning_effort;
    } else if (typeof options.reasoningEffort === 'string') {
      body.reasoning_effort = options.reasoningEffort;
    }
    if (typeof options.temperature === 'number') body.temperature = options.temperature;
    if (Array.isArray(options.stop) && options.stop.length > 0) body.stop = options.stop;

    // Timings are taken here so the dashboard can report the real first-token
    // latency and decode speed the user actually experienced, rather than a
    // number re-derived from token counts.
    const startedAt = Date.now();
    let firstDeltaAt;

    const requestHeaders = { 'content-type': 'application/json' };
    // Session affinity. The built-in client sends a whole set of these whenever
    // the route opts in, and the gateway uses them to keep the prompt cache
    // warm across a conversation. The plugin sent none of them, so a
    // plugin-routed model was paying full price on cache misses that a
    // config-listed model on the same upstream did not.
    const sessionId = typeof options.sessionId === 'string' ? options.sessionId : '';
    if (sessionId) {
      requestHeaders.prompt_cache_key = sessionId;
      requestHeaders.session_id = sessionId;
      requestHeaders['x-session-affinity'] = sessionId;
    }
    const isZenAggregate = modelId.startsWith('zen/') && resolved.basePath === '/v1';
    if (isZenAggregate) {
      if (sessionId) {
        requestHeaders['x-session-id'] = sessionId;
        requestHeaders['x-conversation-id'] = sessionId;
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
          // The proxy states its own failure class in `error.code`, and that value
          // is what decides a replay. Hardcoding SERVER put every in-stream error
          // into the retry set, so a turn that had already delivered half an answer
          // was replayed up to maxRetries times: the tool calls it emitted ran again
          // and the second run was billed again. zen, workbuddy, commandcode and
          // trae all emit stream_cut for exactly this case (src/zen.ts:823,
          // src/workbuddy.ts:1964, src/commandcode/handler.ts, src/trae.ts:899) and
          // every one of them was silently downgraded to SERVER here.
          //
          // Grading still belongs to this layer, not to the proxy: only we know
          // whether this turn had already put something in front of the client.
          // `delivered` mirrors the same rule the missing-[DONE] branch below
          // applies, so a cut reaches the harness as the same code no matter which
          // way the stream ended.
          const deliveredBeforeError = textIndex !== undefined ||
            reasoningIndex !== undefined || toolBlocks.size > 0;
          const upstreamCode = typeof payload.error.code === 'string'
            ? payload.error.code
            : '';
          const code = upstreamCode === 'stream_cut'
            ? (deliveredBeforeError ? 'stream_cut' : 'TRANSPORT')
            : (upstreamCode || 'SERVER');
          yield { type: 'finish', reason: { kind: 'error', failure: { message: String(payload.error.message ?? 'ai-proxy stream error'), code } } };
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
        const thinking = reasoningTextOf(delta);
        if (thinking !== '') {
          if (reasoningIndex === undefined) {
            reasoningIndex = 1;
            yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' };
          }
          reasoning += thinking;
          yield { type: 'reasoning-delta', index: reasoningIndex, text: thinking };
        }
        for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
          if (!isRecord(call)) continue;
          const key = Number(call.index ?? 0);
          let block = toolBlocks.get(key);
          if (!block) {
            block = { index: 100 + key, id: call.id, name: call.function?.name, args: '' };
            toolBlocks.set(key, block);
            yield { type: 'block-start', index: block.index, blockType: 'tool-call' };
          } else if (block.id === undefined && typeof call.id === 'string' && call.id !== '') {
            // OpenAI-compatible gateways commonly open a tool call with only
            // `index` and send the id on a later frame. Reading it once at the
            // start left block.id undefined for the rest of the turn, and the
            // closing block-end then carried an id the harness types as
            // required - so the result could never be matched back.
            block.id = call.id;
          }
          if (block.name === undefined && typeof call.function?.name === 'string') {
            block.name = call.function.name;
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
      // The usage record says a turn failed; the log is where a person looks. Without
      // this a cut stream leaves the panel log silent and the only symptom is the
      // harness reporting an empty response, with nothing here to explain it.
      this.runtime?.record?.(
        `${modelId}: stream ended before [DONE] (exit path), delivered=${delivered ? 'partial' : 'nothing'}`,
      );
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
    // A stream that carried its terminal marker and produced nothing at all.
    //
    // This used to fall through and finish cleanly. A turn with no blocks is what
    // the harness reports as "Provider returned an empty response" - and it reads a
    // clean stop as the model having finished, so the failure looked like the model
    // choosing to say nothing. Nothing was delivered, so a retry is safe here, which
    // is the same rule the cut path above follows.
    if (textIndex === undefined && reasoningIndex === undefined && toolBlocks.size === 0) {
      this.runtime?.record?.(`${modelId}: stream completed with no content blocks; reporting a retryable failure`);
      recordUsage({
        at: startedAt,
        model: modelId,
        effort: typeof options.reasoningEffort === 'string' ? options.reasoningEffort : '',
        ok: false,
        input: usage?.inputTokens ?? 0,
        output: usage?.outputTokens ?? 0,
        reasoning: usage?.reasoningTokens ?? 0,
        decodeTokens: 0,
        ttftMs: firstDeltaAt === undefined ? undefined : firstDeltaAt - startedAt,
        decodeMs: firstDeltaAt === undefined ? undefined : Date.now() - firstDeltaAt,
        origin: 'harness',
        truncated: true,
      });
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: 'ai-proxy stream completed without delivering any content',
            code: 'TRANSPORT',
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
    // A rejected tool call has to fail the turn, not merely be mentioned in it.
    //
    // The proxy detects the bad syntax, strips it, and appends an explanation to
    // the text. That is honest, but it reaches the harness as an ordinary
    // assistant message on a turn that finished cleanly - so the agent loop reads
    // "the model said its piece" and STOPS, waiting for input. Measured
    // 2026-10-05: the user got the rejection notice and then had to prod the
    // session by hand, which is precisely the stall the notice exists to prevent.
    //
    // The only way to make the turn continue on its own is to fail it so the
    // harness retries (maxRetries: 2 in providerRetryPolicy), and TRANSPORT is
    // the only code it retries.
    //
    // Retrying after output has been delivered is normally forbidden here - the
    // stream_cut branch below explains why a replay repeats work and bills it
    // twice - and the user chose this trade-off explicitly after being shown the
    // cost. Nothing executed in this case, which is the whole reason the proxy
    // refused the call, so the replay re-sends the same prompt and the injected
    // retry reminder is what makes the second attempt differ from the first.
    if (finish === 'stop' && !options.signal?.aborted) {
      // The proxy has two spellings for this notice - the full one ("used an
      // invalid syntax that no client can parse") for the first two rejections and
      // the circuit-breaker's shorter "Still the same invalid tool syntax" after
      // that. An earlier version of this check matched only the second, so the
      // FIRST rejection - the one most worth retrying - fell through and the turn
      // still ended cleanly. The patterns below cover both while staying anchored
      // on `[proxy]`, which is what makes them ours rather than text the model wrote.
      const rejection = text.match(/\[proxy\][^\n]*(?:invalid tool syntax|invalid syntax)[^\n]*/i);
      if (rejection) {
        for (const block of toolBlocks.values()) {
          yield { type: 'block-end', index: block.index, block: { type: 'tool-call', id: block.id, name: block.name, arguments: block.args || '{}' } };
        }
        if (usage) yield { type: 'usage', usage };
        this.runtime?.record?.(
          `${modelId}: rejected tool syntax; failing the turn so the harness retries instead of stalling`,
        );
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
          noUsage: usage === undefined,
        });
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              message: 'ai-proxy rejected the tool call syntax; retrying so the model can re-emit it',
              code: 'TRANSPORT',
            },
          },
        };
        return;
      }
    }
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

export function cleanSettings(values) {
  const next = {};
  if (values.mode === 'local' || values.mode === 'external') next.mode = values.mode;
  if (typeof values.projectRoot === 'string' && values.projectRoot.length <= 512) next.projectRoot = values.projectRoot;
  if (typeof values.denoPath === 'string' && values.denoPath.length <= 512) next.denoPath = values.denoPath;
  if (typeof values.externalUrl === 'string' && values.externalUrl.length <= 2048) next.externalUrl = values.externalUrl;
  if (typeof values.apiKeyEnv === 'string' && /^[A-Z_][A-Z0-9_]*$/.test(values.apiKeyEnv)) next.apiKeyEnv = values.apiKeyEnv;
  const port = Number(values.port);
  if (Number.isSafeInteger(port) && port > 0 && port < 65536) next.port = port;
  // A channel name reaches a URL path segment, so it is validated rather than
  // trusted: the panel posts a list, and anything that is not a plain lowercase
  // segment is dropped instead of being written to settings and matched later.
  // Per channel, and each name is checked against the list the panel offers, so a
  // post cannot introduce a channel the proxy has no variable for.
  if (isRecord(values.channelKeys)) {
    const keys = {};
    for (const entry of KEYED_CHANNELS) {
      const value = values.channelKeys[entry.channel];
      if (typeof value === 'string' && value.length <= 512) keys[entry.channel] = value.trim();
    }
    next.channelKeys = keys;
  }
  // The custom vendor list. Each entry is validated as it arrives and stored
  // normalised, so a name that would not survive being a URL path segment never
  // reaches settings.json. Keys live in their own map for the same reason
  // channelKeys does: the panel is write-only about credentials, so the list it
  // reads back carries a set/unset boolean instead of the key.
  if (Array.isArray(values.customProviders)) {
    const rows = [];
    const seen = new Set();
    for (const entry of values.customProviders.slice(0, 32)) {
      if (customProviderProblem(entry) !== null) continue;
      const name = String(entry.name).trim().toLowerCase();
      if (seen.has(name)) continue;
      seen.add(name);
      rows.push({
        name,
        baseUrl: String(entry.baseUrl).trim().replace(/\/+$/, ''),
        ...typeof entry.label === 'string' && entry.label.trim() !== ''
          ? { label: entry.label.trim().slice(0, 64) }
          : {},
        ...typeof entry.authHeader === 'string' && entry.authHeader.trim() !== ''
          ? { authHeader: entry.authHeader.trim().slice(0, 64) }
          : {},
        enabled: entry.enabled !== false,
      });
    }
    next.customProviders = rows;
  }
  if (isRecord(values.customKeys)) {
    // Merged into the stored map, not substituted for it.
    //
    // This used to be `next.customKeys = kept`, a full replace, and the panel only
    // ever sends the key of a vendor whose field the user retyped this session -
    // because the server never sends a key back, so an untouched field arrives
    // blank and is deliberately omitted (see client.js). Replace semantics therefore
    // meant: adding a second vendor and typing *its* key silently deleted the
    // first vendor's key. The user's own words for it were "the API key can only
    // store one", which is exactly what it looked like from outside.
    //
    // An empty string stays the explicit "clear this one" signal, so merging does
    // not remove the ability to delete a key. A name that is not a vendor any more
    // is dropped: a key with nothing to authenticate to is a credential left on disk
    // for no reason.
    const kept = { ...(isRecord(next.customKeys) ? next.customKeys : {}) };
    for (const [name, value] of Object.entries(values.customKeys)) {
      if (!CUSTOM_NAME_PATTERN.test(name)) continue;
      if (typeof value !== 'string' || value.length > 512) continue;
      if (value.trim() === '') {
        delete kept[name];
        continue;
      }
      kept[name] = value.trim();
    }
    // Only for the settings-backed list: a file-backed vendor's key lives in the
    // file, and dropping it here would delete a credential this route never owned.
    const known = new Set(
      (Array.isArray(next.customProviders) ? next.customProviders : [])
        .map((row) => String(row?.name ?? '').toLowerCase()),
    );
    next.customKeys = Object.fromEntries(
      Object.entries(kept).filter(([name]) => known.has(name)),
    );
  }
  if (Array.isArray(values.hiddenChannels)) {
    next.hiddenChannels = [...new Set(values.hiddenChannels
      .filter((entry) => typeof entry === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(entry.trim().toLowerCase()))
      .map((entry) => entry.trim().toLowerCase())
    )];
  }
  // ---- tunnel ----
  // A boolean, so `false` must survive as a value: `tunnelEnabled: false` is a
  // request to turn it off, and treating it as "absent" would make the switch
  // impossible to turn back off.
  if (typeof values.tunnelEnabled === 'boolean') next.tunnelEnabled = values.tunnelEnabled;
  if (typeof values.cloudflaredPath === 'string' && values.cloudflaredPath.length <= 512) {
    next.cloudflaredPath = values.cloudflaredPath.trim();
  }
  // A Worker name is handed to wrangler as an argument, so it is validated as a
  // DNS-ish label: a stray space or slash would reach the CLI as something it
  // cannot parse. Empty is allowed and means "skip the Worker step".
  // 'quick' is the default and the only other legal value is 'named' - the
  // enum is closed because each mode changes the argv handed to cloudflared,
  // and an unrecognised string would otherwise reach it as a tunnel name.
  if (values.tunnelMode === 'quick' || values.tunnelMode === 'named') {
    next.tunnelMode = values.tunnelMode;
  }
  // Same DNS-ish validation as the Worker name: this is a tunnel name from
  // `cloudflared tunnel create`, and it reaches the CLI verbatim.
  if (typeof values.tunnelName === 'string' && values.tunnelName.length <= 128) {
    const name = values.tunnelName.trim();
    if (name === '' || /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) next.tunnelName = name;
  }
  if (typeof values.workerName === 'string' && values.workerName.length <= 128) {
    const name = values.workerName.trim();
    if (name === '' || /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) next.workerName = name;
  }
  return next;
}

/**
 * The channels the panel is allowed to probe on demand.
 *
 * This list and the proxy route that handles /health/probe answer the same
 * question from two sides, so they have to name the same channels. A name
 * the proxy does not know answers 400 unknown channel; a name missing here
 * is filtered out by cleanProbeRequest and then silently widened to every
 * channel - one click spends a full roster of upstream calls while the
 * channel the user asked about is never probed. self-test.mjs asserts the
 * two lists agree.
 *
 * openrouter is absent on purpose: it has no route of its own and needs a
 * per-user key this proxy never holds. It is aggregate-only.
 */
export const PROBE_CHANNELS = [
  'kilo',
  'zen',
  'cnb',
  'commandcode',
  'deepseek-web',
  'tokenharbor',
  'workbuddy',
  'trae',
  'zlkpro',
  'custom',
];

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
      // The login state, so the panel can show the sign-in URL in this path too.
      // The primary branch returns /panel verbatim, which already carries it; only
      // this fallback rebuilds the shape, and a field it forgets is a button that
      // silently does nothing.
      login: isRecord(status?.login) ? status.login : { status: 'unknown' },
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

async function projectPanelSnapshot(adapter, projectAdapter, runtime) {
  // Both sources, computed per call. This snapshot is served on every panel poll,
  // and reading the config file here is what makes a hand-edited
  // custom-providers.json show up without a Host restart.
  const customMerge = mergeCustomSources(runtime?.settings ?? {});
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
    // A hidden channel is absent from the roster by construction, so a toggle
    // built from `channels` alone could only ever turn channels off. The union is
    // what the panel needs to offer both directions.
    hiddenChannels: [...BLOCKED_CHANNELS],
    // KNOWN_CHANNELS is the base, not the roster: a channel that is on but silent
    // must still have a switch, or turning it on is a one-way trip.
    allChannels: [...new Set([
      ...KNOWN_CHANNELS,
      ...Object.keys(channels),
      ...BLOCKED_CHANNELS,
    ])].sort(),
    hiddenChannels: [...BLOCKED_CHANNELS],
    // The user's own upstreams from **both** sources, as the panel is allowed to see
    // them: **no keys**, only a set/unset boolean per vendor - the same rule
    // channelKeySet follows and for the same reason (a credential echoed into a
    // rendered page is a credential in the next screenshot). `origin` says which
    // source each one came from, because a file-backed vendor cannot be edited or
    // deleted from this card - the file owns it.
    customProviders: customMerge.providers.map((entry) => ({
      name: entry.name,
      label: entry.label ?? entry.name,
      baseUrl: entry.baseUrl,
      authHeader: entry.authHeader === 'authorization' ? '' : entry.authHeader,
      enabled: entry.enabled !== false,
      keySet: typeof entry.apiKey === 'string' && entry.apiKey !== '',
      origin: customMerge.origin[entry.name] ?? 'env',
    })),
    // Entries a validation refused, from either source, each saying which. Reported
    // rather than dropped: a vendor that silently did not take effect looks
    // identical to one that was never entered.
    customRejected: customMerge.rejected,
    // Where the file half comes from and whether it is readable. Shown so a user
    // who wrote a file can tell "not picked up" from "wrong directory".
    customFile: {
      path: customMerge.file.path,
      exists: customMerge.file.exists,
      error: customMerge.file.error,
    },
    customShadowed: customMerge.shadowed,
    // The channels the panel offers a key for, each naming the variable the proxy
    // reads, so the field can say which one it is writing.
    keyedChannels: KEYED_CHANNELS,
    // Presence only, per channel. The values are write-only from the panel's point
    // of view: echoing a credential back into a page that renders in a browser is
    // how one ends up in a screenshot.
    channelKeySet: Object.fromEntries(KEYED_CHANNELS.map((entry) => [
      entry.channel,
      typeof runtime.settings.channelKeys?.[entry.channel] === 'string' &&
      runtime.settings.channelKeys[entry.channel] !== '',
    ])),
    // What deepseek-web still needs, and whether its capture is already running.
    deepseekWeb: {
      ...deepseekWebStatus(runtime.settings),
      running: Boolean(runtime.deepseekSetup),
    },
    // Same shape for WorkBuddy. `configured` alone is deliberately weak here the
    // same way deepseek-web's is: the login script writes the credential as one
    // file, so a half-written one would look complete. The proxy's own
    // `/workbuddy/v1/account` is what decides usability, and the panel asks it.
    workbuddy: {
      ...workBuddyStatus(runtime.settings),
      running: Boolean(runtime.workBuddyLogin),
    },
    // The tunnel lives in the panel snapshot, not `runtime.snapshot()`. That method
    // is built once per `apply()` and kept by an instance that outlives a window
    // reload, so anything placed there is stale until the Host restarts - the exact
    // way `channelKeySet` went missing while the rest of the card showed fresh data.
    // This snapshot is recomputed per request, which is what makes the URL appear
    // while the tunnel is still coming up.
    tunnel: runtime.tunnel ? runtime.tunnel.snapshot() : null,
    channels,
    health,
    modelHealth: counts,
    // A member whose model list did not come back whole is absent from `channels`
    // precisely because it failed, so the count alone cannot explain a roster that
    // got shorter. The proxy names the ones it could not fetch.
    catalogIssues: isRecord(health?.catalogIssues) ? health.catalogIssues : {},
  };
}

function apiHandler(adapter, runtime, projectAdapter, tunnel) {
  return async (req, res) => {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    const route = url.pathname.replace(/^\/api\/ai-proxy(?:-commandcode)?/, '').replace(/\/+$/, '') || '/';
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'forbidden' });
    try {
      if (method === 'GET' && (route === '/' || route === '/panel')) {
        const panel = await projectPanelSnapshot(adapter, projectAdapter, runtime);
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
      // 测试一个自定义供应商能不能通。放在这里而不是让面板直接打上游：
      // 浏览器的跨域请求会被上游拒绝（而且会把 key 暴露给页面），代理侧
      // 没有跨域问题，且 key 只经过一次服务端到服务端的调用。
      if (method === 'POST' && route === '/custom/test') {
        const body = await readBody(req);
        const name = String(body?.name ?? '').trim().toLowerCase();
        const vendor = customProvidersForEnv(runtime.settings)
          .find((entry) => entry.name === name);
        if (vendor === undefined) {
          return sendJson(res, 404, { ok: false, error: 'no such custom provider: ' + name });
        }
        const started = Date.now();
        try {
          const response = await adapter.requestAt('/custom/v1', '/models', {
            signal: AbortSignal.timeout(15_000),
          });
          const payload = await response.json().catch(() => null);
          const rows = Array.isArray(payload?.data) ? payload.data : [];
          const own = rows.filter((row) => typeof row?.id === 'string' && row.id.startsWith(name + '/'));
          // 「连不上」和「连上了但没有模型」要分开说：前者是地址或 key 的问题，
          // 后者是上游目录的问题，修法不同。
          if (!response.ok) {
            return sendJson(res, 200, {
              ok: false,
              provider: name,
              status: response.status,
              error: payload?.error?.message ?? 'listing failed',
              latencyMs: Date.now() - started,
            });
          }
          return sendJson(res, 200, {
            ok: own.length > 0,
            provider: name,
            status: response.status,
            modelCount: own.length,
            sample: own.slice(0, 3).map((row) => row.id),
            latencyMs: Date.now() - started,
            ...own.length === 0 ? { error: 'the upstream answered but listed no models' } : {},
          });
        } catch (error) {
          return sendJson(res, 200, {
            ok: false,
            provider: name,
            error: String(error?.message ?? error),
            latencyMs: Date.now() - started,
          });
        }
      }
      if (method === 'POST' && route === '/settings') {
        const body = cleanSettings(await readBody(req));
        // A channel toggle is a display choice, not a runtime change, so it does
        // not go through `runtime.update` - that stops and starts the proxy, and
        // restarting it to hide a channel is both slow and a second chance to fail.
        const onlyChannels = Object.keys(body).length === 1 &&
          Object.prototype.hasOwnProperty.call(body, 'hiddenChannels');
        if (onlyChannels) {
          const applied = applyHiddenChannels(body.hiddenChannels);
          runtime.settings = { ...runtime.settings, hiddenChannels: applied };
          try { saveSettings(runtime.settings); } catch (error) { runtime.lastError = error.message; }
          runtime.record(`channels hidden: ${applied.length > 0 ? applied.join(', ') : '(none)'}`);
          return sendJson(res, 200, runtime.snapshot());
        }
        const next = await runtime.update(body);
        if (Array.isArray(body.hiddenChannels)) applyHiddenChannels(body.hiddenChannels);
        return sendJson(res, 200, next);
      }
      // CommandCode signs in through the browser: the proxy opens a local listener,
      // hands back a URL, and waits up to ten minutes for the callback. Unlike the
      // deepseek capture there is no script to spawn - the flow is already in the
      // proxy - so this is a pass-through, and the panel's job is to show the URL
      // and keep asking whether it landed.
      if (method === 'POST' && /^\/commandcode\/login(?:\/cancel)?$/.test(route)) {
        const proxyPath = route === '/commandcode/login'
          ? '/commandcode/v1/login'
          : '/commandcode/v1/login/cancel';
        if (runtime.state !== 'running' && runtime.state !== 'external') await runtime.start();
        const raw = await fetch(`${runtime.serviceUrl('/commandcode/v1')}${proxyPath.slice('/commandcode/v1'.length)}`, {
          method: 'POST',
          headers: { ...runtime.headers(), 'content-type': 'application/json' },
          body: '{}',
        })
          .then((response) => response.json())
          .catch((reason) => ({ status: { status: 'failed', error: String(reason) } }));
        // POST /login answers `{authUrl, callbackUrl, status: {...}}` while the panel
        // carries `login: {status: 'idle'}`. Handing the panel both shapes would make
        // `status === 'waiting'` mean two different things depending on which one
        // arrived, so only the inner object travels.
        const status = isRecord(raw?.status) ? raw.status : raw;
        sendJson(res, status.status === 'failed' ? 502 : 200, status);
        return;
      }
      if (method === 'POST' && route === '/deepseek-web/setup') {
        const root = resolveProjectRoot(runtime.settings);
        if (!root) {
          sendJson(res, 400, { error: 'project directory not found; set it in the settings above' });
          return;
        }
        const before = deepseekWebStatus(runtime.settings);
        // A capture overwrites all three files. A scan that dies half way through
        // leaves a set that looks complete to `deepseekWebStatus` and is not - the
        // panel would go on saying "ready" for a channel whose token is stale. The
        // originals are kept and put back unless the capture actually finished.
        if (before.configured) {
          const kept = backUpDeepseekState(root);
          if (kept > 0) {
            runtime.record(`deepseek-web: kept a copy of the current state (${kept} file(s))`);
          }
        }
        // The capture opens a browser and waits for a QR scan, so it cannot be
        // awaited here. It runs detached and reports through the log tab, which is
        // the only place a user can act on it.
        if (runtime.deepseekSetup) {
          sendJson(res, 409, { ...before, started: false, alreadyRunning: true });
          return;
        }
        const script = path.join(root, '.tmp-extract-deepseek-cookies.ts');
        if (!fs.existsSync(script)) {
          sendJson(res, 400, {
            error: 'capture script not found at .tmp-extract-deepseek-cookies.ts',
            root,
          });
          return;
        }
        const deno = runtime.settings.denoPath || 'deno';
        const child = spawn(deno, ['run', '-A', '.tmp-extract-deepseek-cookies.ts'], {
          cwd: root,
          // Visible: the browser it opens has to come up in front of the user, and
          // a hidden console window on Windows makes the QR flow look broken.
          windowsHide: false,
          env: { ...process.env, DENO_NO_UPDATE_CHECK: '1' },
          stdio: 'inherit',
        });
        runtime.deepseekSetup = child;
        runtime.record(
          `deepseek-web: capturing login state in ${root} — scan the code when the browser opens`,
        );
        child.on('exit', (code) => {
          runtime.deepseekSetup = null;
          const after = deepseekWebStatus(runtime.settings);
          // Both have to hold. `after.configured` alone is not enough: the capture
          // writes the token and the headers before the cookie, so a scan that dies
          // part way leaves all three present and the panel calls that broken set
          // ready. The script exits non-zero on every failure path, so the code is
          // what says whether the run actually finished.
          const finished = code === 0 && after.configured;
          runtime.record(
            finished
              ? 'deepseek-web: capture finished; the channel is ready'
              : `deepseek-web: capture exited ${code} without completing (missing ${after.missing.join(', ')})`,
          );
          if (finished) {
            dropDeepseekBackups(root);
            // Show it: the channel works, and leaving it hidden after the user just
            // set it up would be a second thing to figure out.
            applyHiddenChannels([...BLOCKED_CHANNELS].filter((name) => name !== 'deepseek-web'));
          } else {
            const restored = restoreDeepseekState(root);
            if (restored > 0) {
              runtime.record(`deepseek-web: capture incomplete; restored ${restored} file(s)`);
            }
          }
        });
        child.on('error', (error) => {
          runtime.deepseekSetup = null;
          runtime.record(`deepseek-web: capture failed to start: ${error.message}`);
          restoreDeepseekState(root);
        });
        sendJson(res, 202, { ...before, started: true, reconfigured: before.configured });
        return;
      }
      // ---- cloudflared tunnel ----
      //
      // Its own routes rather than a settings field alone, because starting a tunnel
      // is a process to spawn and a hostname to wait for - not a value to store. The
      // switch in the panel posts here and the setting is written as a side effect,
      // so the toggle and the process cannot disagree.
      if (route === '/tunnel/start' && method === 'POST') {
        // Persist the intent first: if the Host restarts while the tunnel is up, the
        // setting is what brings it back, and a switch that silently reverts is worse
        // than one that never turned on.
        const before = { ...runtime.settings, tunnelEnabled: true };
        runtime.settings = loadSettings(before);
        try { saveSettings(runtime.settings); } catch (error) { runtime.lastError = error.message; }
        await tunnel.start();
        return sendJson(res, 200, tunnel.snapshot());
      }
      if (route === '/tunnel/stop' && method === 'POST') {
        await tunnel.stop();
        runtime.settings = loadSettings({ ...runtime.settings, tunnelEnabled: false, tunnelUrl: '' });
        try { saveSettings(runtime.settings); } catch (error) { runtime.lastError = error.message; }
        return sendJson(res, 200, tunnel.snapshot());
      }
      // Re-run only the Worker half. Separated because the two fail independently:
      // the tunnel can be up with a stale BACKEND_URL, and re-spawning cloudflared to
      // fix that would hand out a new hostname for no reason.
      if (route === '/tunnel/sync-worker' && method === 'POST') {
        if (tunnel.url === '') {
          return sendJson(res, 409, { ...tunnel.snapshot(), error: 'the tunnel is not up yet' });
        }
        await tunnel.syncWorker();
        return sendJson(res, 200, tunnel.snapshot());
      }
      // TRAE account: the panel asks about credits and runs the daily check-in.
      //
      // The proxy owns the credential, the refresh and the 9074 backoff; the plugin
      // only forwards. That split is deliberate - a retry policy that lived here
      // would have to be re-implemented in the browser panel too, and the two
      // copies would drift exactly where it matters (a claim must not be replayed).
      //
      // `/trae/v1/*` is a root path, not a provider basePath, so `request()` would
      // ask for `/commandcode/v1/trae/v1/...` and 404 into the provider catalog.
      if (method === 'GET' && route === '/trae/status') {
        if (runtime.state !== 'running' && runtime.state !== 'external') await runtime.start();
        // 409 means "no credential yet", which is a normal state the panel renders,
        // not a failure of the proxy. requestAt would throw on it.
        const response = await fetch(`${runtime.serviceUrl('/trae/v1')}/account`, {
          headers: { ...runtime.headers() },
          signal: AbortSignal.timeout(15000),
        }).catch((reason) => ({ json: async () => ({ error: String(reason) }) }));
        // Await first, then shape-check. Testing `response.json` before awaiting it
        // inspects the *function*, which is always a record - so the check passed
        // whatever came back and a transport failure was rendered as an empty
        // account rather than as the reason it failed.
        let payload = {};
        try {
          payload = await response.json();
        } catch {
          payload = { error: 'the proxy answered with no JSON' };
        }
        if (!isRecord(payload)) payload = { error: 'unexpected account payload' };
        return sendJson(res, 200, payload);
      }
      if (method === 'POST' && route === '/trae/checkin') {
        if (runtime.state !== 'running' && runtime.state !== 'external') await runtime.start();
        try {
          const response = await fetch(`${runtime.serviceUrl('/trae/v1')}/checkin`, {
            method: 'POST',
            headers: { ...runtime.headers(), 'content-type': 'application/json' },
            body: '{}',
            // The proxy backs off on 9074 for up to ~30s before answering, so the
            // client timeout has to be well clear of that. A timeout here would
            // leave the user clicking again while the first claim is still running.
            signal: AbortSignal.timeout(90000),
          });
          const payload = await response.json();
          return sendJson(res, 200, isRecord(payload) ? payload : {});
        } catch (error) {
          runtime.record(`trae: check-in request failed: ${error.message}`);
          return sendJson(res, 502, { ok: false, code: 0, message: error.message });
        }
      }
      // WorkBuddy's account read. `/workbuddy/v1/*` is a root path, not a provider
      // basePath, so request() would ask for `/commandcode/v1/workbuddy/v1/...`.
      if (method === 'GET' && route === '/workbuddy/status') {
        if (runtime.state !== 'running' && runtime.state !== 'external') await runtime.start();
        const response = await fetch(`${runtime.serviceUrl('/workbuddy/v1')}/account`, {
          headers: { ...runtime.headers() },
          signal: AbortSignal.timeout(15000),
        }).catch((reason) => ({ json: async () => ({ error: String(reason) }) }));
        let payload = {};
        try {
          payload = await response.json();
        } catch {
          payload = { error: 'the proxy answered with no JSON' };
        }
        if (!isRecord(payload)) payload = { error: 'unexpected account payload' };
        return sendJson(res, 200, payload);
      }
      // The capture opens a browser and polls for five minutes, so it cannot be
      // awaited here; it runs detached and reports through the log tab. No backup:
      // the script overwrites one file, and unlike the deepseek capture there is no
      // half-set to distinguish - if it dies the file is either the old credential
      // or nothing, both of which the status read already reports honestly.
      if (method === 'POST' && route === '/workbuddy/login') {
        const root = resolveProjectRoot(runtime.settings);
        if (!root) {
          sendJson(res, 400, { error: 'project directory not found; set it in the settings above' });
          return;
        }
        if (runtime.workBuddyLogin) {
          sendJson(res, 409, { ...workBuddyStatus(runtime.settings), started: false, alreadyRunning: true });
          return;
        }
        const script = path.join(root, '.tmp-workbuddy-login.ts');
        if (!fs.existsSync(script)) {
          sendJson(res, 400, {
            error: 'login script not found at .tmp-workbuddy-login.ts',
            root,
          });
          return;
        }
        const deno = runtime.settings.denoPath || 'deno';
        const child = spawn(deno, ['run', '-A', '.tmp-workbuddy-login.ts'], {
          cwd: root,
          // Visible: the browser it opens has to come up in front of the user.
          windowsHide: false,
          env: { ...process.env, DENO_NO_UPDATE_CHECK: '1' },
          stdio: 'inherit',
        });
        runtime.workBuddyLogin = child;
        runtime.record(
          `workbuddy: signing in through the browser in ${root} — finish in the page that opens`,
        );
        child.on('exit', (code) => {
          runtime.workBuddyLogin = null;
          const after = workBuddyStatus(runtime.settings);
          runtime.record(
            code === 0 && after.configured
              ? 'workbuddy: sign-in finished; the channel is ready'
              : `workbuddy: sign-in exited ${code} without capturing a credential`,
          );
        });
        return sendJson(res, 200, { started: true });
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
        const before = Array.isArray(projectAdapter?.lastRoster) ? projectAdapter.lastRoster : [];
        await runtime.stop();
        await runtime.start();
        // Re-read the roster right away. Restarting is exactly when someone wants
        // to know what the proxy can see now, and the roster is never cached, so
        // this is one fresh read rather than an invalidation dance.
        //
        // It cannot push the harness's own selector to re-discover: that catalog
        // is loaded once per Host generation and only reset by a connection
        // reset, and the event that would refresh it is emitted by the host, not
        // by a plugin. What this does buy is the answer to "is the channel back"
        // without waiting for a DSH restart.
        let roster = [];
        let rosterError = '';
        try {
          roster = projectAdapter ? await projectAdapter.listProjectModels() : [];
        } catch (error) {
          rosterError = error instanceof Error ? error.message : String(error);
        }
        const ids = roster.map((model) => model.id);
        const added = before.length === 0 ? [] : ids.filter((id) => !before.includes(id));
        const removed = before.length === 0 ? [] : before.filter((id) => !ids.includes(id));
        if (added.length > 0 || removed.length > 0) {
          runtime.record(
            `roster after restart: ${ids.length} models, +${added.length} -${removed.length}` +
              (added.length ? ` added ${added.slice(0, 3).join(', ')}` : '') +
              (removed.length ? ` lost ${removed.slice(0, 3).join(', ')}` : ''),
          );
        }
        return sendJson(res, 200, {
          ...runtime.snapshot(),
          roster: { count: ids.length, added, removed, error: rosterError },
        });
      }
      return sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      return sendJson(res, 502, { error: error instanceof Error ? error.message : String(error), runtime: runtime.snapshot() });
    }
  };
}

/**
 * The two methods a reload has to reach.
 *
 * DSH keeps the adapter *instance* for the life of the process, and `prepareCall`
 * already hands it a closure over `this.stream`. Re-importing the module would
 * therefore change nothing for a running session - the instance's methods were
 * bound at construction. Swapping the prototype entries that `prepareCall` and
 * `resolveModel` call through is what makes an edit actually reach the live
 * adapter.
 */
const HOT = {
  stream: AiProxyAdapter.prototype.stream,
  resolveModel: AiProxyAdapter.prototype.resolveModel,
};

/**
 * Watch the installed copy and the repository, sync one to the other, and swap
 * the prototype entries above.
 *
 * Watching both matters because they are different kinds of install: `web` is a
 * junction onto the repo, `desktop` is a real copy, and the copy is the one in
 * daily use. Editing either one now takes effect without restarting DSH.
 *
 * Debounced because an editor that saves via write-then-rename emits more than
 * one event per save, and re-importing on each would reload a half-written file.
 */
function installHotReload(config = {}) {
  const dirs = new Set([PLUGIN_DIR]);
  // The project root is already configured (the panel's 项目目录 field), and the
  // repository keeps the plugin under `<projectRoot>/dsh-plugin`. That is the
  // directory an edit actually lands in, so it is the one worth watching.
  const root = process.env.AI_PROXY_PLUGIN_REPO || config.projectRoot || '';
  const repo = root ? path.join(path.resolve(root), 'dsh-plugin') : '';
  if (repo && fs.existsSync(repo)) dirs.add(repo);
  const SYNCED = ['index.js', 'client.js', 'self-test.mjs', 'stats.mjs', 'stats.test.mjs', 'package.json', 'cordis.patch.yml'];
  let timer = null;
  let applying = false;
  const self = path.join(PLUGIN_DIR, 'index.js');

  const reload = async () => {
    if (applying) return;
    applying = true;
    try {
      // Keep the two installs identical first: a reload that picked up the copy
      // while the repo still held new code would undo the edit.
      if (repo && dirs.has(repo)) {
        const from = await findNewest(SYNCED.map((f) => path.join(repo, f)));
        if (from) {
          for (const file of SYNCED) {
            const src = path.join(repo, file);
            const dst = path.join(PLUGIN_DIR, file);
            if (!fs.existsSync(src) || src === dst) continue;
            if (fs.readFileSync(src, 'utf8') === fs.readFileSync(dst, 'utf8')) continue;
            fs.copyFileSync(src, dst);
          }
        }
      }
      const mod = await import(pathToFileURL(self).href + '?hot=' + Date.now());
      const next = mod.AiProxyAdapter?.prototype;
      if (!next?.stream) throw new Error('reloaded module has no AiProxyAdapter.stream');
      HOT.stream = next.stream;
      HOT.resolveModel = next.resolveModel;
      HOT.at = Date.now();
      HOT.status = `reloaded ${new Date().toLocaleTimeString()}`;
    } catch (error) {
      HOT.status = `reload failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      applying = false;
    }
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void reload(); }, 250);
    if (typeof timer.unref === 'function') timer.unref();
  };

  for (const dir of dirs) {
    try {
      fs.watch(dir, { persistent: false }, (_event, filename) => {
        if (!filename || String(filename).endsWith('.js') || String(filename).endsWith('.mjs')) schedule();
      });
    } catch { /* a profile that is not there yet is not worth failing over */ }
  }
}

/** Which of the given files was written most recently, if any exist. */
async function findNewest(files) {
  let best = null;
  for (const file of files) {
    try {
      const mtime = (await fs.promises.stat(file)).mtimeMs;
      if (!best || mtime > best.mtime) best = { file, mtime };
    } catch { /* absent files do not win the comparison */ }
  }
  return best;
}

export function apply(ctx, config = {}) {
  const runtime = new ProxyRuntime(config);
  // A sibling of the proxy, not a child of it: see TunnelRuntime's header for why
  // their lifetimes are different.
  const tunnel = new TunnelRuntime(runtime);
  runtime.tunnel = tunnel;
  const resolveImage = installImageResolver(ctx, ctx?.logger);
  const adapter = new AiProxyAdapter({ runtime, resolveImage });
  // The roster goes through the constructor: a capability assigned afterwards
  // leaves every call outside apply() answering with the whole aggregate, which
  // looks exactly like the split not existing.
  const projectAdapter = new ProjectAdapter({
    runtime,
    resolveImage,
    // The roster carries each group id together with its heading.
    channelGroups: CHANNEL_GROUPS,
  });
  const entryId = ctx.fiber?.entry?.options?.id ?? name;
  const groupProviders = Object.keys(CHANNEL_GROUPS);
  // One adapter instance serves every provider: the Host's registerAdapter takes
  // a list and asks providerInfo(provider) once per entry, so each group narrows
  // its own listing through the same object.
  const registration = ctx.llm.registerAdapter(
    [PROJECT_ROUTE, ...groupProviders],
    projectAdapter,
  );
  // ai-proxy stays the only configurable provider. Registering the channels
  // here would put seven API-key prompts in the settings page for one proxy that
  // has a single address - dead controls, and the user asked for this split to be
  // invisible outside the picker.
  ctx.llm.registerConfigurableProviders?.([
    { provider: PROJECT_ROUTE, displayName: 'ai-proxy', settingsNs: entryId, settingsPath: [] },
  ]);
  // The Host builds its model catalog once per generation, and it does that as
  // soon as the plugin loads - which is before the proxy it has to ask is
  // listening. A cold start measured three seconds apart, and a catalog built
  // against a proxy that is not up yet is kept, so the channels that were missing
  // simply never appear in the picker.
  //
  // Retrying here is the only place that can help: the Host has no retry of its
  // own, and a later successful call would not be read.
  ctx.llm.registerModelDiscovery?.(entryId, async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) {
        await new Promise((done) => setTimeout(done, 2000 * attempt));
      }
      try {
        const rows = await projectAdapter.listProjectModels();
        if (rows.length > 0) return rows;
      } catch {
        // The proxy is not up yet. Try again while attempts remain.
      }
    }
    return [];
  });
  ctx.inject?.(['webServer'], (scoped) => {
    const handler = apiHandler(adapter, runtime, projectAdapter, tunnel);
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
  installHotReload(config);
  return () => {
    void runtime.stop();
    registration?.dispose?.();
    // A pending usage write is coalesced for 800ms, so a teardown right after
    // a turn would otherwise drop it. Flushing here makes the last call before a
    // restart survive it.
    flushUsage();
  };
}
