import type { Address } from "@solana/kit";

/**
 * Chain constants for Samuel's path (plan 20261012-itera-agent-proof-route-change-fixes, ADR-3).
 *
 * The Credential and the `run-result-v2` Schema below are the live devnet accounts created by
 * services/attestation/src/setup.ts. The schema is already tokenized (group mint
 * Dug65JpHtBrTqHezwrTTJyVETSxqV86fWB4uWkUZiwQo). The hot signer
 * (ITERA_HOT_SIGNER_KEYPAIR_B64 / _PATH, see ../config.ts) is an authorized signer of the
 * Credential and pays every fee on this path. apps/web/src/verify.ts pins the same two addresses.
 */
export const CHAIN = {
  CLUSTER: "devnet",
  RPC_URL: process.env.ITERA_SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
  WSS_URL: process.env.ITERA_SOLANA_WSS_URL ?? "wss://api.devnet.solana.com",
  CREDENTIAL_PDA: "Dh9NF2L2Ua2u4TUzKRX5u8S5DDCBLNA7aVkunteXt7A3" as Address,
  RUN_RESULT_SCHEMA_PDA: "3FGWK6AsxtXje8r4Eq3rq3GPdoRd3ifx5UN9oKm4w94x" as Address,
  TOKEN_NAME: "Itera Run Result",
  TOKEN_SYMBOL: "ITERA",
} as const;

/** Prefix of every run-start Memo. The rest of the memo is the JSON of RunStartMemoPayload. */
export const RUN_START_MEMO_PREFIX = "itera-run:v1:";

/** Public origin of this API — the NFT metadata URI and its image live under it. */
export const PUBLIC_API_BASE_URL = (
  process.env.ITERA_PUBLIC_API_BASE_URL ?? "https://itera-agent-credentials-api.devfellowship.com"
).replace(/\/+$/, "");

/** Public origin of the web app — the proof landing page (`/proof/:hash`) lives under it. */
export const PUBLIC_WEB_BASE_URL = (
  process.env.ITERA_PUBLIC_WEB_BASE_URL ?? "https://itera-agent-credentials.devfellowship.com"
).replace(/\/+$/, "");

/** Public IPFS gateway used for links and by apps/web/src/verify.ts check 4. */
export const IPFS_GATEWAY_URL = "https://gateway.pinata.cloud/ipfs";

export function explorerTxUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=${CHAIN.CLUSTER}`;
}

export function explorerAddressUrl(address: string): string {
  return `https://explorer.solana.com/address/${address}?cluster=${CHAIN.CLUSTER}`;
}

export function nftMetadataUri(nftMint: string): string {
  return `${PUBLIC_API_BASE_URL}/nft/${nftMint}.json`;
}

export function nftImageUrl(nftMint: string): string {
  return `${PUBLIC_API_BASE_URL}/nft/${nftMint}.png`;
}
