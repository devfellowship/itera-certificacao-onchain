import { AGENT_MODELS } from "../github/models.js";
import { lamportsToSol, usdToLamports } from "./sol-price.js";

/**
 * Ranking of screen 01 (U8, design brief 2.3). The store returns raw rows; the roll-up below is
 * TypeScript, not SQL (CLAUDE.md: no DB functions for business logic).
 *
 * A "result" is one finished run (status pass | fail, ADR-5: INVALID is never scored) of one agent
 * version on one task. The caller sees a result when it is issued (a confirmed proof, or a run of
 * an issued evaluation) or when the caller owns the run. A result on a user task of another wallet
 * is never visible.
 */
export interface RankAgent {
  id: string;
  slug: string | null;
  name: string;
  ownerWallet: string;
  /** profiles.display_name, else the GitHub account login, else null (the row shows the short wallet). */
  authorName: string | null;
  description: string | null;
  model: string;
  modelLabel: string | null;
  /** `listed` | `private`; null before the agents columns exist (treated as listed). */
  visibility: string | null;
  status: string | null;
  listedAt: string | null;
  createdAt: string | null;
}

export interface RankResult {
  agentId: string;
  runId: string;
  runOwnerWallet: string | null;
  /** score_total, 0–100. */
  score: number;
  at: string;
  /** Confirmed proof, or a run of an issued evaluation. */
  issued: boolean;
  /** Every id the task is known by: catalog task uuid, task slug, `pack:<id>@<version>`, pack id. */
  taskKeys: string[];
  taskKind: string | null;
  taskOwnerWallet: string | null;
  /** U27: task author = agent owner, or same GitHub account. Default false. */
  selfEvaluated?: boolean;
  /** U27 sealed-test rule: false for an open-tests or public-repo task (never ranked). Default true. */
  taskRanked?: boolean;
  /** U27 task reputation weight, 0–1 (reputation.ts). Default 1. */
  taskWeight?: number;
}

/** Issued evaluations (table of U6), for "score = latest verified evaluation" without a selection. */
export interface RankEvaluation {
  agentId: string;
  score: number | null;
  issuedAt: string;
}

export interface RankingData {
  agents: RankAgent[];
  results: RankResult[];
  evaluations: RankEvaluation[];
  /** U27: keys (uuid, slug) of tasks that fail the sealed-test rule; dropped from a selection. */
  unrankedTaskKeys?: string[];
}

export interface RankingStore {
  load(callerWallet: string): Promise<RankingData>;
  /** Task ids that carry `tag`, visible to the caller; null when the catalog tables do not exist. */
  taskIdsForTag(tag: string, callerWallet: string): Promise<string[] | null>;
}

export interface RankingRow {
  rank: number | null;
  id: string;
  slug: string | null;
  name: string;
  initials: string;
  authorName: string;
  authorWallet: string;
  isMine: boolean;
  when: string | null;
  description: string | null;
  model: string;
  modelLabel: string;
  draft: boolean;
  visibility: string;
  score: number | null;
  /**
   * U27: the sort key. Mean over the counted tasks of (best score × task reputation weight). Equals
   * the plain mean when every task is curated (weight 1).
   */
  weightedScore: number | null;
  /** U27: mean reputation weight of the counted tasks; null without results. */
  reputationWeight: number | null;
  /** U27: at least one counted result is self-evaluated (task author = agent owner). */
  selfEvaluated: boolean;
  /** Distinct tasks with a visible result. */
  taskCount: number;
  coverage: { k: number; n: number; perTask: boolean[] } | null;
  runCostUsd: number | null;
  runCostLamports: number | null;
  runCostSol: string | null;
}

export interface RankingInput {
  callerWallet: string;
  data: RankingData;
  scope: "all" | "mine";
  q: string;
  /** The selected tasks (ids or slugs), in display order. Empty = no selection. */
  taskIds: string[];
  priceUsdPerRun: number;
  solUsdRate: number | null;
}

export interface RankingOutput {
  rows: RankingRow[];
  counts: { all: number; mine: number };
  /** U27: selected tasks dropped because they fail the sealed-test rule (open tests / public repo). */
  excludedTaskIds: string[];
}

export function initialsOf(name: string): string {
  const letters = name.replace(/[^\p{L}\p{N}]/gu, "");
  return (letters.slice(0, 2) || "??").toUpperCase();
}

