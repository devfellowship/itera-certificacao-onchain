import { Router } from "express";
import { commitMarkdownFile, ManifestsRepoError } from "../domain/manifests-repo.js";
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

    // Doc-adjacent: also commits the public-facing part of this request to the public
    // D0ingC0des/itera-agent-manifests repo as a .md file. requesterContact is deliberately left
    // OUT of the committed file — it stays in Postgres only. That repo is public; a contact
    // email/name has no business being published there just because the request was.
    let manifestCommitError: string | null = null;
    try {
      const fileContent = buildMarkdown(request.id, body.taskDescription, typeof body.requesterRole === "string" ? body.requesterRole : null);
      await commitMarkdownFile(
        `requests/${request.id}.md`,
        fileContent,
        `Evaluation request ${request.id}`,
      );
    } catch (e) {
      manifestCommitError = e instanceof ManifestsRepoError || e instanceof Error ? e.message : String(e);
    }

    res.status(201).json({ id: request.id, status: request.status, manifestCommitError });
  });

  return router;
}

function buildMarkdown(id: string, taskDescription: string, requesterRole: string | null): string {
  const lines = [
    `# Evaluation request ${id}`,
    "",
    `Submitted: ${new Date().toISOString()}`,
    requesterRole ? `Requester role: ${requesterRole}` : null,
    "",
    "## What should the agent demonstrate?",
    "",
    taskDescription,
    "",
  ].filter((line): line is string => line !== null);
  return lines.join("\n");
}
