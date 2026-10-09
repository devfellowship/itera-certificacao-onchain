/**
 * Data mapping for the run-result-v2 schema (CONFIG.RUN_RESULT_SCHEMA in config.ts) — the
 * tokenized attestation that replaces the plain Attestation from manifest.ts/cli.ts (PR #11) as
 * the production on-chain record, per Samuel's brief. Separate file on purpose: manifest.ts's
 * mapping is for the old 5-field (scenario_id/fixture_hash/patch_hash/score_total/generated_at)
 * schema, still used by the working cli.ts path — not touched here.
 */
import type { PinnedManifest } from './ipfs.js';

export interface RunResultData extends Record<string, unknown> {
  manifest_sha256: string;
  evidence_cid: string;
  scenario_id: string;
  score_total: number;
  run_start_sig: string;
}

export interface BuildRunResultDataInput {
  pinned: PinnedManifest;
  scenarioId: string;
  scoreTotal: number;
  /** Signature of the run-start Memo transaction (services/attestation/src/spike-run-start-memo.ts
   * validates the mechanic; the real value comes from the server endpoint in build-order item 4's
   * remaining half). This is the field that binds the result to a specific, wallet-signed run
   * start — without it, nothing stops someone from publishing a result for a run that never
   * happened. */
  runStartSig: string;
}

export function buildRunResultData({ pinned, scenarioId, scoreTotal, runStartSig }: BuildRunResultDataInput): RunResultData {
  if (!Number.isInteger(scoreTotal) || scoreTotal < 0 || scoreTotal > 100) {
    throw new Error(`score_total must be an integer 0-100 (SchemaDataType.U8); got ${scoreTotal}`);
  }
  if (!scenarioId) throw new Error('scenarioId is required');
  if (!runStartSig) throw new Error('runStartSig is required — a run-result attestation must bind to a specific run-start tx');
  if (!pinned.cid || !pinned.manifestSha256) throw new Error('pinned manifest is missing cid/manifestSha256');

  return {
    manifest_sha256: pinned.manifestSha256,
    evidence_cid: pinned.cid,
    scenario_id: scenarioId,
    score_total: scoreTotal,
    run_start_sig: runStartSig,
  };
}
