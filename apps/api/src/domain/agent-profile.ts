import { AGENT_MODELS } from "../github/models.js";
import { initialsOf, shortWallet } from "./agent-ranking.js";

/**
 * Agent profile (screen 08, U15) and README badge (U16). The store returns raw rows; every
 * roll-up below is TypeScript, not SQL (CLAUDE.md: no DB functions for business logic).
 *
 * What is public. A result is "public evidence" when it is ISSUED (a confirmed proof, or a run of
 * an issued evaluation) AND its task is not a user task. A user task, its results and its name
 * never leave the owner's session (my-results). An agent has a public profile when it is listed
 * and has at least one public result; its owner always sees it, with empty states.
 */

export const NETWORK_LABEL = "Solana devnet";

export interface ProfileAgent {
  id: string;
  slug: string | null;
  name: string;
  ownerWallet: string;
  /** profiles.display_name, else the GitHub account login, else null (the page shows the short wallet). */
  authorName: string | null;
  description: string | null;
  model: string;
  modelLabel: string | null;
  modelRelease: string | null;
  repoFullName: string | null;
  agentPath: string | null;
  branch: string | null;
  pinnedCommit: string | null;
  /** Commit of the latest agent_versions row (the one a run uses). */
  latestCommit: string | null;
  visibility: string | null;
  status: string | null;
  listedAt: string | null;
  createdAt: string | null;
}

export interface ProfileTag {
  id: string;
  name: string;
  kind: "tool" | "concept";
}

export interface ProfileResult {
  runId: string;
  status: "pass" | "fail";
  /** score_total, 0-100. */
  score: number;
  /** Hidden-suite counts from the evidence manifest; null when the run has none. */
  testsPassed: number | null;
  testsTotal: number | null;
  at: string;
  /** Canonical task key: the catalog task uuid, else `pack:<id>@<version>`. */
  taskKey: string;
  taskId: string | null;
  taskSlug: string | null;
  taskName: string;
  taskKind: string | null;
  taskOwnerWallet: string | null;
  taskTagIds: string[];
  proof: { status: string; txSig: string | null; nftMint: string | null } | null;
  evaluation: { id: string; slug: string | null; shortId: string | null; status: string; isPublic: boolean; issuedAt: string | null } | null;
}

export interface ProfileEvaluation {
  id: string;
  slug: string | null;
  shortId: string | null;
  score: number | null;
  issuedAt: string | null;
  isPublic: boolean;
  taskCount: number;
  passCount: number;
  failCount: number;
  invalidCount: number;
}

export interface ProfileData {
  results: ProfileResult[];
  /** Issued evaluations of the agent. */
  evaluations: ProfileEvaluation[];
  tags: ProfileTag[];
}

/** A finished run of ANY agent on a user task of the caller (its owner). */
export interface OwnTaskResult {
  agentId: string;
  agentName: string;
  agentOwnerWallet: string;
  taskId: string;
  taskName: string;
  score: number;
  status: "pass" | "fail";
  at: string;
}

export interface BadgeEvaluation {
  slug: string;
  score: number | null;
  taskCount: number;
}

export interface ProfileStore {
  /** By uuid or slug. */
  findAgent(idOrSlug: string): Promise<ProfileAgent | null>;
  load(agentId: string): Promise<ProfileData>;
  /** Results on the user tasks owned by `wallet`, from every agent. Empty when My tasks has no rows. */
  loadOwnTaskResults(wallet: string): Promise<OwnTaskResult[]>;
  /** A public, issued evaluation by slug; null otherwise (private and unknown look the same). */
  findPublicEvaluation(slug: string): Promise<BadgeEvaluation | null>;
}

// ---------------------------------------------------------------------------------------------
// Output shapes

export interface EvidenceRow {
  taskId: string | null;
  taskSlug: string | null;
  name: string;
  tags: Array<{ id: string; name: string }>;
  outcome: "PASS" | "FAIL";
  score: number;
  testsPassed: number | null;
  testsTotal: number | null;
  at: string;
  attestation: { status: string; txSig: string | null; short: string | null; explorerUrl: string | null } | null;
  evaluation: { slug: string; shortId: string | null } | null;
}

