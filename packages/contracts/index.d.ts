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
    /** ghcr.io/devfellowship/testmyagent-grader-<name>@sha256:<digest>; absent = the default sandbox image. */
    image?: string;
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
export declare const apiSchemas: Record<'runDetail' | 'evaluationView' | 'evaluationList' | 'runActions' | 'freeEvaluationRequest' | 'freeEvaluationCreated', Record<string, unknown>>;

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
export declare function validateApiResponse(name: 'runDetail' | 'evaluationView' | 'evaluationList' | 'runActions' | 'freeEvaluationRequest' | 'freeEvaluationCreated', value: unknown): Validation<Record<string, unknown>>;

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

// --- Self-declared local result (plan 20261026-tma-local-runner-and-self-declared-results, ADR-1).
// Schema: schemas/local-result.schema.json (the source of truth); validator: local-result.js.

export type MetricsShape = 'tma-score/1' | 'transcript-mining/1' | 'trajectory/1';
export type LocalResultErrorClass = 'timeout' | 'empty_output' | 'rate_limited' | 'hang' | 'infra_error' | 'cost_capped';

export interface LocalResult {
  format: 'tma-local-result/1';
  agent_id: string;
  task:
    | { catalog: { slug: string; version: number } }
    | { local: { slug: string; name: string; description?: string; contract_sha256: string; environment_sha256: string; hidden_tests_sha256: string } };
  metrics_shape: MetricsShape;
  grader_version: string;
  runner: { version: string; execution: 'tma-sandbox' | 'external'; profile: string | null; sandbox_image_id: string | null };
  executor: {
    model_id: string;
    /** A lab key of model-catalog/labs.json, or null for a custom provider. */
    provider: string | null;
    /** A route key of model-catalog/routes.json. */
    route: string;
    harness: string;
    variant: 'structured-output' | null;
    cost_source: 'metered' | 'derived' | 'reported' | 'none';
    model_effective?: string | null;
  };
  ran_from: string;
  ran_to: string;
  /** Closed per shape: see the $defs of the schema. Every shape has score (0-100), runs and items. */
  summary: { score: number; runs: number; items: number; [key: string]: number | boolean | null };
  /** Closed per shape: see the $defs of the schema. */
  runs: Array<{ item_sha256: string; repeat: number; score: number; wall_s: number | null; cost_usd: number | null; tokens_in: number | null; tokens_out: number | null; error_class: LocalResultErrorClass | null; [key: string]: unknown }>;
}

export interface LocalResultIssue {
  code: 'unknown_key' | 'invalid' | 'too_large' | 'not_json' | 'unknown_provider' | 'unknown_route' | 'inconsistent';
  /** JSON pointer of the offending value, e.g. "/runs/0/actions". */
  path: string;
  message: string;
}
export type LocalResultValidation = { ok: true; value: LocalResult } | { ok: false; issues: LocalResultIssue[]; errors: string[] };

export declare const LOCAL_RESULT_FORMAT: 'tma-local-result/1';
export declare const LOCAL_RESULT_MAX_BYTES: number;
export declare const METRICS_SHAPES: readonly MetricsShape[];
export declare const localResultSchema: Record<string, unknown>;
export declare function validateLocalResult(value: unknown): LocalResultValidation;
export declare function parseLocalResultText(text: string): LocalResultValidation;

// --- tma-local-result/2 and tma-trajectory/1 (plan 20261112-tma-c4-result-store-trajectory-upload, T1, T8).
// Schemas: schemas/local-result-v2.schema.json and schemas/trajectory.schema.json (the source of truth);
// validators: local-result.js and trajectory.js.

export type ToolFamily = 'builtin' | 'shell' | 'git' | 'gh' | 'ssh' | 'web' | 'skill-bash' | 'mcp' | 'agent' | 'other';
export type StepStatus = 'ok' | 'error' | 'denied' | 'timeout';
export type StepErrorClass = 'tool_error' | 'invalid_args' | 'not_found' | 'permission' | 'timeout' | 'rate_limited' | 'network' | 'interrupted' | 'other';
export type TargetKind = 'file' | 'dir' | 'url' | 'host' | 'repo' | 'agent' | 'skill' | 'mcp' | 'command' | 'pattern' | 'none';

