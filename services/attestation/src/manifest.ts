/**
 * Narrow view of services/evaluator's EvidenceManifest — only the fields this schema anchors.
 * Duplicated here instead of imported to keep this package's on-chain surface decoupled from
 * the evaluator's internal types; update both if the manifest shape changes.
 */
export interface EvidenceManifestSummary {
  scenario_id: string;
  fixture_hash: string;
  patch_hash: string;
  score: { total: number };
  generated_at: string;
}

export interface AttestationData extends Record<string, unknown> {
  scenario_id: string;
  fixture_hash: string;
  patch_hash: string;
  score_total: number;
  generated_at: string;
}

/**
 * Maps an evidence manifest onto the on-chain schema's field shape. Pure and network-free —
 * the actual CreateAttestation call (src/client.ts) takes this output and serializes it against
 * the live on-chain Schema account.
 */
export function manifestToAttestationData(manifest: EvidenceManifestSummary): AttestationData {
  if (!Number.isInteger(manifest.score.total) || manifest.score.total < 0 || manifest.score.total > 100) {
    throw new Error(`score.total must be an integer 0-100 (SchemaDataType.U8); got ${manifest.score.total}`);
  }
  if (!manifest.scenario_id || !manifest.fixture_hash || !manifest.patch_hash || !manifest.generated_at) {
    throw new Error('manifest is missing a required field for attestation (scenario_id/fixture_hash/patch_hash/generated_at)');
  }

  return {
    scenario_id: manifest.scenario_id,
    fixture_hash: manifest.fixture_hash,
    patch_hash: manifest.patch_hash,
    score_total: manifest.score.total,
    generated_at: manifest.generated_at,
  };
}
