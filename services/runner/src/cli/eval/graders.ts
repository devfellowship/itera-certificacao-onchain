// The graders of `tma eval grade` (plan C3 T3, ADR-3; parent ADR-10).
//
// A case lists its graders as {id, version, weight, hard_gate}. The kit runs each one by id@version and
// writes ONE result per grader with `infra_ok`. A grader that this kit does not have at that exact
// version is not guessed: its result is infra_ok = false (reason grader_unavailable or
// version_unavailable), so the run is "not measured", never a pass or a fail.
//
// Built in: `hidden-tests`, the TMA evaluator in the grading sandbox (the hosted grader: the same
// sandbox containers, the same score v2). Its version is the evaluator version and its code digest is
// the evaluator digest, as on the hosted worker (outcome.ts hostedGraders). The library graders of the
// eval repo (repo-tests, rules, trajectory-rule: C3 T2) and the judge gate (C3 T5) register here.
import type { EvidenceManifest } from '../../../../evaluator/src/types.js';
import { EVALUATOR_VERSION, evaluatorDigest } from '../../../../evaluator/src/runner.js';
import { finalStatus, HIDDEN_TESTS_GRADER_ID, runScore } from '../../outcome.js';
import type { AgentRunResult } from '../../agent-run.js';
import type { FinalStatus } from '../../jobs.js';
import type { SandboxConfig } from '../../sandbox.js';
import type { GradeFn } from '../local.js';
import { REPO_ROOT, type ResolvedTask } from '../tasks.js';
import type { CaseGrader } from './case.js';

/** What the agent run says about itself; a patch variant has none of these. */
export interface RunFacts {
  timedOut: boolean;
  costCapped: boolean;
  rateLimitedFinal: number;
  /** The run produced no output (the sandbox failed): every grader says "not measured". */
  noOutput?: boolean;
}

export const NO_FACTS: RunFacts = { timedOut: false, costCapped: false, rateLimitedFinal: 0 };

export interface GraderInput {
  runId: string;
  task: ResolvedTask | null;
  patch: string;
  facts: RunFacts;
  grade: GradeFn;
  /** Null when no grader of the case needs the sandbox. */
  config: SandboxConfig | null;
  log: (line: string) => void;
}

export interface GraderOutcome {
  pass: boolean;
  score: number | null;
  infra_ok: boolean;
  reason: string | null;
  /** Host-only evidence (for example the evaluator manifest). Never uploaded. */
  evidence?: Record<string, unknown>;
}

export interface Grader {
  id: string;
  semver: string;
  kind: 'code' | 'judge' | 'human';
  /** The grader runs containers: the command prepares the sandbox first. */
  needsSandbox: boolean;
  codeSha256: () => Promise<string>;
  run: (input: GraderInput) => Promise<GraderOutcome>;
}

/** One grader result: the tma-local-result/2 grader row plus infra_ok and a reason. */
export interface GraderResult {
  id: string;
  version: string;
  code_sha256: string | null;
  kind: 'code' | 'judge' | 'human';
  pass: boolean;
  score: number | null;
  weight: number;
  hard_gate: boolean;
  decisive: boolean;
  infra_ok: boolean;
  reason: string | null;
}

/** The TMA evaluator as a grader: hidden tests + score v2, in fresh grading containers. */
export const hiddenTestsGrader: Grader = {
  id: HIDDEN_TESTS_GRADER_ID,
  semver: EVALUATOR_VERSION,
  kind: 'code',
  needsSandbox: true,
  codeSha256: evaluatorDigest,
  async run(input) {
    if (!input.task) return { pass: false, score: null, infra_ok: false, reason: 'no task bundle: hidden-tests needs the hidden tests of a task bundle' };
    if (!input.config) return { pass: false, score: null, infra_ok: false, reason: 'the sandbox is not prepared' };
    let manifest: EvidenceManifest;
    try {
      manifest = await input.grade({ runId: input.runId, repoRoot: REPO_ROOT, scenarioId: input.task.id, taskDir: input.task.dir, patch: input.patch, config: input.config });
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      input.log(`[tma eval] ${input.runId}: grading failed: ${why.slice(0, 300)}`);
      return { pass: false, score: null, infra_ok: false, reason: `grading failed: ${why.slice(0, 200)}` };
    }
    const status: FinalStatus = finalStatus(
      { timedOut: input.facts.timedOut, costCapped: input.facts.costCapped, patch: input.patch, modelUsage: { rateLimitedFinal: input.facts.rateLimitedFinal } as unknown as AgentRunResult['modelUsage'] },
      manifest,
    );
    const infraOk = status !== 'infra_error';
    return {
      pass: status === 'pass',
      score: infraOk ? runScore(status, manifest) : null,
      infra_ok: infraOk,
      reason: infraOk ? null : 'grading did not measure the run',
      evidence: { status, manifest },
    };
  },
};

