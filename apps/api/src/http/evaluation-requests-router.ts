import { Router } from "express";
import type { Repository } from "../domain/repository.js";

const MAX_DESCRIPTION_LENGTH = 4000;

/**
 * POST /evaluation-requests — the "Solicitar teste na minha tarefa" intake (doc section 5: "No
 * MVP, permitir solicitar a adaptação e descrever o caso sem enviar código ou segredo pelo
 * formulário público"). Public, rate-limited by the global middleware in app.ts. No code/secret
 * scanning here — that constraint is a UI-copy rule for the form, not something this API can
 * reliably detect server-side; the length cap is the one objective guard against an abusive
 * payload.
 */
export function createEvaluationRequestsRouter(repo: Repository): Router {
  const router = Router();

  router.post("/evaluation-requests", async (req, res) => {
    const body = req.body as { requesterContact?: unknown; requesterRole?: unknown; taskDescription?: unknown };
    if (typeof body.requesterContact !== "string" || body.requesterContact.trim().length === 0) {
      res.status(400).json({ error: "requesterContact is required" });
      return;
    }
    if (typeof body.taskDescription !== "string" || body.taskDescription.trim().length === 0) {
      res.status(400).json({ error: "taskDescription is required" });
      return;
    }
    if (body.taskDescription.length > MAX_DESCRIPTION_LENGTH) {
      res.status(400).json({ error: `taskDescription must be ${MAX_DESCRIPTION_LENGTH} characters or fewer` });
      return;
    }
    const request = await repo.createEvaluationRequest({
      requesterContact: body.requesterContact,
      requesterRole: typeof body.requesterRole === "string" ? body.requesterRole : null,
      taskDescription: body.taskDescription,
    });
    res.status(201).json({ id: request.id, status: request.status });
  });

  return router;
}
