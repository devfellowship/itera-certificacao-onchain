/**
 * The public task profile (screen /tasks/:slug, U30; plan 20261012-itera-testmyagent-ui-refactor,
 * ADR-11 and the designer addendum U32, part 3). Pure: rows in, JSON out.
 *
 * What it publishes: the stable rules of a catalog task (goal, input and output, tools, MCP servers
 * with the `tools/list` snapshot pinned to the task version, limits, scorer parts, tests label,
 * version and digests, results). What it never publishes: an endpoint, a token, a secret value, seed
 * contents, a hidden test name. Names, counts and digests only.
 *
 * Contract fields it reads from task_versions.contract (all optional, so a sparse version still renders):
 *   profile.{goal, done_when[], instruction, repository{repo,path}, public_tests_count}
 *   agent.timeout_sec, verifier.{cmd[], timeout_sec}, editable_paths[], protected_paths[]
 *   environment.tools.builtin[], environment.tools.mcp[], run_egress[], secrets[], resources
 * Per MCP server, the resolver of U29 records the pin on the server entry:
 *   tools_snapshot[{name, description, inputSchema}], image_digest, snapshot_captured_at, seed_digest,
 *   reviewed_at. Until that exists a server shows "schema snapshot pending".
 */
import { digestOf } from "../domain/digest.js";
import type { TaskReputation } from "../domain/reputation.js";
import { taskToolEnvironment } from "../domain/task-environment.js";
import { OPEN_TESTS_LABEL } from "../domain/reputation.js";
import type { PublicTaskSource, PublicTaskVersionRow, TaskResultRow } from "./task-store.js";

export const BUILTIN_TOOL_INFO: Record<string, { name: string; description: string }> = {
  read: { name: "read", description: "Read a file in the workspace." },
  write: { name: "write", description: "Create a file in the workspace." },
  edit: { name: "edit", description: "Edit files. This is how the agent returns its patch." },
  bash: { name: "bash", description: "Run a shell command in the sandbox. No network except the model gateway." },
  search: { name: "search", description: "Search the workspace (grep, glob)." },
  list: { name: "list", description: "List a directory." },
  todo: { name: "todo", description: "Keep a to-do list for the run." },
};
const BUILTIN_ORDER = ["read", "write", "edit", "bash", "search", "list", "todo"];

/**
 * Score version 2 (TMA-QC = B; services/evaluator/src/score.ts hiddenRatioScore): the score is the
 * share of the hidden checks × 100 when every gate holds, else 0. Same rule for every task.
 */
export const SCORE_PARTS = [
  { key: "hidden_behavior", label: "Hidden", points: 100, description: "Share of the hidden checks that pass, × 100. The agent never sees them." },
] as const;
/** The gates of score version 2: one broken gate makes the score 0. */
export const SCORE_GATES = [
  "The agent finishes inside the time limit and the cost cap.",
  "The patch is not empty.",
  "The patch touches only the editable paths (else the run is INVALID).",
  "Every final-state assertion of a scored MCP server holds.",
] as const;

const INSTRUCTION_MAX = 8000;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export interface McpToolView {
  name: string;
  description: string;
  /** Parameter names, required ones first. */
  params: string[];
  required: string[];
  inputSchema: unknown;
}

export interface McpServerView {
  name: string;
  description: string | null;
  source: "catalog" | "repo";
  transport: "stdio" | "http";
  /** Catalog `name@N` → "v N"; null for a repo server. */
  version: string | null;
  reviewedAt: string | null;
  retired: boolean;
  seed: { applied: boolean; digest: string | null };
  scorerReadsState: boolean;
  /** "pinned" = the list_tools snapshot of this task version; "pending" = no snapshot recorded yet. */
  snapshot: { status: "pinned" | "pending"; capturedAt: string | null; digest: string | null; toolCount: number };
  /** The tools the agent can call: the pinned snapshot filtered by allowed_tools. */
  tools: McpToolView[];
  /** Tools of the server that the agent cannot call. A count only, never names. */
  notExposedCount: number;
  /** Declared allowed tools when the snapshot is pending. */
  allowedToolNames: string[];
}

export interface ResultsView {
  agentsEvaluated: number;
  runs: number;
  passRate: number | null;
  medianScore: number | null;
  medianDurationMs: number | null;
  outcomes: { pass: number; fail: number; invalid: number };
  leaderboard: Array<{
    rank: number;
    agentName: string;
    agentSlug: string | null;
    ownerWallet: string | null;
    modelLabel: string | null;
    score: number | null;
    outcome: "PASS" | "FAIL" | "INVALID";
    date: string | null;
    evaluationSlug: string | null;
  }>;
}

