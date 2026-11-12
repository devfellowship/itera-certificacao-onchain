/** One tool call that the agent made, in order. Maps 1:1 to a `run_actions` row. */
export interface RunAction {
  seq: number;
  tool: string;
  /** File path (relative to the workspace), shell command, pattern or URL. Truncated. */
  target: string | null;
  ok: boolean;
  occurredAt: string;
  /**
   * The tma-trajectory/1 step fields (plan 20261112-tma-c4-result-store-trajectory-upload, T4). Structure,
   * numbers and digests only: the error text, the arguments and the result never leave the runner as text.
   * Written to the nullable run_actions columns of migration 0023 when that migration is applied.
   */
  trajectory?: StepTrajectory;
}

export type ToolFamily = 'builtin' | 'shell' | 'git' | 'gh' | 'ssh' | 'web' | 'skill-bash' | 'mcp' | 'agent' | 'other';
export type StepStatus = 'ok' | 'error' | 'denied' | 'timeout';
export type StepErrorClass =
  | 'tool_error' | 'invalid_args' | 'not_found' | 'permission' | 'timeout' | 'rate_limited' | 'network' | 'interrupted' | 'other';
export type TargetKind = 'file' | 'dir' | 'url' | 'host' | 'repo' | 'agent' | 'skill' | 'mcp' | 'command' | 'pattern' | 'none';
/** tma-trajectory/2 (plan 20261112-tma-c4-result-store-trajectory-upload, T10). */
export type StepKind = 'read' | 'search' | 'write' | 'test' | 'mcp' | 'shell' | 'agent' | 'other';
export type TurnOrigin = 'human' | 'agent' | 'system';

export interface StepTrajectory {
  /** Earlier step that this one belongs to (a sub-agent call). opencode events carry none, so null. */
  parentSeq: number | null;
  /** The model step (a `step_start` event) in which the call ran, counted from 1. */
  turn: number;
  toolFamily: ToolFamily;
  status: StepStatus;
  /** Null when status is ok; the class of the failure otherwise. */
  errorClass: StepErrorClass | null;
  durationMs: number | null;
  /** opencode reports tokens per model step, not per tool call, so these stay null. */
  tokensIn: number | null;
  tokensOut: number | null;
  targetKind: TargetKind;
  /** sha256 of the canonical tool arguments. */
  argsSha256: string;
  /** sha256 of the tool output (or of the error text for a failed call). Null when there is none. */
  resultSha256: string | null;
  /** The earlier failed step that this call repeats (same tool, same arguments). */
  retryOf: number | null;
  /** tma-trajectory/2: the kind of the call, from the tool and (for bash) the command. Written when 0024 is applied. */
  stepKind: StepKind;
  /** tma-trajectory/2: ms from the first event of the run to the start of the call; null when unknown. */
  startedMs: number | null;
  /** tma-trajectory/2: a hosted run has no human: the first model step answers the task message (system), the rest are the agent's. */
  turnOrigin: TurnOrigin;
}

export interface AgentUsage {
  steps: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface ParsedTrace {
  actions: RunAction[];
  usage: AgentUsage;
  /** Errors that opencode reported as `error` events (provider/API errors). */
  errors: string[];
}
