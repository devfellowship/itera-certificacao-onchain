// Local CLI: turn graded local samples into a tma-local-result/1 body and send it to POST /self-declared-results.
//   tsx src/tma-upload.ts --input samples.json [--build-only] [--send] [--api <url>]
// Default: validate the body, then POST it with ?dry_run=1 (every check, then a rollback). --send writes for real.
// --build-only validates and prints the body, with no network. The session token is read from TMA_SESSION_TOKEN
// only and is never printed. The body holds numbers and identifiers: no patch, answer or output text leaves.
//
// samples.json: { agent_id, task, executor, grader_version, runner?, samples: [{ manifest, patch, ... }] }
// `manifest` is a file written by `evaluator --out`; `patch` is the frozen diff or answer file (only checked for empty).
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { LOCAL_RESULT_FORMAT, validateLocalResult, type LocalResult, type LocalResultIssue } from '@itera/contracts';
import type { EvidenceManifest } from '../../evaluator/src/types.js';
import { finalStatus } from './outcome.js';

export const DEFAULT_API_URL = 'https://itera-agent-credentials-api.devfellowship.com';
const SHA256 = /^[0-9a-f]{64}$/;

export type SampleErrorClass = 'timeout' | 'empty_output' | 'rate_limited' | 'hang' | 'infra_error' | 'cost_capped';

export interface UploadSample {
  manifest: EvidenceManifest;
  /** The frozen patch or answer text. Used to tell an empty submission; never sent. */
  patch: string;
  repeat?: number;
  ran_from: string;
  ran_to: string;
  wall_s?: number | null;
  cost_usd?: number | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  timed_out?: boolean;
  cost_capped?: boolean;
  error_class?: SampleErrorClass | null;
}

export interface UploadInput {
  agent_id: string;
  task: LocalResult['task'];
  executor: LocalResult['executor'];
  grader_version: string;
  runner?: LocalResult['runner'];
  samples: UploadSample[];
}

export type BuildResult = { ok: true; body: LocalResult } | { ok: false; errors: string[] };

const round = (n: number, digits = 6) => Number(n.toFixed(digits));
const sumOrNull = (values: Array<number | null | undefined>) => (values.every((v) => typeof v === 'number') ? round(values.reduce<number>((a, v) => a + (v as number), 0)) : null);

function itemOf(m: EvidenceManifest): string {
  const digest = (m as { contract?: { contract_digest?: string } }).contract?.contract_digest;
  if (digest && SHA256.test(digest)) return digest;
  return SHA256.test(m.fixture_hash) ? m.fixture_hash : createHash('sha256').update(m.scenario_id).digest('hex');
}

const counts = (s: { total: number; passed: number; failed: number }) => ({ total: s.total, passed: s.passed, failed: s.failed });

function runOf(s: UploadSample, index: number) {
  const m = s.manifest;
  const status = finalStatus({ timedOut: s.timed_out ?? false, costCapped: s.cost_capped ?? false, patch: s.patch }, m);
  const parts = {
    public_behavior: m.score.public_behavior,
    hidden_behavior: m.score.hidden_behavior,
    regression: m.score.regression,
    patch_integrity_and_scope: m.score.patch_integrity_and_scope,
    reproducible_evidence: m.score.reproducible_evidence,
    ...(typeof m.score.mcp_state === 'number' ? { mcp_state: m.score.mcp_state } : {}),
  };
  return {
    item_sha256: itemOf(m),
    repeat: s.repeat ?? index + 1,
    status,
    score: m.score.total,
    wall_s: s.wall_s ?? null,
    cost_usd: s.cost_usd ?? null,
    tokens_in: s.tokens_in ?? null,
    tokens_out: s.tokens_out ?? null,
    error_class: s.error_class ?? (s.timed_out ? 'timeout' : s.cost_capped ? 'cost_capped' : s.patch.trim() === '' ? 'empty_output' : null),
    parts,
    tests: { public_baseline: counts(m.tests.public_baseline), public_after_patch: counts(m.tests.public_after_patch), hidden: counts(m.tests.hidden) },
  };
}

