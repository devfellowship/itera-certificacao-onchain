// MT-05 "Build N cases" (plan 20261118-melhorias-tma, task MT-05-SELECT-BUILD-CASES; Q 3d291a2b = A): the studio
// turns N selected traces into N case drafts in the eval repo, the place where the eval cases already live
// (dfl-evals `cases/<type>/<subtype>/<case_key>/case.json`, format tma-case/1, validated by eval/case.ts caseErrors).
//
// One draft per trace. The manifest holds pointers, digests and the short task summary only, as every tma-case/1
// manifest does; the trace text stays on this host. A trace becomes a draft only when it has:
//   - a candidate row with a task id (task_ref: dfl-task),
//   - a pin in a pins index of the selection and its full tma-pin/1 record in `pins-<day>.jsonl` (source = trace
//     needs a pin; a replay case needs a complete one, else the draft is a trace_review case).
// The case key is the rule of `trace-pin` review_batch.py (`trace-<task8>-<run8>`), so the same run gives the same
// key on both paths. A key that the store already holds is skipped (`case_exists`), never overwritten.
//
// Two stores, picked by the login kind in one place (server.ts storeFor), as the trace sources are:
//   - fixture principal -> DirCaseStore on a synthetic folder (the prod check login; nothing leaves the host);
//   - real principal    -> GitCaseStore: a clone of the eval repo; a new branch from origin/<base>, one commit, then
//                          the publish command (push + PR, with the GitHub write credential of Q 414138a4 / Q 91dda89f)
//                          prints the PR URL. Without a clone and a publish command the real store is absent: 503.
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pinReplayable, validatePin } from '@itera/contracts';
import { exec } from '../../exec.js';
import { caseErrors, CASE_FILE, CASE_FORMAT, type CaseManifest } from '../eval/case.js';
import { findCandidate, NotFound, pinRecordOf, resolveTraceId, TRACE_ID, type StudioSources } from './content.js';

export const CASE_DRAFTS_PATH = '/v1/case-drafts';
/** At most this many traces per build (one request, one commit, one PR). */
export const CASE_DRAFTS_MAX = 20;
export const CASE_DRAFTS_MAX_BODY = 16 * 1024;
export const CASE_DRAFT_WRITER = 'tma studio build-cases';
/** The judges of a draft when the serve names none: the two C6 judges of the eval repo (judges/<id>/<semver>). */
export const DEFAULT_CASE_JUDGES: ReadonlyArray<{ id: string; version: string }> = Object.freeze([
  { id: 'async-wait-lifecycle', version: '0.1.0' },
  { id: 'external-block-handling', version: '0.1.0' },
]);

const USE_CASE = /^[a-z0-9][a-z0-9-]{0,30}\/[a-z0-9][a-z0-9-]{0,30}$/;
const CASE_KEY = /^[a-z0-9][a-z0-9_-]{2,62}$/;

export class CaseDraftRefused extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface BuildRequest {
  trace_ids: string[];
  use_case: string;
}

/** Parse and check the POST body: {trace_ids: [1..20 distinct 12-hex trace ids], use_case: "<type>/<subtype>"}. */
export function parseBuildBody(text: string): BuildRequest {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new CaseDraftRefused(400, 'bad_body', 'the body is not JSON');
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new CaseDraftRefused(400, 'bad_body', 'the body is a JSON object');
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (k !== 'trace_ids' && k !== 'use_case') throw new CaseDraftRefused(400, 'bad_body', `unknown key: ${k.slice(0, 40)}`);
  const ids = o.trace_ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > CASE_DRAFTS_MAX) throw new CaseDraftRefused(400, 'bad_trace_ids', `trace_ids: 1 to ${CASE_DRAFTS_MAX} trace ids`);
  if (!ids.every((x): x is string => typeof x === 'string' && TRACE_ID.test(x))) throw new CaseDraftRefused(400, 'bad_trace_ids', 'trace_ids: 12 lowercase hex each');
  if (new Set(ids).size !== ids.length) throw new CaseDraftRefused(400, 'bad_trace_ids', 'trace_ids: a trace id repeats');
  if (typeof o.use_case !== 'string' || !USE_CASE.test(o.use_case)) throw new CaseDraftRefused(400, 'bad_use_case', 'use_case: the L1 pair <type>/<subtype>, for example fix/red-ci');
  return { trace_ids: ids, use_case: o.use_case };
}

