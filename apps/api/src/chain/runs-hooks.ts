/**
 * Adapters from lane D's chain functions to the hooks lane A's runs router injects
 * (`RunsRouterDeps.buildRunStartTx` and `RunsRouterDeps.proofIssuer`, domain/runs-store.ts).
 * Typed structurally so this file does not depend on the order in which the lanes merge.
 */
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
