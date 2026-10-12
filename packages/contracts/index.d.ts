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