export function shortWallet(wallet: string): string {
  return wallet.length > 10 ? `${wallet.slice(0, 4)}…${wallet.slice(-4)}` : wallet;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const mean = (xs: number[]) => (xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length);

function modelLabelOf(agent: RankAgent): string {
  return agent.modelLabel ?? AGENT_MODELS.find((m) => m.id === agent.model)?.label ?? agent.model;
}

/** Results the caller may see and that count: issued or owned by the caller, no other wallet's user task, ranked tasks only. */
function visibleResults(data: RankingData, callerWallet: string): RankResult[] {
  return data.results.filter(
    (r) =>
      (r.issued || r.runOwnerWallet === callerWallet) &&
      !(r.taskKind === "user" && r.taskOwnerWallet !== callerWallet) &&
      r.taskRanked !== false &&
      Number.isFinite(r.score),
  );
}

/** Agents the caller may see: its own, and other wallets' listed agents with an issued result or evaluation. */
function eligibleAgents(data: RankingData, callerWallet: string): RankAgent[] {
  const issued = new Set<string>([...data.results.filter((r) => r.issued).map((r) => r.agentId), ...data.evaluations.map((e) => e.agentId)]);
  return data.agents.filter((a) => a.ownerWallet === callerWallet || (a.visibility !== "private" && issued.has(a.id)));
}

export interface TaskOverview {
  /** Distinct visible agents with a counted result on the task. */
  agentsCount: number;
  /** The agent with the top score on the task; ties go to the newest result. Null without a counted result. */
  best: { agent: RankAgent; score: number } | null;
}

/**
 * Tasks page (U35): per task, how many agents have a counted result and who scored best. Same
 * visibility and ranked rules as the ranking (U27: open-tests and public-repo tasks never rank).
 * A task is matched by any of its keys (uuid, slug).
 */
export function taskOverviews(data: RankingData, callerWallet: string, tasks: Array<{ id: string; slug: string }>): Map<string, TaskOverview> {
  const agents = new Map(eligibleAgents(data, callerWallet).map((a) => [a.id, a]));
  const results = visibleResults(data, callerWallet).filter((r) => agents.has(r.agentId));
  const out = new Map<string, TaskOverview>();
  for (const t of tasks) {
    const mine = results.filter((r) => r.taskKeys.includes(t.id) || r.taskKeys.includes(t.slug));
    let top: RankResult | null = null;
    for (const r of mine) if (!top || r.score > top.score || (r.score === top.score && r.at > top.at)) top = r;
    out.set(t.id, {
      agentsCount: new Set(mine.map((r) => r.agentId)).size,
      best: top ? { agent: agents.get(top.agentId)!, score: round1(top.score) } : null,
    });
  }
  return out;
}

export function computeRanking(input: RankingInput): RankingOutput {
  const { callerWallet, data } = input;
  const unranked = new Set(data.unrankedTaskKeys ?? []);
  const requested = [...new Set(input.taskIds.filter(Boolean))];
  const excludedTaskIds = requested.filter((id) => unranked.has(id));
  const selection = requested.filter((id) => !unranked.has(id));
  const n = selection.length;

  const visible = data.results.filter(
    (r) =>
      (r.issued || r.runOwnerWallet === callerWallet) &&
      !(r.taskKind === "user" && r.taskOwnerWallet !== callerWallet) &&
      r.taskRanked !== false &&
      Number.isFinite(r.score),
  );
  const weightOf = (r: RankResult) => (typeof r.taskWeight === "number" && Number.isFinite(r.taskWeight) ? Math.max(0, Math.min(1, r.taskWeight)) : 1);
  const byAgent = new Map<string, RankResult[]>();
  for (const r of visible) {
    const list = byAgent.get(r.agentId) ?? [];
    list.push(r);
    byAgent.set(r.agentId, list);
  }
  const issuedAgents = new Set<string>([
    ...data.results.filter((r) => r.issued).map((r) => r.agentId),
    ...data.evaluations.map((e) => e.agentId),
  ]);
  const latestEval = new Map<string, RankEvaluation>();
  for (const e of data.evaluations) {
    const cur = latestEval.get(e.agentId);
    if (!cur || e.issuedAt > cur.issuedAt) latestEval.set(e.agentId, e);
  }

  // Own agents always; other wallets' agents only when listed and with an issued evaluation.
  const eligible = data.agents.filter(
    (a) => a.ownerWallet === callerWallet || (a.visibility !== "private" && issuedAgents.has(a.id)),
  );
  const counts = { all: eligible.length, mine: eligible.filter((a) => a.ownerWallet === callerWallet).length };

  const q = input.q.trim().toLowerCase();
  const filtered = eligible.filter((a) => {
    if (input.scope === "mine" && a.ownerWallet !== callerWallet) return false;
    if (!q) return true;
    const hay = [a.name, a.authorName ?? "", a.ownerWallet, a.description ?? "", a.model, modelLabelOf(a), a.slug ?? ""].join("\n").toLowerCase();
    return hay.includes(q);
  });

  const rows: RankingRow[] = filtered.map((a) => {
    const results = byAgent.get(a.id) ?? [];
    // Best score per task (canonical key = the first key), with the task reputation weight.
    const bestPerTask = new Map<string, number>();
    const weightPerTask = new Map<string, number>();
    for (const r of results) {
      const key = r.taskKeys[0] ?? r.runId;
      bestPerTask.set(key, Math.max(bestPerTask.get(key) ?? -Infinity, r.score));
      weightPerTask.set(key, weightOf(r));
    }
    let weighted: number | null = null;
    let weights: number[] = [];
    let score: number | null;
    let coverage: RankingRow["coverage"] = null;
    let runCostUsd: number | null = null;
    let runCostLamports: number | null = null;
    if (n === 0) {
      const ev = latestEval.get(a.id);
      score = ev && ev.score !== null ? ev.score : mean([...bestPerTask.values()]);
      weights = [...bestPerTask.keys()].map((k) => weightPerTask.get(k) ?? 1);
      weighted = mean([...bestPerTask.entries()].map(([k, s]) => s * (weightPerTask.get(k) ?? 1)));
    } else {
      const perTask = selection.map((id) => {
        const matching = results.filter((r) => r.taskKeys.includes(id));
        return matching.length === 0 ? null : { score: Math.max(...matching.map((r) => r.score)), weight: weightOf(matching[0]) };
      });
      const perTaskScores = perTask.map((p) => (p ? p.score : null));
      const have = perTaskScores.filter((s): s is number => s !== null);
      const covered = perTask.filter((p): p is { score: number; weight: number } => p !== null);
      weights = covered.map((p) => p.weight);
      weighted = mean(covered.map((p) => p.score * p.weight));
      coverage = { k: have.length, n, perTask: perTaskScores.map((s) => s !== null) };
      score = mean(have);
      const missing = n - have.length;
      runCostUsd = Math.round(missing * input.priceUsdPerRun * 1e4) / 1e4;
      runCostLamports = input.solUsdRate ? usdToLamports(runCostUsd, input.solUsdRate) : null;
    }
    const isMine = a.ownerWallet === callerWallet;
    return {
      rank: null,
      id: a.id,
      slug: a.slug,
      name: a.name,
      initials: initialsOf(a.name),
      authorName: a.authorName ?? shortWallet(a.ownerWallet),
      authorWallet: a.ownerWallet,
      isMine,
      when: a.listedAt ?? a.createdAt,
      description: a.description,
      model: a.model,
      modelLabel: modelLabelOf(a),
      draft: a.status === "active" ? false : !issuedAgents.has(a.id),
      visibility: a.visibility ?? "listed",
      score: score === null ? null : round1(score),
      // All tasks at full weight (curated): the weighted score is the displayed score, unchanged.
      weightedScore: weighted === null || weights.every((w) => w === 1) ? (score === null ? null : round1(score)) : round1(weighted),
      reputationWeight: weights.length === 0 ? null : Math.round((mean(weights) ?? 0) * 1000) / 1000,
      selfEvaluated: results.some((r) => r.selfEvaluated === true),
      taskCount: bestPerTask.size,
      coverage,
      runCostUsd,
      runCostLamports,
      runCostSol: runCostLamports === null ? null : lamportsToSol(runCostLamports),
    };
  });

  // No selection: weighted score desc. Selection: coverage k desc, then weighted score desc.
  // Unscored rows last. U27: the weighted score multiplies each task score by its reputation.
  rows.sort((x, y) => {
    if ((x.score === null) !== (y.score === null)) return x.score === null ? 1 : -1;
    if (n > 0 && x.coverage!.k !== y.coverage!.k) return y.coverage!.k - x.coverage!.k;
    const xs = x.weightedScore ?? x.score;
    const ys = y.weightedScore ?? y.score;
    if (xs !== null && ys !== null && xs !== ys) return ys - xs;
    if (x.score !== null && y.score !== null && x.score !== y.score) return y.score - x.score;
    return x.name.localeCompare(y.name);
  });
  let rank = 0;
  for (const row of rows) row.rank = row.score === null ? null : ++rank;
  return { rows, counts, excludedTaskIds };
}

/** In-memory store for tests and fixture mode. */
export class FakeRankingStore implements RankingStore {
  data: RankingData = { agents: [], results: [], evaluations: [] };
  tags = new Map<string, string[]>();
  catalogReady = true;

  async load(): Promise<RankingData> {
    return this.data;
  }

  async taskIdsForTag(tag: string): Promise<string[] | null> {
    if (!this.catalogReady) return null;
    return this.tags.get(tag) ?? [];
  }
}
