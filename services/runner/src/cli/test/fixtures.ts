// Synthetic fixtures for the tma CLI tests: invented numbers and hashes only.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Io } from '../command.js';

export const H = (c: string) => c.repeat(64);
export const AGENT = '0b6f3c2e-1d4a-4c8e-9f00-123456789abc';
export const API = 'https://tma-api.test';
export const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZmw6dGVzdCJ9.c2lnbmF0dXJlLXNpZ25hdHVyZQ';

export function tempEnv(): NodeJS.ProcessEnv {
  return { TMA_CONFIG_DIR: join(mkdtempSync(join(tmpdir(), 'tma-cli-test-')), 'cfg'), TMA_API_URL: API };
}

export function captureIo(): Io & { outText: () => string; errText: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return { out: (t) => out.push(t), err: (t) => err.push(t), outText: () => out.join('\n'), errText: () => err.join('\n') };
}

const tmaRun = (repeat: number, score: number) => ({
  item_sha256: H('a'), repeat, status: score === 100 ? 'pass' : 'fail', score, wall_s: 212, cost_usd: 0.031, tokens_in: 51234, tokens_out: 3120, error_class: null,
  parts: { public_behavior: 20, hidden_behavior: score === 100 ? 50 : 30, regression: 15, patch_integrity_and_scope: 10, reproducible_evidence: 5 },
  tests: { public_baseline: { total: 4, passed: 1, failed: 3 }, public_after_patch: { total: 4, passed: 4, failed: 0 }, hidden: { total: 10, passed: 6, failed: 4 } },
});

/** A tma-local-result/1 file as `tma run` writes it (tma-score/1). */
export function tmaScoreResult(over: Record<string, unknown> = {}): Record<string, any> {
  return {
    format: 'tma-local-result/1',
    agent_id: AGENT,
    task: { catalog: { slug: 'webhook-ledger', version: 1 } },
    metrics_shape: 'tma-score/1',
    grader_version: '1.1.0',
    runner: { version: '0.1.0', execution: 'tma-sandbox', profile: 'opencode', sandbox_image_id: `sha256:${H('d')}` },
    executor: { model_id: 'openrouter/deepseek/deepseek-v4.1-flash', provider: 'deepseek', route: 'openrouter', harness: 'opencode 1.18.31', variant: null, cost_source: 'metered' },
    ran_from: '2026-10-26T12:00:00Z',
    ran_to: '2026-10-26T12:20:00Z',
    summary: { score: 90, runs: 2, items: 1, pass_rate: 0.5, cost_total_usd: 0.062 },
    runs: [tmaRun(1, 100), tmaRun(2, 80)],
    ...over,
  };
}

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
const miningSummary = {
  score: 61.2, runs: 2, items: 1, schema_valid_rate: 0.5, quote_literalness_wilson_lb: 0.2, quotes_total: 2, invented_quote_rate: 0.5, redaction_rebuilds: 0,
  correction_recall: 1, correction_precision: 1, subagent_false_corrections: 0, meta_domain: 1, meta_type: 0, meta_outcome: 1,
  diag_decision_recall: null, diag_decision_precision: null, time_per_task_s: 12.5, cost_per_task_usd: 0.001, cost_total_usd: 0.002,
  tokens_in_total: 2000, tokens_out_total: 200, errors: 0, gate_schema_q4a: false, gate_quotes_q4a: false,
};

const legacyExecutor = (model_id: string, route: string, extra: Record<string, unknown> = {}) => ({
  model_id, label: model_id, lane: 'opencode-go', route, route_name: route, harness: 'opencode run', cost_source: 'reported', cost_basis: 'opencode stats',
  model_requested: model_id, model_effective: model_id.split('/').pop(), ran_from: '2026-10-24T10:00:00Z', ran_to: '2026-10-24T11:00:00Z',
  summary: miningSummary, runs: [miningRun(1, 61.2), miningRun(2, 0)], ...extra,
});

/** An old operator import file (tma-bench-import/1), as the bake-off of 2026-10-24/25 wrote it. */
export function legacyMiningFile(): Record<string, any> {
  return {
    format: 'tma-bench-import/1',
    generated_at: '2026-10-25T09:00:00Z',
    task: { slug: 'dfl-transcript-mining', pack_id: 'dfl-transcript-mining', pack_version: '2', name: 'Transcript mining', description: 'Private set' },
    grader_version: '1.0.0', score_version: 'v1', golden_items: 12, golden_manifest_sha256: H('9'), prompt_sha256: null, labels_status: 'frozen', plan: 'bake-off',
    executors: [
      legacyExecutor('opencode-go/deepseek-v4-pro', 'opencode-go'),
      legacyExecutor('zai/glm-5.3', 'zai', { variant: 'structured-output', think: true, effort: 'high' }),
    ],
  };
}