export interface AgentProfile {
  agent: {
    id: string;
    slug: string | null;
    name: string;
    initials: string;
    description: string | null;
    authorName: string;
    authorWallet: string;
    isMine: boolean;
    listedAt: string | null;
    visibility: string;
    draft: boolean;
  };
  source: { repoFullName: string | null; branch: string | null; agentPath: string | null; commit: string | null; commitShort: string | null };
  model: { id: string; label: string; release: string | null };
  stats: { score: number | null; tasksEvaluated: number; evaluations: number; lastVerifiedAt: string | null };
  tags: Array<{ id: string; name: string; kind: "tool" | "concept"; count: number }>;
  evidence: EvidenceRow[];
  latestAttestation:
    | {
        network: string;
        status: "confirmed";
        issuedAt: string;
        txSig: string;
        txShort: string;
        explorerUrl: string;
        evaluationSlug: string | null;
      }
    | null;
  evaluations: Array<{
    id: string;
    shortId: string | null;
    slug: string | null;
    score: number | null;
    issuedAt: string | null;
    taskCount: number;
    counts: { pass: number; fail: number; invalid: number };
    profilePath: string | null;
  }>;
  /** Present when the agent has a public profile: the README badge of U16. */
  badge: { path: string; markdownLinkPath: string | null } | null;
}

export interface MyResultRow {
  task: { id: string; name: string };
  outcome: "PASS" | "FAIL";
  score: number;
  /** The viewer's best own agent on this task (any of the viewer's agents, this one included). */
  bestOwnAgent: { id: string; name: string; score: number } | null;
}

// ---------------------------------------------------------------------------------------------

const round1 = (n: number) => Math.round(n * 10) / 10;
const mean = (xs: number[]) => (xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length);

export function shortSig(sig: string): string {
  return sig.length > 10 ? `${sig.slice(0, 4)}…${sig.slice(-4)}` : sig;
}

export function explorerTxUrl(sig: string): string {
  return `https://solscan.io/tx/${sig}?cluster=devnet`;
}

function modelLabelOf(agent: ProfileAgent): string {
  return agent.modelLabel ?? AGENT_MODELS.find((m) => m.id === agent.model)?.label ?? agent.model;
}

export function isIssued(r: ProfileResult): boolean {
  return r.proof?.status === "confirmed" || r.evaluation?.status === "issued";
}

/** Public evidence: issued and not a user task. */
export function publicResults(data: ProfileData): ProfileResult[] {
  return data.results.filter((r) => isIssued(r) && r.taskKind !== "user");
}

export function publicEvaluations(data: ProfileData): ProfileEvaluation[] {
  return data.evaluations.filter((e) => e.isPublic);
}

/** An agent is publicly visible when it is listed and has at least one public result. */
export function hasPublicProfile(agent: ProfileAgent, data: ProfileData): boolean {
  return agent.visibility !== "private" && (publicResults(data).length > 0 || publicEvaluations(data).length > 0);
}

/** Latest public result per task, newest first. */
export function latestPerTask(results: ProfileResult[]): ProfileResult[] {
  const byTask = new Map<string, ProfileResult>();
  for (const r of results) {
    const cur = byTask.get(r.taskKey);
    if (!cur || r.at > cur.at) byTask.set(r.taskKey, r);
  }
  return [...byTask.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.taskName.localeCompare(b.taskName)));
}

/**
 * The score of the ranking row without a task selection (same rule as GET /agents/ranking): the
 * latest issued public evaluation, else the mean of the best score per task.
 */
export function agentScore(data: ProfileData): number | null {
  const evals = publicEvaluations(data).filter((e) => e.score !== null && e.issuedAt);
  if (evals.length > 0) {
    const latest = evals.reduce((a, b) => ((b.issuedAt ?? "") > (a.issuedAt ?? "") ? b : a));
    return round1(latest.score as number);
  }
  const best = new Map<string, number>();
  for (const r of publicResults(data)) best.set(r.taskKey, Math.max(best.get(r.taskKey) ?? -Infinity, r.score));
  const m = mean([...best.values()]);
  return m === null ? null : round1(m);
}

