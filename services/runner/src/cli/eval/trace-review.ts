// `tma eval upload --mode trace_review` (plan 20261112-tma-c3-eval-repo-kit-docs, C3-T9): a RECORDED session (a
// session that already happened, for example a Claude Code session) becomes ONE run of ONE agent variant on a
// trace_review case, with the structural trajectory of the session. No agent runs and no prediction is needed.
//
//   variant     the recorded session itself: the baseline of the case (change_kind none, the empty diff digest,
//               no prediction). Its base agent is --base-agent, else the case pin (tma-pin/1), else what the
//               session file says (harness claude-code, its version, its model).
//   run         exactly one (repeat 1): the run key of the API is (item, kind, repeat), so the same session sent
//               again is `unchanged`, and a changed grading or label updates the same row.
//   graders     the latest grading of the recorded output (`tma eval grade`, runs/recorded/), if there is one;
//               plus the human label of --label-file as a grader result of kind `human`.
//   format      tma-local-result/3 when the body needs a field that /2 lacks (the label fields labeler and
//               reason_code, the case task summary, a tma-trajectory/2 run); else tma-local-result/2.
//
// What leaves the host is what `tma eval upload` sends for a replay case: numbers, digests, identifiers, the
// redacted structural trajectory. The session text, the prompt, the tool arguments and results stay here.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  EMPTY_DIFF_SHA256,
  GRADER_REASON_CODES,
  LOCAL_RESULT_V2_FORMAT,
  LOCAL_RESULT_V2_MAX_BYTES,
  LOCAL_RESULT_V3_FORMAT,
  validateLocalResultV2,
  validateLocalResultV3,
  type AgentVersion,
  type GraderReasonCode,
  type LocalResultV2Plus,
  type Trajectory,
} from '@itera/contracts';
import { EVALUATOR_VERSION } from '../../../../evaluator/src/runner.js';
import type { EvidenceManifest } from '../../../../evaluator/src/types.js';
import { HIDDEN_TESTS_GRADER_ID } from '../../outcome.js';
import type { FinalStatus } from '../../jobs.js';
import { CliError } from '../env.js';
import { executorOf, resultRow, RUNNER_VERSION, summarize, type ResultRow } from '../result.js';
import { findSecrets } from '../commands/upload.js';
import { CASE_RUNS_DIR, sha256, type LoadedCase } from './case.js';
import { RECORDED_VARIANT_DIR, runDirs, type GradingEntry, type RunRecord } from './runs.js';
import { baseAgentFrom, catalogModelId, runStatus, taskRefOf } from './upload.js';

/** The harness of a Claude Code session file. */
export const CLAUDE_CODE_HARNESS = 'claude-code';
/** The default label of the recorded-session variant. */
export const RECORDED_SESSION_LABEL = 'recorded session';
/** The safe charset of a contract label (variant.label, task summary). */
const LABEL_CHARSET = /^[A-Za-z0-9 .,:;/()+\-_%$=&'#]*$/;
const GRADER_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SEMVER = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const ACTOR = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const HARNESS_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const LABEL_KEYS = ['grader_id', 'version', 'pass', 'score', 'labeler', 'reason_code', 'code_sha256'];
const MAX_WALL_S = 86_400;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** What a Claude Code session file says about itself (numbers and identifiers only). */
export interface SessionFacts {
  harnessVersion: string | null;
  /** The model id as the harness wrote it (the first assistant message that names one). */
  model: string | null;
  firstMs: number | null;
  lastMs: number | null;
}

/** Read the harness version, the model and the first and last timestamps of a Claude Code session. */
export function claudeCodeSessionFacts(text: string): SessionFacts {
  const out: SessionFacts = { harnessVersion: null, model: null, firstMs: null, lastMs: null };
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let ev: any;
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    if (out.harnessVersion === null && typeof ev?.version === 'string' && HARNESS_VERSION.test(ev.version)) out.harnessVersion = ev.version;
    if (out.model === null && ev?.type === 'assistant' && typeof ev?.message?.model === 'string' && ev.message.model !== '<synthetic>') out.model = ev.message.model;
    const at = typeof ev?.timestamp === 'string' ? Date.parse(ev.timestamp) : NaN;
    if (Number.isFinite(at)) {
      out.firstMs = out.firstMs === null ? at : Math.min(out.firstMs, at);
      out.lastMs = out.lastMs === null ? at : Math.max(out.lastMs, at);
    }
  }
  return out;
}