export interface TrajectoryStep {
  seq: number;
  parent_seq: number | null;
  turn: number;
  tool: string;
  tool_family: ToolFamily;
  status: StepStatus;
  error_class: StepErrorClass | null;
  duration_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  target_kind: TargetKind;
  /** At most 120 characters of the redaction charset; null when target_kind is none. */
  target_redacted: string | null;
  args_sha256: string | null;
  result_sha256: string | null;
  retry_of: number | null;
}
export interface Trajectory {
  format: 'tma-trajectory/1';
  steps: TrajectoryStep[];
}

// --- tma-trajectory/2 (plan 20261112-tma-c4-result-store-trajectory-upload, T10): v1 plus three fields per step.
export type StepKind = 'read' | 'search' | 'write' | 'test' | 'mcp' | 'shell' | 'agent' | 'other';
export type TurnOrigin = 'human' | 'agent' | 'system';
export interface TrajectoryStepV2 extends TrajectoryStep {
  step_kind: StepKind;
  /** ms from the start of the run, or null when not recorded. */
  started_ms: number | null;
  turn_origin: TurnOrigin | null;
}
export interface TrajectoryV2 {
  format: 'tma-trajectory/2';
  steps: TrajectoryStepV2[];
}
export type AnyTrajectory = Trajectory | TrajectoryV2;
export declare const TRAJECTORY_V2_FORMAT: 'tma-trajectory/2';
export declare const STEP_KINDS: readonly StepKind[];
export declare const TURN_ORIGINS: readonly TurnOrigin[];
export declare const TRAJECTORY_MAX_STARTED_MS: number;
/** The step kind of one call (one mapping for the hosted runner and the API back-fill). */
export declare function stepKindOf(tool: string, command: string | null, isMcp: boolean): StepKind;
/** The step kind of a stored hosted row from its tool and target (an MCP tool is told by its `<server>_<tool>` name). */
export declare function hostedStepKindOf(tool: string, target: string | null): StepKind;
export declare const OPENCODE_TOOL_NAMES: readonly string[];

// --- trajectory-shapes/1 (plan 20261112-tma-c9-trajectory-analytics, T3): one rules spec (trajectory-shapes/spec.json)
// for studio S9 and the fleet snapshot. While named_shapes is false a consumer MUST NOT label runs by shape.
export type ShapeLetter = 'R' | 'S' | 'W' | 'T' | 'M' | 'X';
export interface ShapeStep {
  kind_source: 'step_kind' | 'intent';
  /** A tma-trajectory/2 step_kind, or a layer-1 fleet intent. */
  value: string;
  tool?: string;
  family?: string;
  ok: boolean;
}
export interface FirstFailure {
  first_fail_seq: number;
  first_fail_kind: string;
  /** The letter of the step before the failure, or 'START' when step 0 failed. */
  last_good_kind: string;
}
export interface ShapeRule {
  name: string;
  description?: string;
  letter?: string;
  min_runs?: number;
  between?: string;
  min_run?: number;
  window?: number;
}
export interface TrajectoryShapesSpec {
  schema: 'trajectory-shapes/1';
  alphabet: Record<ShapeLetter, string>;
  step_kind_map: Record<StepKind, ShapeLetter>;
  layer1_intents: string[];
  intent_map: Record<string, ShapeLetter>;
  tool_fallback: { applies_to: string[]; family: Record<string, ShapeLetter>; tool: Record<string, ShapeLetter>; default: ShapeLetter };
  kind_string: { max_chars: number };
  shape_rules: ShapeRule[];
  empty_shape: string;
  named_shapes: boolean;
  fallback: string;
  gate: { min_spread_points: number; min_n_per_shape: number; result: 'pass' | 'fail'; evidence: string };
  path_map_prune: { collapse_repeats: boolean; min_runs: number; min_share_pct: number; max_depth: number };
  first_failure: { start_token: string; known_limits: string[] };
}
export declare const TRAJECTORY_SHAPES_SPEC: Readonly<TrajectoryShapesSpec>;
export declare function kindOfStep(step: ShapeStep): string;
export declare function kindString(steps: readonly ShapeStep[]): { kind_string: string; truncated: boolean };
export declare function shapeOf(kindString: string): string;
export declare function firstFailure(steps: readonly ShapeStep[]): FirstFailure | null;
export declare function pathMap(kindStrings: readonly string[]): { nodes: Array<{ path: string; n: number }> };
/** The collapsed, max_depth-cut path of one kind string (the prefixes that pathMap counts). */
export declare function pathOf(kindString: string): string;
export declare const trajectoryV2Schema: Record<string, unknown>;
export interface TrajectoryIssue {
  code: 'unknown_key' | 'invalid' | 'inconsistent';
  path: string;
  message: string;
}
export type TrajectoryValidation = { ok: true; value: AnyTrajectory } | { ok: false; issues: TrajectoryIssue[]; errors: string[] };

