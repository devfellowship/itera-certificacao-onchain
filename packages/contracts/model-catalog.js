// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Itera / DevFellowship
// The model catalog of TestMyAgent: which lab made a model (the provider enum) and which route ran it
// (the route enum). The data lives in model-catalog/labs.json and model-catalog/routes.json: add a
// lab or a route there, not here. Pure (no fs, no DOM), so apps/web2 (browser), apps/api (node) and
// the local-result validator share the same match rules (plan 20261026-tma-local-runner-and-self-
// declared-results, ADR-4).
import labsData from './model-catalog/labs.json' with { type: 'json' };
import routesData from './model-catalog/routes.json' with { type: 'json' };

/** @typedef {{ key: string, name: string, logo: string }} Lab */
/** @typedef {{ key: string, name: string }} ModelRoute */

/** @type {Lab} */
export const FALLBACK_LAB = labsData.fallback;
const ROUTE_PREFIXES = new Set(labsData.routePrefixes.map((p) => p.toLowerCase()));
const COMPILED = labsData.labs.map((l) => ({
  key: l.key,
  name: l.name,
  logo: l.logo,
  authors: new Set(l.openrouter.map((a) => a.toLowerCase())),
  patterns: l.patterns.map((p) => new RegExp(p)),
}));

/** Every known lab, in match order (the fallback is not in this list). @type {Lab[]} */
export const LABS = COMPILED.map(({ key, name, logo }) => ({ key, name, logo }));

/** The provider enum: the key of every known lab (the fallback `generic` is not a provider). @type {string[]} */
export const PROVIDER_KEYS = LABS.map((l) => l.key);

/** Lab name by key, including the fallback. @type {Record<string, string>} */
export const PROVIDER_NAME = Object.fromEntries([...LABS, FALLBACK_LAB].map((l) => [l.key, l.name]));

/** @param {{ key: string, name: string, logo: string }} l @returns {Lab} */
const pub = ({ key, name, logo }) => ({ key, name, logo });

/**
 * Lab of a model from whatever the caller has: a model id (`z-ai/glm-4.6`, `ollama/gemma4:12b`,
 * `opencode-go/deepseek-v4-pro`, `gpt-5.5`), a provider name, a display label. Unknown -> the fallback lab.
 * @param {{ id?: string | null, provider?: string | null, label?: string | null }} m
 * @returns {Lab}
 */
export function labOf(m) {
  const id = (m.id ?? '').trim().toLowerCase();
  const rawPrefix = id.includes('/') ? id.split('/')[0].replace(/^~/, '') : '';
  // A route prefix (ollama/, opencode-go/, ...) names where the model ran, not who made it.
  const prefix = ROUTE_PREFIXES.has(rawPrefix) ? '' : rawPrefix;
  if (prefix) {
    const byAuthor = COMPILED.find((l) => l.authors.has(prefix));
    if (byAuthor) return pub(byAuthor);
  }
  // The id prefix is the strongest signal; then the provider field; then the full id; then the free-text label.
  for (const text of [prefix, m.provider, id, m.label]) {
    const s = (text ?? '').toLowerCase();
    if (!s) continue;
    for (const lab of COMPILED) if (lab.patterns.some((re) => re.test(s))) return pub(lab);
  }
  return FALLBACK_LAB;
}

/**
 * Lab key of a model (see `labOf`). Unknown -> `generic`.
 * @param {{ id?: string | null, provider?: string | null, label?: string | null }} m
 */
export function providerOf(m) {
  return labOf(m).key;
}

/** @type {Record<string, ModelRoute>} */
const PREFIXES = routesData.prefixes;
/** @type {ModelRoute} */
export const DEFAULT_ROUTE = routesData.default;

/** Every known route, in file order. @type {ModelRoute[]} */
export const ROUTES = Object.values(PREFIXES).map(({ key, name }) => ({ key, name }));

/** The route enum: the key of every known route. @type {string[]} */
export const ROUTE_KEYS = ROUTES.map((r) => r.key);

/**
 * Route of a model id (`opencode-go/deepseek-v4-pro`, `ollama/gemma4:12b`, `anthropic/claude-haiku-4.5`). Unknown or empty -> OpenRouter.
 * @param {string | null | undefined} modelId
 * @returns {ModelRoute}
 */
export function routeOf(modelId) {
  const id = (modelId ?? '').trim().toLowerCase();
  const prefix = id.includes('/') ? id.split('/')[0].replace(/^~/, '') : '';
  return Object.hasOwn(PREFIXES, prefix) ? PREFIXES[prefix] : DEFAULT_ROUTE;
}

/** True when `key` is in the provider enum. @param {unknown} key */
export function isProviderKey(key) {
  return typeof key === 'string' && PROVIDER_KEYS.includes(key);
}

/** True when `key` is in the route enum. @param {unknown} key */
export function isRouteKey(key) {
  return typeof key === 'string' && ROUTE_KEYS.includes(key);
}
