// `tma eval upload` (plan 20261112-tma-c3-eval-repo-kit-docs T4; C4 owns the contract, ADR-6): the runs of
// ONE variant of ONE case become one `tma-local-result/2` body, sent through the existing door
// POST /self-declared-results (the same API that web2 reads, Q-T13).
//
// What leaves the host: numbers, digests, the case key and use case, the variant label, the grader rows
// and the structural trajectory (redacted targets). Never the patch, the prediction text, a prompt, a
// tool output or a key. The body is validated with the API's own validator and scanned for a credential
// before any network call.
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  agentVersionSha256,
  EMPTY_DIFF_SHA256,
  LOCAL_RESULT_V2_FORMAT,
  LOCAL_RESULT_V2_MAX_BYTES,
  LOCAL_RESULT_V2_MAX_RUNS,
  validateLocalResultV2,
  validateTrajectory,
  type AgentVersion,
  type LocalResultV2,
  type Trajectory,
} from '@itera/contracts';
import { EVALUATOR_VERSION } from '../../../../evaluator/src/runner.js';
import type { EvidenceManifest } from '../../../../evaluator/src/types.js';
import { HIDDEN_TESTS_GRADER_ID } from '../../outcome.js';
import type { FinalStatus } from '../../jobs.js';
import { isCatalogBundle } from '../catalog-slugs.js';
import { CliError } from '../env.js';
import { executorOf, resultRow, RUNNER_VERSION, summarize, type ResultRow } from '../result.js';
import { BENCHMARKS_DIR, catalogVersion, localTaskRef, type ResolvedTask, type TaskRef } from '../tasks.js';
import { findSecrets } from '../commands/upload.js';
import { sha256, type LoadedCase } from './case.js';
import { canonicalJson, type VariantFile } from './variant.js';
import { RUN_FORMAT, runDirs, TRAJECTORY_FILE, type GradingEntry, type RunRecord } from './runs.js';

/** The case_key of tma-local-result/2 (narrower than tma-case/1: no dot, at most 63). */
const V2_CASE_KEY = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const MODEL_ID = /^[a-z0-9][a-z0-9.-]{0,31}(\/[a-z0-9][a-z0-9.-]{0,31})?\/[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const HARNESS = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const AGENT_FIELDS = ['harness', 'harness_version', 'harness_repo_sha', 'model_id', 'rules_sha256', 'skills_sha256', 'mcp_manifest_sha256', 'tools_sha256'] as const;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The base agent version from a record: the 8 fields of tma-local-result/2 variant.agent, an object that
 * holds them under `agent`, or a full tma-pin/1 record (its skills list becomes the digest of its JCS).
 */
export function baseAgentFrom(record: unknown, source: string): AgentVersion {
  if (!isObject(record)) throw new CliError(`${source}: not a JSON object`);
  const r = isObject(record.agent) ? record.agent : record;
  const out: Record<string, string | null> = {};
  for (const k of AGENT_FIELDS) {
    let v = r[k];
    if (k === 'skills_sha256' && Array.isArray(v)) v = sha256(canonicalJson(v)); // a tma-pin/1 skills list
    if (k === 'tools_sha256' && v === undefined && r.format === 'tma-pin/1') v = null; // tma-pin/1 has no tool digest
    if (v === undefined) throw new CliError(`${source}: the base agent needs ${k} (null when unknown)`);
    if (v !== null && typeof v !== 'string') throw new CliError(`${source}: ${k} must be a string or null`);
    out[k] = v as string | null;
  }
  if (!out.harness || !HARNESS.test(out.harness)) throw new CliError(`${source}: harness must be a short name such as claude-code, codex or opencode`);
  if (!out.model_id || !MODEL_ID.test(out.model_id)) {
    throw new CliError(`${source}: model_id "${String(out.model_id).slice(0, 60)}" is not a model-catalog id (lab/model, for example anthropic/claude-sonnet-4.5): give --base-agent with the catalog id`);
  }
  for (const k of ['rules_sha256', 'skills_sha256', 'mcp_manifest_sha256', 'tools_sha256'] as const) if (out[k] !== null && !SHA256.test(out[k]!)) throw new CliError(`${source}: ${k} must be a sha256`);
  if (out.harness_repo_sha !== null && !COMMIT.test(out.harness_repo_sha!)) throw new CliError(`${source}: harness_repo_sha must be a commit`);
  return out as unknown as AgentVersion;
}

/** How the result names the task of the case: a catalog bundle by slug and version, else its digests. */
export function taskRefOf(task: ResolvedTask): TaskRef {
  const name = basename(task.dir);
  if (resolve(task.dir) === resolve(BENCHMARKS_DIR, name) && isCatalogBundle(name)) return { catalog: { slug: name, version: catalogVersion(task.task) } };
  return localTaskRef([task], /^[a-z0-9][a-z0-9-]{0,62}$/.test(name) ? name : undefined);
}

async function readJson<T>(p: string): Promise<T | null> {
  const raw = await readFile(p, 'utf-8').catch(() => null);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new CliError(`${p} is not JSON`);
  }
}

