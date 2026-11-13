// `POST /grade/dry-run` of `tma studio serve` (plan 20261112-tma-c5-studio-area-web2, task C5-T10;
// Tainan Q-C5-2b = A: "dry run only, no network, nothing stored, only A11 Q1 = B judge models").
//
// One grader of the grader library grades one output and the answer goes back to the caller. Nothing is stored:
// the output goes into a temp dir that is removed in `finally`; no case folder, no run folder, no TMA API call
// (the login check `GET /auth/me` is the only one, in auth.ts), no DB.
//
// The grading runs through the SAME code path as `tma eval grade --dry-run` (C3-T11, eval/dry-run.ts
// `dryRunGrade` -> graders.ts `runGraders` + `caseVerdict`): the request becomes a one-grader in-memory case and
// the output a `--trace` file. A code grader is a tma-grader/1 library grader run by eval/prove.ts
// `runLibraryGrader` (the runner of `tma eval grader prove`: argv, no shell, minimal child env). A judge grader
// is eval/judge.ts `makeJudgeGrader` with the kit's JudgeFn; its model must pass `privateTextModelAllowed`
// (A11 Q1 = B) and is checked here BEFORE any temp dir, process or judge call.
//
// Request body (JSON, max 256 KB):
//   { "grader": "<graderId>@<semver>", "output": "<text>", "expected"?: "<text>" }
// `output` is the text under grading. `expected` is the case's expected text (a judge reads it; a code grader
// gets it as workdir/<expected_file> when given). No other key is accepted.
//
// Grader library layout (`--grader-root <dir>`): <dir>/<graderId>/<semver>/grader.json
//   code:  {"schema":"tma-grader/1","kind":"code","id","semver","entry":"grade.py",
//           "dry_run"?: {"spec"?: "<file in the grader dir>", "output_file"?: "output.txt", "expected_file"?: "expected.txt"}}
//          spec.json = dry_run.spec, else fixtures/reference/spec.json, else {}.
//   judge: {"schema":"tma-grader/1","kind":"judge","id","semver","model":"<model id>","rubric"?: "rubric.md"}
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { sha256 } from '../eval/case.js';
import type { LoadedCase } from '../eval/case.js';
import { dryRunGrade, DRY_RUN_FORMAT } from '../eval/dry-run.js';
import type { Grader, GraderOutcome } from '../eval/graders.js';
import { makeJudgeGrader, privateTextModelAllowed, unconfiguredJudgeFn, type JudgeFn } from '../eval/judge.js';
import { libraryManifest, runLibraryGrader } from '../eval/prove.js';
import { catalogModelId } from '../eval/upload.js';

export const DRY_RUN_PATH = '/grade/dry-run';
export const DRY_RUN_MAX_BODY = 256 * 1024;
export const DRY_RUN_TIMEOUT_MS = 60_000;

export interface DryRunOptions {
  /** The grader library root. Unset: the route answers 503 grader_library_not_configured. */
  graderRoot?: string;
  /** The kit's judge path. Default: the kit default (it does not call a model: judge_runner_not_configured). */
  judgeFn?: JudgeFn;
  /** Default 60 s; the answer is 504 after it. */
  timeoutMs?: number;
  /** Parent of the temp dirs (default os.tmpdir()). Tests point it at an empty dir to see it stays empty. */
  tmpRoot?: string;
}

export interface DryRunRequest {
  graderId: string;
  semver: string;
  output: string;
  expected?: string;
}

export interface DryRunAnswer {
  pass: boolean;
  score: number | null;
  details: {
    format: typeof DRY_RUN_FORMAT;
    grader: { id: string; version: string; kind: 'code' | 'judge' | 'human'; code_sha256: string | null };
    infra_ok: boolean;
    reason: string | null;
    output_sha256: string;
  };
  durationMs: number;
  stored: false;
}

/** A refusal with an HTTP status and a fixed code. The message never holds a path or a token. */
export class DryRunRefused extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SEMVER_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?$/;

/** Parse and check the request body. Throws DryRunRefused(400). */
export function parseDryRunBody(raw: string): DryRunRequest {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new DryRunRefused(400, 'bad_json', 'the body is not JSON');
  }
  if (!isObj(v)) throw new DryRunRefused(400, 'bad_body', 'the body is a JSON object');
  for (const k of Object.keys(v)) if (!['grader', 'output', 'expected'].includes(k)) throw new DryRunRefused(400, 'bad_body', `unknown key: ${k.slice(0, 40)}`);
  if (typeof v.grader !== 'string') throw new DryRunRefused(400, 'bad_grader', 'grader must be "<graderId>@<semver>"');
  const at = v.grader.lastIndexOf('@');
  const graderId = v.grader.slice(0, at);
  const semver = v.grader.slice(at + 1);
  if (at <= 0 || !ID_RE.test(graderId) || !SEMVER_RE.test(semver)) throw new DryRunRefused(400, 'bad_grader', 'grader must be "<graderId>@<semver>" (lower-case id, x.y.z)');
  if (typeof v.output !== 'string') throw new DryRunRefused(400, 'bad_output', 'output must be a string');
  if (v.expected !== undefined && typeof v.expected !== 'string') throw new DryRunRefused(400, 'bad_expected', 'expected must be a string');
  return { graderId, semver, output: v.output, ...(typeof v.expected === 'string' ? { expected: v.expected } : {}) };
}

