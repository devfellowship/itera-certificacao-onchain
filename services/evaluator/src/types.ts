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
  total: number;
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

export interface EvidenceManifest {
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
  errors: string[];
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
}
