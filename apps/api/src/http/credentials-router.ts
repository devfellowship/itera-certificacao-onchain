import { Router } from "express";
import { digestOf } from "../domain/digest.js";
import type { Repository } from "../domain/repository.js";

/**
 * GET /credentials/:id · /verify · /export — the buyer-facing surfaces (doc "3 · Credencial para
 * o cliente" and "4 · Verificador e consumo"). Public and read-only on purpose: no operator key,
 * matching the doc's "comprador externo... sem wallet obrigatória para a prova pública".
 */
export function createCredentialsRouter(repo: Repository): Router {
  const router = Router();

  router.get("/credentials/:id", async (req, res) => {
    const manifest = await repo.getPublicClaimManifest(req.params.id);
    if (!manifest) {
      res.status(404).json({ error: "credential not found" });
      return;
    }
    const envelope = await repo.getAttestationEnvelope(manifest.id);
    res.json(toCredentialResponse(manifest, envelope));
  });

  // Doc section 7, "Checks do consumidor". Only the checks this API can actually run without live
  // Solana RPC access are implemented for real right now: recomputing the manifest's own digest
  // and comparing it to what was stored at publish time (the same "local integrity" check
  // apps/web/src/verify.ts and the Tainan prototype's own `digest()` function do). The checks that
  // need a real attestation on-chain (program owner, credential/schema match, status/expiry) stay
  // "unavailable" until attestation issuance is wired into this API — reported as such, never
  // faked as passing.
  router.get("/credentials/:id/verify", async (req, res) => {
    const manifest = await repo.getPublicClaimManifest(req.params.id);
    if (!manifest) {
      res.status(404).json({ error: "credential not found" });
      return;
    }
    const envelope = await repo.getAttestationEnvelope(manifest.id);
    const recomputed = digestOf({
      task: manifest.taskRef,
      release: manifest.releaseRef,
      criteriaResults: manifest.criteriaResults,
      limitations: manifest.limitations,
    });
    const manifestDigestMatches = recomputed === manifest.canonicalDigestSha256;
    res.json({
      claimManifestId: manifest.id,
      registryStatus: envelope?.status ?? "not_issued",
      checks: [
        {
          id: "manifest_digest_matches",
          status: manifestDigestMatches ? "pass" : "fail",
          detail: manifestDigestMatches
            ? "Recomputed digest matches the digest stored at publish time."
            : "Recomputed digest does not match the stored digest.",
        },
        {
          id: "attestation_owner_and_schema",
          status: "unavailable",
          detail: "On-chain attestation issuance is not wired into this API yet.",
        },
      ],
    });
  });

  router.get("/credentials/:id/export", async (req, res) => {
    const manifest = await repo.getPublicClaimManifest(req.params.id);
    if (!manifest) {
      res.status(404).json({ error: "credential not found" });
      return;
    }
    const envelope = await repo.getAttestationEnvelope(manifest.id);
    res.setHeader("Content-Disposition", `attachment; filename="credential-${manifest.id}.json"`);
    res.json(toCredentialResponse(manifest, envelope));
  });

  return router;
}

function toCredentialResponse(
  manifest: {
    id: string;
    taskRef: string;
    releaseRef: string;
    criteriaResults: unknown;
    limitations: string | null;
    canonicalDigestSha256: string | null;
    publishedAt: string | null;
  },
  envelope: { network: string; attestationAddress: string | null; status: string } | null,
) {
  return {
    claimManifestId: manifest.id,
    task: manifest.taskRef,
    release: manifest.releaseRef,
    criteriaResults: manifest.criteriaResults,
    limitations: manifest.limitations,
    manifestDigestSha256: manifest.canonicalDigestSha256,
    publishedAt: manifest.publishedAt,
    registry: {
      network: envelope?.network ?? "solana-devnet",
      attestationAddress: envelope?.attestationAddress ?? null,
      status: envelope?.status ?? "not_issued",
    },
  };
}
