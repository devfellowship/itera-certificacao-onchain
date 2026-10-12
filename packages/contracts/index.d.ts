// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Itera / DevFellowship
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
    /** ADR-11 tool environment of the agent run (optional; see toolEnvironment() for the defaults). */
    tools?: { builtin?: BuiltinTool[]; mcp?: McpServer[] };
    run_egress?: RunEgress[];
    secrets?: string[];
    resources?: { cpus?: number; memory_mb?: number; pids?: number };
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

// --- Tool environment (ADR-11, U28). Inspect: the tools given to the Solver; Valkyrie: run_egress,
// secrets, resources. Schema: schemas/task.schema.json (environment.tools …).

/** Harness built-in tool, neutral name. opencode names: OPENCODE_BUILTIN_TOOLS. */
export type BuiltinTool = 'read' | 'write' | 'edit' | 'bash' | 'search' | 'list' | 'todo';
export type RunEgress = 'model-gateway' | 'mcp';

/** One MCP server that the runner starts per run as a sidecar (exactly one of image / command). */
export interface McpServer {
  name: string;
  description?: string;
  transport: 'stdio' | 'http';
  /** Itera catalog server, "name@version". Exactly one of catalog / image / command. */
  catalog?: string;
  image?: string;
  command?: string[];
  /** Bundle path of the seeded test state, under mcp/<name>/ (never under environment/). */
  seed?: string;
  /** The tools the agent may call; the server enforces it (ITERA_MCP_ALLOWED_TOOLS). */
  allowed_tools: string[];
  /** true = the mcp_state Scorer (trusted plane) reads the final state; assertions in tests/hidden/mcp/<name>/. */
  expose_state_to_scorer?: boolean;
  /** Names from environment.secrets injected into this sidecar. */
  secrets?: string[];
  startup_timeout_sec?: number;
}

/** The normalized tool environment of a task (defaults filled in). */
export interface ToolEnvironment {
  builtin: BuiltinTool[];
  mcp: Array<McpServer & { expose_state_to_scorer: boolean }>;
  run_egress: RunEgress[];
  secrets: string[];
  resources: { cpus?: number; memory_mb?: number; pids?: number };
}

export interface CompatibilityReason {
  code: 'missing_mcp_server' | 'missing_builtin_tool';
  /** The agent requirement that is not met, e.g. "mcp:postgres". */
  requirement: string;
  message: string;
}

export interface Compatibility {
  compatible: boolean;
  reasons: CompatibilityReason[];
}

export declare const BUILTIN_TOOLS: readonly BuiltinTool[];
export declare const OPENCODE_BUILTIN_TOOLS: Readonly<Record<BuiltinTool, string[]>>;
export declare const DEFAULT_TOOL_ENVIRONMENT: Readonly<ToolEnvironment>;
export declare const MAX_REQUIRES: number;
export declare function toolEnvironment(contract: { environment?: Record<string, unknown> } | null | undefined): ToolEnvironment;
export declare function toolEnvironmentErrors(contract: TaskContract): string[];
/** Agent `requires`: "mcp:<server>" | "tool:<builtin>"; a bare name means mcp:<name>. */
export declare function parseAgentRequires(value: unknown): Validation<string[]>;
/** The agent-facing opencode config of a run (mcp entries + built-in deny list); the runner and the task editor preview share it. */
export declare function opencodeAgentConfig(
  servers: ReadonlyArray<{ name: string }>,
  builtin: readonly string[],
  endpoint: (name: string) => { url: string; token: string },
): { mcp?: Record<string, unknown>; tools?: Record<string, boolean> };
export declare function checkCompatibility(env: ToolEnvironment, requires: readonly string[]): Compatibility;
