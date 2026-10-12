import type { EvidenceManifest } from '../../evaluator/src/types.js';
import type { AgentRunResult } from './agent-run.js';
import type { FinalStatus } from './jobs.js';

/**
 * Final status for a graded run. Same rules as the legacy /evaluations dispatch
 * (apps/api/src/http/evaluations-router.ts), plus:
 * - a wall-limit kill is `timeout`, and an agent that changed nothing is `fail`;
 * - a suite that ran ZERO tests is `infra_error`, never a score. The evaluator falls back to an
 *   empty suite when the vitest report does not parse, so "0 tests" means "not measured".
 */
export function finalStatus(agent: Pick<AgentRunResult, 'timedOut' | 'patch'>, manifest: EvidenceManifest): FinalStatus {
  if (agent.timedOut) return 'timeout';
  if (agent.patch.trim() === '') return 'fail';
  if (!manifest.patch_scope.allowed) return 'invalid';
  if (zeroTestSuites(manifest).length > 0) return 'infra_error';
  if (manifest.errors.length > 0) return 'infra_error';
  return manifest.score.total > 0 ? 'pass' : 'fail';
}

/** Names of the suites that executed no test at all. */
export function zeroTestSuites(manifest: EvidenceManifest): string[] {
  const t = manifest.tests;
  return (['public_baseline', 'public_after_patch', 'hidden'] as const).filter((k) => !t[k] || t[k].total === 0);
}

/** The error text stored for a run, or null. */
export function statusError(status: FinalStatus, manifest: EvidenceManifest, agentErrors: string[]): string | null {
  if (status === 'timeout') return agentErrors.join('; ') || 'agent wall limit reached';
  if (status !== 'infra_error') return null;
  const zero = zeroTestSuites(manifest);
  if (zero.length > 0) return `grading inconclusive: no test executed in ${zero.join(', ')}`;
  return manifest.errors.join('; ') || 'grading failed';
}

/** Extra evidence the runner adds next to the evaluator manifest (no secrets, no tmp paths). */
export function runnerEvidence(agent: AgentRunResult) {
  return {
    model: agent.model,
    agent_files: agent.agentFiles,
    agent_wall_ms: agent.durationMs,
    timed_out: agent.timedOut,
    opencode_exit_code: agent.exitCode,
    tool_calls: agent.actions.length,
    usage: agent.usage,
    agent_errors: agent.agentErrors,
  };
}
