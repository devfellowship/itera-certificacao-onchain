import type { EvidenceManifest } from '../../evaluator/src/types.js';
import type { AgentRunResult } from './agent-run.js';
import type { FinalStatus } from './jobs.js';

/**
 * Final status for a graded run. Same rules as the legacy /evaluations dispatch
 * (apps/api/src/http/evaluations-router.ts), plus the two agent-side outcomes:
 * a wall-limit kill is `timeout`, and an agent that changed nothing is `fail`.
 */
export function finalStatus(agent: Pick<AgentRunResult, 'timedOut' | 'patch'>, manifest: EvidenceManifest): FinalStatus {
  if (agent.timedOut) return 'timeout';
  if (agent.patch.trim() === '') return 'fail';
  if (!manifest.patch_scope.allowed) return 'invalid';
  if (manifest.errors.length > 0) return 'infra_error';
  return manifest.score.total > 0 ? 'pass' : 'fail';
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
