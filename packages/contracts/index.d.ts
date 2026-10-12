/** Parsed task.json — see schemas/task.schema.json (the schema is the source of truth). */
export interface TaskContract {
  $schema?: string;
  schema_version: '1.0';
  task: {
    name: string;
    version: string;
    description?: string;
    authors?: Array<{ name: string; email?: string }>;
    keywords?: string[];
  };
  metadata?: {
    title?: string;
    tags?: { tools?: string[]; concepts?: string[] };
    [key: string]: unknown;
  };
  instruction: string;
  environment: {
    dir: string;
    install?: string[];
    allow_internet?: false;
    cpus?: number;
    memory_mb?: number;
  };
  tests: { public: string; hidden: string };
  solution: { patch: string };
  editable_paths: string[];
  protected_paths: string[];
  verifier: {
    cmd: string[];
    report?: 'vitest-json';
    timeout_sec: number;
  };
  agent: { timeout_sec: number };
  est_minutes: number;
}

export declare const taskSchema: Record<string, unknown>;

export declare function validateTaskContract(
  value: unknown,
): { ok: true; value: TaskContract } | { ok: false; errors: string[] };

/** Runner run profile — see schemas/run-profile.schema.json (Valkyrie agent-contract boundaries). */
export interface RunProfile {
  $schema?: string;
  schema_version: '1.0';
  name: string;
  install_cmd: string[];
  run_cmd: string[];
  final_output: 'workspace-diff';
  output_artifacts?: Array<{ name: string; source: 'stdout'; format?: 'opencode-json-events'; required?: boolean }>;
  install_egress: '*' | string[];
  run_egress: Array<'model-gateway'>;
  secrets: Record<string, { source: string; inject_into: 'gateway' }>;
  timeouts: { install_sec: number; run_sec: number };
  resources: { cpus: number; memory_mb: number; pids: number };
}

export declare const runProfileSchema: Record<string, unknown>;

export declare function validateRunProfile(
  value: unknown,
): { ok: true; value: RunProfile } | { ok: false; errors: string[] };

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export declare const evidenceManifestSchema: Record<string, unknown>;
export declare const evidenceStatementSchema: Record<string, unknown>;
export declare const apiSchemas: Record<'runDetail' | 'evaluationView' | 'evaluationList' | 'runActions', Record<string, unknown>>;

/** Minimal shape that the schema guarantees for a graded run (see schemas/evidence-manifest.schema.json). */
export interface GradedManifest {
  scenario_id: string;
  patch_hash: string;
  patch_scope: { changed_files: string[]; allowed: boolean; violations?: string[] };
  tests: Record<'public_baseline' | 'public_after_patch' | 'hidden', { total: number; passed: number; failed: number; cases?: unknown[] }>;
  score: { total: number; [k: string]: number };
  errors: string[];
  [key: string]: unknown;
}

export declare function validateEvidenceManifest(value: unknown): Validation<GradedManifest>;
export declare function isEvidenceManifest(value: unknown): boolean;
export declare function validateEvidenceStatement(value: unknown): Validation<Record<string, unknown>>;
export declare function validateApiResponse(name: 'runDetail' | 'evaluationView' | 'evaluationList' | 'runActions', value: unknown): Validation<Record<string, unknown>>;

export type RunState = 'queued' | 'running' | 'completed' | 'timeout' | 'infra_error' | 'cancelled';
export type RunVerdict = 'pass' | 'fail' | 'invalid' | 'inconclusive';
export declare function runResult(
  status: string,
  manifest?: { result?: { state: string; verdict: string; scored: boolean } } | null,
): { state: RunState; verdict: RunVerdict | null; scored: boolean };
