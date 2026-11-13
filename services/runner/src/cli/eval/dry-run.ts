// `tma eval grade --dry-run` (plan C3 T11): grade with the case graders and PRINT the verdict as JSON.
//
// A dry run only reads. It writes nothing into the case folder (no run folder, no grades.json, no
// summary.json, no evidence.json) and it makes no network call: the TMA API and its DB never see it.
// What it grades:
//   --trace <file>      one output file (for example a recorded patch of a trace)
//   --run <run dir>     the output of a run folder (patch.diff, checked against run.json)
//   nothing             a trace_review case: its recorded output; a replay case: every run folder
import { readdir, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { CliError } from '../env.js';
import { defaultGrade, prepareSandbox } from '../local.js';
import { CASE_RECORDED_FILE, CASE_RUNS_DIR, sha256, type LoadedCase } from './case.js';
import { BUILTIN_GRADERS, caseVerdict, needsSandbox, NO_FACTS, runGraders, type CaseVerdict, type GraderResult, type RunFacts } from './graders.js';
import { RUN_FORMAT, runDirs, type EvalDeps, type RunRecord } from './runs.js';

export const DRY_RUN_FORMAT = 'tma-eval-dry-run/1';

export interface DryRunOutput {
  source: 'recorded' | 'run' | 'trace';
  /** The run id of a run folder; the file name of a trace; "recorded" for the recorded output. */
  run_id: string;
  patch_sha256: string;
  graders: GraderResult[];
  case: CaseVerdict;
}

export interface DryRunVerdict {
  format: typeof DRY_RUN_FORMAT;
  dry_run: true;
  case_key: string;
  manifest_sha256: string;
  outputs: DryRunOutput[];
}

interface Target {
  source: DryRunOutput['source'];
  runId: string;
  patch: string;
  facts: RunFacts;
  executorModel: string | null;
}

async function readRunTarget(dir: string, c: LoadedCase): Promise<Target> {
  const raw = await readFile(join(dir, 'run.json'), 'utf-8').catch(() => null);
  let run: RunRecord | null = null;
  try {
    run = raw === null ? null : (JSON.parse(raw) as RunRecord);
  } catch {
    run = null;
  }
  if (!run || run.format !== RUN_FORMAT) throw new CliError(`${dir} is not a tma eval run folder (no ${RUN_FORMAT} run.json)`);
  if (run.case_key !== c.manifest.case_key) throw new CliError(`${dir} is a run of case ${run.case_key}, not ${c.manifest.case_key}`);
  const patch = await readFile(join(dir, 'patch.diff'), 'utf-8').catch(() => null);
  if (patch === null) throw new CliError(`${join(dir, 'patch.diff')} is missing`);
  if (sha256(patch) !== run.patch_sha256) throw new CliError(`${join(dir, 'patch.diff')} changed after the run`);
  return { source: 'run', runId: run.run_id, patch, facts: run.facts, executorModel: run.agent?.model ?? null };
}

/** The outputs that the dry run grades, read only. */
async function targets(c: LoadedCase, o: { runs: string[]; trace?: string }): Promise<Target[]> {
  if (o.trace) {
    const body = await readFile(resolve(o.trace), 'utf-8').catch(() => null);
    if (body === null) throw new CliError(`cannot read ${o.trace}`);
    return [{ source: 'trace', runId: basename(o.trace), patch: body, facts: NO_FACTS, executorModel: null }];
  }
  let runs = o.runs;
  if (runs.length === 0 && c.manifest.mode === 'trace_review') {
    if (!c.lock.recorded) throw new CliError(`case ${c.manifest.case_key} has no recorded output`);
    const body = await readFile(join(c.dir, CASE_RECORDED_FILE), 'utf-8').catch(() => null);
    if (body === null) throw new CliError(`the recorded output ${c.lock.recorded.target} is gone`);
    if (sha256(body) !== c.lock.recorded.sha256) throw new CliError(`the recorded output ${c.lock.recorded.target} changed after "tma eval case"`);
    return [{ source: 'recorded', runId: 'recorded', patch: body, facts: NO_FACTS, executorModel: null }];
  }
  if (runs.length === 0) {
    const root = join(c.dir, CASE_RUNS_DIR);
    for (const e of await readdir(root, { withFileTypes: true }).catch(() => [])) if (e.isDirectory()) runs.push(...(await runDirs(join(root, e.name))));
  }
  runs = [...new Set(runs)];
  if (runs.length === 0) throw new CliError(`no output to grade in ${c.dir}: give --trace <file> or --run <run dir>, or run a variant first`);
  const out: Target[] = [];
  for (const dir of runs) out.push(await readRunTarget(dir, c));
  return out;
}

/**
 * Grade without a trace on disk or on the network. The sandbox graders still run their fresh grading
 * containers on this host (as `tma eval grade` does); nothing is written into the case folder.
 */
export async function dryRunGrade(input: { c: LoadedCase; runs: string[]; trace?: string; deps: EvalDeps; log: (line: string) => void }): Promise<DryRunVerdict> {
  const { c, deps, log } = input;
  const list = await targets(c, { runs: input.runs, trace: input.trace });
  const registry = deps.graders ?? BUILTIN_GRADERS;
  const config = needsSandbox(c.manifest.graders, registry) ? (await prepareSandbox(deps, 'opencode', log)).config : null;
  const outputs: DryRunOutput[] = [];
  for (const t of list) {
    const { results } = await runGraders(
      c.manifest.graders,
      { runId: t.runId, task: c.task, patch: t.patch, facts: t.facts, grade: deps.grade ?? defaultGrade, config, log, executorModel: t.executorModel },
      registry,
    );
    outputs.push({ source: t.source, run_id: t.runId, patch_sha256: sha256(t.patch), graders: results, case: caseVerdict(results) });
  }
  return { format: DRY_RUN_FORMAT, dry_run: true, case_key: c.manifest.case_key, manifest_sha256: c.manifestSha256, outputs };
}