/** Builds the tma-local-result/1 body of a list of graded samples and validates it against the contract. */
export function buildLocalResult(input: UploadInput): BuildResult {
  if (input.samples.length === 0) return { ok: false, errors: ['samples is empty'] };
  const runs = input.samples.map(runOf);
  const times = input.samples.flatMap((s) => [Date.parse(s.ran_from), Date.parse(s.ran_to)]);
  if (times.some(Number.isNaN)) return { ok: false, errors: ['ran_from and ran_to of every sample must be ISO timestamps'] };
  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const passed = runs.filter((r) => r.status === 'pass').length;
  const cost = sumOrNull(runs.map((r) => r.cost_usd));
  const wall = sumOrNull(runs.map((r) => r.wall_s));
  const body = {
    format: LOCAL_RESULT_FORMAT,
    agent_id: input.agent_id,
    task: input.task,
    metrics_shape: 'tma-score/1',
    grader_version: input.grader_version,
    runner: input.runner ?? { version: '0.1.0', execution: 'external', profile: null, sandbox_image_id: null },
    executor: input.executor,
    ran_from: iso(Math.min(...times)),
    ran_to: iso(Math.max(...times)),
    summary: {
      score: round(runs.reduce((a, r) => a + r.score, 0) / runs.length, 2),
      runs: runs.length,
      items: new Set(runs.map((r) => r.item_sha256)).size,
      pass_rate: round(passed / runs.length, 4),
      time_per_task_s: wall === null ? null : round(wall / runs.length, 2),
      cost_per_task_usd: cost === null ? null : round(cost / runs.length),
      cost_total_usd: cost,
      tokens_in_total: sumOrNull(runs.map((r) => r.tokens_in)),
      tokens_out_total: sumOrNull(runs.map((r) => r.tokens_out)),
      errors: runs.filter((r) => r.status === 'infra_error' || r.status === 'timeout').length,
    },
    runs,
  };
  const checked = validateLocalResult(body);
  return checked.ok ? { ok: true, body: checked.value } : { ok: false, errors: checked.issues.map((i: LocalResultIssue) => `${i.path} ${i.message}`) };
}

export interface SendOptions {
  api: string;
  token: string;
  send: boolean;
  fetchImpl?: typeof fetch;
}

/** POSTs the body. Dry run unless `send`. Returns the status and the JSON answer; the token is never part of either. */
export async function postLocalResult(body: LocalResult, opts: SendOptions): Promise<{ status: number; answer: unknown }> {
  const url = `${opts.api.replace(/\/+$/, '')}/self-declared-results${opts.send ? '' : '?dry_run=1'}`;
  const res = await (opts.fetchImpl ?? fetch)(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let answer: unknown = text;
  try {
    answer = JSON.parse(text);
  } catch {
    answer = text.slice(0, 300);
  }
  return { status: res.status, answer };
}

export async function loadInput(file: string): Promise<UploadInput> {
  const dir = dirname(resolve(file));
  const raw = JSON.parse(await readFile(file, 'utf-8')) as Omit<UploadInput, 'samples'> & { samples: Array<Omit<UploadSample, 'manifest' | 'patch'> & { manifest: string; patch: string }> };
  const samples: UploadSample[] = [];
  for (const s of raw.samples ?? []) {
    samples.push({
      ...s,
      manifest: JSON.parse(await readFile(resolve(dir, s.manifest), 'utf-8')) as EvidenceManifest,
      patch: await readFile(resolve(dir, s.patch), 'utf-8'),
    });
  }
  return { ...raw, samples };
}

export function parseFlags(argv: string[]): { input?: string; api?: string; send: boolean; buildOnly: boolean } {
  const out: { input?: string; api?: string; send: boolean; buildOnly: boolean } = { send: false, buildOnly: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--send') out.send = true;
    else if (argv[i] === '--build-only') out.buildOnly = true;
    else if (argv[i] === '--input') out.input = argv[++i];
    else if (argv[i] === '--api') out.api = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return out;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (!flags.input) throw new Error('Usage: tma-upload --input <samples.json> [--build-only] [--send] [--api <url>]  (token in TMA_SESSION_TOKEN)');
  const built = buildLocalResult(await loadInput(flags.input));
  if (!built.ok) {
    console.error(built.errors.map((e) => `invalid: ${e}`).join('\n'));
    process.exit(1);
  }
  if (flags.buildOnly) {
    console.log(JSON.stringify(built.body, null, 2));
    return;
  }
  const token = process.env.TMA_SESSION_TOKEN;
  if (!token) throw new Error('set TMA_SESSION_TOKEN to a TMA session token (Login with DFL)');
  const { status, answer } = await postLocalResult(built.body, { api: flags.api ?? process.env.TMA_API_URL ?? DEFAULT_API_URL, token, send: flags.send });
  console.log(`${flags.send ? 'sent' : 'dry run'}: HTTP ${status}`);
  console.log(JSON.stringify(answer, null, 2));
  if (status >= 400) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
