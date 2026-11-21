// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Itera / DevFellowship
// tma-run-cost/1 (plan 20261112-tma-c7-model-comparison-per-use-case, C7-COST): the body of POST /eval-results/run-cost.
// It adds a DERIVED cost to runs that are already stored: the measured tokens of each run at the published list price
// of one model. Numbers and identifiers only. It carries no patch, no grade and no text beyond a source URL.
// The API finds each run by its stored token counts, recomputes the cost with derivedCostUsd, and writes only
// runs.model_cost_usd and runs.model_cost_source (never a grade, a digest or any other column).

export const RUN_COST_FORMAT = 'tma-run-cost/1';
/** The most runs in one call (one upload holds at most 50 runs). */
export const RUN_COST_MAX_RUNS = 50;
const MAX_TOKENS = 4_000_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const BODY_KEYS = ['format', 'evaluation_id', 'dry_run', 'price', 'runs'];
const PRICE_KEYS = ['model_id', 'input', 'cache_read', 'cache_write', 'output', 'source_url', 'as_of', 'table_sha256'];
const RUN_KEYS = ['tokens_in', 'tokens_out', 'cache_read_tokens', 'cache_write_tokens'];

/** @param {unknown} v */
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** @param {unknown} v */
const positive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
/** @param {unknown} v */
const tokenCount = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_TOKENS;

/**
 * USD of one run at a list price (USD per 1M tokens). `tokensIn` is the TOTAL input (cache reads and writes included);
 * the fresh input is what is left after the cache tokens. A null cache price bills those tokens at the input price.
 * null when a token count is missing or the cache split is larger than the input. Rounded to 6 decimals.
 * @param {{input: number, cache_read: number | null, cache_write: number | null, output: number}} price
 * @param {{tokensIn: number | null, tokensOut: number | null, cacheRead?: number | null, cacheWrite?: number | null}} usage
 * @returns {number | null}
 */
export function derivedCostUsd(price, usage) {
  if (usage.tokensIn === null || usage.tokensOut === null) return null;
  const read = usage.cacheRead ?? 0;
  const write = usage.cacheWrite ?? 0;
  const fresh = usage.tokensIn - read - write;
  if (fresh < 0) return null;
  const usd = (fresh * price.input + read * (price.cache_read ?? price.input) + write * (price.cache_write ?? price.input) + usage.tokensOut * price.output) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}

/**
 * Validate a parsed tma-run-cost/1 body. Closed: an unknown key is an issue with its path.
 * @param {unknown} value
 * @returns {{ok: true, value: any} | {ok: false, issues: Array<{code: string, path: string, message: string}>}}
 */
export function validateRunCost(value) {
  /** @type {Array<{code: string, path: string, message: string}>} */
  const issues = [];
  const bad = (/** @type {string} */ code, /** @type {string} */ path, /** @type {string} */ message) => void issues.push({ code, path, message });
  if (!isObject(value)) return { ok: false, issues: [{ code: 'invalid_body', path: '/', message: 'the body must be a JSON object' }] };
  for (const k of Object.keys(value)) if (!BODY_KEYS.includes(k)) bad('unknown_key', `/${k}`, `unknown key ${k}`);
  if (value.format !== RUN_COST_FORMAT) bad('invalid_format', '/format', `format must be ${RUN_COST_FORMAT}`);
  if (typeof value.evaluation_id !== 'string' || !UUID.test(value.evaluation_id)) bad('invalid_evaluation_id', '/evaluation_id', 'evaluation_id must be a lowercase uuid');
  if ('dry_run' in value && typeof value.dry_run !== 'boolean') bad('invalid_dry_run', '/dry_run', 'dry_run must be true or false');
  const p = value.price;
  if (!isObject(p)) bad('invalid_price', '/price', 'price must be an object');
  else {
    for (const k of Object.keys(p)) if (!PRICE_KEYS.includes(k)) bad('unknown_key', `/price/${k}`, `unknown key ${k}`);
    if (typeof p.model_id !== 'string' || !MODEL.test(p.model_id)) bad('invalid_price', '/price/model_id', 'model_id is malformed');
    for (const k of ['input', 'output']) if (!positive(p[k])) bad('invalid_price', `/price/${k}`, `${k} must be a number greater than 0`);
    for (const k of ['cache_read', 'cache_write']) if (p[k] !== null && !positive(p[k])) bad('invalid_price', `/price/${k}`, `${k} must be a number greater than 0, or null`);
    if (typeof p.source_url !== 'string' || !p.source_url.startsWith('https://') || p.source_url.length <= 8 || p.source_url.length > 300) bad('invalid_price', '/price/source_url', 'source_url must be an https URL of at most 300 characters');
    if (typeof p.as_of !== 'string' || !DATE.test(p.as_of)) bad('invalid_price', '/price/as_of', 'as_of must be YYYY-MM-DD');
    if (typeof p.table_sha256 !== 'string' || !SHA256.test(p.table_sha256)) bad('invalid_price', '/price/table_sha256', 'table_sha256 must be a sha256 hex digest');
  }
  const runs = value.runs;
  if (!Array.isArray(runs) || runs.length < 1 || runs.length > RUN_COST_MAX_RUNS) bad('invalid_runs', '/runs', `runs must hold 1 to ${RUN_COST_MAX_RUNS} items`);
  else {
    runs.forEach((r, i) => {
      const w = `/runs/${i}`;
      if (!isObject(r)) return bad('invalid_runs', w, 'a run is an object');
      for (const k of Object.keys(r)) if (!RUN_KEYS.includes(k)) bad('unknown_key', `${w}/${k}`, `unknown key ${k}`);
      for (const k of RUN_KEYS) if (!tokenCount(r[k])) bad('invalid_runs', `${w}/${k}`, `${k} must be a token count (integer, 0 or more)`);
      if (tokenCount(r.tokens_in) && tokenCount(r.cache_read_tokens) && tokenCount(r.cache_write_tokens) && r.cache_read_tokens + r.cache_write_tokens > r.tokens_in) {
        bad('invalid_runs', w, 'cache_read_tokens + cache_write_tokens are part of tokens_in and cannot be more than it');
      }
    });
  }
  return issues.length ? { ok: false, issues } : { ok: true, value };
}
