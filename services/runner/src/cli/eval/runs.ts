// `tma eval run` and `tma eval grade` (plan C3 T3): run a variant N times, grade each output with the
// case graders, keep everything on the host.
//
//   <case>/runs/<variant_sha256[:12]>/
//     variant.lock.json        the variant file, its digests, the case it ran on
//     prediction.md            the written prediction (non-baseline), fixed before the first run
//     summary.json             n, passes, scores, per grader (rewritten after each run and re-grade)
//     <run-id>/patch.diff      the output
//     <run-id>/run.json        what the run did (agent actions stay here, on the host)
//     <run-id>/grades.json     one entry per grading; a re-grade ADDS an entry (parent ADR-10)
//
// The sandbox is the TMA sandbox of `tma run` (runAgent) and the grader is the hosted grader
// (gradeInSandbox): no second sandbox (ADR-4).
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { toolEnvironment } from '@itera/contracts';
import { runAgent as defaultRunAgent, type AgentRunResult } from '../../agent-run.js';
import { routeOfModel } from '../../model-route.js';
import { taskWallMs } from '../../provenance.js';
import type { SandboxConfig } from '../../sandbox.js';
import type { Fetch } from '../api.js';
import { CliError, userModelKey } from '../env.js';
import { defaultGrade, newRunId, prepareSandbox, redact, type LocalDeps } from '../local.js';
import { REPO_ROOT } from '../tasks.js';
import { CLI_VERSION } from '../version.js';
import { builtinProfiles, checkModelId } from '../commands/run.js';
import { CASE_RECORDED_FILE, CASE_RUNS_DIR, sha256, type LoadedCase } from './case.js';
import { BUILTIN_GRADERS, caseVerdict, needsSandbox, NO_FACTS, runGraders, type CaseVerdict, type Grader, type GraderResult, type RunFacts } from './graders.js';
import type { ResolvedVariant } from './variant.js';
import type { RunAction } from '../../types.js';
import { trajectoryFromActions } from './trajectory.js';

/** The structural trajectory of a run (tma-trajectory/1), next to run.json. Agent runs write it; for a
 * recorded output, `tma eval trajectory --out <run dir>/trajectory.json` adds it. */
export const TRAJECTORY_FILE = 'trajectory.json';

export const RUN_FORMAT = 'tma-eval-run/1';
export const GRADES_FORMAT = 'tma-eval-grades/1';
export const SUMMARY_FORMAT = 'tma-eval-summary/1';
export const VARIANT_LOCK_FORMAT = 'tma-eval-variant/1';
/** The folder of the recorded output of a trace_review case (it has no variant file). */
export const RECORDED_VARIANT_DIR = 'recorded';

export interface EvalDeps extends LocalDeps {
  graders?: readonly Grader[];
  /** tma eval upload: the HTTP client (a test passes a fake). */
  fetchImpl?: Fetch;
}

export interface RunRecord {
  format: typeof RUN_FORMAT;
  run_id: string;
  repeat: number;
  case_key: string;
  manifest_sha256: string;
  variant_sha256: string;
  kind: 'patch' | 'agent' | 'recorded';
  started_at: string;
  wall_s: number | null;
  facts: RunFacts;
  patch_sha256: string;
  /** The run profile of an agent run; null for a patch or recorded output. */
  profile?: string | null;
  /** The docker image id of the sandbox that ran or graded the run. */
  sandbox_image_id?: string | null;
  /** Agent runs: the model usage and the tool calls. Host only. */
  agent: null | { model: string; tokens_in: number | null; tokens_out: number | null; cost_usd: number | null; agent_errors: string[]; actions: unknown[] };
}

export interface GradingEntry {
  graded_at: string;
  kit_version: string;
  manifest_sha256: string;
  graders: GraderResult[];
  case: CaseVerdict;
}

export interface RunSummaryRow {
  run_id: string;
  repeat: number;
  infra_ok: boolean;
  pass: boolean;
  score: number | null;
  graders: Array<Pick<GraderResult, 'id' | 'version' | 'pass' | 'score' | 'infra_ok'>>;
}

export interface VariantSummary {
  format: typeof SUMMARY_FORMAT;
  case_key: string;
  manifest_sha256: string;
  variant_sha256: string;
  label: string;
  is_baseline: boolean;
  n: number;
  measured: number;
  passed: number;
  mean_score: number | null;
  runs: RunSummaryRow[];
}

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

