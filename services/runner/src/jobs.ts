import type { RunArtifact } from '@itera/contracts/run-artifacts';
import type { RunProvenance } from './provenance.js';
import type { ModelUsage } from './model-usage.js';
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
  /** agent_versions.commit_sha (K11 provenance). */
  agentCommit?: string | null;
}

/** Model usage written to runs.model_cost_usd / model_tokens_in / model_tokens_out (0006_run_cost.sql). */
export type RunCost = Pick<ModelUsage, 'costUsd' | 'tokensIn' | 'tokensOut'>;

export interface RunOutcome {
  status: FinalStatus;
  phase: RunPhase;
  scoreTotal: number;
  evidenceManifest: unknown;
  error: string | null;
  /** Unified diff of the agent's change. Stored as an `observations` row (mode 'observed'). */
  patch: string | null;
  actions: RunAction[];
  /** Measured model usage of the run. Null when the agent never started or the gateway reported nothing. */
  cost?: RunCost | null;
  /** K11: result provenance (0017_run_provenance.sql). Null when the run never reached the agent. */
  provenance?: RunProvenance | null;
  /**
   * L17a: the stored outputs of the run, `result.json` first, then the agent's (run-artifacts.ts). One
   * `observations` row each (`output_artifact_ref = 'artifact:' + path`), in the finish transaction.
   * Absent or empty when the run failed before the agent started.
   */
  artifacts?: RunArtifact[];
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
  /** status + worker_id of the given runs (missing ids are absent from the map). */
  runStates(runIds: string[]): Promise<Map<string, { status: string; workerId: string | null }>>;
  /** Every run in `running`, with its worker. */
  runningRuns(): Promise<Array<{ runId: string; workerId: string | null }>>;
  /**
   * A run whose worker is gone: requeue it ONCE as a free retry (status queued, error
   * LOST_RUN_REQUEUED), or mark it infra_error when it was already requeued once. Conditional on
   * the run still being `running` under `workerId`.
   */
  recoverLost(runId: string, workerId: string | null): Promise<'requeued' | 'failed' | 'skipped'>;
}

export const LOST_RUN_REQUEUED = 'requeued after a runner restart';