/** The human label of a recorded session (--label-file). It becomes ONE grader result of kind `human`. */
export interface HumanLabel {
  grader_id: string;
  version: string;
  pass: boolean;
  score: number | null;
  /** The actor key of the author of the label (a slug or a principal id, never an e-mail address). */
  labeler: string | null;
  reason_code: GraderReasonCode | null;
  /** The digest of the labelling guide; default: a fixed digest of tma-human-label/1 and the grader id@version. */
  code_sha256: string | null;
}

/** Validate a --label-file value. Closed keys: a label holds no free text. */
export function readHumanLabel(value: unknown, source: string): HumanLabel {
  if (!isObject(value)) throw new CliError(`${source}: a label is a JSON object {grader_id, version, pass, score?, labeler?, reason_code?, code_sha256?}`);
  const errors: string[] = [];
  for (const k of Object.keys(value)) if (!LABEL_KEYS.includes(k)) errors.push(`${k}: unknown key (a label holds no free text)`);
  const v = value;
  if (typeof v.grader_id !== 'string' || !GRADER_ID.test(v.grader_id)) errors.push('grader_id: a grader id (lowercase letters, digits and -)');
  if (typeof v.version !== 'string' || !SEMVER.test(v.version)) errors.push('version: a semver x.y.z');
  if (typeof v.pass !== 'boolean') errors.push('pass: true or false');
  if (v.score !== undefined && v.score !== null && (typeof v.score !== 'number' || !Number.isFinite(v.score) || v.score < 0 || v.score > 100)) errors.push('score: a number from 0 to 100, or null');
  if (v.labeler !== undefined && v.labeler !== null && (typeof v.labeler !== 'string' || !ACTOR.test(v.labeler))) errors.push('labeler: an actor key (a slug or a principal id, never an e-mail address)');
  if (v.reason_code !== undefined && v.reason_code !== null && !GRADER_REASON_CODES.includes(v.reason_code as GraderReasonCode)) errors.push(`reason_code: one of ${GRADER_REASON_CODES.join(', ')}, or null`);
  if (v.code_sha256 !== undefined && v.code_sha256 !== null && (typeof v.code_sha256 !== 'string' || !SHA256.test(v.code_sha256))) errors.push('code_sha256: a sha256');
  if (errors.length > 0) throw new CliError(`${source} is not a valid label:\n  ${errors.join('\n  ')}`);
  return {
    grader_id: v.grader_id as string,
    version: v.version as string,
    pass: v.pass as boolean,
    score: (v.score as number | null | undefined) ?? null,
    labeler: (v.labeler as string | null | undefined) ?? null,
    reason_code: (v.reason_code as GraderReasonCode | null | undefined) ?? null,
    code_sha256: (v.code_sha256 as string | null | undefined) ?? null,
  };
}

/** The default code digest of a human grader version: a fixed name, so the same id@version is one registry row. */
export function humanGraderDigest(id: string, version: string): string {
  return sha256(`tma-human-label/1\n${id}@${version}`);
}

type GraderEntry = LocalResultV2Plus['runs'][number]['graders'][number];

/**
 * The grader result of a label. decisive is false unless the case lists this grader at this version (then the
 * weight and the hard gate come from the case); a label of a grader the case does not list is a side signal.
 */
export function humanGraderOf(label: HumanLabel, c: LoadedCase): GraderEntry {
  const listed = c.manifest.graders.find((g) => g.id === label.grader_id);
  if (listed && listed.version !== label.version) {
    throw new CliError(`the case lists grader ${listed.id} at ${listed.version}; the label is for ${label.version}`);
  }
  return {
    id: label.grader_id,
    semver: label.version,
    code_sha256: label.code_sha256 ?? humanGraderDigest(label.grader_id, label.version),
    kind: 'human',
    pass: label.pass,
    score: label.score,
    weight: listed ? Math.min(listed.weight, 100) : 0,
    hard_gate: listed ? listed.hard_gate : false,
    decisive: listed !== undefined,
    // The label fields exist in /3 only: an absent value is left out, so a label without them stays /2.
    ...(label.labeler !== null ? { labeler: label.labeler } : {}),
    ...(label.reason_code !== null ? { reason_code: label.reason_code } : {}),
  } as GraderEntry;
}