export interface TaskProfile {
  id: string;
  slug: string;
  name: string;
  description: string;
  tags: Array<{ id: string; name: string; kind: "tool" | "concept" }>;
  curatedByItera: true;
  runnable: boolean;
  estMinutes: number | null;
  price: { usdPerRun: number; currency: "USD"; paidIn: "SOL"; network: "devnet" };
  tests: { label: "sealed" | "open"; hiddenCount: number | null; publicCount: number | null };
  version: {
    number: number;
    latest: number;
    isLatest: boolean;
    createdAt: string;
    commit: string | null;
    repoUrl: string | null;
    digest: string | null;
    digests: { contract: string; environment: string; mcpSchema: string | null; fixture: string | null; hidden: string | null; seeds: Array<{ server: string; digest: string | null }> };
    history: Array<{ version: number; createdAt: string; changed: Array<"Contract" | "Environment" | "Tests"> }>;
  };
  goal: { text: string; doneWhen: string[] };
  input: {
    instruction: { text: string | null; truncated: boolean };
    repository: { repo: string | null; path: string | null; commit: string | null };
    editablePaths: string[];
    protectedPaths: string[];
  };
  output: { summary: string; checkedBy: string | null; separateContainer: true; hiddenCount: number | null };
  tools: Array<{ id: string; name: string; description: string; allowed: boolean }>;
  mcp: { servers: McpServerView[]; scorerReads: string[]; snapshotDigest: string | null };
  limits: {
    runTimeoutSec: number | null;
    estMinutes: number | null;
    costCapUsd: number;
    resources: { cpus: number | null; memoryMb: number | null; pids: number | null };
    network: "model-gateway" | "model-gateway+mcp";
    secrets: string[];
    mcpBootTimeoutSec: number | null;
    editablePaths: string[];
    protectedPaths: string[];
  };
  scoring: { parts: Array<{ key: string; label: string; points: number; description: string }>; gates: string[]; version: 2; total: 100 };
  reputation: TaskReputation | null;
  /** Runs on this version. */
  results: ResultsView;
  /** Runs on every version. */
  resultsAll: ResultsView;
  links: { web: string; api: string };
}

export interface ProfileLinks {
  webBaseUrl: string;
  apiBaseUrl: string;
}

export interface ProfileOptions {
  /** Version to show; the latest when absent or unknown. */
  version?: number;
  reputation?: TaskReputation | null;
  results?: TaskResultRow[];
  costCapUsd: number;
  runFeeUsd: number;
  links: ProfileLinks;
}

const shortSha = (s: string | null) => (s ? s.slice(0, 7) : null);

function normalizeSnapshot(raw: unknown): McpToolView[] | null {
  if (!Array.isArray(raw)) return null;
  const out: McpToolView[] = [];
  for (const t of raw) {
    const o = obj(t);
    const name = str(o.name);
    if (!name) continue;
    const schema = o.inputSchema ?? o.input_schema ?? {};
    const props = Object.keys(obj(obj(schema).properties));
    const required = strArr(obj(schema).required);
    const params = [...required.filter((p) => props.includes(p)), ...props.filter((p) => !required.includes(p))];
    out.push({ name, description: str(o.description) ?? "", params, required, inputSchema: schema });
  }
  return out;
}

export function mcpServerViews(contract: unknown): McpServerView[] {
  const env = taskToolEnvironment({ contract });
  return env.mcp.map((s) => {
    const raw = obj(s);
    const snapshot = normalizeSnapshot(raw.tools_snapshot);
    const allowed = strArr(raw.allowed_tools);
    const catalog = str(raw.catalog);
    const exposed = snapshot ? snapshot.filter((t) => allowed.includes(t.name)) : [];
    const pinned = snapshot !== null && snapshot.length > 0;
    return {
      name: String(raw.name),
      description: str(raw.description),
      source: catalog ? "catalog" : "repo",
      transport: raw.transport === "stdio" ? "stdio" : "http",
      version: catalog && catalog.includes("@") ? `v${catalog.split("@")[1]}` : null,
      reviewedAt: catalog ? null : str(raw.reviewed_at),
      retired: raw.retired === true,
      seed: { applied: Boolean(raw.seed) || Boolean(raw.seed_digest), digest: str(raw.seed_digest) },
      scorerReadsState: raw.expose_state_to_scorer === true,
      snapshot: {
        status: pinned ? "pinned" : "pending",
        capturedAt: pinned ? str(raw.snapshot_captured_at) : null,
        digest: pinned ? digestOf(snapshot) : null,
        toolCount: snapshot?.length ?? 0,
      },
      tools: exposed,
      notExposedCount: pinned ? snapshot!.length - exposed.length : 0,
      allowedToolNames: allowed,
    };
  });
}

