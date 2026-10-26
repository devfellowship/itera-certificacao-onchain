// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Itera / DevFellowship
import { describe, expect, it } from 'vitest';
import {
  LOCAL_RESULT_MAX_BYTES,
  PROVIDER_KEYS,
  ROUTE_KEYS,
  localResultSchema,
  parseLocalResultText,
  validateLocalResult,
} from './index.js';
import { labOf, routeOf } from './model-catalog.js';

// Synthetic fixtures: invented numbers and hashes only.
const H = (c: string) => c.repeat(64);
const AGENT = '0b6f3c2e-1d4a-4c8e-9f00-123456789abc';

const base = (over: Record<string, unknown> = {}): Record<string, any> => ({
  format: 'tma-local-result/1',
  agent_id: AGENT,
  task: { catalog: { slug: 'tsk_webhook_dup', version: 1 } },
  grader_version: '1.1.0',
  runner: { version: '0.1.0', execution: 'tma-sandbox', profile: 'opencode', sandbox_image_id: `sha256:${H('d')}` },
  executor: { model_id: 'openrouter/deepseek/deepseek-v4.1-flash', provider: 'deepseek', route: 'openrouter', harness: 'opencode 1.18.31', variant: null, cost_source: 'metered' },
  ran_from: '2026-10-26T12:00:00Z',
  ran_to: '2026-10-26T12:20:00Z',
  ...over,
});

const tmaRun = (repeat: number, score: number) => ({
  item_sha256: H('a'), repeat, status: score === 100 ? 'pass' : 'fail', score, wall_s: 212, cost_usd: 0.031, tokens_in: 51234, tokens_out: 3120, error_class: null,
  parts: { public_behavior: 20, hidden_behavior: score === 100 ? 50 : 30, regression: 15, patch_integrity_and_scope: 10, reproducible_evidence: 5 },
  tests: { public_baseline: { total: 4, passed: 1, failed: 3 }, public_after_patch: { total: 4, passed: 4, failed: 0 }, hidden: { total: 10, passed: 6, failed: 4 } },
});
const tmaScore = (over: Record<string, unknown> = {}) =>
  base({ metrics_shape: 'tma-score/1', summary: { score: 90, runs: 2, items: 1, pass_rate: 0.5, cost_total_usd: 0.062 }, runs: [tmaRun(1, 100), tmaRun(2, 80)], ...over });

const COUNT_KEYS = [
  'quotes', 'quotes_literal', 'quotes_artefact', 'quotes_trivial', 'quotes_all_keys', 'quotes_all_keys_literal',
  'corrections_pred', 'corrections_gold', 'corrections_gold_core', 'corrections_matched', 'corrections_core_found',
  'decisions_pred', 'decisions_gold', 'decisions_gold_core', 'decisions_matched', 'decisions_core_found', 'subagent_false_corrections',
];
const miningRun = (repeat: number, score: number) => ({
  item_sha256: H('a'), kind: 'main', stratum: 'main-large', repeat, present: true, gates: { schema: score > 0, redaction: true }, schema_error_count: score > 0 ? 0 : 2,
  counts: Object.fromEntries(COUNT_KEYS.map((k) => [k, 1])), metrics: { meta_domain: true, meta_type: false, meta_outcome: true, links_f1: 0.5 },
  score, wall_s: 12.5, cost_usd: 0.001, tokens_in: 1000, tokens_out: 100, error_class: null,
});
const mining = () =>
  base({
    metrics_shape: 'transcript-mining/1',
    task: { local: { slug: 'dfl-transcript-mining-private', name: 'Transcript mining (private set)', contract_sha256: H('1'), environment_sha256: H('2'), hidden_tests_sha256: H('3') } },
    runner: { version: '0.1.0', execution: 'external', profile: null, sandbox_image_id: null },
    executor: { model_id: 'zai/glm-5.3', provider: 'zai', route: 'zai', harness: 'chat completions, one call per item', variant: null, cost_source: 'derived', model_effective: 'glm-5.3' },
    summary: {
      score: 61.2, runs: 2, items: 1, schema_valid_rate: 0.5, quote_literalness_wilson_lb: 0.2, quotes_total: 2, invented_quote_rate: 0.5, redaction_rebuilds: 0,
      correction_recall: 1, correction_precision: 1, subagent_false_corrections: 0, meta_domain: 1, meta_type: 0, meta_outcome: 1,
      diag_decision_recall: null, diag_decision_precision: null, time_per_task_s: 12.5, cost_per_task_usd: 0.001, cost_total_usd: 0.002,
      tokens_in_total: 2000, tokens_out_total: 200, errors: 0, gate_schema_q4a: false, gate_quotes_q4a: false,
    },
    runs: [miningRun(1, 61.2), miningRun(2, 0)],
  });

