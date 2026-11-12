// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Itera / DevFellowship
// The self-declared local result (tma-local-result/1): the ONE body that POST /self-declared-results
// accepts (plan 20261026-tma-local-runner-and-self-declared-results, ADR-1). Numbers and identifiers
// only. The closed schema is schemas/local-result.schema.json (a port of the retired operator import's
// parser, services/runner/src/bench-import.ts, deleted in plan ADR-3; see git history). This file adds the checks a JSON Schema cannot say.
// tma-local-result/2 (plan 20261112-tma-c4-result-store-trajectory-upload, T1 and T8) is v1 plus the test case
// (the problem), the agent variant (a base agent version plus one diff), their comparison (baseline flag,
// prediction), per-grader results, infra_ok and the structural trajectory of each run; its closed schema is
// schemas/local-result-v2.schema.json. The case and the variant are independent (parent plan ADR-26): an
// upload is one crossing of the two. v1 stays accepted with its own key and limits.
// tma-local-result/3 (same plan, T9, T10 and T11; ADR-3: "A new field needs a contract PR (/3)") is /2 plus the
// optional case task summary, the grader version fields (proof, calibration, note, author), the label fields
// (reason_code, labeler) and a run trajectory of tma-trajectory/1 or tma-trajectory/2; its closed schema is
// schemas/local-result-v3.schema.json. /2 is unchanged and stays accepted; /3 has the /2 limits and rules.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isProviderKey, isRouteKey, PROVIDER_KEYS, ROUTE_KEYS } from './model-catalog.js';
import { trajectorySchema, trajectoryStepIssues, trajectoryV2Schema } from './trajectory.js';

const require = createRequire(import.meta.url);
/** @type {typeof import('ajv/dist/2020.js').default} */
const Ajv2020 = require('ajv/dist/2020.js');

export const LOCAL_RESULT_FORMAT = 'tma-local-result/1';
/** The largest body that the API accepts (1 MiB, the route limit of POST /self-declared-results). */
export const LOCAL_RESULT_MAX_BYTES = 1024 * 1024;
export const METRICS_SHAPES = /** @type {const} */ (['tma-score/1', 'transcript-mining/1', 'trajectory/1']);

export const LOCAL_RESULT_V2_FORMAT = 'tma-local-result/2';
/** The largest v2 body (4 MiB): up to 50 runs of up to 2,000 trajectory steps each. */
export const LOCAL_RESULT_V2_MAX_BYTES = 4 * 1024 * 1024;
/** The most runs in one v2 upload. */
export const LOCAL_RESULT_V2_MAX_RUNS = 50;
/** tma-local-result/3: /2 plus the task summary, grader version and label fields, and tma-trajectory/2 runs. Same limits as /2. */
export const LOCAL_RESULT_V3_FORMAT = 'tma-local-result/3';
/**
 * The kind of the ONE diff of an agent variant on its base agent version (parent plan ADR-26): the model, the
 * system prompt and what is injected into it (rules, skill, retrieval, memory), the configured tools (tools,
 * mcp, permissions), orchestration, limits, the harness. none = the base agent unchanged.
 */
export const VARIANT_CHANGE_KINDS = /** @type {const} */ ([
  'prompt', 'rules', 'skill', 'retrieval', 'memory', 'model', 'tools', 'mcp', 'permissions', 'orchestration', 'limits', 'harness', 'none',
]);
/** The fields of a base agent version (tma-local-result/2 variant.agent), in canonical order. */
export const AGENT_VERSION_FIELDS = /** @type {const} */ ([
  'harness', 'harness_version', 'harness_repo_sha', 'model_id', 'rules_sha256', 'skills_sha256', 'mcp_manifest_sha256', 'tools_sha256',
]);
/** sha256 of the empty string: the variant_sha256 of change_kind none. */
export const EMPTY_DIFF_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
export const GRADER_KINDS = /** @type {const} */ (['code', 'judge', 'human']);
export const CASE_MODES = /** @type {const} */ (['replay', 'trace_review']);

export const localResultSchema = JSON.parse(readFileSync(new URL('./schemas/local-result.schema.json', import.meta.url), 'utf-8'));
export const localResultV2Schema = JSON.parse(readFileSync(new URL('./schemas/local-result-v2.schema.json', import.meta.url), 'utf-8'));
export const localResultV3Schema = JSON.parse(readFileSync(new URL('./schemas/local-result-v3.schema.json', import.meta.url), 'utf-8'));