export declare const TRAJECTORY_FORMAT: 'tma-trajectory/1';
export declare const TRAJECTORY_MAX_STEPS: number;
export declare const TRAJECTORY_MAX_TARGET: number;
export declare const TOOL_FAMILIES: readonly ToolFamily[];
export declare const STEP_STATUSES: readonly StepStatus[];
export declare const STEP_ERROR_CLASSES: readonly StepErrorClass[];
export declare const TARGET_KINDS: readonly TargetKind[];
export declare const trajectorySchema: Record<string, unknown>;
export declare function trajectoryStepIssues(steps: ReadonlyArray<TrajectoryStep>, base?: string): TrajectoryIssue[];
export declare function validateTrajectory(value: unknown): TrajectoryValidation;

/** The kind of the ONE diff of an agent variant on its base agent version (parent plan ADR-26). */
export type VariantChangeKind =
  | 'prompt' | 'rules' | 'skill' | 'retrieval' | 'memory' | 'model' | 'tools' | 'mcp' | 'permissions'
  | 'orchestration' | 'limits' | 'harness' | 'none';
export type GraderKind = 'code' | 'judge' | 'human';
export type CaseMode = 'replay' | 'trace_review';

/** A base agent version: harness + model + rules + skills + configured tools (field names of tma-pin/1). */
export interface AgentVersion {
  harness: string;
  harness_version: string | null;
  harness_repo_sha: string | null;
  model_id: string;
  rules_sha256: string | null;
  skills_sha256: string | null;
  /** The MCP servers and tools the agent has CONFIGURED (not the environment servers of the case). */
  mcp_manifest_sha256: string | null;
  /** The configured built-in tools, permissions and scopes. */
  tools_sha256: string | null;
}

/** The closed reason of a label (grader_results.reason_code; the S13 chips). */
export type GraderReasonCode = 'wrong_sha' | 'no_check' | 'partial' | 'other';
/** A judge's label counts and 2x2 table on its test split: tp + fn + tn + fp = n_test <= n_labels. */
export interface GraderCalibration {
  n_labels: number;
  n_test: number;
  tp: number;
  fn: number;
  tn: number;
  fp: number;
  /** YYYY-MM-DD, or null. */
  realigned_at: string | null;
}

export interface GraderResult {
  id: string;
  semver: string;
  code_sha256: string;
  kind: GraderKind;
  pass: boolean;
  score: number | null;
  weight: number;
  hard_gate: boolean;
  decisive: boolean;
}

/** A tma-local-result/3 grader entry: the /2 entry plus optional fields (plan T11; refused in /2). */
export interface GraderResultV3 extends GraderResult {
  // The first four belong to the grader VERSION: every run that names it sends the same values.
  proof?: { caught: number; total: number } | null;
  /** A judge only. */
  calibration?: GraderCalibration | null;
  /** At most 60 characters, the label charset. */
  note?: string | null;
  /** An actor key (a slug or a principal id). */
  author?: string | null;
  // These two belong to this result.
  reason_code?: GraderReasonCode | null;
  labeler?: string | null;
}