const OUTCOME: Record<string, "PASS" | "FAIL" | "INVALID"> = { pass: "PASS", fail: "FAIL", invalid: "INVALID", timeout: "INVALID" };

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Public results of one task: runs on public, issued evaluations. infra_error runs never arrive here. */
export function resultsView(rows: TaskResultRow[]): ResultsView {
  const finished = rows.filter((r) => OUTCOME[r.status]);
  const outcomes = { pass: 0, fail: 0, invalid: 0 };
  for (const r of finished) outcomes[OUTCOME[r.status]!.toLowerCase() as keyof typeof outcomes] += 1;
  const scored = finished.filter((r) => (r.status === "pass" || r.status === "fail") && r.scoreTotal !== null);
  const durations = finished
    .map((r) => (r.completedAt ? new Date(r.completedAt).getTime() - new Date(r.claimedAt ?? r.startedAt).getTime() : NaN))
    .filter((n) => Number.isFinite(n) && n >= 0);
  const byAgent = new Map<string, TaskResultRow[]>();
  for (const r of finished) byAgent.set(r.agentId, [...(byAgent.get(r.agentId) ?? []), r]);
  const board = [...byAgent.values()].map((runs) => {
    const latest = [...runs].sort((a, b) => (b.issuedAt ?? "").localeCompare(a.issuedAt ?? ""))[0]!;
    const s = runs.filter((r) => (r.status === "pass" || r.status === "fail") && r.scoreTotal !== null).map((r) => r.scoreTotal!);
    return {
      agentName: latest.agentName,
      agentSlug: latest.agentSlug,
      ownerWallet: latest.ownerWallet ?? null,
      modelLabel: latest.modelLabel,
      score: s.length ? round1(s.reduce((a, b) => a + b, 0) / s.length) : null,
      outcome: OUTCOME[latest.status]!,
      date: latest.issuedAt,
      evaluationSlug: latest.evaluationSlug,
    };
  });
  board.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || (b.date ?? "").localeCompare(a.date ?? ""));
  const med = median(scored.map((r) => r.scoreTotal!));
  return {
    agentsEvaluated: byAgent.size,
    runs: finished.length,
    passRate: finished.length ? Math.round((outcomes.pass / finished.length) * 1000) / 1000 : null,
    medianScore: med === null ? null : round1(med),
    medianDurationMs: median(durations),
    outcomes,
    leaderboard: board.slice(0, 10).map((b, i) => ({ rank: i + 1, ...b })),
  };
}

function splitContract(contract: unknown): { rest: unknown; environment: unknown } {
  const { environment, ...rest } = obj(contract);
  return { rest, environment: environment ?? null };
}

function changedParts(cur: PublicTaskVersionRow, prev: PublicTaskVersionRow | undefined): Array<"Contract" | "Environment" | "Tests"> {
  if (!prev) return [];
  const a = splitContract(cur.contract);
  const b = splitContract(prev.contract);
  const out: Array<"Contract" | "Environment" | "Tests"> = [];
  if (digestOf(a.rest) !== digestOf(b.rest)) out.push("Contract");
  if (digestOf(a.environment) !== digestOf(b.environment)) out.push("Environment");
  if (cur.fixtureDigest !== prev.fixtureDigest || cur.hiddenDigest !== prev.hiddenDigest || cur.hiddenTestsCount !== prev.hiddenTestsCount) out.push("Tests");
  return out;
}

const short = (d: string | null) => (d ? d : null);

