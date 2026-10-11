import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { Repository } from "../domain/repository.js";
import { requireOperator } from "./require-operator.js";

interface CreateEvaluationBody {
  idempotencyKey?: unknown;
  vendor?: { displayName?: unknown };
  agent?: { name?: unknown; endpointUrl?: unknown };
  release?: { releaseRef?: unknown; declaredConfigDigest?: unknown };
  task?: { id?: unknown; version?: unknown };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * POST /evaluations · GET /evaluations/:id/events · POST /evaluations/:id/publish — the
 * vendor-side surfaces from the doc ("1 · Preparar avaliação" and "2 · Execução e publicação").
 * All three require the operator key (see require-operator.ts); none of this is buyer-facing.
 */
export function createEvaluationsRouter(repo: Repository): Router {
  const router = Router();
  // Scoped to /evaluations specifically — a path-less router.use(requireOperator) would run for
  // every request that reaches this router, and since app.ts mounts this router at the app root
  // with no prefix, that would intercept /credentials/* and /evaluation-requests too (caught by
  // this exact bug during testing: every other router's route returned 401 before ever running).
  router.use("/evaluations", requireOperator);

  // Doc section 4, step 1-3: "Fornecedor escolhe pack, declara release... registra pedido
  // idempotente" + "API congela taskVersion... Orquestrador envia desafio com runId, nonce...".
  // This endpoint only does the freeze-and-register half. Actually dispatching the challenge to
  // the vendor's HTTPS endpoint and running the grader is a separate, not-yet-built step (needs
  // services/evaluator wired in as a callable dependency) — a run is created here in `pending`
  // status and stays there until that dispatch step exists.
  router.post("/evaluations", async (req, res) => {
    const body = req.body as CreateEvaluationBody;
    if (!isNonEmptyString(body.idempotencyKey)) {
      res.status(400).json({ error: "idempotencyKey is required" });
      return;
    }
    if (!isNonEmptyString(body.vendor?.displayName)) {
      res.status(400).json({ error: "vendor.displayName is required" });
      return;
    }
    if (!isNonEmptyString(body.agent?.name) || !isNonEmptyString(body.agent?.endpointUrl)) {
      res.status(400).json({ error: "agent.name and agent.endpointUrl are required" });
      return;
    }
    let endpointUrl: URL;
    try {
      endpointUrl = new URL(body.agent!.endpointUrl as string);
    } catch {
      res.status(400).json({ error: "agent.endpointUrl must be a valid URL" });
      return;
    }
    if (endpointUrl.protocol !== "https:") {
      // Doc section 4, "Rede e execução": HTTPS allowlisted only, never arbitrary/plaintext.
      res.status(400).json({ error: "agent.endpointUrl must use https" });
      return;
    }
    if (!isNonEmptyString(body.release?.releaseRef)) {
      res.status(400).json({ error: "release.releaseRef is required" });
      return;
    }
    if (!isNonEmptyString(body.task?.id) || !isNonEmptyString(body.task?.version)) {
      res.status(400).json({ error: "task.id and task.version are required" });
      return;
    }

    const idempotencyKey = body.idempotencyKey as string;
    const existingRun = await repo.findRunByIdempotencyKey(idempotencyKey);
    if (existingRun) {
      res.status(200).json(toRunResponse(existingRun));
      return;
    }

    const taskPack = await repo.getTaskPack(body.task!.id as string, body.task!.version as string);
    if (!taskPack) {
      res.status(404).json({ error: `unknown task pack ${body.task!.id}/${body.task!.version}` });
      return;
    }

    const vendor = await repo.findOrCreateVendor({ displayName: body.vendor!.displayName as string });
    const agent = await repo.findOrCreateAgent({
      vendorId: vendor.id,
      name: body.agent!.name as string,
      endpointUrl: endpointUrl.toString(),
    });
    const release = await repo.findOrCreateReleaseDeclaration({
      agentId: agent.id,
      releaseRef: body.release!.releaseRef as string,
      declaredConfigDigest: isNonEmptyString(body.release?.declaredConfigDigest)
        ? (body.release!.declaredConfigDigest as string)
        : null,
    });

    const run = await repo.createRun({
      releaseDeclarationId: release.id,
      taskPackId: taskPack.id,
      taskPackVersion: taskPack.version,
      nonce: randomUUID(),
      idempotencyKey,
    });
    res.status(201).json(toRunResponse(run));
  });

  router.get("/evaluations/:id/events", async (req, res) => {
    const run = await repo.getRun(req.params.id);
    if (!run) {
      res.status(404).json({ error: "run not found" });
      return;
    }
    const events = await repo.listObservations(run.id);
    res.json({
      runId: run.id,
      status: run.status,
      events: events.map((e) => ({
        id: e.id,
        requestDigest: e.requestDigest,
        responseDigest: e.responseDigest,
        outputArtifactRef: e.outputArtifactRef,
        mode: e.mode,
        occurredAt: e.occurredAt,
      })),
    });
  });

  // Doc section 4, step 7: "Plataforma fecha manifesto redigido... nenhum campo de resultado pode
  // ser editado" — each publish call appends a new claim_manifests row, never updates one in
  // place. Requires the run to already be resolved (status != pending): publishing an unresolved
  // run would mean the operator asserting a result nothing actually graded, which the doc
  // explicitly rules out ("resultado fiel").
  router.post("/evaluations/:id/publish", async (req, res) => {
    const run = await repo.getRun(req.params.id);
    if (!run) {
      res.status(404).json({ error: "run not found" });
      return;
    }
    if (run.status === "pending") {
      res.status(409).json({ error: "run has not been resolved yet; nothing to publish" });
      return;
    }
    const body = req.body as { criteriaResults?: unknown; limitations?: unknown };
    if (!Array.isArray(body.criteriaResults)) {
      res.status(400).json({ error: "criteriaResults must be an array" });
      return;
    }
    const manifest = await repo.publishClaimManifest({
      runId: run.id,
      taskRef: `${run.taskPackId}/${run.taskPackVersion}`,
      releaseRef: run.releaseDeclarationId,
      criteriaResults: body.criteriaResults as never,
      limitations: typeof body.limitations === "string" ? body.limitations : null,
    });
    res.status(201).json({
      claimManifestId: manifest.id,
      canonicalDigestSha256: manifest.canonicalDigestSha256,
      publishedAt: manifest.publishedAt,
    });
  });

  return router;
}

function toRunResponse(run: {
  id: string;
  nonce: string;
  status: string;
  taskPackId: string;
  taskPackVersion: string;
}) {
  return {
    runId: run.id,
    nonce: run.nonce,
    status: run.status,
    task: { id: run.taskPackId, version: run.taskPackVersion },
  };
}