/** The case key of one run: `trace-<first 8 of the task id>-<first 8 alphanumerics of the agent or session id>`. */
export function draftCaseKey(taskId: string, sessionId: string, agentId: string | null): string {
  const run = (agentId || sessionId || '').slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, '') || 'run';
  return `trace-${taskId.slice(0, 8).toLowerCase()}-${run}`;
}

export type DraftSkip = { trace_id: string; reason: 'trace_not_found' | 'no_candidate' | 'no_task' | 'no_pin' | 'no_pin_record' | 'pin_record_invalid' | 'manifest_invalid' | 'case_exists' };
export interface Draft {
  trace_id: string;
  case_key: string;
  path: string;
  manifest: CaseManifest;
}

/** The tma-case/1 draft of one trace, or the reason it cannot be one. Reads the sources only. */
export function draftFromTrace(src: StudioSources, traceId: string, useCase: string, judges: ReadonlyArray<{ id: string; version: string }>, writtenAt: string): Draft | DraftSkip {
  let run: { sessionId: string; agentId: string | null };
  try {
    run = resolveTraceId(src, traceId);
  } catch (e) {
    if (e instanceof NotFound) return { trace_id: traceId, reason: 'trace_not_found' };
    throw e;
  }
  const found = findCandidate(src.selectDir, run.sessionId, run.agentId);
  if (!found) return { trace_id: traceId, reason: 'no_candidate' };
  const row = found.row;
  const taskId = typeof row.task_id === 'string' ? row.task_id.trim() : '';
  if (taskId.length < 3 || taskId.length > 120) return { trace_id: traceId, reason: 'no_task' };
  const pin = pinRecordOf(src.selectDir, run.sessionId, run.agentId);
  if (!pin) return { trace_id: traceId, reason: 'no_pin' };
  if (!pin.record) return { trace_id: traceId, reason: 'no_pin_record' };
  const checked = validatePin(pin.record);
  if (!checked.ok || checked.value.pin_sha256 !== pin.pin_sha256) return { trace_id: traceId, reason: 'pin_record_invalid' };
  const replay = row.mode === 'replay' && pinReplayable(checked.value);
  const summary = row.task_summary && typeof row.task_summary === 'object' ? (row.task_summary as Record<string, unknown>) : null;
  const before = typeof summary?.before === 'string' ? summary.before.trim() : '';
  const expected = typeof summary?.expected === 'string' ? summary.expected.trim() : '';
  const caseKey = draftCaseKey(taskId, run.sessionId, run.agentId);
  const manifest: CaseManifest = {
    schema: CASE_FORMAT,
    case_key: caseKey,
    use_case: useCase,
    mode: replay ? 'replay' : 'trace_review',
    answer_shape: 'open',
    pin: { pin_sha256: pin.pin_sha256, record: pin.record },
    task_ref: { kind: 'dfl-task', id: taskId },
    expected: {
      text: expected ? expected.slice(0, 4000) : `Draft from trace ${traceId}: write the expected outcome before the merge.`,
      written_by: CASE_DRAFT_WRITER,
      written_at: writtenAt,
    },
    graders: judges.map((j) => ({ id: j.id, version: j.version, weight: 1, hard_gate: false })),
    split: 'none',
    source: 'trace',
  };
  // The short summary rides along only when it fits the case charset and length; else the draft goes without it.
  if (before && expected) {
    const withSummary = { ...manifest, task_summary: { before: before.slice(0, 280), expected: expected.slice(0, 280) } };
    if (caseErrors(withSummary).length === 0) Object.assign(manifest, { task_summary: withSummary.task_summary });
  }
  if (caseErrors(manifest).length > 0 || !CASE_KEY.test(caseKey)) return { trace_id: traceId, reason: 'manifest_invalid' };
  return { trace_id: traceId, case_key: caseKey, path: casePath(useCase, caseKey), manifest };
}

/** `cases/<type>/<subtype>/<case_key>/case.json`, the layout of the eval repo. */
export const casePath = (useCase: string, caseKey: string) => ['cases', ...useCase.split('/'), caseKey, CASE_FILE].join('/');