/** Distinct public tasks, evaluations (issued evaluations plus each standalone issued run) and the last proof date. */
export function agentStats(data: ProfileData) {
  const results = publicResults(data);
  const tasks = new Set(results.map((r) => r.taskKey));
  const evalIds = new Set(publicEvaluations(data).map((e) => e.id));
  // A run proven on its own (the legacy POST /runs/:id/publish flow) is one evaluation of one task.
  const standalone = results.filter((r) => !r.evaluation).length;
  const dates = [...results.map((r) => r.at), ...publicEvaluations(data).map((e) => e.issuedAt ?? "")].filter(Boolean).sort();
  return {
    score: agentScore(data),
    tasksEvaluated: tasks.size,
    evaluations: evalIds.size + standalone,
    lastVerifiedAt: dates.length > 0 ? dates[dates.length - 1]! : null,
  };
}

export interface ProfileInput {
  agent: ProfileAgent;
  data: ProfileData;
  viewerWallet: string | null;
}

export function buildProfile({ agent, data, viewerWallet }: ProfileInput): AgentProfile {
  const tagById = new Map(data.tags.map((t) => [t.id, t]));
  const latest = latestPerTask(publicResults(data));
  const evidence: EvidenceRow[] = latest.map((r) => ({
    taskId: r.taskId,
    taskSlug: r.taskSlug,
    name: r.taskName,
    tags: r.taskTagIds.flatMap((id) => {
      const t = tagById.get(id);
      return t ? [{ id: t.id, name: t.name }] : [];
    }),
    outcome: r.status === "pass" ? "PASS" : "FAIL",
    score: round1(r.score),
    testsPassed: r.testsPassed,
    testsTotal: r.testsTotal,
    at: r.at,
    attestation: r.proof
      ? {
          status: r.proof.status,
          txSig: r.proof.txSig,
          short: r.proof.txSig ? shortSig(r.proof.txSig) : null,
          explorerUrl: r.proof.status === "confirmed" && r.proof.txSig ? explorerTxUrl(r.proof.txSig) : null,
        }
      : null,
    evaluation: r.evaluation?.isPublic && r.evaluation.slug ? { slug: r.evaluation.slug, shortId: r.evaluation.shortId } : null,
  }));

  // Tag counts = number of the agent's public tasks that carry the tag.
  const counts = new Map<string, number>();
  for (const r of latest) for (const id of new Set(r.taskTagIds)) counts.set(id, (counts.get(id) ?? 0) + 1);
  const tags = [...counts.entries()]
    .flatMap(([id, count]) => {
      const t = tagById.get(id);
      return t ? [{ id: t.id, name: t.name, kind: t.kind, count }] : [];
    })
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const proven = publicResults(data)
    .filter((r) => r.proof?.status === "confirmed" && r.proof.txSig)
    .sort((a, b) => (a.at < b.at ? 1 : -1))[0];
  const latestAttestation = proven
    ? {
        network: NETWORK_LABEL,
        status: "confirmed" as const,
        issuedAt: proven.evaluation?.issuedAt ?? proven.at,
        txSig: proven.proof!.txSig!,
        txShort: shortSig(proven.proof!.txSig!),
        explorerUrl: explorerTxUrl(proven.proof!.txSig!),
        evaluationSlug: proven.evaluation?.isPublic ? proven.evaluation.slug : null,
      }
    : null;

  const evaluations = publicEvaluations(data)
    .slice()
    .sort((a, b) => ((a.issuedAt ?? "") < (b.issuedAt ?? "") ? 1 : -1))
    .map((e) => ({
      id: e.id,
      shortId: e.shortId,
      slug: e.slug,
      score: e.score === null ? null : round1(e.score),
      issuedAt: e.issuedAt,
      taskCount: e.taskCount,
      counts: { pass: e.passCount, fail: e.failCount, invalid: e.invalidCount },
      profilePath: e.slug ? `/e/${e.slug}` : null,
    }));

  const isMine = viewerWallet !== null && viewerWallet === agent.ownerWallet;
  const stats = agentStats(data);
  const key = agent.slug ?? agent.id;
  const public_ = hasPublicProfile(agent, data);
  const commit = agent.pinnedCommit ?? agent.latestCommit;
  return {
    agent: {
      id: agent.id,
      slug: agent.slug,
      name: agent.name,
      initials: initialsOf(agent.name),
      description: agent.description,
      authorName: agent.authorName ?? shortWallet(agent.ownerWallet),
      authorWallet: agent.ownerWallet,
      isMine,
      listedAt: agent.listedAt ?? agent.createdAt,
      visibility: agent.visibility ?? "listed",
      draft: agent.status === "active" ? false : !public_,
    },
    source: {
      repoFullName: agent.repoFullName,
      branch: agent.branch,
      agentPath: agent.agentPath,
      commit,
      commitShort: commit ? commit.slice(0, 7) : null,
    },
    model: { id: agent.model, label: modelLabelOf(agent), release: agent.modelRelease },
    stats,
    tags,
    evidence,
    latestAttestation,
    evaluations,
    badge: public_ ? { path: `/badge/agents/${encodeURIComponent(key)}.svg`, markdownLinkPath: latestAttestation?.evaluationSlug ? `/e/${latestAttestation.evaluationSlug}` : null } : null,
  };
}

