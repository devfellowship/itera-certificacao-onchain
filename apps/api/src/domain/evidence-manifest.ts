/** Shape of the evaluator's evidence manifest (services/evaluator score model). Type only: grading runs in the runner's sandbox, never in this process. */
export interface EvidenceManifest {
  schema_version: string;
  evaluator_version: string;
  scenario_id: string;
  generated_at: string;
  fixture_hash: string;
  patch_hash: string;
  patch_scope: { changed_files: string[]; allowed: boolean };
  tests: {
    public_baseline: { total: number; passed: number; failed: number };
    public_after_patch: { total: number; passed: number; failed: number };
    hidden: { total: number; passed: number; failed: number };
  };
  score: {
    public_behavior: number;
    hidden_behavior: number;
    regression: number;
    patch_integrity_and_scope: number;
    reproducible_evidence: number;
    total: number;
  };
  errors: string[];
}
