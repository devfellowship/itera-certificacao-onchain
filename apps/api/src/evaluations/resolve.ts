/**
 * The shared part of an evaluation request (plan 20261015-testmyagent-web2-client, ADR-6): the body
 * check, the agent and task resolution, the compatibility check and the daily run limit. The quote
 * route (both payment kinds) and the free path's settle step use it. The messages and status codes
 * are the ones of the original quote route.
 */
import type { Compatibility } from "@itera/contracts";
import type { AgentVersionRef } from "../domain/runs-store.js";
import type { PaymentOutcome } from "../payments/adapters/types.js";
import { compatibilityOf } from "./compatibility.js";
import type { EvaluationsConfig } from "./config.js";
import type { AgentForEval, EvalTask, EvaluationsStore } from "./store.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export type Checked<T> = ({ ok: true } & T) | { ok: false; outcome: PaymentOutcome };

const refuse = (status: number, body: unknown) => ({ ok: false as const, outcome: { status, body } });

/** `{agentId, taskIds[]}` of a quote or a free evaluation. No store read. */
export function parseEvaluationRequest(rawBody: unknown, config: EvaluationsConfig): Checked<{ agentId: string; taskIds: string[] }> {
  const body = (rawBody ?? {}) as { agentId?: unknown; taskIds?: unknown };
  if (!isNonEmptyString(body.agentId) || !UUID_RE.test(body.agentId)) return refuse(400, { error: "agentId (uuid) is required" });
  const taskIds = Array.isArray(body.taskIds) ? [...new Set(body.taskIds.filter(isNonEmptyString).map((t) => t.trim()))] : [];
  if (taskIds.length === 0) return refuse(400, { error: "taskIds (non-empty array) is required" });
  if (taskIds.length > config.maxTasks) return refuse(400, { error: `at most ${config.maxTasks} tasks per evaluation` });
  return { ok: true, agentId: body.agentId, taskIds };
}

/**
 * The agent (owned or listed), its version, and the runnable, compatible tasks (in the requested
 * order); then the daily run limit of the principal.
 */
export async function resolveEvaluationRequest(
  store: EvaluationsStore,
  config: EvaluationsConfig,
  principalId: string,
  req: { agentId: string; taskIds: string[] },
): Promise<Checked<{ agent: AgentForEval; version: AgentVersionRef; tasks: EvalTask[] }>> {
  const agent = await store.getAgent(req.agentId);
  if (!agent || (agent.ownerWallet !== principalId && agent.visibility !== "listed")) return refuse(404, { error: "agent not found" });
  const version = await store.agentVersionFor(agent.id, agent.pinnedCommit);
  if (!version) return refuse(409, { error: "agent has no synced version yet — connect its repository first" });
  const tasks: EvalTask[] = [];
  const incompatible: Array<{ taskId: string; slug: string; reasons: Compatibility["reasons"] }> = [];
  for (const id of req.taskIds) {
    const t = await store.resolveTask(id);
    // U19: a private (user) task exists only for its owner.
    if (!t || (!t.isPublic && t.ownerWallet != null && t.ownerWallet !== principalId)) return refuse(404, { error: `unknown task ${id}` });
    if (!t.runnable) return refuse(409, { error: `task ${t.slug} is not runnable yet` });
    // ADR-11 / U28: an incompatible agent/task pair is refused here, before any payment or run.
    const c = compatibilityOf(agent, t);
    if (!c.compatible) incompatible.push({ taskId: t.taskId, slug: t.slug, reasons: c.reasons });
    const { runnable: _r, ownerWallet: _o, contract: _c, ...task } = t;
    tasks.push(task);
  }
  if (incompatible.length > 0) {
    return refuse(422, {
      error: `the agent is not compatible with ${incompatible.length === 1 ? `task ${incompatible[0]!.slug}` : `${incompatible.length} tasks`}: ${incompatible.flatMap((x) => x.reasons.map((r) => r.message)).join("; ")}`,
      code: "incompatible",
      incompatible,
    });
  }
  const recent = await store.countRecentRuns(principalId);
  if (recent + tasks.length > config.runsPerWalletPerDay) {
    return refuse(429, { error: `daily limit: ${config.runsPerWalletPerDay} runs per wallet per 24h (${recent} used)` });
  }
  return { ok: true, agent, version, tasks };
}