const GATES = ['schema', 'intents_closed', 'risk_floor', 'speaker', 'outcome_consistent'];
const trajRun = (repeat: number) => ({
  item_sha256: H('e'), kind: 'subagent', repeat, present: true,
  checks: Object.fromEntries([...GATES, 'class_match', 'risk_match', 'intent_agreement', 'corrections'].map((k) => [k, true])),
  metrics: { class_match: 1, risk_match: 0.5, intent_agreement: 0.75, corrections: null, corrections_recall: null, corrections_precision: null, class_type: true, class_subtype: null },
  score: 88, wall_s: 30, cost_usd: null, tokens_in: null, tokens_out: null, error_class: null,
});
const trajectory = () =>
  base({
    metrics_shape: 'trajectory/1',
    task: { catalog: { slug: 'dfl-session-decision-trajectory-extraction', version: 2 } },
    executor: { model_id: 'opencode-go/deepseek-v4-pro', provider: 'deepseek', route: 'opencode-go', harness: 'opencode run', variant: 'structured-output', cost_source: 'reported' },
    summary: {
      score: 88, runs: 1, items: 1, gate_pass_rate: 1, check_pass_rate: 1, mean_score_when_gates_pass: 88,
      ...Object.fromEntries(GATES.map((g) => [`gate_fail_${g}`, 0])),
      metric_class_match: 1, metric_risk_match: 0.5, metric_intent_agreement: 0.75, metric_corrections: null,
      time_per_task_s: 30, items_per_hour: 120, cost_per_task_usd: null, cost_total_usd: null, tokens_in_total: null, tokens_out_total: null, errors: 0,
    },
    runs: [trajRun(1)],
  });

const issues = (v: unknown) => {
  const r = validateLocalResult(v);
  return r.ok ? [] : r.issues;
};

describe('local-result.schema.json — round trip of each shape', () => {
  for (const [name, make] of [['tma-score/1', tmaScore], ['transcript-mining/1', mining], ['trajectory/1', trajectory]] as const) {
    it(`accepts a ${name} result, and the same value comes back after JSON text`, () => {
      const value = make();
      const r = parseLocalResultText(JSON.stringify(value));
      expect(r.ok ? [] : r.errors).toEqual([]);
      if (r.ok) expect(r.value).toEqual(value);
    });
  }
  it('refuses the runs of one shape under another shape', () => {
    const v = { ...mining(), metrics_shape: 'tma-score/1' };
    expect(validateLocalResult(v).ok).toBe(false);
  });
});