interface VariantLock {
  variant_sha256: string;
  prediction_sha256: string | null;
  variant: VariantFile;
}

export interface UploadInput {
  c: LoadedCase;
  variantDir: string;
  agentId: string;
  /** --base-agent: the base agent version. Default: the case pin, else (agent variant) the agent folder. */
  baseAgent?: AgentVersion;
}

/** The base agent of an upload: the flag, the case pin, or the agent variant itself. */
async function resolveBaseAgent(input: UploadInput, v: VariantFile): Promise<AgentVersion> {
  if (input.baseAgent) return input.baseAgent;
  const pin = input.c.manifest.pin?.record;
  if (pin && pin.format === 'tma-pin/1') return baseAgentFrom(pin, 'the case pin');
  if (v.kind === 'agent') {
    const dir = resolve(input.variantDir);
    const lock = (await readJson<{ source_file: string }>(join(dir, 'variant.lock.json')))!;
    const agentDir = resolve(join(lock.source_file, '..'), v.agent!.agent_dir);
    let rules: string | null = null;
    for (const f of ['AGENTS.md', 'CLAUDE.md']) {
      const body = await readFile(join(agentDir, f)).catch(() => null);
      if (body) {
        rules = sha256(body);
        break;
      }
    }
    return { harness: v.agent!.profile ?? 'opencode', harness_version: null, harness_repo_sha: null, model_id: v.agent!.model, rules_sha256: rules, skills_sha256: null, mcp_manifest_sha256: null, tools_sha256: null };
  }
  throw new CliError('the base agent is unknown: the case has no tma-pin/1 and the variant is a patch. Give --base-agent <file> (the 8 fields of variant.agent, or an agents/<name>/<ver>.json of the eval repo)');
}

/** The final status of a run from its latest grading (the hidden-tests status when it ran). */
function runStatus(g: GradingEntry, evidence: Record<string, { status?: FinalStatus }> | null): FinalStatus {
  if (!g.case.infra_ok) return 'infra_error';
  const hidden = evidence?.[`${HIDDEN_TESTS_GRADER_ID}@${EVALUATOR_VERSION}`]?.status;
  if (hidden === 'invalid' || hidden === 'timeout') return hidden;
  return g.case.pass ? 'pass' : 'fail';
}

