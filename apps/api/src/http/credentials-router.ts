import type { Address } from "@solana/kit";
import { Router } from "express";
import { digestOf } from "../domain/digest.js";
import type { Repository } from "../domain/repository.js";
import { verifyOnChain } from "../domain/solana-attestation.js";

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

  // Doc section 7, "Checks do consumidor": confirm program owner, confirm credential/schema
  // against a trust store, recompute the digest. Both halves are real now — local (recomputing
  // the manifest's own digest, same check apps/web/src/verify.ts and the Tainan prototype's own
  // `digest()` do) and on-chain (domain/solana-attestation.ts's verifyOnChain, a live RPC read
  // against the known Credential/Schema addresses, never trusting the manifest's own claim about
  // itself). If no attestation was ever issued for this claim, the on-chain check reports
  // `unavailable` honestly rather than failing or faking a pass.
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

    const checks = [
      {
        id: "manifest_digest_matches",
        status: manifestDigestMatches ? "pass" : "fail",
        detail: manifestDigestMatches
          ? "Recomputed digest matches the digest stored at publish time."
          : "Recomputed digest does not match the stored digest.",
      },
    ];

    if (!envelope?.attestationAddress) {
      checks.push({
        id: "attestation_owner_and_schema",
        status: "unavailable",
        detail: "No on-chain attestation was issued for this claim.",
      });
    } else {
      try {
        const onChain = await verifyOnChain(envelope.attestationAddress as Address);
        const allMatch = onChain.exists && onChain.ownedBySasProgram && onChain.credentialMatches && onChain.schemaMatches;
        checks.push({
          id: "attestation_owner_and_schema",
          status: allMatch ? "pass" : "fail",
          detail: !onChain.exists
            ? "Attestation account not found on devnet."
            : !onChain.ownedBySasProgram
              ? "Attestation account is not owned by the Solana Attestation Service program."
              : !onChain.credentialMatches
                ? "Attestation references an unexpected credential."
                : !onChain.schemaMatches
                  ? "Attestation references an unexpected schema."
                  : `Verified on-chain: credential, schema, and program owner all match. Decoded score ${onChain.decoded?.score_total ?? "?"}.`,
        });
      } catch (e) {
        checks.push({
          id: "attestation_owner_and_schema",
          status: "unavailable",
          detail: `RPC read failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }

    res.json({ claimManifestId: manifest.id, registryStatus: envelope?.status ?? "not_issued", checks });
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