/** The task summary of a case (Q-T16 = A): at most 280 characters per field, the label charset. No outcome. */
export interface TaskSummary {
  before: string | null;
  expected: string | null;
}

export interface LocalResultV2 extends Omit<LocalResult, 'format' | 'runs'> {
  format: 'tma-local-result/2';
  /** The test case: the problem. origin_pin_sha256 is provenance of the origin trace, never an agent binding. */
  case: { case_key: string; manifest_sha256: string; origin_pin_sha256: string | null; mode: CaseMode; use_case_key: string };
  /** The agent variant: a base agent version plus ONE diff. Independent of the case. */
  variant: { agent: AgentVersion; variant_sha256: string; label: string; change_kind: VariantChangeKind };
  /** The crossing of this case and this variant. */
  comparison: { is_baseline: boolean; prediction_sha256: string | null };
  /** Closed per shape: the v1 run of the shape plus infra_ok, graders and trajectory. At most 50. */
  runs: Array<LocalResult['runs'][number] & { infra_ok: boolean; graders: GraderResult[]; trajectory: Trajectory | null }>;
}

/**
 * tma-local-result/3 (plan ADR-3: "A new field needs a contract PR (/3)"): /2 plus the optional case task summary,
 * the optional grader version and label fields, and a run trajectory of tma-trajectory/1 or tma-trajectory/2.
 */
export interface LocalResultV3 extends Omit<LocalResultV2, 'format' | 'case' | 'runs'> {
  format: 'tma-local-result/3';
  case: LocalResultV2['case'] & { task_summary?: TaskSummary | null };
  /** Closed per shape, as in /2; the graders may carry the /3 fields and the trajectory may be tma-trajectory/2. */
  runs: Array<LocalResult['runs'][number] & { infra_ok: boolean; graders: GraderResultV3[]; trajectory: AnyTrajectory | null }>;
}

/** A /2 or /3 body: both are assignable to it, so one writer stores both (a /2 body has none of the /3 fields). */
export type LocalResultV2Plus = Omit<LocalResultV3, 'format'> & { format: 'tma-local-result/2' | 'tma-local-result/3' };

export type LocalResultV2Validation = { ok: true; value: LocalResultV2 } | { ok: false; issues: LocalResultIssue[]; errors: string[] };
export type LocalResultV3Validation = { ok: true; value: LocalResultV3 } | { ok: false; issues: LocalResultIssue[]; errors: string[] };
export type AnyLocalResultValidation =
  | ({ format: 'tma-local-result/1' } & LocalResultValidation)
  | ({ format: 'tma-local-result/2' } & LocalResultV2Validation)
  | ({ format: 'tma-local-result/3' } & LocalResultV3Validation)
  | ({ format: undefined } & { ok: false; issues: LocalResultIssue[]; errors: string[] });

export declare const LOCAL_RESULT_V2_FORMAT: 'tma-local-result/2';
export declare const LOCAL_RESULT_V2_MAX_BYTES: number;
export declare const LOCAL_RESULT_V2_MAX_RUNS: number;
export declare const LOCAL_RESULT_V3_FORMAT: 'tma-local-result/3';
export declare const VARIANT_CHANGE_KINDS: readonly VariantChangeKind[];
export declare const AGENT_VERSION_FIELDS: readonly (keyof AgentVersion)[];
/** sha256 of the empty string: the variant_sha256 of change_kind none. */
export declare const EMPTY_DIFF_SHA256: string;
/** sha256 of the canonical base agent version: eval_variants.agent_sha256. */
export declare function agentVersionSha256(agent: AgentVersion): string;
export declare const GRADER_KINDS: readonly GraderKind[];
export declare const CASE_MODES: readonly CaseMode[];
export declare const GRADER_VERSION_FIELDS: readonly ('proof' | 'calibration' | 'note' | 'author')[];
export declare const GRADER_REASON_CODES: readonly GraderReasonCode[];
/** The grader-version fields of a grader entry as one canonical string (an absent key = null). */
export declare function graderVersionFieldsKey(g: GraderResultV3): string;
export declare const localResultV2Schema: Record<string, unknown>;
export declare function validateLocalResultV2(value: unknown): LocalResultV2Validation;
export declare const localResultV3Schema: Record<string, unknown>;
export declare function validateLocalResultV3(value: unknown): LocalResultV3Validation;
/** Validate by `format`: /2 or /3 when it says so, else v1. */
export declare function validateAnyLocalResult(value: unknown): AnyLocalResultValidation;
/** Parse and validate any version; refuses above 4 MiB, and a v1 body above 1 MiB. */
export declare function parseAnyLocalResultText(text: string): AnyLocalResultValidation;

