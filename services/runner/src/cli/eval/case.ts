// `tma-case/1` on the host (plan 20261112-tma-c3-eval-repo-kit-docs T3, ADR-2, ADR-4; umbrella ADR-29).
//
// A case manifest lives in the private eval repo (dfl-evals: cases/<type>/<subtype>/<case-key>/case.json).
// It holds pointers, digests and human-written text only. `tma eval case` turns one manifest into a CASE
// FOLDER on the host: the manifest (byte copy), a lock with every digest the later steps re-check, the
// agent-visible input, and an empty runs/ folder. Nothing in this module talks to a server.
//
// The validator below mirrors schemas/tma-case-1.schema.json of dfl-evals with the use case as the L1
// pair type/subtype (umbrella ADR-29, Q-T17 = A), plus the optional l2_tag and task_summary. Keep the two
// in step: an unknown key is refused, as in the schema.
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pinReplayable, validatePin } from '@itera/contracts';
import { exec } from '../../exec.js';
import { loadRunProfile } from '../../run-profile.js';
import { CliError } from '../env.js';
import { materializeLocalWorkspace } from '../local.js';
import { BENCHMARKS_DIR, loadResolved, refuseMcp, type ResolvedTask } from '../tasks.js';
import { CLI_VERSION } from '../version.js';

export const CASE_FORMAT = 'tma-case/1';
/** The lock that `tma eval case` writes next to the manifest. Host only; never uploaded. */
export const CASE_LOCK_FORMAT = 'tma-eval-case/1';
/** The no-content limit of dfl-evals (ADR-2): a case manifest is small. */
export const CASE_MAX_BYTES = 256 * 1024;
export const CASE_FILE = 'case.json';
export const CASE_LOCK_FILE = 'case.lock.json';
export const CASE_INPUT_DIR = 'input';
export const CASE_RECORDED_FILE = 'recorded.diff';
export const CASE_RUNS_DIR = 'runs';

/**
 * ONE case_key rule for tma-case/1 and tma-local-result/2: no dot, 3 to 63 characters. The upload contract
 * (local-result-v2 case.case_key) and the eval_cases.case_key CHECK (0023) allow no dot and 63 at most, so a
 * case that this kit accepts always uploads. devfellowship/dfl-evals checks the same rule.
 */
