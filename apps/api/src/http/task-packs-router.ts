import { Router } from "express";
import type { Repository } from "../domain/repository.js";

/**
 * GET /task-packs — public, read-only list of the task packs a vendor can pick for PreparePage's
 * "Task" field (apps/web). Only `webhook-ledger/1` is seeded today, but the field was a hardcoded
 * value in the UI — this lets new task packs show up automatically once seeded in the DB, instead
 * of needing a frontend code change every time.
 */
export function createTaskPacksRouter(repo: Repository): Router {
  const router = Router();

  router.get("/task-packs", async (_req, res) => {
    const taskPacks = await repo.listTaskPacks();
    res.json(taskPacks.map((pack) => ({ id: pack.id, version: pack.version })));
  });

  return router;
}