export interface DraftListItem {
  case_key: string;
  use_case: string;
  mode: string;
  task_id: string;
  written_at: string;
  path: string;
}

export interface BuildResult {
  store: 'fixture' | 'evals';
  created: Array<{ trace_id: string; case_key: string; use_case: string; path: string }>;
  skipped: DraftSkip[];
  /** The pull request of the real store; null for the fixture store or when nothing was created. */
  pr_url: string | null;
  branch: string | null;
}

/** Where the drafts of one login kind are written. */
export interface CaseStore {
  readonly kind: 'fixture' | 'evals';
  /** True when the store already holds a case at this path. */
  has(path: string): Promise<boolean>;
  /** Write the drafts (all new). Returns the PR of the real store. */
  write(drafts: Draft[], title: string): Promise<{ pr_url: string | null; branch: string | null }>;
  list(): Promise<DraftListItem[]>;
  /** Remove one draft (the fixture store only; a real draft is removed by closing its PR). */
  remove(caseKey: string): Promise<boolean>;
}

const manifestText = (m: CaseManifest) => `${JSON.stringify(m, null, 2)}\n`;

function listCases(root: string): DraftListItem[] {
  const out: DraftListItem[] = [];
  const casesDir = join(root, 'cases');
  const dirs = (d: string) => {
    try {
      return readdirSync(d).filter((n) => statSync(join(d, n)).isDirectory());
    } catch {
      return [];
    }
  };
  for (const type of dirs(casesDir)) {
    for (const subtype of dirs(join(casesDir, type))) {
      for (const key of dirs(join(casesDir, type, subtype))) {
        try {
          const m = JSON.parse(readFileSync(join(casesDir, type, subtype, key, CASE_FILE), 'utf8')) as CaseManifest;
          if (m.expected?.written_by !== CASE_DRAFT_WRITER) continue;
          out.push({ case_key: m.case_key, use_case: m.use_case, mode: m.mode, task_id: m.task_ref.id, written_at: m.expected.written_at, path: casePath(m.use_case, m.case_key) });
        } catch {
          // Not a readable manifest: not a draft of this studio.
        }
      }
    }
  }
  return out.sort((a, b) => b.written_at.localeCompare(a.written_at) || a.case_key.localeCompare(b.case_key));
}

/** The fixture store: a plain folder with the eval repo layout. Writes only inside its root. */
export class DirCaseStore implements CaseStore {
  readonly kind = 'fixture' as const;
  readonly root: string;
  constructor(root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.root = realpathSync(root);
  }
  private abs(path: string): string {
    const p = resolve(this.root, path);
    if (!p.startsWith(this.root + sep)) throw new Error('path outside the store');
    return p;
  }
  async has(path: string): Promise<boolean> {
    try {
      statSync(this.abs(path));
      return true;
    } catch {
      return false;
    }
  }
  async write(drafts: Draft[]): Promise<{ pr_url: null; branch: null }> {
    for (const d of drafts) {
      const file = this.abs(d.path);
      mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
      writeFileSync(file, manifestText(d.manifest), { flag: 'wx', mode: 0o600 });
    }
    return { pr_url: null, branch: null };
  }
  async list(): Promise<DraftListItem[]> {
    return listCases(this.root);
  }
  async remove(caseKey: string): Promise<boolean> {
    if (!CASE_KEY.test(caseKey)) return false;
    const hit = listCases(this.root).find((d) => d.case_key === caseKey);
    if (!hit) return false;
    rmSync(join(this.abs(hit.path), '..'), { recursive: true, force: true });
    return true;
  }
}

export interface GitCaseStoreOptions {
  /** A clone of the eval repo with an `origin` remote. This store owns its working tree. */
  repo: string;
  /** The base branch of the PR. Default main. */
  base?: string;
  /** Pushes the branch and opens the PR: `<cmd> <repo dir> <branch> <title>`; the last stdout line is the PR URL. */
  publishCmd: string;
  /** Clock and timeouts, for the tests. */
  now?: () => Date;
  timeoutMs?: number;
}

/**
 * The real store: one branch `studio/build-cases-<stamp>` from origin/<base>, one commit with the drafts, then the
 * publish command. The working tree goes back to a detached origin/<base> after every build, also after a failure.
 */
