/**
 * evaluation-issuer — an API interval job (plan P3). Each tick, for every open evaluation:
 *   1. Gate Q1: an infra_error run gets ONE free retry (a new queued run that replaces its slot).
 *   2. Every finished, graded run gets its proof through the existing issueProof (ITERA pays the
 *      issuance). The proof nonce is sha256(`${payment tx sig}:${slot run id}`) (chain/attestation.ts).
 *   3. The roll-up columns are stored for the lists (GET /evaluations, public profile).
 * No DB functions or triggers. One tick at a time.
 */
import { digestOf } from "../domain/digest.js";
import type { ProofIssuer, RunsStore } from "../domain/runs-store.js";
import { criteriaFromManifest, hasEvalLog } from "../http/runs-router.js";
import { AFTER_GRADED, paymentKindOf } from "../payments/adapters/index.js";
import { needsProof, rollup, slotsOf } from "./rollup.js";
import type { EvaluationsStore } from "./store.js";

export interface EvaluationIssuerDeps {
  store: EvaluationsStore;
  runs: RunsStore;
  proofIssuer?: ProofIssuer;
  /** A failed proof is retried at most this often. */
  proofRetryMs?: number;
  log?: (event: Record<string, unknown>) => void;
  now?: () => number;
}

export function createEvaluationIssuer(deps: EvaluationIssuerDeps) {
  const lastAttempt = new Map<string, number>();
  const retryMs = deps.proofRetryMs ?? 60_000;
  const log = deps.log ?? ((e) => console.log(JSON.stringify({ job: "evaluation-issuer", ...e })));
  const now = deps.now ?? Date.now;
  let running = false;

  async function processEvaluation(id: string): Promise<void> {
    const ev = await deps.store.getEvaluation(id);
    if (!ev) return;
    let runs = await deps.store.listRuns(id);

    // 1. Free retry (Gate Q1): once per slot, never after a cancel.
    if (!ev.cancelledAt) {
      for (const slot of slotsOf(runs)) {
        if (slot.run.status === "infra_error" && slot.attempts === 1) {
          const retry = await deps.store.insertFreeRetry(id, slot.run.id);
          if (retry) log({ event: "free_retry", evaluationId: id, failedRunId: slot.run.id, retryRunId: retry.id });
        }
      }
      runs = await deps.store.listRuns(id);
    }

    // 2. Proofs for finished runs.
    let proofs = await deps.store.listProofs(runs.map((r) => r.id));
    const proofIssuer = deps.proofIssuer;
    if (proofIssuer) {
      const byRun = new Map(proofs.map((p) => [p.runId, p]));
      // ADR-6: the payment adapter of the evaluation decides what follows a graded run
      // (solana_pay → the proof; free_byok → nothing).
      const afterGraded = AFTER_GRADED[paymentKindOf(ev)];
      for (const slot of slotsOf(runs)) {
        const r = slot.run;
        if (!needsProof(r)) continue;
        const p = byRun.get(r.id);
        await afterGraded({
          evaluationId: id,
          run: r,
          proof: p,
          issueProof: async () => {
            if (p?.status === "confirmed") {
              if (p) await deps.store.setProofEvaluation(r.id, id);
              return;
            }
            if (now() - (lastAttempt.get(r.id) ?? 0) < retryMs) return;
            lastAttempt.set(r.id, now());
            const run = await deps.runs.getRun(r.id);
            if (!run || !hasEvalLog(run.evidenceManifest)) return;
            const [agent, agentVersion] = await Promise.all([
              run.agentId ? deps.runs.getAgent(run.agentId) : Promise.resolve(null),
              run.agentVersionId ? deps.runs.getAgentVersion(run.agentVersionId) : Promise.resolve(null),
            ]);
            try {
              const result = await proofIssuer.issueProof({
                run: { ...run, evaluationId: id, retryOfRunId: r.retryOfRunId },
                manifest: run.evidenceManifest,
                manifestSha256: digestOf(run.evidenceManifest),
                criteria: criteriaFromManifest(run.evidenceManifest),
                agent,
                agentVersion,
              });
              await deps.store.setProofEvaluation(r.id, id);
              log({ event: "proof", evaluationId: id, runId: r.id, status: result.status, nftMint: result.nftMint ?? null, error: result.error ?? null });
            } catch (e) {
              log({ event: "proof_error", evaluationId: id, runId: r.id, error: e instanceof Error ? e.message : String(e) });
            }
          },
        });
      }
      proofs = await deps.store.listProofs(runs.map((r) => r.id));
    }

    // 3. Roll-up columns.
    const [agent, version] = await Promise.all([deps.store.getAgent(ev.agentId), deps.store.getAgentVersion(ev.agentVersionId)]);
    const { columns } = rollup({
      evaluation: ev,
      runs,
      proofs,
      agent: { name: agent?.name ?? "agent", slug: agent?.slug ?? null, repoFullName: agent?.repoFullName ?? null },
      agentCommit: version?.commitSha ?? null,
      nowMs: now(),
    });
    await deps.store.saveRollup(id, columns);
    if (columns.status !== ev.status) log({ event: "status", evaluationId: id, from: ev.status, to: columns.status });
  }

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      for (const id of await deps.store.listOpen(50)) {
        try {
          await processEvaluation(id);
        } catch (e) {
          log({ event: "error", evaluationId: id, error: e instanceof Error ? e.message : String(e) });
        }
      }
    } catch (e) {
      log({ event: "error", error: e instanceof Error ? e.message : String(e) });
    } finally {
      running = false;
    }
  }

  return {
    tick,
    processEvaluation,
    start(intervalMs = Number(process.env.ITERA_EVALUATION_ISSUER_INTERVAL_MS ?? 5_000)) {
      const timer = setInterval(() => void tick(), intervalMs);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}