export const BUILTIN_GRADERS: readonly Grader[] = [hiddenTestsGrader];

/** The grader of a case entry at its exact version, or why there is none. */
export function findGrader(entry: CaseGrader, registry: readonly Grader[] = BUILTIN_GRADERS): { grader: Grader } | { reason: string } {
  const same = registry.filter((g) => g.id === entry.id);
  if (same.length === 0) return { reason: `grader_unavailable: this kit has no grader ${entry.id} (it has ${registry.map((g) => `${g.id}@${g.semver}`).join(', ')})` };
  const exact = same.find((g) => g.semver === entry.version);
  if (!exact) return { reason: `version_unavailable: the case asks ${entry.id}@${entry.version}, this kit has ${same.map((g) => g.semver).join(', ')}` };
  return { grader: exact };
}

/** Run every grader of the case on one output. One result per case entry, in case order. */
export async function runGraders(
  entries: CaseGrader[],
  input: GraderInput,
  registry: readonly Grader[] = BUILTIN_GRADERS,
): Promise<{ results: GraderResult[]; evidence: Record<string, unknown> }> {
  const results: GraderResult[] = [];
  const evidence: Record<string, unknown> = {};
  for (const e of entries) {
    const found = findGrader(e, registry);
    const base = { id: e.id, version: e.version, weight: e.weight, hard_gate: e.hard_gate };
    if ('reason' in found) {
      results.push({ ...base, code_sha256: null, kind: 'code', pass: false, score: null, decisive: false, infra_ok: false, reason: found.reason });
      continue;
    }
    const g = found.grader;
    const out: GraderOutcome = input.facts.noOutput ? { pass: false, score: null, infra_ok: false, reason: 'the run produced no output (sandbox failure)' } : await g.run(input);
    if (out.evidence) evidence[`${g.id}@${g.semver}`] = out.evidence;
    // A judge decides only with a passing calibration record (C3 T5); until then every judge is a side signal.
    const decisive = g.kind === 'code';
    results.push({ ...base, code_sha256: await g.codeSha256(), kind: g.kind, pass: out.infra_ok && out.pass, score: out.score, decisive, infra_ok: out.infra_ok, reason: out.reason });
  }
  return { results, evidence };
}

export interface CaseVerdict {
  infra_ok: boolean;
  pass: boolean;
  score: number | null;
}

/**
 * The case result of one run. Not measured (infra_ok = false, score null) when any grader did not
 * measure. A failed hard gate makes the score 0 and the run a fail. Else the score is the weighted
 * mean of the decisive graders, and the run passes when every decisive grader passes.
 */
export function caseVerdict(results: GraderResult[]): CaseVerdict {
  if (results.length === 0 || results.some((r) => !r.infra_ok)) return { infra_ok: false, pass: false, score: null };
  const decisive = results.filter((r) => r.decisive);
  if (decisive.length === 0) return { infra_ok: true, pass: false, score: null };
  if (results.some((r) => r.hard_gate && !r.pass)) return { infra_ok: true, pass: false, score: 0 };
  const scored = decisive.filter((r) => r.score !== null);
  const weight = scored.reduce((s, r) => s + r.weight, 0);
  const score = weight > 0 ? Math.round(scored.reduce((s, r) => s + r.weight * r.score!, 0) / weight) : null;
  return { infra_ok: true, pass: decisive.every((r) => r.pass), score };
}

export function needsSandbox(entries: CaseGrader[], registry: readonly Grader[] = BUILTIN_GRADERS): boolean {
  return entries.some((e) => {
    const f = findGrader(e, registry);
    return 'grader' in f && f.grader.needsSandbox;
  });
}