/** `<root>/<id>/<semver>` when it is a real folder inside the root (symlinks resolved). Throws DryRunRefused. */
function graderDirOf(root: string, id: string, semver: string): string {
  let realRoot: string;
  try {
    realRoot = realpathSync(resolve(root));
  } catch {
    throw new DryRunRefused(503, 'grader_library_unavailable', 'the grader library root cannot be read');
  }
  let dir: string;
  try {
    dir = realpathSync(join(realRoot, id, semver));
  } catch {
    throw new DryRunRefused(404, 'grader_not_found', `no grader ${id}@${semver} in the grader library`);
  }
  if (!dir.startsWith(realRoot + sep)) throw new DryRunRefused(400, 'bad_grader', 'the grader is outside the grader library');
  return dir;
}

/** A path named in grader.json, inside the grader folder, or null. */
function inside(dir: string, rel: unknown): string | null {
  if (typeof rel !== 'string' || rel === '' || isAbsolute(rel)) return null;
  const p = resolve(dir, rel);
  return relative(dir, p).startsWith('..') ? null : p;
}

/** A relative file name for the workdir (no "..", no absolute path). */
function workdirName(v: unknown, dflt: string): string {
  if (v === undefined) return dflt;
  if (typeof v !== 'string' || !/^[A-Za-z0-9_.-][A-Za-z0-9_./-]{0,127}$/.test(v) || v.split('/').includes('..')) {
    throw new DryRunRefused(422, 'bad_grader_manifest', 'grader.json dry_run file names must be relative names inside workdir');
  }
  return v;
}

interface Loaded {
  grader: Grader;
  kind: 'code' | 'judge';
}

/**
 * Read grader.json and build the kit Grader. A judge whose model is outside A11 Q1 = B is refused HERE, before
 * any temp dir, child process or judge call.
 */
async function loadGrader(dir: string, req: DryRunRequest, opts: DryRunOptions, timeoutMs: number, outputFile: () => string): Promise<Loaded> {
  const raw = await readFile(join(dir, 'grader.json'), 'utf-8').catch(() => null);
  let g: unknown;
  try {
    g = raw === null ? null : JSON.parse(raw);
  } catch {
    g = null;
  }
  if (!isObj(g) || g.schema !== 'tma-grader/1') throw new DryRunRefused(422, 'bad_grader_manifest', 'grader.json is not a tma-grader/1 manifest');
  const id = typeof g.id === 'string' ? g.id : req.graderId;
  const semver = typeof g.semver === 'string' ? g.semver : req.semver;
  if (id !== req.graderId || semver !== req.semver) throw new DryRunRefused(422, 'bad_grader_manifest', 'grader.json names another id or version than its folder');

  if (g.kind === 'judge') {
    if (typeof g.model !== 'string' || g.model.trim() === '') throw new DryRunRefused(422, 'bad_grader_manifest', 'a judge grader.json needs "model"');
    // A11 Q1 = B: only the fleet Claude models or a local ollama/ or local/ model may read private case text.
    if (!privateTextModelAllowed(g.model)) {
      throw new DryRunRefused(
        422,
        'judge_model_not_allowed',
        `the judge model ${catalogModelId(g.model).slice(0, 80)} is not allowed: a dry run accepts only a fleet Claude model or a local ollama/ or local/ model (A11 Q1 = B)`,
      );
    }
    const rubricPath = inside(dir, g.rubric ?? 'rubric.md');
    const rubric = rubricPath ? await readFile(rubricPath, 'utf-8').catch(() => null) : null;
    if (rubric === null) throw new DryRunRefused(422, 'bad_grader_manifest', 'the judge rubric file is missing');
    const grader = makeJudgeGrader({
      id,
      semver,
      rubric,
      expected: req.expected ?? '',
      model: g.model,
      judgesDir: dirname(dirname(dir)),
      readsPrivateText: true,
      judgeFn: opts.judgeFn ?? unconfiguredJudgeFn,
      outputHandle: () => outputFile(),
    });
    return { grader, kind: 'judge' };
  }

  if (g.kind !== undefined && g.kind !== 'code') throw new DryRunRefused(422, 'grader_kind_not_supported', 'a dry run grades with a code or a judge grader');
  let lib;
  try {
    lib = await libraryManifest(dir);
  } catch {
    lib = null;
  }
  if (!lib) throw new DryRunRefused(422, 'bad_grader_manifest', 'a code grader.json needs "entry" inside the grader folder');
  const dry = isObj(g.dry_run) ? g.dry_run : {};
  const outName = workdirName(dry.output_file, 'output.txt');
  const expName = workdirName(dry.expected_file, 'expected.txt');
  const specPath = dry.spec !== undefined ? inside(dir, dry.spec) : join(dir, 'fixtures', 'reference', 'spec.json');
  if (dry.spec !== undefined && !specPath) throw new DryRunRefused(422, 'bad_grader_manifest', 'grader.json dry_run.spec must be inside the grader folder');
  const argv = ['python3', lib.entry];
  const grader: Grader = {
    id,
    semver,
    kind: 'code',
    needsSandbox: false,
    codeSha256: async () => sha256(raw!),
    async run(input): Promise<GraderOutcome> {
      const r = await runLibraryGrader({
        argv,
        graderDir: dir,
        timeoutMs,
        ...(opts.tmpRoot ? { tmpRoot: opts.tmpRoot } : {}),
        setup: async (tmp) => {
          const spec = specPath ? await readFile(specPath, 'utf-8').catch(() => null) : null;
          await writeFile(join(tmp, 'spec.json'), spec ?? '{}\n', 'utf-8');
          await mkdir(join(tmp, 'workdir'));
          const put = async (name: string, text: string) => {
            await mkdir(dirname(join(tmp, 'workdir', name)), { recursive: true });
            await writeFile(join(tmp, 'workdir', name), text, 'utf-8');
          };
          await put(outName, input.patch);
          if (req.expected !== undefined) await put(expName, req.expected);
        },
      });
      if (r.timed_out) return { pass: false, score: null, infra_ok: false, reason: 'grader_timeout: the grader did not answer in time' };
      if (r.observed === null) return { pass: false, score: null, infra_ok: false, reason: `grader_no_answer: no tma-grader-result/1 line (exit ${r.exit_code ?? 'none'})` };
      if (r.observed === 'infra_error') return { pass: false, score: null, infra_ok: false, reason: 'grader_infra_error: the grader did not measure the output' };
      return { pass: r.observed === 'pass', score: r.observed === 'pass' ? 100 : 0, infra_ok: true, reason: null };
    },
  };
  return { grader, kind: 'code' };
}