/** The latest grading of the recorded output of the case (runs/recorded/<run-id>/), or null when it was not graded. */
async function latestRecordedGrading(c: LoadedCase): Promise<{ run: RunRecord; grading: GradingEntry; evidence: Record<string, { status?: FinalStatus; manifest?: EvidenceManifest }> | null } | null> {
  const dirs = await runDirs(join(c.dir, CASE_RUNS_DIR, RECORDED_VARIANT_DIR));
  for (const dir of dirs.reverse()) {
    const read = async <T>(f: string): Promise<T | null> => {
      const raw = await readFile(join(dir, f), 'utf-8').catch(() => null);
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        throw new CliError(`${join(dir, f)} is not JSON`);
      }
    };
    const run = await read<RunRecord>('run.json');
    const grading = (await read<{ gradings: GradingEntry[] }>('grades.json'))?.gradings.at(-1);
    if (!run || !grading) continue;
    if (grading.manifest_sha256 !== c.manifestSha256) throw new CliError(`${dir} was graded on another version of the case manifest: grade it again (tma eval grade --case ${c.dir})`);
    return { run, grading, evidence: await read('evidence.json') };
  }
  return null;
}

export interface TraceReviewInput {
  c: LoadedCase;
  agentId: string;
  /** The structural trajectory of the recorded session (tma eval trajectory --from claude-code). */
  trajectory: Trajectory;
  session: SessionFacts;
  /** --base-agent. Default: the case pin, else the session (harness claude-code, its version and model). */
  baseAgent?: AgentVersion;
  label?: HumanLabel;
  /** --label-only: the run carries the human grader only (adding a label to a run already uploaded). */
  labelOnly?: boolean;
  variantLabel?: string;
}

/** The base agent of a recorded session: the flag, the case pin, or what the session file says. */
function recordedBaseAgent(input: TraceReviewInput): AgentVersion {
  if (input.baseAgent) return input.baseAgent;
  const pin = input.c.manifest.pin?.record;
  if (pin && pin.format === 'tma-pin/1') return baseAgentFrom(pin, 'the case pin');
  if (!input.session.model) throw new CliError('the base agent is unknown: the session names no model and the case has no tma-pin/1. Give --base-agent <file>');
  return baseAgentFrom(
    {
      harness: CLAUDE_CODE_HARNESS, harness_version: input.session.harnessVersion, harness_repo_sha: null, model_id: catalogModelId(input.session.model),
      rules_sha256: null, skills_sha256: null, mcp_manifest_sha256: null, tools_sha256: null,
    },
    'the session',
  );
}

/** The task summary of the case as the contract takes it, or null (absent, or outside the contract charset). */
function contractTaskSummary(c: LoadedCase): { before: string; expected: string } | null {
  const s = c.manifest.task_summary;
  if (!s) return null;
  const fits = (t: string) => t.length >= 1 && t.length <= 280 && LABEL_CHARSET.test(t);
  return fits(s.before) && fits(s.expected) ? { before: s.before, expected: s.expected } : null;
}

