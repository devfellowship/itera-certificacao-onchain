/**
 * CreateTokenizedAttestation for `run-result-v2` — the NFT. Logic from
 * services/attestation/src/client.ts (`createTokenizedAttestationFromRunResult`), moved into the
 * API with two changes:
 *   - the metadata URI is per mint: `${PUBLIC_API_BASE_URL}/nft/<mint>.json`. SAS takes `uri` on
 *     every CreateTokenizedAttestation call and writes it into that attestation mint's own
 *     TokenMetadata extension, so it is NOT fixed at the schema (group) level.
 *   - issuance is idempotent: when the attestation PDA for this nonce exists, it returns the
 *     existing accounts instead of failing on a second mint.
 */
import {
  fetchMaybeAttestation,
  fetchSchema,
  findAttestationMintPda,
  findAttestationPda,
  findSasAuthorityPda,
  findSchemaMintPda,
  getCreateTokenizedAttestationInstruction,
  serializeAttestationData,
} from "@solana/attestation";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getMintSize,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";
import { createKeyPairSignerFromPrivateKeyBytes, type Address, type KeyPairSigner } from "@solana/kit";
import { createHash } from "node:crypto";
import { hotSignerClient } from "./client.js";
import { CHAIN, nftMetadataUri } from "./config.js";

export interface RunResultData extends Record<string, unknown> {
  manifest_sha256: string;
  evidence_cid: string;
  scenario_id: string;
  score_total: number;
  run_start_sig: string;
}

export interface MintResult {
  attestationAddress: string;
  nftMint: string;
  /** Signature of the CreateTokenizedAttestation tx (null when the attestation already existed
   * and its creation signature could not be read back). */
  txSig: string | null;
  alreadyExisted: boolean;
}

export interface Minter {
  /** Deterministic addresses for a run, before any tx. */
  addressesFor(runStartSig: string): Promise<{ attestationAddress: string; nftMint: string }>;
  mint(input: { recipient: string; data: RunResultData }): Promise<MintResult>;
}

/** nonce = the address of a keypair seeded with sha256(run_start_sig) — same derivation as
 * services/attestation/src/issue-run-result.ts and apps/web/src/verify.ts check 6. */
export async function nonceForRunStartSig(runStartSig: string): Promise<Address> {
  const seed = createHash("sha256").update(runStartSig).digest();
  const signer: KeyPairSigner = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(seed));
  return signer.address;
}

export async function deriveProofAddresses(runStartSig: string): Promise<{ nonce: Address; attestationAddress: Address; nftMint: Address }> {
  const nonce = await nonceForRunStartSig(runStartSig);
  const [attestationAddress] = await findAttestationPda({ credential: CHAIN.CREDENTIAL_PDA, schema: CHAIN.RUN_RESULT_SCHEMA_PDA, nonce });
  const [nftMint] = await findAttestationMintPda({ attestation: attestationAddress });
  return { nonce, attestationAddress, nftMint };
}

export class SasMinter implements Minter {
  async addressesFor(runStartSig: string) {
    const { attestationAddress, nftMint } = await deriveProofAddresses(runStartSig);
    return { attestationAddress, nftMint };
  }

  async mint({ recipient, data }: { recipient: string; data: RunResultData }): Promise<MintResult> {
    if (!Number.isInteger(data.score_total) || data.score_total < 0 || data.score_total > 100) {
      throw new Error(`score_total must be an integer 0-100 (U8); got ${data.score_total}`);
    }
    const client = await hotSignerClient();
    const signer = client.payer as KeyPairSigner;
    const { nonce, attestationAddress, nftMint } = await deriveProofAddresses(data.run_start_sig);

    const existing = await fetchMaybeAttestation(client.rpc, attestationAddress);
    if (existing.exists) {
      const sigs = await client.rpc.getSignaturesForAddress(attestationAddress, { limit: 20 }).send();
      const first = sigs.length > 0 ? sigs[sigs.length - 1].signature : null;
      return { attestationAddress, nftMint, txSig: first, alreadyExisted: true };
    }

    const [schemaMint] = await findSchemaMintPda({ schema: CHAIN.RUN_RESULT_SCHEMA_PDA });
    const [sasPda] = await findSasAuthorityPda();
    const schema = await fetchSchema(client.rpc, CHAIN.RUN_RESULT_SCHEMA_PDA);
    const [recipientTokenAccount] = await findAssociatedTokenPda({
      mint: nftMint,
      owner: recipient as Address,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });
    const uri = nftMetadataUri(nftMint);
    const mintAccountSpace = getMintSize([
      { __kind: "GroupMemberPointer", authority: sasPda, memberAddress: nftMint },
      { __kind: "NonTransferable" },
      { __kind: "MetadataPointer", authority: sasPda, metadataAddress: nftMint },
      { __kind: "PermanentDelegate", delegate: sasPda },
      { __kind: "MintCloseAuthority", closeAuthority: sasPda },
      {
        __kind: "TokenMetadata",
        updateAuthority: sasPda,
        mint: nftMint,
        name: CHAIN.TOKEN_NAME,
        symbol: CHAIN.TOKEN_SYMBOL,
        uri,
        additionalMetadata: new Map([
          ["attestation", attestationAddress],
          ["schema", CHAIN.RUN_RESULT_SCHEMA_PDA],
        ]),
      },
      { __kind: "TokenGroupMember", group: schemaMint, mint: nftMint, memberNumber: 1 },
    ]);

    const instruction = getCreateTokenizedAttestationInstruction({
      payer: signer,
      authority: signer,
      credential: CHAIN.CREDENTIAL_PDA,
      schema: CHAIN.RUN_RESULT_SCHEMA_PDA,
      attestation: attestationAddress,
      schemaMint,
      attestationMint: nftMint,
      sasPda,
      recipient: recipient as Address,
      nonce,
      expiry: 0,
      data: serializeAttestationData(schema.data, data),
      name: CHAIN.TOKEN_NAME,
      uri,
      symbol: CHAIN.TOKEN_SYMBOL,
      mintAccountSpace,
      recipientTokenAccount,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });
    const { context } = await client.sendTransaction(instruction);
    return { attestationAddress, nftMint, txSig: context.signature, alreadyExisted: false };
  }
}