/** Results of `agent` on the viewer's user tasks, with the viewer's best own agent per task. */
export function buildMyResults(agentId: string, viewerWallet: string, own: OwnTaskResult[]): MyResultRow[] {
  const mine = own.filter((r) => r.agentId === agentId);
  const latest = new Map<string, OwnTaskResult>();
  for (const r of mine) {
    const cur = latest.get(r.taskId);
    if (!cur || r.at > cur.at) latest.set(r.taskId, r);
  }
  const rows: MyResultRow[] = [];
  for (const r of [...latest.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.taskName.localeCompare(b.taskName)))) {
    let best: MyResultRow["bestOwnAgent"] = null;
    for (const o of own) {
      if (o.taskId !== r.taskId || o.agentOwnerWallet !== viewerWallet) continue;
      if (!best || o.score > best.score || (o.score === best.score && o.agentName.localeCompare(best.name) < 0)) {
        best = { id: o.agentId, name: o.agentName, score: o.score };
      }
    }
    rows.push({
      task: { id: r.taskId, name: r.taskName },
      outcome: r.status === "pass" ? "PASS" : "FAIL",
      score: round1(r.score),
      bestOwnAgent: best ? { ...best, score: round1(best.score) } : null,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------

export interface BadgeData {
  score: number | null;
  taskCount: number;
}

/** The badge of an agent: null (404) unless the agent has a public profile. */
export function agentBadge(agent: ProfileAgent | null, data: ProfileData | null): BadgeData | null {
  if (!agent || !data || !hasPublicProfile(agent, data)) return null;
  const stats = agentStats(data);
  return { score: stats.score, taskCount: stats.tasksEvaluated };
}

/** In-memory store for tests and fixture mode. */
export class FakeProfileStore implements ProfileStore {
  agents: ProfileAgent[] = [];
  data = new Map<string, ProfileData>();
  own: OwnTaskResult[] = [];
  evaluations: Array<BadgeEvaluation> = [];

  async findAgent(idOrSlug: string): Promise<ProfileAgent | null> {
    return this.agents.find((a) => a.id === idOrSlug || a.slug === idOrSlug) ?? null;
  }
  async load(agentId: string): Promise<ProfileData> {
    return this.data.get(agentId) ?? { results: [], evaluations: [], tags: [] };
  }
  async loadOwnTaskResults(wallet: string): Promise<OwnTaskResult[]> {
    void wallet;
    return this.own;
  }
  async findPublicEvaluation(slug: string): Promise<BadgeEvaluation | null> {
    return this.evaluations.find((e) => e.slug === slug) ?? null;
  }
}
