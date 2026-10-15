export interface TestCaseResult {
  name: string;
  file: string;
  passed: boolean;
}

/**
 * How one verifier run ended. Only `ok` carries trustworthy counts.
 * - no_report: the verifier wrote no parseable report (crash, missing runner, wrong command).
 * - timeout: the verifier hit task.json verifier.timeout_sec and was killed.
 * - report_mismatch: the report disagrees with the verifier exit code (exit 0 with failures, or a
 *   non-zero exit with no failure). The report file is written inside the grading container, so a
 *   mismatch is treated as possible tampering, never as a score.
 */
export type SuiteState = 'ok' | 'no_report' | 'timeout' | 'report_mismatch' | 'skipped';

export interface TestSuiteResult {
  total: number;
  passed: number;
  failed: number;
  /** Cases that were skipped or todo (also counted in `failed`). */
  skipped?: number;
  cases: TestCaseResult[];
  state?: SuiteState;
  exit_code?: number | null;
  duration_ms?: number;
}

export interface ScoreBreakdown {
  public_behavior: number;
  hidden_behavior: number;
  regression: number;
  patch_integrity_and_scope: number;
  reproducible_evidence: number;
  /** ADR-11: points of the mcp_state Scorer (only for a task whose MCP state is scored). */
  mcp_state?: number;
  /** The platform score 0-100. Score version 2: see EvalLog.score_rule. Version 1: the sum of the parts. */
  total: number;
}

/**
 * Score version 2 (TMA-QC = B): how `score.total` was derived. Each gate is true (holds), false
 * (broken: the total is 0) or null (does not apply to this run). `legacy_total` is the v1 sum of
 * the five parts, for diagnostics only.
 */
export interface ScoreRule {
  formula: 'hidden_ratio_x100_gated';
  /** "passed/total" of the hidden checks, or null when they were not measured. */
  hidden: string | null;
  gates: {
    hidden_measured: boolean;
    patch_nonempty: boolean;
    patch_scope: boolean;
    mcp_state: boolean | null;
    /** Set by the runner: the agent finished inside its wall limit and its cost cap. */
    agent_finished?: boolean;
  };
  legacy_total: number;
}

/** Where the verifier ran, and what was enforced there. No temp path, no secret. */
export interface ExecutorInfo {
  /** `sandbox-container`: one fresh no-network container per suite. `local-process`: same host process tree (legacy API path, tests). */
  profile: 'sandbox-container' | 'local-process';
  image: string | null;
  /** `docker image inspect` Id (sha256:...) of the grading image, or null for local-process. */
  image_id: string | null;
  node_version: string | null;
  /** Controls that this executor enforces on every verifier run (see services/runner/README.md "Grader sandbox"). */
  controls: string[];
}

// ---------------------------------------------------------------------------------------------
// Inspect AI vocabulary (UKGovernmentBEIS/inspect_ai, MIT; names only, no code):
//   Task = task.json bundle · Sample = one instance of the task (input = instruction, target =
//   "the hidden tests pass") · Solver = the agent (repo files + model + opencode, services/runner) ·
//   Scorer = one grader (score.ts SCORERS) · Score = value + explanation + metadata ·
//   EvalLog = the per-run log = our evidence manifest (eval spec, plan, results, stats, samples).
// See docs/contracts/GLOSSARY.md.
// ---------------------------------------------------------------------------------------------

/** Inspect `Score`: value + explanation + metadata. value null = UNSCORED (never a silent zero). */
export interface Score {
  value: number | null;
  answer?: string | null;
  explanation?: string;
  metadata?: Record<string, unknown>;
}

/** Inspect `EvalSpec` (subset): what was evaluated, pinned. */
export interface EvalSpec {
  task: string;
  task_version: string;
  /** sha256 of task.json. */
  task_digest: string;
  created: string;
  dataset: { name: string; samples: number };
  scorers: string[];
  evaluator: { version: string; digest: string; commit: string | null };
  environment_digest: string;
  /** Filled by the runner: the Solver (agent + model + harness). */
  solver?: { name: string; model: string | null; agent_files: string[] };
}

