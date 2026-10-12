import { Router, type Response } from "express";
import { CHAIN, IPFS_GATEWAY_URL, PUBLIC_WEB_BASE_URL, explorerAddressUrl, nftImageUrl } from "../chain/config.js";
import { renderNftPng, type NftImageInput } from "../chain/nft-image.js";
import { NotAnIteraProof, readOnChainProof, type OnChainProof } from "../chain/onchain-proof.js";

/**
 * Public NFT metadata + image for Itera proof NFTs (plan 20261012-itera-agent-proof-route-change-fixes, F5).
 *
 *   GET /nft/:mint.json — Metaplex-style metadata JSON; wallets and explorers fetch the mint's
 *                         TokenMetadata `uri`, which points here.
 *   GET /nft/:mint.png  — the generated image.
 *
 * Keyed by the NFT mint and built from chain data only (see chain/onchain-proof.ts): it needs no
 * database row, and it cannot show a score the chain does not hold. CORS is `*` because explorers
 * fetch these from the browser; both routes are read-only and side-effect free.
 */
export function createNftRouter(deps: { readProof?: (mint: string) => Promise<OnChainProof> } = {}): Router {
  const readProof = deps.readProof ?? ((mint: string) => readOnChainProof(mint));
  const router = Router();

  const load = async (mint: string, res: Response): Promise<OnChainProof | null> => {
    res.set("Access-Control-Allow-Origin", "*");
    try {
      return await readProof(mint);
    } catch (error) {
      if (error instanceof NotAnIteraProof) {
        res.status(404).json({ error: "not an Itera proof NFT", detail: error.message });
      } else {
        res.status(502).json({ error: "chain read failed", detail: error instanceof Error ? error.message : String(error) });
      }
      return null;
    }
  };

  router.get("/nft/:mint.json", async (req, res) => {
    const proof = await load(req.params.mint, res);
    if (!proof) return;
    res.set("Cache-Control", "public, max-age=300");
    res.json(nftMetadataJson(proof));
  });

  router.get("/nft/:mint.png", async (req, res) => {
    const proof = await load(req.params.mint, res);
    if (!proof) return;
    res.set("Cache-Control", "public, max-age=3600");
    res.type("image/png").send(renderNftPng(imageInput(proof)));
  });

  return router;
}

export function imageInput(proof: OnChainProof): NftImageInput {
  return {
    scoreTotal: proof.data.score_total,
    benchmark: proof.data.scenario_id,
    agent: proof.memo?.agent_repo ?? "unknown agent",
    model: proof.memo?.model_id ?? "unknown model",
    proofHash: proof.data.manifest_sha256,
  };
}

export function nftMetadataJson(proof: OnChainProof) {
  const { data, memo } = proof;
  const agent = memo?.agent_repo ?? "unknown";
  return {
    name: `${CHAIN.TOKEN_NAME} · ${data.scenario_id} · ${data.score_total}`,
    symbol: CHAIN.TOKEN_SYMBOL,
    description:
      `Itera agent proof. Agent ${agent} scored ${data.score_total}/100 on benchmark ${data.scenario_id}. ` +
      "Non-transferable Solana Attestation Service credential (schema run-result-v2). " +
      `Evidence: ipfs://${data.evidence_cid} (sha256 ${data.manifest_sha256}).`,
    image: nftImageUrl(proof.nftMint),
    external_url: `${PUBLIC_WEB_BASE_URL}/proof/${data.manifest_sha256}`,
    attributes: [
      { trait_type: "benchmark", value: data.scenario_id },
      { trait_type: "score", value: data.score_total, display_type: "number", max_value: 100 },
      { trait_type: "agent", value: agent },
      { trait_type: "model", value: memo?.model_id ?? "unknown" },
      ...(memo?.agent_commit ? [{ trait_type: "agent_commit", value: memo.agent_commit }] : []),
    ],
    properties: {
      category: "image",
      files: [{ uri: nftImageUrl(proof.nftMint), type: "image/png" }],
      attestation: proof.attestationAddress,
      attestation_explorer: explorerAddressUrl(proof.attestationAddress),
      evidence: `${IPFS_GATEWAY_URL}/${data.evidence_cid}`,
      manifest_sha256: data.manifest_sha256,
      run_start_sig: data.run_start_sig,
      run_id: memo?.run_id ?? null,
    },
  };
}
