/**
 * Reads a proof from chain only, by NFT mint: mint → TokenMetadata → attestation → run-result-v2
 * data → run-start Memo tx. The NFT metadata JSON and image are built from this, so they need no
 * database and say nothing the chain does not say.
 */
import { deserializeAttestationData, fetchMaybeAttestation, fetchMaybeSchema } from "@solana/attestation";
import { fetchMaybeMint } from "@solana-program/token-2022";
import { isAddress, type Address, type Rpc, type Signature, type SolanaRpcApi } from "@solana/kit";
import type { RunResultData } from "./attestation.js";
import { readRpc } from "./client.js";
import { CHAIN } from "./config.js";
import { parseRunStartMemo, type RunStartMemoPayload } from "./run-start.js";

export interface OnChainProof {
  nftMint: string;
  attestationAddress: string;
  data: RunResultData;
  memo: RunStartMemoPayload | null;
  /** The wallet that signed the run-start Memo (the NFT recipient). */
  userWallet: string | null;
}

export class NotAnIteraProof extends Error {}

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; value: OnChainProof }>();

export async function readOnChainProof(nftMint: string, rpc: Rpc<SolanaRpcApi> = readRpc()): Promise<OnChainProof> {
  const hit = cache.get(nftMint);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  if (!isAddress(nftMint)) throw new NotAnIteraProof("not a Solana address");

  const mint = await fetchMaybeMint(rpc, nftMint as Address);
  if (!mint.exists) throw new NotAnIteraProof("mint not found");
  const extensions = mint.data.extensions.__option === "Some" ? mint.data.extensions.value : [];
  const metadata = extensions.find((e) => e.__kind === "TokenMetadata");
  if (!metadata || metadata.__kind !== "TokenMetadata") throw new NotAnIteraProof("mint has no token metadata");
  const attestationAddress = metadata.additionalMetadata.get("attestation");
  const schemaAddress = metadata.additionalMetadata.get("schema");
  if (!attestationAddress || schemaAddress !== CHAIN.RUN_RESULT_SCHEMA_PDA) throw new NotAnIteraProof("not an Itera run-result-v2 NFT");

  const attestation = await fetchMaybeAttestation(rpc, attestationAddress as Address);
  if (!attestation.exists || attestation.data.credential !== CHAIN.CREDENTIAL_PDA) throw new NotAnIteraProof("attestation is not from the Itera credential");
  const schema = await fetchMaybeSchema(rpc, CHAIN.RUN_RESULT_SCHEMA_PDA);
  if (!schema.exists) throw new NotAnIteraProof("schema not found");
  const data = deserializeAttestationData(schema.data, attestation.data.data) as RunResultData;

  let memo: RunStartMemoPayload | null = null;
  let userWallet: string | null = null;
  try {
    const tx = await rpc
      .getTransaction(data.run_start_sig as Signature, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" })
      .send();
    const message = tx?.transaction.message as
      | { accountKeys: Array<{ pubkey: string; signer: boolean }>; instructions: Array<{ program?: string; parsed?: unknown }> }
      | undefined;
    const memoIx = message?.instructions.find((ix) => ix.program === "spl-memo" && typeof ix.parsed === "string");
    memo = memoIx ? parseRunStartMemo(memoIx.parsed as string) : null;
    userWallet = message?.accountKeys.filter((k) => k.signer)[1]?.pubkey ?? null;
  } catch {
    // The public devnet RPC rate-limits getTransaction. The image and JSON still render from the
    // attestation data; agent/model show as unknown.
  }

  const value: OnChainProof = { nftMint, attestationAddress, data, memo, userWallet };
  cache.set(nftMint, { at: Date.now(), value });
  if (cache.size > 500) cache.delete(cache.keys().next().value as string);
  return value;
}