/** Inspect `EvalPlan`: the steps that produced the Sample output. */
export interface EvalPlan {
  name: string;
  steps: Array<{ solver: string; params: Record<string, unknown> }>;
}

/** Inspect `EvalResults` (subset). */
export interface EvalResults {
  total_samples: number;
  completed_samples: number;
  scores: Array<{ name: string; scorer: string; metrics: { value: { name: 'value'; value: number | null } } }>;
}

/** Inspect `EvalStats` (subset). */
export interface EvalStats {
  started_at: string;
  completed_at: string;
  model_usage?: Record<string, unknown>;
}

/** Inspect `EvalSample` (subset). Our run has exactly one sample. */
export interface EvalSample {
  id: string;
  epoch: number;
  /** sha256 of the instruction (the prompt itself lives in the task bundle). */
  input: string;
  target: string;
  scores: Record<string, Score>;
  metadata: Record<string, unknown>;
}

/** Operational state kept apart from the verdict (analysis vocabulary). */
export interface RunResult {
  state: 'completed' | 'timeout' | 'infra_error';
  verdict: 'pass' | 'fail' | 'invalid' | 'inconclusive';
  /** false = score.total measures nothing (UNSCORED). */
  scored: boolean;
  reason?: string;
}

/**
 * The per-run EvalLog = `runs.evidence_manifest`. Legacy keys (scenario_id … errors) stay for the
 * API and the proofs already minted; the Inspect-shaped blocks (version … samples) are additive.
 */
export interface EvalLog {
  schema_version: string;
  evaluator_version: string;
  scenario_id: string;
  generated_at: string;
  fixture_hash: string;
  patch_hash: string;
  patch_scope: {
    changed_files: string[];
    allowed: boolean;
    violations: string[];
  };
  tests: {
    public_baseline: TestSuiteResult;
    public_after_patch: TestSuiteResult;
    hidden: TestSuiteResult;
  };
  score: ScoreBreakdown;
  /** 2 = score.total is the gated hidden ratio (ScoreRule). Absent = 1 (the sum of the five parts). */
  score_version?: 2;
  /** How score.total was derived (score version 2). */
  score_rule?: ScoreRule;
  errors: string[];
  /** ADR-11: per MCP server, digests and counts of the final-state check (the raw export stays private). */
  mcp?: { weight: number; servers: import('./mcp-state.js').McpServerEvidence[] };
  /** The task contract the run was graded against (task.json). */
  contract?: {
    schema_version: string;
    name: string;
    version: string;
    /** sha256 hex of the task.json bytes. */
    contract_digest: string;
    verifier_cmd: string[];
  };
  /** Pinned grading environment: image, install command, lockfile. */
  environment?: {
    executor: ExecutorInfo;
    install_cmd: string[];
    lockfile_sha256: string | null;
  };
  /** sha256 hex of the canonical JSON of `environment`. */
  environment_digest?: string;
  /** Git commit of the evaluator code, when the deployment knows it (ITERA_GIT_COMMIT); else null. */
  evaluator_commit?: string | null;
  /** sha256 hex of the evaluator source files that graded the run. */
  evaluator_digest?: string;
  executor?: { profile: ExecutorInfo['profile'] };
  /** What this evidence does NOT prove. */
  limitations?: string[];
  /** Inspect EvalLog blocks. */
  version?: 2;
  status?: 'success' | 'error';
  eval?: EvalSpec;
  plan?: EvalPlan;
  results?: EvalResults;
  stats?: EvalStats;
  samples?: EvalSample[];
  /** Set by the runner from the final status. */
  result?: RunResult;
}

/** @deprecated old name of EvalLog; kept for existing imports. */
export type EvidenceManifest = EvalLog;