const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false });
const validateFn = ajv.compile(localResultSchema);
// The v2 and v3 schemas refer to the trajectory schemas by their $id (sibling files): /2 takes tma-trajectory/1
// only (trajectory.schema.json); a /3 run's trajectory takes the one its `format` names (trajectory-v2.schema.json for
// tma-trajectory/2).
ajv.addSchema(trajectorySchema);
ajv.addSchema(trajectoryV2Schema);
const validateV2Fn = ajv.compile(localResultV2Schema);
const validateV3Fn = ajv.compile(localResultV3Schema);

/**
 * @typedef {{ code: 'unknown_key' | 'invalid' | 'too_large' | 'not_json' | 'unknown_provider' | 'unknown_route' | 'inconsistent', path: string, message: string }} LocalResultIssue
 */

/**
 * @param {import('ajv').ErrorObject[] | null | undefined} errors
 * @returns {LocalResultIssue[]}
 */
function issuesOf(errors) {
  /** @type {LocalResultIssue[]} */
  const out = [];
  for (const e of errors ?? []) {
    // `if` only reports that its `then` failed; the `then` errors themselves carry the detail.
    if (e.keyword === 'if') continue;
    // `trajectory` is null or a record (oneOf): the record branch carries the detail, so drop the
    // oneOf summary and the "must be null" of the null branch.
    if (e.keyword === 'oneOf' || e.schemaPath.endsWith('/oneOf/0/type')) continue;
    if (e.keyword === 'additionalProperties') {
      const key = /** @type {{ additionalProperty: string }} */ (e.params).additionalProperty;
      out.push({ code: 'unknown_key', path: `${e.instancePath}/${key}`, message: 'unknown key (a local result holds numbers and identifiers only)' });
      continue;
    }
    out.push({ code: 'invalid', path: e.instancePath || '/', message: e.message ?? 'is invalid' });
  }
  return out;
}

/** @param {LocalResultIssue[]} issues */
function failed(issues) {
  return { ok: /** @type {const} */ (false), issues, errors: issues.map((i) => `${i.path} ${i.message}`) };
}

/**
 * Validate a parsed local result: the closed schema, then the catalog enums (provider, route) and the
 * cross-field rules (summary.runs = the length of runs, ran_from <= ran_to).
 * @param {unknown} value
 */
export function validateLocalResult(value) {
  if (!validateFn(value)) return failed(issuesOf(validateFn.errors));
  const v = /** @type {any} */ (value);
  const issues = commonIssues(v);
  if (issues.length > 0) return failed(issues);
  return { ok: /** @type {const} */ (true), value: v };
}

/**
 * The cross-field rules that v1 and v2 share.
 * @param {any} v a schema-valid local result
 * @returns {LocalResultIssue[]}
 */
function commonIssues(v) {
  /** @type {LocalResultIssue[]} */
  const issues = [];
  if (v.executor.provider !== null && !isProviderKey(v.executor.provider)) {
    issues.push({ code: 'unknown_provider', path: '/executor/provider', message: `must be one of ${PROVIDER_KEYS.join(', ')} or null` });
  }
  if (!isRouteKey(v.executor.route)) {
    issues.push({ code: 'unknown_route', path: '/executor/route', message: `must be one of ${ROUTE_KEYS.join(', ')}` });
  }
  if (v.summary.runs !== v.runs.length) {
    issues.push({ code: 'inconsistent', path: '/summary/runs', message: `says ${v.summary.runs}, the list has ${v.runs.length}` });
  }
  if (Date.parse(v.ran_from) > Date.parse(v.ran_to)) {
    issues.push({ code: 'inconsistent', path: '/ran_from', message: 'is after ran_to' });
  }
  return issues;
}

/**
 * Validate a parsed tma-local-result/2: the closed schema (with tma-trajectory/1 per run), the v1
 * cross-field rules, and the v2 rules: the baseline has change_kind none and no prediction, every
 * other variant has a prediction; change_kind none has the empty diff digest; the executor model is the
 * base model unless the diff is the model; a replay case has an origin pin; one run per
 * (item_sha256, kind, repeat); unique grader ids per run; a tma-score run with status infra_error has
 * infra_ok false; the trajectory step rules of trajectory.js.
 * @param {unknown} value
 */
export function validateLocalResultV2(value) {
  if (!validateV2Fn(value)) return failed(issuesOf(validateV2Fn.errors));
  return checkedV2(/** @type {any} */ (value));
}

/**
 * Validate a parsed tma-local-result/3: the closed schema (a run trajectory of tma-trajectory/1 or /2, the optional
 * task summary, grader version and label fields), the /2 rules, and the /3 rules: a grader proof catches at most its
 * planted bugs; calibration belongs to a judge and its 2x2 table adds up to n_test (at most n_labels); every run that
 * names a grader version sends the same proof, calibration, note and author.
 * @param {unknown} value
 */