async function readJson<T>(path: string): Promise<T | null> {
  const raw = await readFile(path, 'utf-8').catch(() => null);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new CliError(`${path} is not JSON`);
  }
}

/**
 * Write the variant folder of a case, or check the one that is there. The prediction is written once,
 * before the first run; a later run with a different prediction is refused (book p38).
 */
export async function prepareVariantDir(c: LoadedCase, v: ResolvedVariant): Promise<string> {
  const dir = join(c.dir, CASE_RUNS_DIR, v.variantSha256.slice(0, 12));
  await mkdir(dir, { recursive: true });
  const predictionFile = join(dir, 'prediction.md');
  const existing = await readFile(predictionFile, 'utf-8').catch(() => null);
  if (v.file.prediction !== null) {
    const body = `${v.file.prediction.trim()}\n`;
    if (existing !== null && existing !== body) {
      throw new CliError(`the prediction of this variant changed after its first run (${predictionFile}): a prediction is written before the runs and stays. Use a new variant file.`);
    }
    if (existing === null) await writeFile(predictionFile, body, 'utf-8');
  }
  const lockPath = join(dir, 'variant.lock.json');
  const old = await readJson<{ variant_sha256: string; is_baseline: boolean }>(lockPath);
  if (old && old.is_baseline !== v.file.is_baseline) throw new CliError(`${lockPath}: this variant already ran with is_baseline = ${old.is_baseline}`);
  await writeFile(
    lockPath,
    json({
      format: VARIANT_LOCK_FORMAT,
      case_key: c.manifest.case_key,
      manifest_sha256: c.manifestSha256,
      variant_sha256: v.variantSha256,
      prediction_sha256: v.predictionSha256,
      source_file: v.path,
      variant: v.file,
    }),
  );
  return dir;
}

async function sandboxFor(c: LoadedCase, deps: EvalDeps, profile: string, alsoAgent: boolean, log: (l: string) => void): Promise<{ config: SandboxConfig; imageId: string | null } | null> {
  if (!alsoAgent && !needsSandbox(c.manifest.graders, deps.graders ?? BUILTIN_GRADERS)) return null;
  return prepareSandbox(deps, profile, log);
}

/** Grade one run folder with the case graders and ADD a grading entry. Returns the entry. */
export async function gradeRunDir(input: { c: LoadedCase; runDir: string; config: SandboxConfig | null; deps: EvalDeps; log: (line: string) => void }): Promise<GradingEntry> {
  const run = await readJson<RunRecord>(join(input.runDir, 'run.json'));
  if (!run || run.format !== RUN_FORMAT) throw new CliError(`${input.runDir} is not a tma eval run folder (no ${RUN_FORMAT} run.json)`);
  if (run.case_key !== input.c.manifest.case_key) throw new CliError(`${input.runDir} is a run of case ${run.case_key}, not ${input.c.manifest.case_key}`);
  const patch = await readFile(join(input.runDir, 'patch.diff'), 'utf-8');
  if (sha256(patch) !== run.patch_sha256) throw new CliError(`${join(input.runDir, 'patch.diff')} changed after the run`);
  const now = input.deps.now ?? (() => new Date());
  const { results, evidence } = await runGraders(
    input.c.manifest.graders,
    { runId: run.run_id, task: input.c.task, patch, facts: run.facts, grade: input.deps.grade ?? defaultGrade, config: input.config, log: input.log },
    input.deps.graders ?? BUILTIN_GRADERS,
  );
  const entry: GradingEntry = { graded_at: now().toISOString(), kit_version: CLI_VERSION, manifest_sha256: input.c.manifestSha256, graders: results, case: caseVerdict(results) };
  const gradesPath = join(input.runDir, 'grades.json');
  const grades = (await readJson<{ format: string; gradings: GradingEntry[] }>(gradesPath)) ?? { format: GRADES_FORMAT, gradings: [] };
  grades.gradings.push(entry);
  await writeFile(gradesPath, json(grades));
  // The evaluator manifest and other grader evidence: host only, the latest grading.
  if (Object.keys(evidence).length > 0) await writeFile(join(input.runDir, 'evidence.json'), json(evidence));
  return entry;
}

