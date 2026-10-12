/** One tool call that the agent made, in order. Maps 1:1 to a `run_actions` row. */
export interface RunAction {
  seq: number;
  tool: string;
  /** File path (relative to the workspace), shell command, pattern or URL. Truncated. */
  target: string | null;
  ok: boolean;
  occurredAt: string;
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