/** The one-grader in-memory case that carries the request through `dryRunGrade`. Nothing of it is on disk. */
function memoryCase(dir: string, req: DryRunRequest, kind: 'code' | 'judge'): LoadedCase {
  const manifest: LoadedCase['manifest'] = {
    schema: 'tma-case/1',
    case_key: `studio-dry-run/${req.graderId}@${req.semver}`,
    use_case: 'studio-dry-run',
    mode: 'trace_review',
    answer_shape: 'open',
    pin: null,
    task_ref: { kind: 'tma-task', id: 'none' },
    expected: { text: req.expected ?? '', written_by: 'studio-dry-run', written_at: new Date(0).toISOString() },
    // A judge asks for a decisive result: it counts only with a passing calibration record (C3 T5).
    graders: [{ id: req.graderId, version: req.semver, weight: 1, hard_gate: false, ...(kind === 'judge' ? { decisive: true } : {}) }],
    split: 'none',
    source: 'synthetic',
  };
  const text = JSON.stringify(manifest);
  return { dir, manifest, manifestSha256: sha256(text), lock: {} as LoadedCase['lock'], task: null };
}

/**
 * Run one dry run. Refusals throw DryRunRefused before any execution. The temp dir is removed in `finally`,
 * also after a throw. The grading promise is returned whole so the caller can keep the busy flag until it ends.
 */
export async function runDryRun(req: DryRunRequest, opts: DryRunOptions): Promise<DryRunAnswer> {
  const started = Date.now();
  if (!opts.graderRoot) throw new DryRunRefused(503, 'grader_library_not_configured', 'this service has no grader library (--grader-root)');
  const dir = graderDirOf(opts.graderRoot, req.graderId, req.semver);
  if (!(await stat(dir).catch(() => null))?.isDirectory()) throw new DryRunRefused(404, 'grader_not_found', `no grader ${req.graderId}@${req.semver} in the grader library`);
  const timeoutMs = opts.timeoutMs ?? DRY_RUN_TIMEOUT_MS;
  let outputFile = '';
  const { grader, kind } = await loadGrader(dir, req, opts, timeoutMs, () => outputFile);
  const tmp = await mkdtemp(join(opts.tmpRoot ?? tmpdir(), 'tma-studio-dry-run-'));
  try {
    outputFile = join(tmp, 'output.txt');
    await writeFile(outputFile, req.output, 'utf-8');
    const verdict = await dryRunGrade({ c: memoryCase(tmp, req, kind), runs: [], trace: outputFile, deps: { graders: [grader] }, log: () => undefined });
    const out = verdict.outputs[0]!;
    const r = out.graders[0]!;
    // The grader process hit the time limit: the same answer as the route timeout.
    if (r.reason?.startsWith('grader_timeout')) throw new DryRunRefused(504, 'dry_run_timeout', 'the dry run did not end in time');
    return {
      pass: out.case.pass,
      score: out.case.score,
      details: {
        format: DRY_RUN_FORMAT,
        grader: { id: r.id, version: r.version, kind: r.kind, code_sha256: r.code_sha256 },
        infra_ok: r.infra_ok,
        reason: r.reason ? r.reason.split(tmp).join('<tmp>') : null,
        output_sha256: out.patch_sha256,
      },
      durationMs: Date.now() - started,
      stored: false,
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