const CASE_KEY = /^[a-z0-9][a-z0-9_-]{2,62}$/;
/** The L1 pair type/subtype (umbrella ADR-29). Same segment pattern as eval_cases.use_case_key. */
const USE_CASE = /^[a-z0-9][a-z0-9-]{0,30}\/[a-z0-9][a-z0-9-]{0,30}$/;
const L2_TAG = /^[a-z0-9][a-z0-9._-]{1,79}$/;
const SUMMARY_TEXT = /^[A-Za-z0-9À-ÖØ-öø-ÿ .,;:!?()/'"_+%&@#=*-]+$/;
const GRADER_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
/** A TMA task reference in a case: <bundle slug>@<version>. */
const TMA_TASK_ID = /^([a-z0-9][a-z0-9_-]{0,62})@(\d{1,6})(\.\d{1,6}){0,2}$/;

const TOP_KEYS = ['schema', 'case_key', 'use_case', 'l2_tag', 'task_summary', 'mode', 'answer_shape', 'pin', 'task_ref', 'expected', 'graders', 'split', 'source'];
const REQUIRED = ['schema', 'case_key', 'use_case', 'mode', 'answer_shape', 'pin', 'task_ref', 'expected', 'graders', 'split', 'source'];

export interface CaseGrader {
  id: string;
  version: string;
  weight: number;
  hard_gate: boolean;
  /** Kind judge only: ask for a decisive result. Counts only with a passing calibration record. Default false. */
  decisive?: boolean;
}

export interface CaseManifest {
  schema: 'tma-case/1';
  case_key: string;
  use_case: string;
  l2_tag?: string;
  task_summary?: { before: string; expected: string };
  mode: 'replay' | 'trace_review';
  answer_shape: 'single' | 'open';
  pin: null | { pin_sha256: string; record: Record<string, unknown> };
  task_ref: { kind: 'dfl-task' | 'tma-task'; id: string };
  expected: { text: string; written_by: string; written_at: string };
  graders: CaseGrader[];
  split: 'golden' | 'calibration-train' | 'calibration-dev' | 'calibration-test' | 'none';
  source: 'trace' | 'a11-build-case' | 'synthetic';
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function closedKeys(path: string, v: Record<string, unknown>, allowed: string[], errors: string[]): void {
  for (const k of Object.keys(v)) if (!allowed.includes(k)) errors.push(`${path}/${k}: unknown key`);
}

function text(path: string, v: unknown, min: number, max: number, errors: string[]): void {
  if (typeof v !== 'string' || v.length < min || v.length > max) errors.push(`${path}: must be a string of ${min} to ${max} characters`);
}

/** Every reason the value is not a valid tma-case/1 manifest. Empty = valid. */
export function caseErrors(v: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(v)) return ['/: a case manifest is a JSON object'];
  closedKeys('', v, TOP_KEYS, errors);
  for (const k of REQUIRED) if (!(k in v)) errors.push(`/${k}: required`);
  if ('schema' in v && v.schema !== CASE_FORMAT) errors.push(`/schema: must be ${CASE_FORMAT}`);
  if ('case_key' in v && (typeof v.case_key !== 'string' || !CASE_KEY.test(v.case_key))) errors.push('/case_key: lowercase letters, digits, _ and -, 3 to 63 characters (no dot: it is the key of the upload)');
  if ('use_case' in v && (typeof v.use_case !== 'string' || !USE_CASE.test(v.use_case))) {
    errors.push('/use_case: the L1 pair <type>/<subtype>, for example fix/red-ci (umbrella ADR-29; an L2 cluster key goes in l2_tag)');
  }
  if ('l2_tag' in v && (typeof v.l2_tag !== 'string' || !L2_TAG.test(v.l2_tag))) errors.push('/l2_tag: an L2 cluster key');
  if ('task_summary' in v) {
    const s = v.task_summary;
    if (!isObject(s)) errors.push('/task_summary: an object {before, expected}');
    else {
      if ('outcome' in s) errors.push('/task_summary/outcome: refused (the outcome describes one run; it stays on the trace and on the host)');
      closedKeys('/task_summary', s, ['before', 'expected', 'outcome'], errors);
      for (const k of ['before', 'expected']) {
        const t = s[k];
        if (typeof t !== 'string' || t.length < 1 || t.length > 280 || !SUMMARY_TEXT.test(t)) errors.push(`/task_summary/${k}: one line of 1 to 280 characters in the label charset`);
      }
    }
  }
  if ('mode' in v && v.mode !== 'replay' && v.mode !== 'trace_review') errors.push('/mode: replay or trace_review');
  if ('answer_shape' in v && v.answer_shape !== 'single' && v.answer_shape !== 'open') errors.push('/answer_shape: single or open');
  if ('pin' in v && v.pin !== null) {
    const p = v.pin;
    if (!isObject(p)) errors.push('/pin: null or {pin_sha256, record}');
    else {
      closedKeys('/pin', p, ['pin_sha256', 'record'], errors);
      if (typeof p.pin_sha256 !== 'string' || !SHA256.test(p.pin_sha256)) errors.push('/pin/pin_sha256: 64 lowercase hex');
      if (!isObject(p.record)) errors.push('/pin/record: the tma-pin/1 record');
      else if (p.record.format !== 'tma-pin/1' && p.record.schema !== 'tma-pin/1') errors.push('/pin/record: not a tma-pin/1 record');
    }
  }
  if (v.source === 'trace' && v.pin === null) errors.push('/pin: required (non-null) when source = trace');
  if ('task_ref' in v) {
    const t = v.task_ref;
    if (!isObject(t)) errors.push('/task_ref: {kind, id}');
    else {
      closedKeys('/task_ref', t, ['kind', 'id'], errors);
      if (t.kind !== 'dfl-task' && t.kind !== 'tma-task') errors.push('/task_ref/kind: dfl-task or tma-task');
      text('/task_ref/id', t.id, 3, 120, errors);
      if (t.kind === 'tma-task' && typeof t.id === 'string' && !TMA_TASK_ID.test(t.id)) errors.push('/task_ref/id: a tma-task is <slug>@<version>, for example tsk_webhook_dup@1.0.0');
    }
  }
  if ('expected' in v) {
    const e = v.expected;
    if (!isObject(e)) errors.push('/expected: {text, written_by, written_at}');
    else {
      closedKeys('/expected', e, ['text', 'written_by', 'written_at'], errors);
      text('/expected/text', e.text, 1, 4000, errors);
      text('/expected/written_by', e.written_by, 1, 80, errors);
      if (typeof e.written_at !== 'string' || !DATE_TIME.test(e.written_at)) errors.push('/expected/written_at: an RFC 3339 date-time');
    }
  }
  if ('graders' in v) {
    const g = v.graders;
    if (!Array.isArray(g) || g.length === 0) errors.push('/graders: at least one grader');
    else {
      const seen = new Set<string>();
      g.forEach((x, i) => {
        if (!isObject(x)) return errors.push(`/graders/${i}: {id, version, weight, hard_gate}`);
        closedKeys(`/graders/${i}`, x, ['id', 'version', 'weight', 'hard_gate', 'decisive'], errors);
        if (typeof x.id !== 'string' || !GRADER_ID.test(x.id)) errors.push(`/graders/${i}/id: a grader id`);
        else if (seen.has(x.id)) errors.push(`/graders/${i}/id: ${x.id} is listed twice (one version per grader per case)`);
        else seen.add(x.id);
        if (typeof x.version !== 'string' || !SEMVER.test(x.version)) errors.push(`/graders/${i}/version: a semver x.y.z`);
        if (typeof x.weight !== 'number' || !Number.isFinite(x.weight) || x.weight <= 0) errors.push(`/graders/${i}/weight: a number above 0`);
        if (typeof x.hard_gate !== 'boolean') errors.push(`/graders/${i}/hard_gate: true or false`);
        if ('decisive' in x && typeof x.decisive !== 'boolean') errors.push(`/graders/${i}/decisive: true or false`);
      });
    }
  }
  if ('split' in v && !['golden', 'calibration-train', 'calibration-dev', 'calibration-test', 'none'].includes(v.split as string)) errors.push('/split: golden, calibration-train|dev|test or none');
  if ('source' in v && !['trace', 'a11-build-case', 'synthetic'].includes(v.source as string)) errors.push('/source: trace, a11-build-case or synthetic');
  return errors;
}

export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** Read, size-check, parse and validate one case manifest. manifest_sha256 = sha256 of the file bytes. */
export async function readCaseManifest(file: string): Promise<{ manifest: CaseManifest; raw: Buffer; manifestSha256: string }> {
  const raw = await readFile(file).catch(() => null);
  if (!raw) throw new CliError(`no case manifest at ${file}`);
  if (raw.length > CASE_MAX_BYTES) throw new CliError(`${file} is ${raw.length} bytes; a case manifest is at most ${CASE_MAX_BYTES} (it holds pointers and digests only)`);
  let value: unknown;
  try {
    value = JSON.parse(raw.toString('utf-8'));
  } catch {
    throw new CliError(`${file} is not JSON`);
  }
  const errors = caseErrors(value);
  if (errors.length > 0) throw new CliError(`${file} is not a valid ${CASE_FORMAT} manifest:\n  ${errors.slice(0, 12).join('\n  ')}`);
  return { manifest: value as CaseManifest, raw, manifestSha256: sha256(raw) };
}

/** The pin of a case, checked. A replay needs a complete, valid tma-pin/1 record (parent ADR-7). */
export function checkCasePin(m: CaseManifest): { pinSha256: string | null; replayable: boolean | null; repo: string | null; baseSha: string | null } {
  if (m.pin === null) return { pinSha256: null, replayable: null, repo: null, baseSha: null };
  const record = m.pin.record;
  if (record.format !== 'tma-pin/1') {
    // A pointer-only pin (the record names the session, not every digest): provenance, never a replay input.
    if (m.mode === 'replay') throw new CliError('the case pin is not a full tma-pin/1 record (no "format"): a replay needs the complete pin of C2 (tma-pin/1)');
    return { pinSha256: m.pin.pin_sha256, replayable: null, repo: null, baseSha: null };
  }
  const v = validatePin(record);
  if (!v.ok) throw new CliError(`the case pin is not a valid tma-pin/1 record: ${v.errors.slice(0, 4).join('; ')}`);
  if (v.value.pin_sha256 !== m.pin.pin_sha256) throw new CliError('the case pin_sha256 does not match the pin record');
  const replayable = pinReplayable(v.value);
  if (m.mode === 'replay' && !replayable) throw new CliError('the case pin has a missing field: a partial pin is not used for replay (parent ADR-7)');
  return { pinSha256: m.pin.pin_sha256, replayable, repo: v.value.repo ?? null, baseSha: v.value.base_sha ?? null };
}

/**
 * The task bundle of a case: --task-dir (a private bundle, for example one that A11 build-case wrote),
 * else the curated bundle benchmarks/<slug> of a tma-task. The major version must match. Null: the case
 * has no bundle on this host (a dfl-task case without --task-dir).
 */
export async function resolveCaseTask(m: CaseManifest, taskDir?: string, benchmarksDir = BENCHMARKS_DIR): Promise<ResolvedTask | null> {
  let r: ResolvedTask | null = null;
  if (taskDir) {
    if (!(await stat(join(taskDir, 'task.json')).catch(() => null))) throw new CliError(`no task.json in ${taskDir}`);
    r = await loadResolved(taskDir);
  } else if (m.task_ref.kind === 'tma-task') {
    const slug = TMA_TASK_ID.exec(m.task_ref.id)![1]!;
    const dir = join(benchmarksDir, slug);
    if (!(await stat(join(dir, 'task.json')).catch(() => null))) throw new CliError(`the case names ${m.task_ref.id}: no bundle ${slug} in this runner (give --task-dir <folder>)`);
    r = await loadResolved(dir);
  }
  if (r && m.task_ref.kind === 'tma-task') {
    const want = Number.parseInt(TMA_TASK_ID.exec(m.task_ref.id)![2]!, 10);
    const have = Number.parseInt(r.task.contract.task.version, 10);
    if (want !== have) throw new CliError(`the case names ${m.task_ref.id}, the bundle ${r.id} has version ${r.task.contract.task.version}`);
  }
  if (r) refuseMcp(r);
  return r;
}

export interface CaseLock {
  format: typeof CASE_LOCK_FORMAT;
  kit_version: string;
  built_at: string;
  case_key: string;
  use_case: string;
  mode: CaseManifest['mode'];
  manifest_sha256: string;
  pin_sha256: string | null;
  pin_replayable: boolean | null;
  task: null | {
    ref: string;
    bundle_dir: string;
    contract_sha256: string;
    environment_sha256: string;
    hidden_tests_sha256: string;
    item_sha256: string;
  };
  input: { kind: 'bundle-workspace' | 'pin-clone' | 'none'; dir: string | null; repo: string | null; base_sha: string | null };
  recorded: null | { file: string; target: string; sha256: string };
}

async function isEmptyOrAbsent(dir: string): Promise<boolean> {
  const st = await stat(dir).catch(() => null);
  if (!st) return true;
  return st.isDirectory() && (await readdir(dir)).length === 0;
}

/** Clone owner/name at base_sha into dest with the host's own git and credentials. */
async function clonePinnedRepo(repo: string, baseSha: string, dest: string): Promise<void> {
  const url = `https://github.com/${repo}.git`;
  const clone = await exec('git', ['clone', '--quiet', '--no-checkout', '--filter=blob:none', url, dest], { timeoutMs: 600_000 });
  if (clone.code !== 0) throw new CliError(`git clone ${url} failed: ${clone.stderr.trim().slice(0, 300)}`);
  const co = await exec('git', ['-C', dest, 'checkout', '--quiet', '--detach', baseSha], { timeoutMs: 600_000 });
  if (co.code !== 0) throw new CliError(`git checkout ${baseSha.slice(0, 12)} in ${repo} failed: ${co.stderr.trim().slice(0, 300)}`);
}

/** Build the case folder. `dest` must be new or empty. Returns the lock. */
export async function buildCaseFolder(input: {
  caseFile: string;
  dest: string;
  taskDir?: string;
  recorded?: string;
  clone?: boolean;
  now?: () => Date;
  benchmarksDir?: string;
}): Promise<CaseLock> {
  const { manifest: m, raw, manifestSha256 } = await readCaseManifest(input.caseFile);
  const dest = resolve(input.dest);
  if (!(await isEmptyOrAbsent(dest))) throw new CliError(`${input.dest} exists and is not empty: give a new folder`);
  const pin = checkCasePin(m);
  const r = await resolveCaseTask(m, input.taskDir, input.benchmarksDir);
  if (m.mode === 'trace_review' && !input.recorded) throw new CliError('a trace_review case grades a recorded output: give --recorded <patch file> (it stays on this host)');
  if (m.mode === 'replay' && input.recorded) throw new CliError('--recorded is for a trace_review case; a replay case runs a variant (tma eval run)');
  if (input.clone && (m.mode !== 'replay' || !pin.repo || !pin.baseSha)) throw new CliError('--clone needs a replay case whose pin names the repo and the base_sha');
  if (m.mode === 'replay' && !r && !input.clone) {
    throw new CliError(`the case ${m.case_key} has no task bundle on this host (task_ref ${m.task_ref.kind} ${m.task_ref.id}): give --task-dir <bundle>, or --clone to fetch the pinned repo`);
  }

  await mkdir(join(dest, CASE_RUNS_DIR), { recursive: true });
  await writeFile(join(dest, CASE_FILE), raw);
  let inputInfo: CaseLock['input'] = { kind: 'none', dir: null, repo: pin.repo, base_sha: pin.baseSha };
  if (input.clone) {
    await clonePinnedRepo(pin.repo!, pin.baseSha!, join(dest, CASE_INPUT_DIR));
    inputInfo = { kind: 'pin-clone', dir: CASE_INPUT_DIR, repo: pin.repo, base_sha: pin.baseSha };
  } else if (r && m.mode === 'replay') {
    // The agent-visible input of the task (environment + public tests + INSTRUCTION.md), for a harness
    // outside the sandbox. The sandbox itself rebuilds its workspace from the bundle on each run.
    const profile = loadRunProfile();
    await materializeLocalWorkspace(r, join(dest, CASE_INPUT_DIR), { install: false, installCmd: profile.install_cmd, installTimeoutMs: profile.timeouts.install_sec * 1000 });
    inputInfo = { kind: 'bundle-workspace', dir: CASE_INPUT_DIR, repo: pin.repo, base_sha: pin.baseSha };
  }
  let recorded: CaseLock['recorded'] = null;
  if (input.recorded) {
    const target = resolve(input.recorded);
    const body = await readFile(target).catch(() => null);
    if (!body) throw new CliError(`no recorded output at ${input.recorded}`);
    // A link, not a copy: the recorded output stays where the host keeps it (Q-T9 = A).
    await symlink(target, join(dest, CASE_RECORDED_FILE));
    recorded = { file: CASE_RECORDED_FILE, target, sha256: sha256(body) };
  }
  const lock: CaseLock = {
    format: CASE_LOCK_FORMAT,
    kit_version: CLI_VERSION,
    built_at: (input.now ?? (() => new Date()))().toISOString(),
    case_key: m.case_key,
    use_case: m.use_case,
    mode: m.mode,
    manifest_sha256: manifestSha256,
    pin_sha256: pin.pinSha256,
    pin_replayable: pin.replayable,
    task: r
      ? {
          ref: m.task_ref.id,
          bundle_dir: r.dir,
          contract_sha256: r.digests.contract,
          environment_sha256: r.digests.environment,
          hidden_tests_sha256: r.digests.hidden_tests,
          item_sha256: r.itemSha256,
        }
      : null,
    input: inputInfo,
    recorded,
  };
  await writeFile(join(dest, CASE_LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`, 'utf-8');
  return lock;
}

export interface LoadedCase {
  dir: string;
  manifest: CaseManifest;
  manifestSha256: string;
  lock: CaseLock;
  task: ResolvedTask | null;
}

/**
 * Open a case folder and re-check it: the manifest still has the locked digest, and the task bundle
 * still has the locked digests. A changed manifest or bundle is a different case: build it again.
 */
export async function loadCaseFolder(dir: string): Promise<LoadedCase> {
  const root = resolve(dir);
  const lockRaw = await readFile(join(root, CASE_LOCK_FILE), 'utf-8').catch(() => null);
  if (!lockRaw) throw new CliError(`${dir} is not a case folder (no ${CASE_LOCK_FILE}): run "tma eval case" first`);
  let lock: CaseLock;
  try {
    lock = JSON.parse(lockRaw) as CaseLock;
  } catch {
    throw new CliError(`${join(dir, CASE_LOCK_FILE)} is not JSON`);
  }
  if (lock.format !== CASE_LOCK_FORMAT) throw new CliError(`${join(dir, CASE_LOCK_FILE)} is not a ${CASE_LOCK_FORMAT} lock`);
  const { manifest, manifestSha256 } = await readCaseManifest(join(root, CASE_FILE));
  if (manifestSha256 !== lock.manifest_sha256) throw new CliError(`${CASE_FILE} changed after "tma eval case" (digest ${manifestSha256.slice(0, 12)} vs ${lock.manifest_sha256.slice(0, 12)}): build the case folder again`);
  let task: ResolvedTask | null = null;
  if (lock.task) {
    task = await loadResolved(lock.task.bundle_dir);
    const d = task.digests;
    if (d.contract !== lock.task.contract_sha256 || d.environment !== lock.task.environment_sha256 || d.hidden_tests !== lock.task.hidden_tests_sha256) {
      throw new CliError(`the task bundle ${lock.task.bundle_dir} changed after "tma eval case": build the case folder again`);
    }
  }
  return { dir: root, manifest, manifestSha256, lock, task };
}