// --- Pin recipe (plan 20261112-tma-c2-trace-selection-pin, T2; parent ADR-7).
// Schema: schemas/pin.schema.json (the source of truth); validator: pin.js.

export type PinField =
  | 'repo'
  | 'base_sha'
  | 'harness'
  | 'harness_version'
  | 'harness_repo_sha'
  | 'rules_sha256'
  | 'skills_sha256'
  | 'model_id'
  | 'mcp_manifest_sha256'
  | 'input_sha256';
/** exact = read from the record; derived = rebuilt from git at the session time; missing = not recovered (the field is null). */
export type PinCompleteness = 'exact' | 'derived' | 'missing';

export interface Pin {
  format: 'tma-pin/1';
  /** owner/name */
  repo: string | null;
  /** The repository commit at the session start. */
  base_sha: string | null;
  harness: 'claude-code' | 'codex' | 'opencode' | null;
  harness_version: string | null;
  /** The harness configuration repository commit (fleet: dfl-harness). */
  harness_repo_sha: string | null;
  /** sha256 of the rules file as loaded (CLAUDE.md / AGENTS.md). */
  rules_sha256: string | null;
  /** Folder digests of the invoked skills, sorted ascending, unique. */
  skills_sha256: string[] | null;
  model_id: string | null;
  mcp_manifest_sha256: string | null;
  /** sha256 of the rendered task text or the first human turn. */
  input_sha256: string | null;
  completeness: Record<PinField, PinCompleteness>;
  /** sha256 of the RFC 8785 canonical JSON of the record without this key. */
  pin_sha256: string;
}

export interface PinIssue {
  code: 'unknown_key' | 'invalid' | 'too_large' | 'not_json' | 'inconsistent';
  /** JSON pointer of the offending value, e.g. "/completeness/base_sha". */
  path: string;
  message: string;
}
export type PinValidation = { ok: true; value: Pin } | { ok: false; issues: PinIssue[]; errors: string[] };

export declare const PIN_FORMAT: 'tma-pin/1';
export declare const PIN_MAX_BYTES: number;
export declare const PIN_FIELDS: readonly PinField[];
export declare const PIN_COMPLETENESS: readonly PinCompleteness[];
export declare const pinSchema: Record<string, unknown>;
export declare function canonicalPinJson(record: Record<string, unknown>): string;
export declare function pinDigest(record: Record<string, unknown>): string;
export declare function sealPin<T extends Record<string, unknown>>(record: T): T & { pin_sha256: string };
export declare function pinReplayable(pin: { completeness: Record<string, string> }): boolean;
export declare function validatePin(value: unknown): PinValidation;
export declare function parsePinText(text: string): PinValidation;

// --- Route row (plan 20261112-tma-c8-routing-from-evals, T1, T2, T4; ADR-4, ADR-5; Q3 = A).
// Schemas: schemas/route-v1.schema.json (tma-route/1) and schemas/route-v2.schema.json (tma-route/2), the source of
// truth; validator: route.js (it picks the schema by `format`).

export type RouteState = 'proposed' | 'approved' | 'live' | 'needs_check' | 'rolled_back';
export type RouteRule = 'absolute' | 'relative';