describe('local-result.schema.json — numbers only', () => {
  it('refuses an unknown key and gives its JSON path', () => {
    expect(issues({ ...tmaScore(), transcript: 'x' })).toContainEqual(expect.objectContaining({ code: 'unknown_key', path: '/transcript' }));
    const v = tmaScore();
    (v.runs as any[])[1].note = 'anything';
    expect(issues(v)).toContainEqual(expect.objectContaining({ code: 'unknown_key', path: '/runs/1/note' }));
    const e = tmaScore();
    (e.executor as any).api_key = 'x';
    expect(issues(e)).toContainEqual(expect.objectContaining({ code: 'unknown_key', path: '/executor/api_key' }));
  });
  it('refuses an actions key, a patch, stdout and messages on a run', () => {
    for (const key of ['actions', 'patch', 'stdout', 'stderr', 'messages', 'events', 'prompt', 'answer']) {
      const v = tmaScore();
      (v.runs as any[])[0][key] = key === 'actions' ? [{ tool: 'bash', input: 'cat .env' }] : 'x';
      expect(issues(v), key).toContainEqual(expect.objectContaining({ code: 'unknown_key', path: `/runs/0/${key}` }));
    }
  });
  it('has no property for logs, actions, a patch, a prompt, an answer or a key anywhere in the schema', () => {
    const forbidden = /^(actions?|events?|patch|diff|stdout|stderr|logs?|messages?|prompt|answer|output|transcript|content|text|key|api_key|token|secret)$/;
    const names: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      const o = node as Record<string, unknown>;
      if (o.properties && typeof o.properties === 'object') names.push(...Object.keys(o.properties));
      Object.values(o).forEach(walk);
    };
    walk(localResultSchema);
    expect(names.length).toBeGreaterThan(50);
    expect(names.filter((n) => forbidden.test(n))).toEqual([]);
  });
  it('refuses free text: a newline, a quote mark, and a string of 61 characters', () => {
    const withNewline = tmaScore();
    (withNewline.executor as any).harness = 'line one\nline two';
    expect(issues(withNewline)).toContainEqual(expect.objectContaining({ code: 'invalid', path: '/executor/harness' }));
    const withQuote = tmaScore();
    (withQuote.executor as any).harness = 'say "hi" <b>';
    expect(issues(withQuote)).toContainEqual(expect.objectContaining({ path: '/executor/harness' }));
    const long = mining();
    (long.task as any).local.name = 'x'.repeat(61);
    expect(issues(long)).toContainEqual(expect.objectContaining({ path: '/task/local/name' }));
    const bad = tmaScore();
    (bad.runs as any[])[0].item_sha256 = 'abc';
    expect(issues(bad)).toContainEqual(expect.objectContaining({ path: '/runs/0/item_sha256' }));
  });
  it('refuses a body above 1 MiB before it parses it', () => {
    const big = JSON.stringify({ ...tmaScore(), pad: 'x'.repeat(LOCAL_RESULT_MAX_BYTES) });
    const r = parseLocalResultText(big);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]).toMatchObject({ code: 'too_large', path: '/' });
    expect(LOCAL_RESULT_MAX_BYTES).toBe(1_048_576);
  });
  it('accepts a body just under 1 MiB of valid runs (the largest file of a full bake-off fits)', () => {
    const runs = Array.from({ length: 2000 }, (_, i) => tmaRun((i % 100) + 1, 80));
    const v = tmaScore({ summary: { score: 80, runs: 2000, items: 20 }, runs });
    const text = JSON.stringify(v);
    expect(Buffer.byteLength(text)).toBeLessThan(LOCAL_RESULT_MAX_BYTES);
    expect(parseLocalResultText(text).ok).toBe(true);
  });
  it('refuses text that is not JSON', () => {
    const r = parseLocalResultText('{"format":');
    expect(r.ok ? null : r.issues[0]?.code).toBe('not_json');
  });
});

