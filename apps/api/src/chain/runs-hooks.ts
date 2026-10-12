/**
 * Adapters from lane D's chain functions to the hooks lane A's runs router injects
 * (`RunsRouterDeps.buildRunStartTx` and `RunsRouterDeps.proofIssuer`, domain/runs-store.ts).
 * Typed structurally so this file does not depend on the order in which the lanes merge.
 */
import { issueProof, ProofPreconditionError } from "./issue-proof.js";
import type { ProofStore } from "./proof-store.js";
import { buildRunStartTx } from "./run-start.js";

interface RunStartHookInput {
  runId: string;
  wallet: string;
  agentId: string;
  repoFullName: string | null;
  commitSha: string;
  model: string | null;
  benchmarkId: string;
  benchmarkVersion: string;
}

interface TaskPackLike {
  fixtureDigest: string | null;
  evaluatorRef: string;
}

/** `getTaskPack` = Repository.getTaskPack (task_packs carries the fixture digest and evaluator ref). */
export function runStartHook(
  getTaskPack: (id: string, version: string) => Promise<TaskPackLike | null>,
) {
  return async (
    input: RunStartHookInput,
  ): Promise<{ wireTransactionBase64: string; memo: string }> => {
    const pack = await getTaskPack(input.benchmarkId, input.benchmarkVersion);
    return buildRunStartTx({
      runId: input.runId,
      userWallet: input.wallet,
      agentRepo: input.repoFullName ?? `agent:${input.agentId}`,
      agentCommit: input.commitSha,
      modelId: input.model ?? "unknown",
      evaluatorCommit: pack?.evaluatorRef || "unknown",
      fixtureHash: pack?.fixtureDigest || "unknown",
      scenarioId: input.benchmarkId,
    });
  };
}

interface IssueHookInput {
  run: {
    id: string;
    ownerWallet: string | null;
    agentId: string | null;
    taskPackId: string;
    taskPackVersion: string;
    status: string;
    runStartSig: string | null;
    evidenceManifest: unknown | null;
    scoreTotal: number | null;
    evaluationId?: string | null;
    retryOfRunId?: string | null;
  };
  manifest: unknown;
  agentVersion: { agentId: string; commitSha: string } | null;
  agent: {
    id: string;
    repoFullName: string | null;
    model: string | null;
  } | null;
}

export function proofIssuerHook(store: ProofStore) {
  return {
    async issueProof(input: IssueHookInput) {
      const { run, agent, agentVersion } = input;
      let proof;
      try {
        proof = await issueProof(
          {
            runId: run.id,
            ownerWallet: run.ownerWallet,
            runStartSig: run.runStartSig,
            status: run.status,
            evidenceManifest: input.manifest ?? run.evidenceManifest,
            scoreTotal: run.scoreTotal,
            benchmarkId: run.taskPackId,
            benchmarkVersion: run.taskPackVersion,
            agentId: agent?.id ?? run.agentId,
            agentName: agent?.repoFullName ?? null,
            agentRepo: agent?.repoFullName ?? null,
            agentCommit: agentVersion?.commitSha ?? null,
            modelId: agent?.model ?? null,
            evaluationId: run.evaluationId ?? null,
            slotRunId: run.evaluationId ? (run.retryOfRunId ?? run.id) : null,
          },
          { store },
        );
      } catch (error) {
        if (!(error instanceof ProofPreconditionError)) throw error;
        return {
          proofHash: "",
          status: "failed" as const,
          nftMint: null,
          txSig: null,
          error: error.message,
        };
      }
      return {
        proofHash: proof.manifestSha256 ?? "",
        status: proof.status,
        nftMint: proof.nftMint,
        txSig: proof.txSig,
        error: proof.error,
      };
    },
  };
}