/** Build and validate the tma-local-result/2 body of one variant folder. */
export async function buildEvalUpload(input: UploadInput): Promise<LocalResultV2> {
  const { c } = input;
  const dir = resolve(input.variantDir);
  const lock = await readJson<VariantLock>(join(dir, 'variant.lock.json'));
  if (!lock) throw new CliError(`${input.variantDir} is not a variant folder of a tma eval run (no variant.lock.json). A recorded output uploads with C3-T9.`);
  const v = lock.variant;
  if (!V2_CASE_KEY.test(c.manifest.case_key)) {
    throw new CliError(`case_key "${c.manifest.case_key}" does not fit tma-local-result/2 (lowercase letters, digits, _ and -, at most 63; no dot): rename the case`);
  }
  if (c.manifest.mode === 'replay' && c.lock.pin_sha256 === null) {
    throw new CliError(`case ${c.manifest.case_key} is a replay case with no pin: tma-local-result/2 needs the origin pin of a replay case (case.origin_pin_sha256). A synthetic case stays local.`);
  }
  if (!c.task) throw new CliError(`case ${c.manifest.case_key} has no task bundle on this host`);
  if (!v.is_baseline && v.change_kind === 'none') {
    throw new CliError(`variant "${v.label}" is not the baseline and has change_kind none: an uploaded variant names its one diff. A control output (for example the empty output) stays local.`);
  }
  const base = await resolveBaseAgent(input, v);

  const dirs = await runDirs(dir);
  if (dirs.length === 0) throw new CliError(`no run in ${input.variantDir}`);
  if (dirs.length > LOCAL_RESULT_V2_MAX_RUNS) throw new CliError(`${dirs.length} runs in ${input.variantDir}; one upload holds at most ${LOCAL_RESULT_V2_MAX_RUNS}`);
  const runs: LocalResultV2['runs'] = [];
  let from = Infinity;
  let to = -Infinity;
  let imageId: string | null = null;
  for (const rd of dirs) {
    const run = (await readJson<RunRecord>(join(rd, 'run.json')))!;
    if (run.format !== RUN_FORMAT || run.manifest_sha256 !== c.manifestSha256) throw new CliError(`${rd} ran on another version of the case manifest`);
    const g = (await readJson<{ gradings: GradingEntry[] }>(join(rd, 'grades.json')))?.gradings.at(-1);
    if (!g) throw new CliError(`${rd} is not graded: run tma eval grade first`);
    if (g.manifest_sha256 !== c.manifestSha256) throw new CliError(`${rd} was graded on another version of the case manifest: grade it again`);
    const evidence = await readJson<Record<string, { status?: FinalStatus; manifest?: EvidenceManifest }>>(join(rd, 'evidence.json'));
    const manifest = evidence?.[`${HIDDEN_TESTS_GRADER_ID}@${EVALUATOR_VERSION}`]?.manifest ?? null;
    const status = runStatus(g, evidence);
    const row: ResultRow = resultRow({
      itemSha256: c.lock.task!.item_sha256,
      repeat: run.repeat,
      status,
      score: g.case.score ?? 0,
      manifest,
      wallS: run.wall_s,
      costUsd: run.agent?.cost_usd ?? null,
      tokensIn: run.agent?.tokens_in ?? null,
      tokensOut: run.agent?.tokens_out ?? null,
      facts: { timedOut: run.facts.timedOut, costCapped: run.facts.costCapped, rateLimited: run.facts.rateLimitedFinal > 0, emptyPatch: run.patch_sha256 === sha256('') },
    });
    let trajectory: Trajectory | null = null;
    const t = await readJson<unknown>(join(rd, TRAJECTORY_FILE));
    if (t !== null) {
      const ok = validateTrajectory(t);
      if (!ok.ok) throw new CliError(`${join(rd, TRAJECTORY_FILE)} is not a valid tma-trajectory/1: ${ok.errors.slice(0, 3).join('; ')}`);
      trajectory = ok.value;
    }
    runs.push({
      ...row,
      infra_ok: g.case.infra_ok,
      graders: g.graders
        .filter((x) => x.infra_ok && x.code_sha256 !== null)
        .map((x) => ({ id: x.id, semver: x.version, code_sha256: x.code_sha256!, kind: x.kind, pass: x.pass, score: x.score, weight: Math.min(x.weight, 100), hard_gate: x.hard_gate, decisive: x.decisive })),
      trajectory,
    });
    from = Math.min(from, Date.parse(run.started_at));
    to = Math.max(to, Date.parse(g.graded_at), Date.parse(run.started_at));
    imageId = imageId ?? run.sandbox_image_id ?? null;
  }
  const first = (await readJson<RunRecord>(join(dirs[0]!, 'run.json')))!;
  const isAgent = v.kind === 'agent';
  const executorModel = isAgent ? v.agent!.model : base.model_id;
  const body = {
    format: LOCAL_RESULT_V2_FORMAT,
    agent_id: input.agentId,
    task: taskRefOf(c.task),
    metrics_shape: 'tma-score/1' as const,
    grader_version: EVALUATOR_VERSION,
    runner: { version: RUNNER_VERSION, execution: isAgent ? ('tma-sandbox' as const) : ('external' as const), profile: isAgent ? (first.profile ?? 'opencode') : null, sandbox_image_id: imageId },
    executor: executorOf({ modelId: executorModel, harness: isAgent ? (first.profile ?? 'opencode') : 'patch', costSource: isAgent && runs.some((r) => r.cost_usd !== null) ? 'derived' : 'none' }),
    ran_from: new Date(from).toISOString(),
    ran_to: new Date(to).toISOString(),
    summary: summarize(runs as unknown as ResultRow[]),
    runs,
    case: { case_key: c.manifest.case_key, manifest_sha256: c.manifestSha256, origin_pin_sha256: c.lock.pin_sha256, mode: c.manifest.mode, use_case_key: c.manifest.use_case },
    variant: { agent: base, variant_sha256: v.change_kind === 'none' ? EMPTY_DIFF_SHA256 : lock.variant_sha256, label: v.label, change_kind: v.change_kind },
    comparison: { is_baseline: v.is_baseline, prediction_sha256: v.is_baseline ? null : lock.prediction_sha256 },
  };
  const checked = validateLocalResultV2(body);
  if (!checked.ok) throw new CliError(`the upload does not match tma-local-result/2:\n  ${checked.errors.slice(0, 10).join('\n  ')}`);
  const bytes = Buffer.byteLength(JSON.stringify(checked.value), 'utf8');
  if (bytes > LOCAL_RESULT_V2_MAX_BYTES) throw new CliError(`the body is ${bytes} bytes; the API takes at most ${LOCAL_RESULT_V2_MAX_BYTES}`);
  const secrets = findSecrets(checked.value);
  if (secrets.length > 0) throw new CliError(`the upload stops, a value looks like a credential:\n  ${secrets.slice(0, 5).join('\n  ')}`);
  return checked.value;
}

/** The agent_sha256 that the API derives (eval_variants.agent_sha256), for the human line. */
export function agentSha(body: LocalResultV2): string {
  return agentVersionSha256(body.variant.agent);
}

/** Every variant folder of a case (runs/<sha12>, not the recorded output). */
export async function variantFolders(caseDir: string): Promise<string[]> {
  const root = join(caseDir, 'runs');
  const out: string[] = [];
  for (const e of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory() && (await stat(join(root, e.name, 'variant.lock.json')).catch(() => null))) out.push(join(root, e.name));
  }
  return out.sort();
}