/** The keys that tma-route/1 and tma-route/2 share. */
export interface RouteBase {
  id: string;
  tenant: string;
  /** The L1 pair type/subtype. */
  use_case_key: string;
  /** env:<FLAG> or claude-md:<row>. */
  route_target: string;
  target_value: string;
  /** The value in the file at approval time; null = not known. */
  rollback_value: string | null;
  model_id: string;
  agent_sha256: string;
  harness?: 'claude-code' | 'codex' | 'opencode' | null;
  harness_repo_sha?: string | null;
  rules_sha256?: string | null;
  skills_sha256?: string[] | null;
  fallback_model_id?: string | null;
  fallback_agent_sha256?: string | null;
  picked_rule: RouteRule;
  verdict: string;
  n: number;
  evidence_run_ids: string[];
  compare_profile_sha256: string;
  policy_version: string;
  state: RouteState;
  pr_url?: string | null;
  approved_by_actor: string | null;
  approved_at: string | null;
  created_at?: string;
  updated_at?: string;
}

/** A tma-route/1 row (a route file; format optional). */
export interface RouteV1 extends RouteBase {
  format?: 'tma-route/1';
}

/** A tma-route/2 row (what the API answers): /1 plus the apply-path columns, each present and null until set. */
export interface RouteV2 extends RouteBase {
  format: 'tma-route/2';
  /** When the route went live; non-null in state live. */
  live_at: string | null;
  /** The rollback PR; non-null in state rolled_back. */
  rollback_pr_url: string | null;
  /** When the route was rolled back; non-null in state rolled_back. */
  rolled_back_at: string | null;
}

/**
 * A route row as a reader sees it: either format. Every RouteV1 and every RouteV2 is a Route; the v2 keys are
 * optional here (absent on a /1 row), so a reader can read `live_at` without narrowing first.
 */
export interface Route extends RouteBase {
  format?: 'tma-route/1' | 'tma-route/2';
  live_at?: string | null;
  rollback_pr_url?: string | null;
  rolled_back_at?: string | null;
}

export interface RouteIssue {
  code: 'unknown_key' | 'invalid' | 'too_large' | 'not_json' | 'inconsistent';
  path: string;
  message: string;
}
export type RouteValidation = { ok: true; value: Route } | { ok: false; issues: RouteIssue[]; errors: string[] };

export declare const ROUTE_FORMAT_V1: 'tma-route/1';
export declare const ROUTE_FORMAT_V2: 'tma-route/2';
/** The current route format (= ROUTE_FORMAT_V2). */
export declare const ROUTE_FORMAT: 'tma-route/2';
export declare const ROUTE_MAX_BYTES: number;
export declare const ROUTE_STATES: readonly RouteState[];
export declare const ROUTE_RULES: readonly RouteRule[];
export declare const ROUTE_PASSING_VERDICTS: Readonly<Record<RouteRule, readonly string[]>>;
export declare const ROUTE_MIN_N: number;
export declare const routeSchema: Record<string, unknown>;
export declare const routeSchemaV2: Record<string, unknown>;
export declare function routeVerdictPasses(rule: string, verdict: string): boolean;
export declare function validateRoute(value: unknown): RouteValidation;
export declare function parseRouteText(text: string): RouteValidation;

// --- Route observation (plan 20261112-tma-c8-routing-from-evals, T5; ADR-3, ADR-7).
// Schema: schemas/route-observation-v1.schema.json (tma-route-observation/1); validator: route-observation.js.

export type RouteHarness = 'claude-code' | 'codex' | 'opencode';

/** What the host runs today for one harness; null = not known. */
export interface RouteObservationAgent {
  harness_repo_sha: string | null;
  rules_sha256: string | null;
  skills_sha256: string | null;
}

/** A tma-route-observation/1 file: what a host-side collector observed today. */
export interface RouteObservation {
  format: 'tma-route-observation/1';
  observed_at: string;
  /** The digest of the model list and prices (tiers.json + catalog). */
  models: { digest: string };
  /** The share in percent of each L1 pair among the declared runs of the window; total 0 = no data. */
  mix: { window_days: 14; total: number; shares: Record<string, number> };
  /** Per L1 pair, grader id -> version. */
  graders: Record<string, Record<string, string>>;
  agents: Partial<Record<RouteHarness, RouteObservationAgent>>;
}

export interface RouteObservationIssue {
  code: 'unknown_key' | 'invalid' | 'too_large' | 'not_json';
  path: string;
  message: string;
}
export type RouteObservationValidation =
  | { ok: true; value: RouteObservation }
  | { ok: false; issues: RouteObservationIssue[]; errors: string[] };

