export interface TestCaseResult {
  name: string;
  file: string;
  passed: boolean;
}

export interface TestSuiteResult {
  total: number;
  passed: number;
  failed: number;
  cases: TestCaseResult[];
}

export interface ScoreBreakdown {
  public_behavior: number;
  hidden_behavior: number;
  regression: number;
  patch_integrity_and_scope: number;
  reproducible_evidence: number;
  total: number;
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
}