/** The run folders of a variant folder, oldest first (by run.json started_at). */
export async function runDirs(variantDir: string): Promise<string[]> {
  const out: Array<{ dir: string; at: string }> = [];
  for (const e of await readdir(variantDir, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory()) continue;
    const run = await readJson<RunRecord>(join(variantDir, e.name, 'run.json')).catch(() => null);
    if (run?.format === RUN_FORMAT) out.push({ dir: join(variantDir, e.name), at: run.started_at });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at) || a.dir.localeCompare(b.dir)).map((x) => x.dir);
}

/** Rewrite summary.json of a variant folder from the LATEST grading of each run. */
export async function writeSummary(c: LoadedCase, variantDir: string, meta: { variantSha256: string; label: string; isBaseline: boolean }): Promise<VariantSummary> {
  const rows: RunSummaryRow[] = [];
  for (const dir of await runDirs(variantDir)) {
    const run = (await readJson<RunRecord>(join(dir, 'run.json')))!;
    const grades = await readJson<{ gradings: GradingEntry[] }>(join(dir, 'grades.json'));
    const last = grades?.gradings.at(-1);
    rows.push({
      run_id: run.run_id,
      repeat: run.repeat,
      infra_ok: last?.case.infra_ok ?? false,
      pass: last?.case.pass ?? false,
      score: last?.case.score ?? null,
      graders: (last?.graders ?? []).map((g) => ({ id: g.id, version: g.version, pass: g.pass, score: g.score, infra_ok: g.infra_ok })),
    });
  }
  const measured = rows.filter((r) => r.infra_ok && r.score !== null);
  const summary: VariantSummary = {
    format: SUMMARY_FORMAT,
    case_key: c.manifest.case_key,
    manifest_sha256: c.manifestSha256,
    variant_sha256: meta.variantSha256,
    label: meta.label,
    is_baseline: meta.isBaseline,
    n: rows.length,
    measured: measured.length,
    passed: rows.filter((r) => r.pass).length,
    mean_score: measured.length ? Math.round((measured.reduce((s, r) => s + r.score!, 0) / measured.length) * 10) / 10 : null,
    runs: rows,
  };
  await writeFile(join(variantDir, 'summary.json'), json(summary));
  return summary;
}

async function writeRun(dir: string, record: RunRecord, patch: string, secret?: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'patch.diff'), redact(patch, secret), 'utf-8');
  await writeFile(join(dir, 'run.json'), redact(json(record), secret), 'utf-8');
}