export declare const ROUTE_OBSERVATION_FORMAT: 'tma-route-observation/1';
export declare const ROUTE_OBSERVATION_MAX_BYTES: number;
export declare const routeObservationSchema: Record<string, unknown>;
export declare function validateRouteObservation(value: unknown): RouteObservationValidation;
export declare function parseRouteObservationText(text: string): RouteObservationValidation;

export {
  FALLBACK_LAB,
  LABS,
  PROVIDER_KEYS,
  PROVIDER_NAME,
  labOf,
  providerOf,
  DEFAULT_ROUTE,
  ROUTES,
  ROUTE_KEYS,
  routeOf,
  isProviderKey,
  isRouteKey,
} from './model-catalog.js';
export type { Lab, ModelRoute, ProviderKey } from './model-catalog.js';

// --- Stored outputs of a hosted run (plan TMA L17, task L17a). Shared by the runner (collects and
// stores) and the API (lists and serves). Module: run-artifacts.js (the header documents the storage).

export type ArtifactKind = 'json' | 'markdown' | 'html' | 'text' | 'image' | 'diff';
export type ArtifactEncoding = 'utf-8' | 'base64';
export interface ArtifactTypeEntry {
  contentType: string;
  kind: ArtifactKind;
  encoding: ArtifactEncoding;
}
/** One stored artifact as the runner hands it to the job store, and as the API reads it back. */
export interface RunArtifact {
  /** The stored path: `result.json`, `agent/stderr.txt`, `agent/trace.jsonl`, `files/<workspace path>`. */
  path: string;
  /** UTF-8 text, or base64 text for encoding 'base64'. */
  content: string;
  encoding: ArtifactEncoding;
  /** sha256 hex of the raw bytes. */
  sha256: string;
  /** Raw bytes. */
  bytes: number;
}
export type ArtifactSkipReason = 'not_allowed' | 'unsafe_path' | 'symlink' | 'not_file' | 'too_large' | 'not_utf8' | 'run_cap' | 'unreadable';
export interface SkippedArtifact {
  path: string;
  reason: ArtifactSkipReason;
}
/** `result.json` (format tma-run-result/1): what the worker writes from the final outcome. */
export interface RunResultArtifact {
  format: 'tma-run-result/1';
  status: string;
  phase: string;
  scoreTotal: number;
  error: string | null;
  model: string | null;
  route: string | null;
  agent: { exitCode: number; timedOut: boolean; durationMs: number; errors: string[] } | null;
  cost: { usd: number; tokensIn: number; tokensOut: number } | null;
  skipped: SkippedArtifact[];
}

export declare const RUN_RESULT_FORMAT: 'tma-run-result/1';
export declare const ARTIFACT_REF_PREFIX: 'artifact:';
export declare const PATCH_ARTIFACT_PATH: 'patch.diff';
export declare const PATCH_CONTENT_TYPE: 'text/x-diff';
export declare const ARTIFACT_MAX_FILE_BYTES: number;
export declare const ARTIFACT_MAX_RUN_BYTES: number;
export declare const ARTIFACT_MAX_COUNT: number;
export declare const ARTIFACT_MAX_PATH_LENGTH: number;
export declare const ARTIFACT_LIMITS: Readonly<{ maxFileBytes: number; maxRunBytes: number; maxCount: number }>;
export declare const ARTIFACT_TYPES: Readonly<Record<'json' | 'jsonl' | 'md' | 'markdown' | 'html' | 'htm' | 'txt' | 'log' | 'csv' | 'svg' | 'png' | 'jpg' | 'jpeg' | 'gif' | 'webp', ArtifactTypeEntry>>;
export declare const REDACTED: '[redacted]';
export declare function artifactType(path: string): ArtifactTypeEntry | null;
export declare function isSafeArtifactPath(path: unknown): path is string;
export declare function artifactRef(path: string): string;
export declare function artifactPathOfRef(ref: unknown): string | null;
export declare function redactSecrets(text: string, extra?: readonly string[]): string;
