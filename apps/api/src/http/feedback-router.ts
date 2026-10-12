import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { FEEDBACK_NOTE_MAX, FEEDBACK_RUN_STATUSES } from "../domain/reputation.js";
import { provenanceView, reputationOf, type ReputationStore } from "../domain/reputation-store.js";
import { optionalWallet, requireWallet as defaultRequireWallet } from "./auth.js";

/**
 * U27 — run feedback and task reputation (db/migrations/0010_reputation.sql).
 *
 *   POST /runs/:id/feedback {matchedReality: boolean, note?: string}   run owner, one per run
 *        201 {feedback, taskReputation} | 400 | 401 | 403 | 404 | 409 (not finished / already answered)
 *   GET  /runs/:id/feedback                                             run owner → {feedback|null, provenance}
 *   GET  /tasks/:idOrSlug/reputation      public for curated tasks, author-only for a user task → {taskId, slug, distinctWallets,
 *        runs, feedbackCount, feedbackYesRate, weight, curatedByItera}
 */
export interface FeedbackRouterDeps {
  store: ReputationStore;
  requireWallet?: RequestHandler;
  optionalWallet?: RequestHandler;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TASK_KEY_RE = /^[A-Za-z0-9._-]{1,100}$/;

const handle =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

export function createFeedbackRouter(deps: FeedbackRouterDeps): Router {
  const { store } = deps;
  const requireWallet = deps.requireWallet ?? defaultRequireWallet;
  const router = Router();

  router.post(
    "/runs/:id/feedback",
    requireWallet,
    handle(async (req, res) => {
      const id = String(req.params.id);
      const run = UUID_RE.test(id) ? (await store.runProvenance([id])).get(id) : undefined;
      if (!run) {
        res.status(404).json({ error: "run not found" });
        return;
      }
      if (!run.runOwnerWallet || run.runOwnerWallet !== req.wallet) {
        res.status(403).json({ error: "only the owner of the run can give feedback" });
        return;
      }
      if (!FEEDBACK_RUN_STATUSES.has(run.runStatus)) {
        res.status(409).json({ error: `run is ${run.runStatus}; feedback needs a finished, graded run`, code: "not_finished" });
        return;
      }
      const body = (req.body ?? {}) as { matchedReality?: unknown; note?: unknown };
      if (typeof body.matchedReality !== "boolean") {
        res.status(400).json({ error: "matchedReality must be a boolean" });
        return;
      }
      if (body.note !== undefined && body.note !== null && typeof body.note !== "string") {
        res.status(400).json({ error: "note must be a string" });
        return;
      }
      const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;
      if (note && note.length > FEEDBACK_NOTE_MAX) {
        res.status(400).json({ error: `note must be at most ${FEEDBACK_NOTE_MAX} characters` });
        return;
      }
      const saved = await store.insertFeedback({ runId: run.runId, wallet: req.wallet!, taskId: run.taskId, matchedReality: body.matchedReality, note });
      if (!saved) {
        const existing = (await store.getFeedback([run.runId])).get(run.runId) ?? null;
        res.status(409).json({ error: "this run already has feedback (one per run)", code: "already_answered", feedback: existing });
        return;
      }
      const rep = run.taskId ? ((await reputationOf(store, [run.taskId])).get(run.taskId) ?? null) : null;
      res.status(201).json({ feedback: saved, taskReputation: rep });
    }),
  );

  router.get(
    "/runs/:id/feedback",
    requireWallet,
    handle(async (req, res) => {
      const id = String(req.params.id);
      const run = UUID_RE.test(id) ? (await store.runProvenance([id])).get(id) : undefined;
      if (!run) {
        res.status(404).json({ error: "run not found" });
        return;
      }
      if (run.runOwnerWallet !== req.wallet) {
        res.status(403).json({ error: "only the owner of the run can read its feedback" });
        return;
      }
      const feedback = (await store.getFeedback([id])).get(id) ?? null;
      res.json({ feedback, canAnswer: !feedback && FEEDBACK_RUN_STATUSES.has(run.runStatus), provenance: provenanceView(run) });
    }),
  );

  router.get(
    "/tasks/:idOrSlug/reputation",
    deps.optionalWallet ?? optionalWallet,
    handle(async (req, res) => {
      const key = String(req.params.idOrSlug);
      const rep = TASK_KEY_RE.test(key) ? (await reputationOf(store, [key])).get(key) : undefined;
      // A user task is private (0007 tasks_user_owner_check): only its author sees its reputation.
      if (!rep || (!rep.curatedByItera && rep.ownerWallet !== null && rep.ownerWallet !== req.wallet)) {
        res.status(404).json({ error: "task not found" });
        return;
      }
      res.json(rep);
    }),
  );

  return router;
}
