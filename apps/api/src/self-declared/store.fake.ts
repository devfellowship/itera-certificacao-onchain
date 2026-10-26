/** In-memory SelfDeclaredStore for router tests: the same checks, in the same order, as store.pg.ts. */
import type { LocalResult } from "@itera/contracts";
import {
  SelfDeclaredError,
  modelLookup,
  outcomeOf,
  resultDigest,
  selfDeclaredId,
  type ImportAction,
  type ImportOptions,
  type ImportOutcome,
  type SelfDeclaredStore,
} from "./store.js";

export interface FakeSelfDeclaredRow {
  id: string;
  owner: string;
  agentId: string;
  digest: string;
  createdAt: number;
  score: number;
  result: LocalResult;
}

export class FakeSelfDeclaredStore implements SelfDeclaredStore {
  /** agent id → owner principal (and whether it has a version). */
  agents = new Map<string, { owner: string; hasVersion: boolean }>();
  /** OpenRouter ids in public.models. */
  models = new Set<string>();
  /** `${owner}|${modelId}` of user_models. */
  customModels = new Set<string>();
  /** Catalog tasks by slug. */
  tasks = new Map<string, { id: string; visibility: "public" | "private"; owner: string | null; versions: number[]; local?: boolean }>();
  rows = new Map<string, FakeSelfDeclaredRow>();
  now = () => Date.now();
  /** Set to throw this error from importResult (e.g. a SchemaNotReadyError). */
  failWith: Error | null = null;

  async importResult(principal: string, r: LocalResult, options: ImportOptions): Promise<ImportOutcome> {
    if (this.failWith) throw this.failWith;
    const id = selfDeclaredId(principal, r);
    const agent = this.agents.get(r.agent_id);
    if (!agent || agent.owner !== principal) throw new SelfDeclaredError(404, "agent_not_found", "agent not found");
    const m = r.executor.model_id;
    const lookup = modelLookup(m);
    if (!this.customModels.has(`${principal}|${m}`) && !("known" in lookup) && !this.models.has(lookup.catalogId)) {
      throw new SelfDeclaredError(400, "unknown_model", `unknown model ${m}`);
    }
    let taskId: string;
    if ("catalog" in r.task) {
      const t = this.tasks.get(r.task.catalog.slug);
      if (!t || (t.visibility !== "public" && t.owner !== principal)) throw new SelfDeclaredError(404, "task_not_found", "task not found");
      if (!t.versions.includes(r.task.catalog.version)) throw new SelfDeclaredError(404, "task_version_not_found", "task version not found");
      taskId = t.id;
    } else {
      const slug = r.task.local.slug;
      const t = this.tasks.get(slug);
      if (t && (t.owner !== principal || !t.local)) throw new SelfDeclaredError(409, "task_slug_taken", `task slug ${slug} is taken`);
      const created = t ?? { id: `task-${slug}`, visibility: "private" as const, owner: principal, versions: [1], local: true };
      if (!options.dryRun) this.tasks.set(slug, created);
      taskId = created.id;
    }
    if (!agent.hasVersion) throw new SelfDeclaredError(409, "agent_has_no_version", "the agent has no version yet");
    const digest = resultDigest(r);
    const prev = this.rows.get(id);
    const action: ImportAction = !prev ? "inserted" : prev.digest === digest ? "unchanged" : "updated";
    const out: ImportOutcome = { evaluationId: id, runId: id, action, outcome: outcomeOf(r), taskId, taskVersionId: `${taskId}-v1`, dryRun: options.dryRun };
    if (action === "inserted") {
      const since = this.now() - 24 * 3600 * 1000;
      const n = [...this.rows.values()].filter((x) => x.owner === principal && x.createdAt > since).length;
      if (n >= options.perDay) throw new SelfDeclaredError(429, "self_declared_quota", `at most ${options.perDay} self-declared results per 24 h`);
    }
    if (action !== "unchanged" && !options.dryRun) {
      this.rows.set(id, { id, owner: principal, agentId: r.agent_id, digest, createdAt: prev?.createdAt ?? this.now(), score: r.summary.score, result: r });
    }
    return out;
  }
}
