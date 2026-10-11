import { randomUUID } from "node:crypto";
import { Router } from "express";
import { digestOf } from "../domain/digest.js";
import { gradePatch, GraderError, type EvidenceManifest } from "../domain/grader.js";
import { assertPublicHttpsEndpoint, NetworkGuardError } from "../domain/network-guard.js";
import type { Repository } from "../domain/repository.js";
import { issueScoreAttestation, ITERA_CREDENTIAL_PDA, ITERA_SCORE_SCHEMA_PDA } from "../domain/solana-attestation.js";
import { requireOperator } from "./require-operator.js";

function isGradedEvidenceManifest(value: unknown): value is EvidenceManifest {
  return (
    typeof value === "object" &&
    value !== null &&
    "scenario_id" in value &&
    "fixture_hash" in value &&
    "patch_hash" in value &&
    "score" in value
  );
}

const DISPATCH_TIMEOUT_MS = 15_000;

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
 * POST /evaluations · POST /evaluations/:id/dispatch · GET /evaluations/:id/events ·
 * POST /evaluations/:id/publish — the vendor-side surfaces from the doc ("1 · Preparar avaliação"
 * and "2 · Execução e publicação"). All four require the operator key (see require-operator.ts);
 * none of this is buyer-facing.
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

  // Doc section 4, steps 3-6: "Orquestrador envia desafio... Endpoint retorna artefato...
  // Validador rejeita... Grader fora do agente aplica o artefato num alvo limpo e executa
  // assertions externas." Blocking/synchronous for this MVP — the doc's own architecture table
  // lists a dedicated worker/queue as a future component, not required for the 72h build; a real
  // grading run takes 15-90s (this repo's own evaluator test suite), so this request is slow by
  // design, not by accident.
  router.post("/evaluations/:id/dispatch", async (req, res) => {
    const run = await repo.getRun(req.params.id);
    if (!run) {
      res.status(404).json({ error: "run not found" });
      return;
    }
    if (run.status !== "pending") {
      res.status(409).json({ error: `run already resolved to ${run.status}` });
      return;
    }
    const release = await repo.getReleaseDeclaration(run.releaseDeclarationId);
    const agent = release ? await repo.getAgent(release.agentId) : null;
    if (!release || !agent) {
      res.status(500).json({ error: "run references a release/agent that no longer exists" });
      return;
    }

    const endpointUrl = new URL(agent.endpointUrl);
    try {
      await assertPublicHttpsEndpoint(endpointUrl);
    } catch (e) {
      if (e instanceof NetworkGuardError) {
        await repo.resolveRun({ runId: run.id, status: "infra_error", evidenceManifest: { error: e.message }, scoreTotal: 0 });
        res.status(502).json({ error: e.message });
        return;
      }
      throw e;
    }

    // Doc section 5, "Interface mínima com endpoint" — exact field set, outputContract fixed to
    // patch-v1 (the only contract this API's grader understands right now).
    const payload = {
      runId: run.id,
      nonce: run.nonce,
      task: { id: run.taskPackId, version: run.taskPackVersion },
      fixtureRef: `benchmarks/${run.taskPackId}/fixture`,
      deadlineAt: new Date(Date.now() + DISPATCH_TIMEOUT_MS).toISOString(),
      outputContract: "patch-v1",
    };

    let responseBody: { patch?: unknown };
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);
      try {
        const vendorResponse = await fetch(endpointUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        if (!vendorResponse.ok) {
          throw new Error(`endpoint responded with HTTP ${vendorResponse.status}`);
        }
        responseBody = (await vendorResponse.json()) as { patch?: unknown };
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      const isTimeout = e instanceof Error && e.name === "AbortError";
      await repo.resolveRun({
        runId: run.id,
        status: isTimeout ? "timeout" : "infra_error",
        evidenceManifest: { error: e instanceof Error ? e.message : String(e) },
        scoreTotal: 0,
      });
      res.status(isTimeout ? 504 : 502).json({ error: isTimeout ? "endpoint did not respond in time" : "endpoint request failed" });
      return;
    }

    if (typeof responseBody.patch !== "string") {
      await repo.resolveRun({
        runId: run.id,
        status: "invalid",
        evidenceManifest: { error: "endpoint response missing a string 'patch' field" },
        scoreTotal: 0,
      });
      res.status(422).json({ error: "endpoint response did not include a 'patch' string" });
      return;
    }
    const patch = responseBody.patch;

    await repo.createObservation({
      runId: run.id,
      requestDigest: digestOf(payload),
      responseDigest: digestOf(responseBody),
      outputArtifactContent: patch,
      mode: "observed",
    });

    let manifest;
    try {
      manifest = await gradePatch(run.taskPackId, patch);
    } catch (e) {
      const message = e instanceof GraderError ? e.message : e instanceof Error ? e.message : String(e);
      const resolved = await repo.resolveRun({
        runId: run.id,
        status: "infra_error",
        evidenceManifest: { error: message },
        scoreTotal: 0,
      });
      res.status(500).json({ error: `grader failed: ${message}`, run: toRunResponse(resolved) });
      return;
    }

    // Doc section 2, "Tela 4": Tarefa PASS/FAIL/INVALID/TIMEOUT/INFRA_ERROR — a scope violation
    // (patch_scope.allowed === false) is INVALID per the doc's own error-flow section ("Patch
    // proibido é INVALID"), not a FAIL with a zero score indistinguishable from a legitimately
    // failing patch.
    const status = !manifest.patch_scope.allowed
      ? "invalid"
      : manifest.errors.length > 0
        ? "infra_error"
        : manifest.score.total > 0
          ? "pass"
          : "fail";

    const resolved = await repo.resolveRun({ runId: run.id, status, evidenceManifest: manifest, scoreTotal: manifest.score.total });
    res.json(toRunResponse(resolved));
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
      scoreTotal: run.scoreTotal,
      evidenceManifest: run.evidenceManifest,
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

    // Doc section 9, Day 3: real SAS issuance anchors the published claim on-chain. Only possible
    // when a real grading run actually produced an EvidenceManifest — a timeout/infra_error run
    // has nothing but an {error} object (see the dispatch route above), so there is genuinely
    // nothing true to attest to; the envelope stays `not_issued` rather than attesting a fiction.
    let attestationError: string | null = null;
    if (isGradedEvidenceManifest(run.evidenceManifest)) {
      try {
        const issued = await issueScoreAttestation(manifest.id, run.evidenceManifest);
        await repo.recordAttestationEnvelope({
          claimManifestId: manifest.id,
          attestationAddress: issued.attestationAddress,
          issuerRef: ITERA_CREDENTIAL_PDA,
          schemaRef: ITERA_SCORE_SCHEMA_PDA,
          manifestDigest: manifest.canonicalDigestSha256 ?? "",
          status: "confirmed",
        });
      } catch (e) {
        // A failed issuance (RPC down, insufficient devnet SOL, etc.) must not fail the publish
        // itself — the claim manifest is still a valid, redacted record either way. Reported back
        // so the operator knows the on-chain anchor didn't happen, not silently swallowed.
        attestationError = e instanceof Error ? e.message : String(e);
      }
    }

    res.status(201).json({
      claimManifestId: manifest.id,
      canonicalDigestSha256: manifest.canonicalDigestSha256,
      attestationError,
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