export function validateLocalResultV3(value) {
  if (!validateV3Fn(value)) return failed(issuesOf(validateV3Fn.errors));
  return checkedV2(/** @type {any} */ (value));
}

/**
 * The cross-field rules of /2 and /3 on a schema-valid body. The grader version rules find nothing on a /2 body,
 * because its schema has none of those keys.
 * @param {any} v
 */
function checkedV2(v) {
  const issues = commonIssues(v);
  if (v.comparison.is_baseline) {
    if (v.variant.change_kind !== 'none') issues.push({ code: 'inconsistent', path: '/variant/change_kind', message: 'must be none for the baseline' });
    if (v.comparison.prediction_sha256 !== null) issues.push({ code: 'inconsistent', path: '/comparison/prediction_sha256', message: 'must be null for the baseline' });
  } else if (v.comparison.prediction_sha256 === null) {
    issues.push({ code: 'inconsistent', path: '/comparison/prediction_sha256', message: 'is required for a variant that is not the baseline' });
  }
  if (v.variant.change_kind === 'none' && v.variant.variant_sha256 !== EMPTY_DIFF_SHA256) {
    issues.push({ code: 'inconsistent', path: '/variant/variant_sha256', message: 'must be the sha256 of the empty string when change_kind is none' });
  }
  // The executor ran the base model, unless the one diff is the model.
  if (v.variant.change_kind === 'model') {
    if (v.executor.model_id === v.variant.agent.model_id) issues.push({ code: 'inconsistent', path: '/executor/model_id', message: 'must differ from variant.agent.model_id when change_kind is model' });
  } else if (v.executor.model_id !== v.variant.agent.model_id) {
    issues.push({ code: 'inconsistent', path: '/executor/model_id', message: 'must equal variant.agent.model_id unless change_kind is model' });
  }
  if (v.case.mode === 'replay' && v.case.origin_pin_sha256 === null) {
    issues.push({ code: 'inconsistent', path: '/case/origin_pin_sha256', message: 'is required when mode is replay' });
  }
  /** @type {Set<string>} */
  const runKeys = new Set();
  /** The grader-version fields of the first run that names each version (id@semver#code digest). */
  /** @type {Map<string, string>} */
  const versionFields = new Map();
  v.runs.forEach((/** @type {any} */ run, /** @type {number} */ i) => {
    const key = `${run.item_sha256}:${run.kind ?? ''}:${run.repeat}`;
    if (runKeys.has(key)) issues.push({ code: 'inconsistent', path: `/runs/${i}/repeat`, message: 'repeats an earlier run (same item_sha256, kind and repeat)' });
    runKeys.add(key);
    /** @type {Set<string>} */
    const graderIds = new Set();
    run.graders.forEach((/** @type {any} */ g, /** @type {number} */ j) => {
      if (graderIds.has(g.id)) issues.push({ code: 'inconsistent', path: `/runs/${i}/graders/${j}/id`, message: 'repeats an earlier grader of this run' });
      graderIds.add(g.id);
      issues.push(...graderVersionIssues(g, `/runs/${i}/graders/${j}`));
      const version = `${g.id}@${g.semver}#${g.code_sha256}`;
      const fields = graderVersionFieldsKey(g);
      const first = versionFields.get(version);
      if (first === undefined) versionFields.set(version, fields);
      else if (first !== fields) {
        issues.push({ code: 'inconsistent', path: `/runs/${i}/graders/${j}`, message: `proof, calibration, note and author of grader version ${version} differ from an earlier run` });
      }
    });
    if (run.status === 'infra_error' && run.infra_ok) {
      issues.push({ code: 'inconsistent', path: `/runs/${i}/infra_ok`, message: 'must be false when status is infra_error' });
    }
    if (run.trajectory !== null) issues.push(...trajectoryStepIssues(run.trajectory.steps, `/runs/${i}/trajectory/steps`));
  });
  if (issues.length > 0) return failed(issues);
  return { ok: /** @type {const} */ (true), value: v };
}

/** The keys of a grader entry that belong to the grader VERSION (grader_versions), not to one result. */
export const GRADER_VERSION_FIELDS = /** @type {const} */ (['proof', 'calibration', 'note', 'author']);
/** The closed reason of a label (grader_results.reason_code; the S13 chips). */
export const GRADER_REASON_CODES = /** @type {const} */ (['wrong_sha', 'no_check', 'partial', 'other']);

/**
 * The cross-field rules of the optional grader-version fields of /3 (plan T11): a proof catches at most the planted bugs;
 * calibration belongs to a judge, and its 2x2 table adds up to the test split, which is at most the labels.
 * @param {any} g a schema-valid grader entry
 * @param {string} at its JSON pointer
 * @returns {LocalResultIssue[]}
 */
