import type { RunAction } from './types.js';

/** Phases of an async run (shared contract "Job protocol"). */
export type RunPhase = 'preparing' | 'agent_running' | 'grading' | 'done';
export type FinalStatus = 'pass' | 'fail' | 'invalid' | 'timeout' | 'infra_error';

/** One agent file as lane C stores it in agent_versions.files. Paths are relative to agents.agent_path. */
export interface AgentFile {
  path: string;
  encoding?: 'utf-8' | 'base64';
  content: string;
}

export interface ClaimedRun {
  runId: string;
  scenarioId: string;
  scenarioVersion: string;
  agentVersionId: string | null;
}

export interface RunJob extends ClaimedRun {
  model: string;
  files: AgentFile[];
  /** runs.model_api_key_enc: the user's OpenRouter key, sealed by the API (run-key.ts). Null when absent. */
  modelApiKeyEnc: string | null;
}

export interface RunOutcome {
  status: FinalStatus;
  phase: RunPhase;
  scoreTotal: number;
  evidenceManifest: unknown;
  error: string | null;
  /** Unified diff of the agent's change. Stored as an `observations` row (mode 'observed'). */
  patch: string | null;
  actions: RunAction[];
}

export interface JobStore {
  /** Claims the oldest `queued` run (FOR UPDATE SKIP LOCKED) and marks it `running`. */
  claim(workerId: string): Promise<ClaimedRun | null>;
  /** Agent files + model for the run's pinned agent version. Null when the version is missing. */
  loadJob(run: ClaimedRun): Promise<RunJob | null>;
  setPhase(runId: string, workerId: string, phase: RunPhase): Promise<void>;
  /** Writes status, manifest, score, observation and run_actions in ONE transaction, and wipes the run's model key. */
  finish(runId: string, workerId: string, outcome: RunOutcome): Promise<void>;
  /** Marks `running` runs claimed before `olderThanMs` as infra_error and wipes their model key. Returns how many. */
  reapStale(olderThanMs: number): Promise<number>;
}
