/**
 * Storage seam of U27 (db/migrations/0010_reputation.sql): run provenance (task author, agent
 * owner, GitHub accounts), task reputation inputs, and run feedback. The rules are in reputation.ts.
 */
import {
  isRankedTask,
  isSelfEvaluated,
  taskReputation,
  unrankedReason,
  type AgentProvenance,
  type TaskProvenance,
  type TaskReputation,
  type TaskReputationInput,
} from "./reputation.js";

export interface RunProvenance {
  runId: string;
  runOwnerWallet: string | null;
  runStatus: string;
  /** Catalog task uuid; null for a legacy run without a catalog task. */
  taskId: string | null;
  task: TaskProvenance | null;
  agent: AgentProvenance;
}

export interface RunFeedback {
  runId: string;
  wallet: string;
  taskId: string | null;
  matchedReality: boolean;
  note: string | null;
  createdAt: string;
}

/** Reputation inputs of one task, with its identity (ownerWallet = tasks.owner_wallet). */
export type TaskInputs = TaskReputationInput & { taskId: string; slug: string; ownerWallet: string | null };

export interface ReputationStore {
  /** Keyed by run id; runs that do not exist are absent. */
  runProvenance(runIds: string[]): Promise<Map<string, RunProvenance>>;
  /** Raw reputation inputs, keyed by task uuid AND slug. Unknown keys are absent. */
  reputationInputs(taskKeys: string[]): Promise<Map<string, TaskInputs>>;
  getFeedback(runIds: string[]): Promise<Map<string, RunFeedback>>;
  /** Insert one answer. Returns null when the run already has one (one per run). */
  insertFeedback(f: Omit<RunFeedback, "createdAt">): Promise<RunFeedback | null>;
}

/** The view of one run that the proof, the profile and the API return. */
export interface RunProvenanceView {
  taskAuthorWallet: string | null;
  agentOwnerWallet: string | null;
  selfEvaluated: boolean;
  ranked: boolean;
  unrankedReason: string | null;
  curatedByItera: boolean;
}

export function provenanceView(p: RunProvenance | null | undefined): RunProvenanceView {
  if (!p) {
    return { taskAuthorWallet: null, agentOwnerWallet: null, selfEvaluated: false, ranked: true, unrankedReason: null, curatedByItera: false };
  }
  return {
    taskAuthorWallet: p.task?.authorWallet ?? null,
    agentOwnerWallet: p.agent.ownerWallet,
    selfEvaluated: isSelfEvaluated(p.task, p.agent),
    ranked: isRankedTask(p.task),
    unrankedReason: unrankedReason(p.task),
    curatedByItera: p.task?.kind === "itera",
  };
}

export async function reputationOf(store: ReputationStore, taskKeys: string[]): Promise<Map<string, TaskReputation & { taskId: string; slug: string; ownerWallet: string | null }>> {
  const inputs = await store.reputationInputs(taskKeys);
  const out = new Map<string, TaskReputation & { taskId: string; slug: string; ownerWallet: string | null }>();
  for (const [k, v] of inputs) out.set(k, { ...taskReputation(v), taskId: v.taskId, slug: v.slug, ownerWallet: v.ownerWallet });
  return out;
}

/** In-memory store for tests. */
export class FakeReputationStore implements ReputationStore {
  provenance = new Map<string, RunProvenance>();
  inputs = new Map<string, TaskInputs>();
  feedback = new Map<string, RunFeedback>();

  async runProvenance(runIds: string[]) {
    return new Map(runIds.filter((id) => this.provenance.has(id)).map((id) => [id, this.provenance.get(id)!]));
  }

  async reputationInputs(taskKeys: string[]) {
    const out = new Map<string, TaskInputs>();
    for (const v of this.inputs.values()) {
      const fb = [...this.feedback.values()].filter((f) => f.taskId === v.taskId);
      const merged = { ...v, feedbackTotal: v.feedbackTotal + fb.length, feedbackYes: v.feedbackYes + fb.filter((f) => f.matchedReality).length };
      if (taskKeys.includes(v.taskId)) out.set(v.taskId, merged);
      if (taskKeys.includes(v.slug)) out.set(v.slug, merged);
    }
    return out;
  }

  async getFeedback(runIds: string[]) {
    return new Map(runIds.filter((id) => this.feedback.has(id)).map((id) => [id, this.feedback.get(id)!]));
  }

  async insertFeedback(f: Omit<RunFeedback, "createdAt">) {
    if (this.feedback.has(f.runId)) return null;
    const row = { ...f, createdAt: new Date().toISOString() };
    this.feedback.set(f.runId, row);
    return row;
  }
}