describe('local-result validator — the rules a schema cannot say', () => {
  it('takes the provider and the route from the model catalog', () => {
    const p = tmaScore();
    (p.executor as any).provider = 'acme';
    expect(issues(p)).toContainEqual(expect.objectContaining({ code: 'unknown_provider', path: '/executor/provider' }));
    const r = tmaScore();
    (r.executor as any).route = 'my-proxy';
    expect(issues(r)).toContainEqual(expect.objectContaining({ code: 'unknown_route', path: '/executor/route' }));
    const custom = tmaScore();
    (custom.executor as any).provider = null;
    expect(issues(custom)).toEqual([]);
  });
  it('refuses a run count that differs from the list, and ran_from after ran_to', () => {
    expect(issues(tmaScore({ summary: { score: 90, runs: 3, items: 1 } }))).toContainEqual(expect.objectContaining({ code: 'inconsistent', path: '/summary/runs' }));
    expect(issues(tmaScore({ ran_from: '2026-10-26T13:00:00Z' }))).toContainEqual(expect.objectContaining({ code: 'inconsistent', path: '/ran_from' }));
  });
  it('takes exactly one of task.catalog and task.local', () => {
    const both = tmaScore({ task: { catalog: { slug: 'tsk_webhook_dup', version: 1 }, local: (mining().task as any).local } });
    expect(validateLocalResult(both).ok).toBe(false);
    expect(validateLocalResult(tmaScore({ task: {} })).ok).toBe(false);
  });

  it('task.catalog.slug is the bundle folder name: tsk_webhook_dup is accepted; a capital, a leading _, a space and 64 characters are refused', () => {
    for (const slug of ['tsk_webhook_dup', 'tsk_helpdesk_refunds', 'webhook-ledger', 'a', 'a'.repeat(63)]) {
      expect(issues(tmaScore({ task: { catalog: { slug, version: 1 } } }))).toEqual([]);
    }
    for (const slug of ['Tsk_X', '_x', 'a b', 'a'.repeat(64), '']) {
      expect(issues(tmaScore({ task: { catalog: { slug, version: 1 } } })).map((i) => i.path)).toContain('/task/catalog/slug');
    }
  });
  it('task.local.slug is NOT widened: an underscore is still refused for a private task', () => {
    const r = mining() as any;
    r.task.local.slug = 'tsk_private';
    expect(issues(r).map((i) => i.path)).toContain('/task/local/slug');
  });
  it('refuses a local task with an empty name (tasks.name is 1..60 characters)', () => {
    const r = mining() as any;
    r.task.local.name = '';
    const out = validateLocalResult(r) as any;
    expect(out.ok).toBe(false);
    expect(out.issues.map((i: any) => i.path)).toContain('/task/local/name');
  });
  it('refuses a score above 100 and a negative cost', () => {
    expect(validateLocalResult(tmaScore({ summary: { score: 101, runs: 2, items: 1 } })).ok).toBe(false);
    const v = tmaScore();
    (v.runs as any[])[0].cost_usd = -1;
    expect(issues(v)).toContainEqual(expect.objectContaining({ path: '/runs/0/cost_usd' }));
  });
});

describe('model catalog (packages/contracts/model-catalog)', () => {
  it('is the provider enum and the route enum of plan §3', () => {
    expect(PROVIDER_KEYS).toEqual([
      'anthropic', 'openai', 'google', 'qwen', 'deepseek', 'zai', 'kimi', 'xai', 'nvidia', 'meta', 'mistral', 'minimax', 'cohere', 'microsoft', 'amazon', 'tencent', 'bytedance', 'xiaomi',
    ]);
    expect(ROUTE_KEYS).toEqual(['openrouter', 'opencode-go', 'ollama', 'zai', 'codex', 'claude-code', 'minimax']);
  });
  it('matches a model to its lab and its route', () => {
    expect(labOf({ id: 'opencode-go/deepseek-v4-pro' }).key).toBe('deepseek');
    expect(labOf({ id: 'z-ai/glm-4.6' }).key).toBe('zai');
    expect(labOf({ id: 'acme/mystery-7b' }).key).toBe('generic');
    expect(routeOf('opencode-go/deepseek-v4-pro').key).toBe('opencode-go');
    expect(routeOf('anthropic/claude-haiku-4.5').key).toBe('openrouter');
  });
});