export function buildTaskProfile(src: PublicTaskSource, opts: ProfileOptions): TaskProfile | null {
  const latest = src.versions[0];
  if (!latest) return null;
  const v = (opts.version !== undefined && src.versions.find((x) => x.version === opts.version)) || latest;
  const contract = obj(v.contract);
  const prof = obj(contract.profile);
  const env = taskToolEnvironment({ contract: v.contract });
  const servers = mcpServerViews(v.contract);
  const editable = strArr(contract.editable_paths);
  const protectedPaths = strArr(contract.protected_paths);
  const agent = obj(contract.agent);
  const verifier = obj(contract.verifier);
  const repo = obj(prof.repository);
  const resources = env.resources;
  const sealed = !v.labels.includes(OPEN_TESTS_LABEL);
  const instruction = str(prof.instruction);
  const verifierCmd = strArr(verifier.cmd);
  const checkedBy = verifierCmd.length ? verifierCmd.filter((p) => !p.includes("{")).join(" ") : null;
  const pinnedAll = servers.length > 0 && servers.every((s) => s.snapshot.status === "pinned");
  const snapshotDigest = pinnedAll ? digestOf(servers.map((s) => ({ name: s.name, tools: s.snapshot.digest }))) : null;
  const contractDigest = digestOf(contract);
  const environmentDigest = digestOf(env);
  const commit = v.commitSha ?? str(repo.commit);
  const repoFull = v.repoFullName ?? str(repo.repo);
  const rows = opts.results ?? [];
  // A run without a recorded version (legacy bridge) belongs to the latest version.
  const results = resultsView(rows.filter((r) => (r.taskVersion ?? latest.version) === v.version));
  const resultsAll = resultsView(rows);

  return {
    id: src.task.id,
    slug: src.task.slug,
    name: src.task.name,
    description: src.task.description,
    tags: src.task.tags,
    curatedByItera: true,
    runnable: v.runnable,
    estMinutes: numOrNull(contract.est_minutes) ?? src.task.estMinutes,
    price: { usdPerRun: opts.runFeeUsd, currency: "USD", paidIn: "SOL", network: "devnet" },
    tests: { label: sealed ? "sealed" : "open", hiddenCount: v.hiddenTestsCount, publicCount: numOrNull(prof.public_tests_count) },
    version: {
      number: v.version,
      latest: latest.version,
      isLatest: v.version === latest.version,
      createdAt: v.createdAt,
      commit: shortSha(commit),
      repoUrl: repoFull && !sealed ? `https://github.com/${repoFull}` : null,
      digest: contractDigest,
      digests: {
        contract: contractDigest,
        environment: environmentDigest,
        mcpSchema: snapshotDigest,
        fixture: short(v.fixtureDigest),
        hidden: short(v.hiddenDigest),
        seeds: servers.map((s) => ({ server: s.name, digest: s.seed.digest })),
      },
      history: src.versions.map((x, i) => ({ version: x.version, createdAt: x.createdAt, changed: changedParts(x, src.versions[i + 1]) })),
    },
    goal: { text: str(prof.goal) ?? src.task.description, doneWhen: strArr(prof.done_when).slice(0, 4) },
    input: {
      instruction: { text: instruction ? instruction.slice(0, INSTRUCTION_MAX) : null, truncated: Boolean(instruction && instruction.length > INSTRUCTION_MAX) },
      repository: { repo: repoFull, path: v.repoPath && v.repoPath !== "." ? v.repoPath : str(repo.path), commit: shortSha(commit) },
      editablePaths: editable,
      protectedPaths,
    },
    output: {
      summary: editable.length ? "A patch to the editable paths." : "A patch to the workspace.",
      checkedBy,
      separateContainer: true,
      hiddenCount: v.hiddenTestsCount,
    },
    tools: BUILTIN_ORDER.map((id) => ({ id, name: BUILTIN_TOOL_INFO[id]!.name, description: BUILTIN_TOOL_INFO[id]!.description, allowed: env.builtin.includes(id as never) })),
    mcp: { servers, scorerReads: servers.filter((s) => s.scorerReadsState).map((s) => s.name), snapshotDigest },
    limits: {
      runTimeoutSec: numOrNull(agent.timeout_sec),
      estMinutes: numOrNull(contract.est_minutes) ?? src.task.estMinutes,
      costCapUsd: opts.costCapUsd,
      resources: { cpus: resources.cpus ?? null, memoryMb: resources.memory_mb ?? null, pids: resources.pids ?? null },
      network: env.run_egress.includes("mcp") ? "model-gateway+mcp" : "model-gateway",
      secrets: env.secrets,
      mcpBootTimeoutSec: servers.length ? Math.max(...env.mcp.map((s) => s.startup_timeout_sec ?? 30)) : null,
      editablePaths: editable,
      protectedPaths,
    },
    scoring: { parts: SCORE_PARTS.map((p) => ({ ...p })), gates: [...SCORE_GATES], version: 2, total: 100 },
    reputation: opts.reputation ?? null,
    results,
    resultsAll,
    links: { web: `${opts.links.webBaseUrl}/tasks/${src.task.slug}`, api: `${opts.links.apiBaseUrl}/public/tasks/${src.task.slug}` },
  };
}

/** The schemas download: tools of every server, as the agent sees them, pinned to the version. */
export function schemasDownload(p: TaskProfile) {
  return {
    task: p.slug,
    version: p.version.number,
    schemaDigest: p.mcp.snapshotDigest,
    servers: p.mcp.servers.map((s) => ({
      name: s.name,
      transport: s.transport,
      snapshot: s.snapshot.status,
      tools: s.tools.map((t) => ({ name: `${s.name}_${t.name}`, description: t.description, inputSchema: t.inputSchema })),
    })),
  };
}
