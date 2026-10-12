/**
 * Pre-run compatibility of an agent with a task (ADR-11, U28). The agent's `requires` (chip field
 * of screen 02, agents.requires, 0011) must be offered by the task's tool environment. Checked:
 *   - GET /tasks/:idOrSlug/compatibility?agentId=   optional auth (owner, or a listed agent)
 *   - POST /evaluations/quote                       422 before any payment (router.ts)
 */
import { checkCompatibility, type Compatibility, type ToolEnvironment } from "@itera/contracts";
import { Router, type NextFunction, type Request, type Response } from "express";
import { SchemaNotReadyError } from "../domain/runs-store.js";
import { taskToolEnvironment } from "../domain/task-environment.js";
import { optionalWallet } from "../http/auth.js";
import type { AgentForEval, EvaluationsStore, ResolvedTask } from "./store.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function compatibilityOf(agent: Pick<AgentForEval, "requires">, task: Pick<ResolvedTask, "contract">): Compatibility & { environment: ToolEnvironment } {
  const environment = taskToolEnvironment(task);
  return { ...checkCompatibility(environment, agent.requires ?? []), environment };
}

/** What the agent sees of the environment: names and allowed tools, never images, seeds or secrets. */
export function environmentSummary(env: ToolEnvironment) {
  return {
    builtin: env.builtin,
    mcp: env.mcp.map((s) => ({ name: s.name, transport: s.transport, allowedTools: s.allowed_tools })),
    runEgress: env.run_egress,
  };
}

export function createCompatibilityRouter(deps: { store: EvaluationsStore }): Router {
  const router = Router();
  router.get("/tasks/:idOrSlug/compatibility", optionalWallet, (req: Request, res: Response, next: NextFunction) => {
    (async () => {
      const wallet = req.wallet ?? null;
      const agentId = typeof req.query.agentId === "string" ? req.query.agentId.trim() : "";
      if (!UUID_RE.test(agentId)) {
        res.status(400).json({ error: "agentId (uuid) is required" });
        return;
      }
      const task = await deps.store.resolveTask(String(req.params.idOrSlug));
      // A private task of another wallet is never shown (same 404 as GET /tasks/:idOrSlug).
      if (!task || (!task.isPublic && (wallet === null || task.ownerWallet !== wallet))) {
        res.status(404).json({ error: "task not found" });
        return;
      }
      const agent = await deps.store.getAgent(agentId);
      if (!agent || (agent.visibility !== "listed" && (wallet === null || agent.ownerWallet !== wallet))) {
        res.status(404).json({ error: "agent not found" });
        return;
      }
      const c = compatibilityOf(agent, task);
      res.json({
        taskId: task.taskId,
        slug: task.slug,
        agentId: agent.id,
        compatible: c.compatible,
        reasons: c.reasons,
        requires: agent.requires ?? [],
        environment: environmentSummary(c.environment),
      });
    })().catch((e: unknown) => {
      if (e instanceof SchemaNotReadyError) res.status(503).json({ error: e.message });
      else next(e);
    });
  });
  return router;
}
