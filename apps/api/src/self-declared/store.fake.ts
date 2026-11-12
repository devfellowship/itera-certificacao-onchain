/** In-memory SelfDeclaredStore for router tests: the same checks, in the same order, as store.pg.ts. */
import type { LocalResult, LocalResultV2 } from "@itera/contracts";
import { agentVersionSha256 } from "@itera/contracts";
import {
  SelfDeclaredError,
  resultDigest as digestOf,
  runIdV2,
  runStatusV2,
  selfDeclaredIdV2,
  stableUuid,
  type ImportOptionsV2,
  type ImportOutcomeV2,
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
  /** v2: case key → { id, baseline variant id }. A case binds no agent (parent plan ADR-26). */
  cases = new Map<string, { id: string; baselineVariantId: string | null }>();
  /** v2: agent variant key (tenant, principal, base agent digest, diff digest) → { id, change kind }. Independent of a case. */
  variants = new Map<string, { id: string; changeKind: string }>();
  /** v2: evaluation id → run id → { digest, seq, status, graderRows, steps }. */
  v2Runs = new Map<string, Map<string, { digest: string; seq: number; status: string; graderRows: number; steps: number }>>();
  /** The tenant of the last v2 import (the router passes it). */
  lastTenant: string | null = null;

  /** The same checks, in the same order, as PgSelfDeclaredStore.importResultV2 (the v1 checks first). */
  async importResultV2(principal: string, r: LocalResultV2, options: ImportOptionsV2): Promise<ImportOutcomeV2> {
    if (this.failWith) throw this.failWith;
    this.lastTenant = options.tenant;
    const v1 = await this.importResult(principal, r as unknown as LocalResult, { ...options, dryRun: true });
    const caseKey = `${options.tenant}|${principal}|${r.case.case_key}|${r.case.manifest_sha256}`;
    const kase = { ...(this.cases.get(caseKey) ?? { id: stableUuid(`case:${caseKey}`), baselineVariantId: null }) };
    const variantKey = `${options.tenant}|${principal}|${agentVersionSha256(r.variant.agent)}|${r.variant.variant_sha256}`;
    const variant = this.variants.get(variantKey) ?? { id: stableUuid(`variant:${variantKey}`), changeKind: r.variant.change_kind };
    if (variant.changeKind !== r.variant.change_kind) {
      throw new SelfDeclaredError(409, "variant_conflict", "this agent variant exists with another change kind");
    }
    if (r.comparison.is_baseline) {
      if (kase.baselineVariantId && kase.baselineVariantId !== variant.id) {
        throw new SelfDeclaredError(409, "baseline_exists", "this case already has a baseline");
      }
      kase.baselineVariantId = variant.id;
    } else if (kase.baselineVariantId === variant.id) {
      throw new SelfDeclaredError(409, "variant_conflict", "this agent variant is the baseline of the case: upload it with comparison.is_baseline true");
    }
    const id = selfDeclaredIdV2(principal, r);
    const runs = new Map(this.v2Runs.get(id) ?? []);
    const counts = { inserted: 0, updated: 0, unchanged: 0 };
    let seq = Math.max(0, ...[...runs.values()].map((x) => x.seq));
    for (const run of r.runs) {
      const rid = runIdV2(id, run);
      const digest = digestOf(run);
      const prev = runs.get(rid);
      if (prev && prev.digest === digest) {
        counts.unchanged++;
        continue;
      }
      if (prev) counts.updated++;
      else counts.inserted++;
      runs.set(rid, {
        digest, seq: prev?.seq ?? ++seq, status: runStatusV2(r, run),
        graderRows: (prev?.graderRows ?? 0) + run.graders.length, steps: run.trajectory?.steps.length ?? 0,
      });
    }
    const existed = this.v2Runs.has(id);
    const action = !existed ? "inserted" : counts.inserted + counts.updated === 0 ? "unchanged" : "updated";
    if (action === "inserted") {
      const since = this.now() - 24 * 3600 * 1000;
      const n = [...this.rows.values()].filter((x) => x.owner === principal && x.createdAt > since).length + [...this.v2Runs.keys()].length;
      if (n >= options.perDay) throw new SelfDeclaredError(429, "self_declared_quota", `at most ${options.perDay} self-declared results per 24 h`);
    }
    if (!options.dryRun && action !== "unchanged") {
      this.variants.set(variantKey, variant);
      this.cases.set(caseKey, kase);
      this.v2Runs.set(id, runs);
    }
    const ordered = [...runs.entries()].sort((a, b) => a[1].seq - b[1].seq);
    const graded = ordered.filter(([, x]) => x.status !== "infra_error");
    return {
      evaluationId: id, caseId: kase.id, variantId: variant.id, runIds: ordered.map(([rid]) => rid), action, runs: counts,
      outcome: graded.length > 0 && graded.every(([, x]) => x.status === "pass") ? "pass" : "fail",
      taskId: v1.taskId, taskVersionId: v1.taskVersionId, dryRun: options.dryRun,
    };
  }

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