/** Build and validate the body of ONE recorded session on a trace_review case. */
export async function buildTraceReviewUpload(input: TraceReviewInput): Promise<{ body: LocalResultV2Plus; notes: string[] }> {
  const { c } = input;
  const notes: string[] = [];
  if (c.manifest.mode !== 'trace_review') throw new CliError(`case ${c.manifest.case_key} is a ${c.manifest.mode} case: --mode trace_review uploads a recorded session of a trace_review case`);
  if (!c.task || !c.lock.task) throw new CliError(`case ${c.manifest.case_key} has no task bundle on this host: build the case with --task-dir (the upload names the task by its digests)`);
  if (input.labelOnly && !input.label) throw new CliError('--label-only needs --label-file');
  const variantLabel = input.variantLabel ?? RECORDED_SESSION_LABEL;
  if (variantLabel.length < 1 || variantLabel.length > 60 || !LABEL_CHARSET.test(variantLabel)) throw new CliError('--variant-label: 1 to 60 characters of A-Z a-z 0-9 space . , : ; / ( ) + - _ % $ = & \' #');
  const base = recordedBaseAgent(input);

  const recorded = await latestRecordedGrading(c);
  const label = input.label ? humanGraderOf(input.label, c) : null;
  if (!recorded && !label) throw new CliError(`the recorded session has no grade: run tma eval grade --case ${c.dir}, or give --label-file <json>`);

  let graders: GraderEntry[] = [];
  let status: FinalStatus;
  let score: number;
  let manifest: EvidenceManifest | null = null;
  let infraOk = true;
  if (recorded) {
    const g = recorded.grading;
    status = runStatus(g, recorded.evidence);
    score = g.case.score ?? 0;
    infraOk = g.case.infra_ok;
    manifest = recorded.evidence?.[`${HIDDEN_TESTS_GRADER_ID}@${EVALUATOR_VERSION}`]?.manifest ?? null;
    graders = g.graders
      .filter((x) => x.infra_ok && x.code_sha256 !== null && x.id !== label?.id)
      .map((x) => ({ id: x.id, semver: x.version, code_sha256: x.code_sha256!, kind: x.kind, pass: x.pass, score: x.score, weight: Math.min(x.weight, 100), hard_gate: x.hard_gate, decisive: x.decisive }));
  } else {
    // No code grading: the run is what the human label says.
    status = label!.pass ? 'pass' : 'fail';
    score = label!.score ?? (label!.pass ? 100 : 0);
    notes.push('no tma eval grade of the recorded output: the run status and score come from the label');
  }
  if (input.labelOnly) graders = [];
  if (label) graders.push(label);

  const s = input.session;
  const wallS = s.firstMs !== null && s.lastMs !== null ? Math.min((s.lastMs - s.firstMs) / 1000, MAX_WALL_S) : null;
  const row: ResultRow = resultRow({
    itemSha256: c.lock.task.item_sha256,
    repeat: 1,
    status,
    score,
    manifest,
    wallS,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
    facts: { timedOut: false, costCapped: false, rateLimited: false, emptyPatch: false },
  });
  const run = { ...row, infra_ok: infraOk, graders, trajectory: input.trajectory };
  const fallbackMs = recorded ? Date.parse(recorded.grading.graded_at) : Date.parse('1970-01-01T00:00:00Z');
  const from = s.firstMs ?? fallbackMs;
  const to = Math.max(s.lastMs ?? from, from);

  const summary = contractTaskSummary(c);
  if (c.manifest.task_summary && !summary) notes.push('the case task summary has a character outside the upload charset: it stays on this host');
  const needsV3 = summary !== null || input.trajectory.format !== 'tma-trajectory/1' || graders.some((g) => 'labeler' in g || 'reason_code' in g);
  const value = {
    format: needsV3 ? LOCAL_RESULT_V3_FORMAT : LOCAL_RESULT_V2_FORMAT,
    agent_id: input.agentId,
    task: taskRefOf(c.task),
    metrics_shape: 'tma-score/1' as const,
    grader_version: EVALUATOR_VERSION,
    runner: { version: RUNNER_VERSION, execution: 'external' as const, profile: null, sandbox_image_id: recorded?.run.sandbox_image_id ?? null },
    executor: executorOf({ modelId: base.model_id, harness: base.harness, costSource: 'none' }),
    ran_from: new Date(from).toISOString(),
    ran_to: new Date(to).toISOString(),
    summary: summarize([row]),
    runs: [run],
    case: {
      case_key: c.manifest.case_key, manifest_sha256: c.manifestSha256, origin_pin_sha256: c.lock.pin_sha256, mode: c.manifest.mode, use_case_key: c.manifest.use_case,
      ...(needsV3 && summary ? { task_summary: summary } : {}),
    },
    // The recorded session is the baseline of the case: the base agent unchanged, no prediction.
    variant: { agent: base, variant_sha256: EMPTY_DIFF_SHA256, label: variantLabel, change_kind: 'none' as const },
    comparison: { is_baseline: true, prediction_sha256: null },
  };
  const checked = needsV3 ? validateLocalResultV3(value) : validateLocalResultV2(value);
  if (!checked.ok) throw new CliError(`the upload does not match ${value.format}:\n  ${checked.errors.slice(0, 10).join('\n  ')}`);
  const bytes = Buffer.byteLength(JSON.stringify(checked.value), 'utf8');
  if (bytes > LOCAL_RESULT_V2_MAX_BYTES) throw new CliError(`the body is ${bytes} bytes; the API takes at most ${LOCAL_RESULT_V2_MAX_BYTES}`);
  const secrets = findSecrets(checked.value);
  if (secrets.length > 0) throw new CliError(`the upload stops, a value looks like a credential:\n  ${secrets.slice(0, 5).join('\n  ')}`);
  return { body: checked.value as LocalResultV2Plus, notes };
}