/** Run one variant `repeat` times on a replay case, grade each run. */
export async function runVariant(input: { c: LoadedCase; v: ResolvedVariant; repeat: number; deps: EvalDeps; log: (line: string) => void }): Promise<{ variantDir: string; summary: VariantSummary }> {
  const { c, v, deps } = input;
  if (c.manifest.mode !== 'replay') throw new CliError(`case ${c.manifest.case_key} is a trace_review case: it runs nothing. Grade its recorded output: tma eval grade --case ${c.dir}`);
  if (!c.task) throw new CliError(`case ${c.manifest.case_key} has no task bundle on this host: the kit cannot run it (build the case with --task-dir)`);
  const task = c.task;
  const now = deps.now ?? (() => new Date());

  let modelKey: string | undefined;
  const profile = v.file.agent?.profile ?? 'opencode';
  if (v.file.kind === 'agent') {
    checkModelId(v.file.agent!.model);
    if (!builtinProfiles().includes(profile)) throw new CliError(`unknown profile "${profile.slice(0, 40)}": the built-in profiles are ${builtinProfiles().join(', ')}`);
    // The key comes before Docker: a missing key is the first thing the user must fix.
    const route = routeOfModel(v.file.agent!.model, { openrouterUpstream: '', opencodeGoUpstream: '' }).route;
    modelKey = userModelKey(route, deps.env);
  }
  const log = (line: string) => input.log(redact(line, modelKey));
  const variantDir = await prepareVariantDir(c, v);
  const sandbox = await sandboxFor(c, deps, profile, v.file.kind === 'agent', log);
  const config = sandbox?.config ?? null;
  const already = (await runDirs(variantDir)).length;

  for (let n = 1; n <= input.repeat; n++) {
    const runId = newRunId();
    const startedAt = now();
    let patch = v.patchText ?? '';
    let facts: RunFacts = NO_FACTS;
    let wallS: number | null = null;
    let agentInfo: RunRecord['agent'] = null;
    if (v.file.kind === 'agent') {
      const runConfig: SandboxConfig = { ...config!, wallMs: taskWallMs(task.task.contract.agent?.timeout_sec, config!) };
      log(`[tma eval] ${runId}: ${c.manifest.case_key} variant ${v.variantSha256.slice(0, 12)} repeat ${already + n}, model ${v.file.agent!.model}`);
      let agent: AgentRunResult;
      let sandboxFailed = false;
      try {
        agent = await (deps.runAgent ?? defaultRunAgent)({
          runId,
          repoRoot: REPO_ROOT,
          scenarioId: task.id,
          taskDir: task.dir,
          agentDir: v.agentDir!,
          model: v.file.agent!.model,
          modelKey: modelKey!,
          config: runConfig,
          builtinTools: toolEnvironment(task.task.contract).builtin,
        });
      } catch (err) {
        const message = redact(err instanceof Error ? err.message : String(err), modelKey);
        log(`[tma eval] ${runId}: the sandbox failed: ${message}`);
        // Not measured: a run folder with no output, graded as infra_error by every sandbox grader.
        agent = { patch: '', timedOut: false, costCapped: false, durationMs: 0, actions: [], agentErrors: [`sandbox: ${message.slice(0, 300)}`], usage: { steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 } } as unknown as AgentRunResult;
        sandboxFailed = true;
      }
      patch = agent.patch;
      facts = { timedOut: agent.timedOut, costCapped: agent.costCapped ?? false, rateLimitedFinal: agent.modelUsage?.rateLimitedFinal ?? 0, noOutput: sandboxFailed };
      wallS = agent.durationMs / 1000;
      const usage = agent.modelUsage;
      agentInfo = {
        model: v.file.agent!.model,
        tokens_in: usage ? usage.tokensIn : (agent.usage?.inputTokens ?? null),
        tokens_out: usage ? usage.tokensOut : (agent.usage?.outputTokens ?? null),
        cost_usd: usage ? usage.costUsd : (agent.usage?.costUsd ?? null),
        agent_errors: agent.agentErrors ?? [],
        actions: agent.actions ?? [],
      };
    } else {
      log(`[tma eval] ${runId}: ${c.manifest.case_key} variant ${v.variantSha256.slice(0, 12)} (${v.file.label}) repeat ${already + n}, patch ${patch.length} bytes`);
    }
    const runDir = join(variantDir, runId);
    const record: RunRecord = {
      format: RUN_FORMAT,
      run_id: runId,
      repeat: already + n,
      case_key: c.manifest.case_key,
      manifest_sha256: c.manifestSha256,
      variant_sha256: v.variantSha256,
      kind: v.file.kind,
      started_at: startedAt.toISOString(),
      wall_s: wallS,
      facts,
      patch_sha256: sha256(redact(patch, modelKey)),
      agent: agentInfo,
      profile: v.file.kind === 'agent' ? profile : null,
      sandbox_image_id: sandbox?.imageId ?? null,
    };
    await writeRun(runDir, record, patch, modelKey);
    if (agentInfo) {
      // The structural trajectory of the agent run (T4): redacted targets, digests, no text.
      const trajectory = trajectoryFromActions(agentInfo.actions as RunAction[]);
      if (trajectory) await writeFile(join(runDir, TRAJECTORY_FILE), redact(json(trajectory), modelKey));
    }
    const entry = await gradeRunDir({ c, runDir, config, deps, log });
    log(`[tma eval] ${runId}: ${entry.case.infra_ok ? (entry.case.pass ? 'pass' : 'fail') : 'not measured'}, score ${entry.case.score ?? '-'}`);
  }
  const summary = await writeSummary(c, variantDir, { variantSha256: v.variantSha256, label: v.file.label, isBaseline: v.file.is_baseline });
  return { variantDir, summary };
}

