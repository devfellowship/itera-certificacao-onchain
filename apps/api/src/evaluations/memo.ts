import { canonicalStringify } from "../domain/digest.js";

/**
 * The one Memo of the payment tx (claude-main 2026-10-12: one wallet prompt per evaluation).
 * Text: `itera-eval:v1:` + canonical JSON. Run ids are 32-hex (no dashes) to keep the tx under
 * 1232 bytes. Its signature becomes runs.run_start_sig for every run of the evaluation; the proof
 * nonce of a run is sha256(`${sig}:${runId}`) (chain/attestation.ts proofNonceSeed).
 */
export const EVALUATION_MEMO_PREFIX = "itera-eval:v1:";

export interface EvaluationMemoInput {
  evaluationId: string;
  runIds: string[];
  agentRepo: string | null;
  agentCommit: string;
  modelId: string;
  /** `slug@version` per task, in run order. */
  tasks: string[];
}

export function buildEvaluationMemo(input: EvaluationMemoInput): string {
  return (
    EVALUATION_MEMO_PREFIX +
    canonicalStringify({
      evaluation_id: input.evaluationId,
      run_ids: input.runIds.map((id) => id.replace(/-/g, "")),
      agent_repo: input.agentRepo,
      agent_commit: input.agentCommit,
      model_id: input.modelId,
      tasks: input.tasks,
    })
  );
}

export function parseEvaluationMemo(text: string): { evaluationId: string; runIds: string[]; tasks: string[] } | null {
  if (!text.startsWith(EVALUATION_MEMO_PREFIX)) return null;
  try {
    const body = JSON.parse(text.slice(EVALUATION_MEMO_PREFIX.length)) as { evaluation_id?: unknown; run_ids?: unknown; tasks?: unknown };
    if (typeof body.evaluation_id !== "string" || !Array.isArray(body.run_ids)) return null;
    return {
      evaluationId: body.evaluation_id,
      runIds: body.run_ids.map((h) => {
        const s = String(h);
        return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
      }),
      tasks: Array.isArray(body.tasks) ? body.tasks.map(String) : [],
    };
  } catch {
    return null;
  }
}