export class GitCaseStore implements CaseStore {
  readonly kind = 'evals' as const;
  constructor(private readonly o: GitCaseStoreOptions) {}
  private async git(args: string[]): Promise<string> {
    const r = await exec('git', ['-C', this.o.repo, ...args], { timeoutMs: this.o.timeoutMs ?? 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    if (r.code !== 0) throw new CaseDraftRefused(502, 'evals_git_failed', `git ${args[0]} failed`);
    return r.stdout;
  }
  private get base() {
    return this.o.base ?? 'main';
  }
  private async sync(): Promise<void> {
    await this.git(['fetch', '--quiet', 'origin', this.base]);
    await this.git(['checkout', '--quiet', '--force', '--detach', `origin/${this.base}`]);
  }
  async has(path: string): Promise<boolean> {
    await this.sync();
    const r = await exec('git', ['-C', this.o.repo, 'cat-file', '-e', `origin/${this.base}:${path}`], { timeoutMs: 10_000 });
    return r.code === 0;
  }
  async write(drafts: Draft[], title: string): Promise<{ pr_url: string | null; branch: string | null }> {
    const stamp = (this.o.now ?? (() => new Date()))().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').toLowerCase();
    const branch = `studio/build-cases-${stamp}`;
    try {
      await this.sync();
      await this.git(['checkout', '--quiet', '-b', branch]);
      for (const d of drafts) {
        const file = join(this.o.repo, d.path);
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, manifestText(d.manifest), { flag: 'wx' });
      }
      await this.git(['add', '--', ...drafts.map((d) => d.path)]);
      await this.git(['-c', 'user.name=tma-studio', '-c', 'user.email=tma-studio@users.noreply.github.com', 'commit', '--quiet', '-m', title]);
      const r = await exec(this.o.publishCmd, [this.o.repo, branch, title], { timeoutMs: this.o.timeoutMs ?? 120_000 });
      const url = r.stdout.trim().split('\n').at(-1)?.trim() ?? '';
      if (r.code !== 0 || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(url)) throw new CaseDraftRefused(502, 'evals_publish_failed', 'the publish command did not print a PR URL');
      return { pr_url: url, branch };
    } finally {
      await this.sync().catch(() => undefined);
      await exec('git', ['-C', this.o.repo, 'branch', '-D', branch], { timeoutMs: 10_000 }).catch(() => undefined);
    }
  }
  async list(): Promise<DraftListItem[]> {
    await this.sync();
    return listCases(this.o.repo);
  }
  async remove(): Promise<boolean> {
    throw new CaseDraftRefused(409, 'close_the_pr', 'a draft in the eval repo is removed by closing its pull request');
  }
}

/** Build the drafts of N traces into one store. Skips what cannot be a draft; writes the rest in one go. */
export async function buildCaseDrafts(src: StudioSources, store: CaseStore, req: BuildRequest, judges: ReadonlyArray<{ id: string; version: string }> = DEFAULT_CASE_JUDGES, now: Date = new Date()): Promise<BuildResult> {
  const writtenAt = now.toISOString().replace(/\.\d+Z$/, 'Z');
  const drafts: Draft[] = [];
  const skipped: DraftSkip[] = [];
  const keys = new Set<string>();
  for (const id of req.trace_ids) {
    const d = draftFromTrace(src, id, req.use_case, judges, writtenAt);
    if ('reason' in d) skipped.push(d);
    else if (keys.has(d.case_key) || (await store.has(d.path))) skipped.push({ trace_id: id, reason: 'case_exists' });
    else {
      keys.add(d.case_key);
      drafts.push(d);
    }
  }
  const title = `cases: ${drafts.length} ${drafts.length === 1 ? 'draft' : 'drafts'} from studio traces (${req.use_case})`;
  const out = drafts.length > 0 ? await store.write(drafts, title) : { pr_url: null, branch: null };
  return {
    store: store.kind,
    created: drafts.map((d) => ({ trace_id: d.trace_id, case_key: d.case_key, use_case: req.use_case, path: d.path })),
    skipped,
    pr_url: out.pr_url,
    branch: out.branch,
  };
}