/** A trace_review case: put its recorded output in runs/recorded/<run-id>/ and grade it. */
export async function gradeRecorded(input: { c: LoadedCase; deps: EvalDeps; log: (line: string) => void }): Promise<{ variantDir: string; summary: VariantSummary }> {
  const { c, deps } = input;
  if (!c.lock.recorded) throw new CliError(`case ${c.manifest.case_key} has no recorded output`);
  const body = await readFile(join(c.dir, CASE_RECORDED_FILE), 'utf-8').catch(() => null);
  if (body === null) throw new CliError(`the recorded output ${c.lock.recorded.target} is gone`);
  if (sha256(body) !== c.lock.recorded.sha256) throw new CliError(`the recorded output ${c.lock.recorded.target} changed after "tma eval case"`);
  const variantDir = join(c.dir, CASE_RUNS_DIR, RECORDED_VARIANT_DIR);
  const variantSha256 = sha256(`recorded:${c.lock.recorded.sha256}`);
  const runId = newRunId();
  const record: RunRecord = {
    format: RUN_FORMAT,
    run_id: runId,
    repeat: (await runDirs(variantDir)).length + 1,
    case_key: c.manifest.case_key,
    manifest_sha256: c.manifestSha256,
    variant_sha256: variantSha256,
    kind: 'recorded',
    started_at: (deps.now ?? (() => new Date()))().toISOString(),
    wall_s: null,
    facts: NO_FACTS,
    patch_sha256: sha256(body),
    agent: null,
    profile: null,
    sandbox_image_id: null,
  };
  await writeRun(join(variantDir, runId), record, body);
  const config = (await sandboxFor(c, deps, 'opencode', false, input.log))?.config ?? null;
  await gradeRunDir({ c, runDir: join(variantDir, runId), config, deps, log: input.log });
  const summary = await writeSummary(c, variantDir, { variantSha256, label: 'recorded output', isBaseline: true });
  return { variantDir, summary };
}

/** Re-grade the given run folders (each gets a NEW grading entry) and refresh their variant summaries. */
export async function regrade(input: { c: LoadedCase; runs: string[]; deps: EvalDeps; log: (line: string) => void }): Promise<VariantSummary[]> {
  const config = (await sandboxFor(input.c, input.deps, 'opencode', false, input.log))?.config ?? null;
  const variantDirs = new Set<string>();
  for (const dir of input.runs) {
    if (!(await stat(join(dir, 'run.json')).catch(() => null))) throw new CliError(`${dir} is not a run folder (no run.json)`);
    const entry = await gradeRunDir({ c: input.c, runDir: dir, config, deps: input.deps, log: input.log });
    input.log(`[tma eval] ${basename(dir)}: ${entry.case.infra_ok ? (entry.case.pass ? 'pass' : 'fail') : 'not measured'}, score ${entry.case.score ?? '-'}`);
    variantDirs.add(join(dir, '..'));
  }
  const out: VariantSummary[] = [];
  for (const vd of variantDirs) {
    const lock = await readJson<{ variant_sha256: string; variant: { label: string; is_baseline: boolean } }>(join(vd, 'variant.lock.json'));
    const old = await readJson<VariantSummary>(join(vd, 'summary.json'));
    out.push(
      await writeSummary(input.c, vd, {
        variantSha256: lock?.variant_sha256 ?? old?.variant_sha256 ?? '',
        label: lock?.variant.label ?? old?.label ?? basename(vd),
        isBaseline: lock?.variant.is_baseline ?? old?.is_baseline ?? false,
      }),
    );
  }
  return out;
}

/** The human table of a variant summary. */
export function summaryTable(s: VariantSummary): string {
  const lines = [`case ${s.case_key}  variant ${s.variant_sha256.slice(0, 12)} (${s.label})${s.is_baseline ? '  [baseline]' : ''}`, 'run             repeat  result         score  graders'];
  for (const r of s.runs) {
    const result = r.infra_ok ? (r.pass ? 'pass' : 'fail') : 'not measured';
    const graders = r.graders.map((g) => `${g.id}@${g.version}=${g.infra_ok ? (g.pass ? 'pass' : 'fail') : 'n/m'}${g.score === null ? '' : `/${g.score}`}`).join(' ');
    lines.push(`${r.run_id.padEnd(16)}${String(r.repeat).padStart(6)}  ${result.padEnd(13)}${String(r.score ?? '-').padStart(6)}  ${graders}`);
  }
  lines.push(`n ${s.n}, measured ${s.measured}, passed ${s.passed}, mean score ${s.mean_score ?? '-'}`);
  return lines.join('\n');
}
