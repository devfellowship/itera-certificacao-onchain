/**
 * issueProof(run) — Samuel's path, result half (plan 20261012-itera-agent-proof-route-change-fixes, F5):
 *   1. Build the public evidence document (redacted manifest + run binding), serialize it ONCE.
 *   2. manifest_sha256 = sha256(those bytes) = proofHash.
 *   3. Pin the bytes to IPFS (Pinata). No pinner → status `failed`, error `ipfs not configured`.
 *   4. CreateTokenizedAttestation `run-result-v2` to the owner wallet, nonce sha256(run_start_sig).
 *   5. Write the `proofs` row.
 *
 * Idempotent: a confirmed proof is returned as is. A failed or pending proof is retried. The
 * on-chain step is idempotent too (same nonce → same attestation PDA, see SasMinter).
 */
import { SasMinter, type Minter } from "./attestation.js";
import { buildEvidenceDocument, scenarioIdOf, scoreForChain } from "./evidence.js";
import { manifestBytes, pinnerFromEnv, sha256Hex, type Pinner } from "./ipfs.js";
import type { ProofRecord, ProofRun, ProofStore } from "./proof-store.js";

export const IPFS_NOT_CONFIGURED = "ipfs not configured";

export class ProofPreconditionError extends Error {}

export interface IssueProofDeps {
  store: ProofStore;
  /** undefined → from env (PINATA_JWT); null → not configured. */
  pinner?: Pinner | null;
  minter?: Minter;
}

/** A finished run with a graded manifest gets a proof; infra_error never has one. */
const PROOF_ELIGIBLE_STATUSES = new Set(["pass", "fail", "invalid", "timeout"]);

export async function issueProof(run: ProofRun, deps: IssueProofDeps): Promise<ProofRecord> {
  const { store } = deps;
  const existing = await store.getProofByRunId(run.runId);
  if (existing?.status === "confirmed") return existing;

  if (!PROOF_ELIGIBLE_STATUSES.has(run.status)) {
    throw new ProofPreconditionError(`run is ${run.status}; only a finished, graded run gets a proof`);
  }
  if (!run.ownerWallet) throw new ProofPreconditionError("run has no owner wallet");
  if (!run.runStartSig) throw new ProofPreconditionError("run has no run-start signature — sign the run-start Memo first");
  if (!run.evidenceManifest) throw new ProofPreconditionError("run has no evidence manifest");

  const bytes = manifestBytes(buildEvidenceDocument(run));
  const manifestSha256 = sha256Hex(bytes);
  const base = {
    runId: run.runId,
    ownerWallet: run.ownerWallet,
    manifestSha256,
    evidenceCid: existing?.evidenceCid ?? null,
    attestationAddress: null as string | null,
    nftMint: null as string | null,
    txSig: null as string | null,
  };

  const pinner = deps.pinner === undefined ? pinnerFromEnv() : deps.pinner;
  if (!base.evidenceCid) {
    if (!pinner) return store.upsertProof({ ...base, status: "failed", error: IPFS_NOT_CONFIGURED });
    try {
      base.evidenceCid = (await pinner.pin(bytes, `itera-evidence-${run.runId}.json`)).cid;
    } catch (error) {
      return store.upsertProof({ ...base, status: "failed", error: `ipfs pin failed: ${message(error)}` });
    }
  }

  const minter = deps.minter ?? new SasMinter();
  const addresses = await minter.addressesFor(run.runStartSig);
  // Record `pending` with the deterministic addresses before the tx, so a crash mid-mint leaves a
  // row that names the accounts to check.
  await store.upsertProof({ ...base, ...addresses, status: "pending", error: null });
  try {
    const minted = await minter.mint({
      recipient: run.ownerWallet,
      data: {
        manifest_sha256: manifestSha256,
        evidence_cid: base.evidenceCid,
        scenario_id: scenarioIdOf(run),
        score_total: scoreForChain(run),
        run_start_sig: run.runStartSig,
      },
    });
    return store.upsertProof({
      ...base,
      attestationAddress: minted.attestationAddress,
      nftMint: minted.nftMint,
      txSig: minted.txSig,
      status: "confirmed",
      error: null,
    });
  } catch (error) {
    return store.upsertProof({ ...base, ...addresses, status: "failed", error: `mint failed: ${message(error)}` });
  }
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}