function graderVersionIssues(g, at) {
  /** @type {LocalResultIssue[]} */
  const issues = [];
  if (g.proof != null && g.proof.caught > g.proof.total) {
    issues.push({ code: 'inconsistent', path: `${at}/proof/caught`, message: `is ${g.proof.caught}, more than the ${g.proof.total} planted bugs` });
  }
  const c = g.calibration;
  if (c != null) {
    if (g.kind !== 'judge') issues.push({ code: 'inconsistent', path: `${at}/calibration`, message: 'is for a judge only (kind judge)' });
    const sum = c.tp + c.fn + c.tn + c.fp;
    if (sum !== c.n_test) issues.push({ code: 'inconsistent', path: `${at}/calibration/n_test`, message: `is ${c.n_test}; tp + fn + tn + fp is ${sum}` });
    if (c.n_test > c.n_labels) issues.push({ code: 'inconsistent', path: `${at}/calibration/n_test`, message: `is ${c.n_test}, more than n_labels ${c.n_labels}` });
  }
  return issues;
}

/**
 * The grader-version fields of a grader entry as one canonical string (an absent key = null), to compare two runs
 * that name the same version.
 * @param {any} g
 */
export function graderVersionFieldsKey(g) {
  const canon = (/** @type {unknown} */ x) =>
    x !== null && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, /** @type {any} */ (x)[k]])) : x;
  return JSON.stringify(GRADER_VERSION_FIELDS.map((k) => [k, canon(g[k] ?? null)]));
}

/**
 * The digest of a base agent version (variant.agent of tma-local-result/2): sha256 of the canonical JSON of
 * its fields in AGENT_VERSION_FIELDS order (null kept). The API stores it as eval_variants.agent_sha256; with
 * variant_sha256 it is the identity of an agent variant.
 * @param {Record<string, string | null>} agent
 * @returns {string}
 */
export function agentVersionSha256(agent) {
  const canonical = JSON.stringify(AGENT_VERSION_FIELDS.map((k) => [k, agent[k] ?? null]));
  return createHash('sha256').update(`tma-agent-version/1\n${canonical}`).digest('hex');
}

/**
 * Validate a parsed local result of either version, by its `format`. A value with no known format is
 * checked as v1, so its issues name the v1 contract.
 * @param {unknown} value
 */
export function validateAnyLocalResult(value) {
  const format = value !== null && typeof value === 'object' ? /** @type {any} */ (value).format : undefined;
  if (format === LOCAL_RESULT_V2_FORMAT) return { ...validateLocalResultV2(value), format: LOCAL_RESULT_V2_FORMAT };
  if (format === LOCAL_RESULT_V3_FORMAT) return { ...validateLocalResultV3(value), format: LOCAL_RESULT_V3_FORMAT };
  return { ...validateLocalResult(value), format: LOCAL_RESULT_FORMAT };
}

/**
 * Parse and validate the raw text of a local result (a CLI file, a request body). Refuses a text
 * above LOCAL_RESULT_MAX_BYTES before it parses it.
 * @param {string} text
 */
export function parseLocalResultText(text) {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > LOCAL_RESULT_MAX_BYTES) {
    return failed([{ code: 'too_large', path: '/', message: `is ${bytes} bytes; the limit is ${LOCAL_RESULT_MAX_BYTES}` }]);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return failed([{ code: 'not_json', path: '/', message: 'is not JSON' }]);
  }
  return validateLocalResult(value);
}

/**
 * Parse and validate the raw text of a local result of either version. Refuses a text above
 * LOCAL_RESULT_V2_MAX_BYTES before it parses it, and a v1 text above LOCAL_RESULT_MAX_BYTES after.
 * @param {string} text
 */
export function parseAnyLocalResultText(text) {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > LOCAL_RESULT_V2_MAX_BYTES) {
    return { ...failed([{ code: 'too_large', path: '/', message: `is ${bytes} bytes; the limit is ${LOCAL_RESULT_V2_MAX_BYTES}` }]), format: undefined };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { ...failed([{ code: 'not_json', path: '/', message: 'is not JSON' }]), format: undefined };
  }
  const result = validateAnyLocalResult(value);
  if (result.format === LOCAL_RESULT_FORMAT && bytes > LOCAL_RESULT_MAX_BYTES) {
    return { ...failed([{ code: 'too_large', path: '/', message: `is ${bytes} bytes; the limit of ${LOCAL_RESULT_FORMAT} is ${LOCAL_RESULT_MAX_BYTES}` }]), format: LOCAL_RESULT_FORMAT };
  }
  return result;
}
