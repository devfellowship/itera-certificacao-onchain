/**
 * Spike (Samuel's build order, item 1): validate TokenizeSchema + CreateTokenizedAttestation on
 * devnet end to end, and measure the tokenized attestation tx size against the 1232-byte limit
 * BEFORE committing to a schema — TokenizeSchema's maxSize can never grow afterward.
 *
 * Standalone script, not wired into client.ts/cli.ts yet: this is a throwaway spike, not the
 * production issuance path. If it works, the real run-result-v2 schema + tokenized issuance move
 * into client.ts as part of build-order item 3 (idempotent setup + hot key).
 *
 * Reuses the EXISTING Credential (`itera-agent-proof`, created live on devnet 2026-10-08) instead
 * of creating a new one — a Credential can hold multiple Schemas, and re-creating it would hit
 * the exact AccountAlreadyInitialized bug Samuel's brief flags (services/attestation/src/cli.ts
 * has no idempotent setup yet; sidestepping it here rather than fixing it is deliberate — that
 * fix is build-order item 3, not this spike).
 */
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getMintSize,
  TOKEN_2022_PROGRAM_ADDRESS,
} from '@solana-program/token-2022';
import {
  fetchSchema,
  findAttestationMintPda,
  findAttestationPda,
  findCredentialPda,
  findSasAuthorityPda,
  findSchemaMintPda,
  findSchemaPda,
  getCreateSchemaInstruction,
  getCreateTokenizedAttestationInstruction,
  getTokenizeSchemaInstruction,
  SchemaDataType,
  serializeAttestationData,
} from '@solana/attestation';
import { getTransactionEncoder, type KeyPairSigner } from '@solana/kit';
import { setupClient } from './client.js';
import { CONFIG } from './config.js';

// The schema Samuel's brief specifies for run-result-v2 — 5 fields only. Do NOT add fields:
// at 12 fields the tokenized tx measured 1312 bytes (over the 1232 limit); at these 5 it should
// land around 973. agent_commit/model_id/evaluator_commit/fixture_hash stay in the Memo + the
// off-chain manifest instead of on-chain fields.
const RUN_RESULT_SCHEMA = {
  NAME: 'run-result-v2',
  VERSION: 1,
  DESCRIPTION: 'Itera benchmark run result: manifest digest, evidence CID, scenario, score, and the run-start tx signature it binds to.',
  FIELD_NAMES: ['manifest_sha256', 'evidence_cid', 'scenario_id', 'score_total', 'run_start_sig'],
  LAYOUT: [
    SchemaDataType.String, // manifest_sha256
    SchemaDataType.String, // evidence_cid
    SchemaDataType.String, // scenario_id
    SchemaDataType.U8,     // score_total (0-100)
    SchemaDataType.String, // run_start_sig
  ],
} as const;

// Placeholder on-chain token metadata URI — an SPL Token-2022 TokenMetadata extension just
// stores a string here, it is never resolved for the instructions to succeed (confirmed against
// solana-foundation/solana-attestation-service's own tokenized example, which uses
// 'https://example.com/metadata.json' as-is). A real pinned {name,symbol,image} JSON is cosmetic
// — it only changes how Phantom renders the token — and can be swapped in later without touching
// any on-chain account.
const TOKEN_CONFIG = {
  NAME: 'Itera Run Result',
  SYMBOL: 'ITERA',
  METADATA_URI: 'https://example.com/itera-run-result-metadata.json',
} as const;

async function main() {
  console.log('--- Itera tokenized attestation spike (devnet) ---\n');

  const { client, issuer, signer } = await setupClient();
  console.log(`Payer/issuer/signer: ${issuer.address}`);

  const [credentialPda] = await findCredentialPda({ authority: issuer.address, name: CONFIG.CREDENTIAL_NAME });
  console.log(`Reusing existing Credential: ${credentialPda}`);

  console.log('\n1. Creating Schema (run-result-v2)...');
  const [schemaPda] = await findSchemaPda({
    credential: credentialPda,
    name: RUN_RESULT_SCHEMA.NAME,
    version: RUN_RESULT_SCHEMA.VERSION,
  });
  const createSchemaIx = getCreateSchemaInstruction({
    authority: issuer,
    payer: client.payer,
    name: RUN_RESULT_SCHEMA.NAME,
    credential: credentialPda,
    description: RUN_RESULT_SCHEMA.DESCRIPTION,
    fieldNames: [...RUN_RESULT_SCHEMA.FIELD_NAMES],
    schema: schemaPda,
    layout: [...RUN_RESULT_SCHEMA.LAYOUT],
  });
  const { context: schemaCtx } = await client.sendTransaction(createSchemaIx);
  console.log(`   Schema PDA: ${schemaPda} — tx ${schemaCtx.signature}`);

  console.log('\n2. Tokenizing Schema...');
  const [schemaMint] = await findSchemaMintPda({ schema: schemaPda });
  const [sasPda] = await findSasAuthorityPda();
  const schemaMintSpace = getMintSize([
    { __kind: 'GroupPointer', authority: sasPda, groupAddress: schemaMint },
  ]);
  const tokenizeIx = getTokenizeSchemaInstruction({
    payer: client.payer,
    authority: issuer,
    credential: credentialPda,
    schema: schemaPda,
    mint: schemaMint,
    sasPda,
    maxSize: schemaMintSpace,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  });
  const { context: tokenizeCtx } = await client.sendTransaction(tokenizeIx);
  console.log(`   Schema Mint: ${schemaMint} — tx ${tokenizeCtx.signature}`);

  console.log('\n3. Creating Tokenized Attestation (recipient = issuer wallet, for the spike)...');
  const nonce = issuer.address; // spike only: real issuance uses sha256(run_start_sig), per the brief
  const [attestationPda] = await findAttestationPda({ credential: credentialPda, schema: schemaPda, nonce });
  const [attestationMint] = await findAttestationMintPda({ attestation: attestationPda });
  const schema = await fetchSchema(client.rpc, schemaPda);

  const [recipientTokenAccount] = await findAssociatedTokenPda({
    mint: attestationMint,
    owner: issuer.address,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  });

  const attestationMintSpace = getMintSize([
    { __kind: 'GroupMemberPointer', authority: sasPda, memberAddress: attestationMint },
    { __kind: 'NonTransferable' },
    { __kind: 'MetadataPointer', authority: sasPda, metadataAddress: attestationMint },
    { __kind: 'PermanentDelegate', delegate: sasPda },
    { __kind: 'MintCloseAuthority', closeAuthority: sasPda },
    {
      __kind: 'TokenMetadata',
      updateAuthority: sasPda,
      mint: attestationMint,
      name: TOKEN_CONFIG.NAME,
      symbol: TOKEN_CONFIG.SYMBOL,
      uri: TOKEN_CONFIG.METADATA_URI,
      additionalMetadata: new Map([
        ['attestation', attestationPda],
        ['schema', schemaPda],
      ]),
    },
    { __kind: 'TokenGroupMember', group: schemaMint, mint: attestationMint, memberNumber: 1 },
  ]);

  const spikeData = {
    manifest_sha256: 'a'.repeat(64), // placeholder sha256 hex for the spike
    evidence_cid: 'bafybeigdyrztspike0000000000000000000000000000000000000000000',
    scenario_id: 'webhook-ledger',
    score_total: 100,
    run_start_sig: '5'.repeat(88), // placeholder, signature-length-ish base58 string
  };

  const createTokenizedIx = getCreateTokenizedAttestationInstruction({
    payer: client.payer,
    authority: signer as KeyPairSigner,
    credential: credentialPda,
    schema: schemaPda,
    attestation: attestationPda,
    schemaMint,
    attestationMint,
    sasPda,
    recipient: issuer.address,
    nonce,
    expiry: 0, // never expires — same reasoning as the plain attestation
    data: serializeAttestationData(schema.data, spikeData),
    name: TOKEN_CONFIG.NAME,
    uri: TOKEN_CONFIG.METADATA_URI,
    symbol: TOKEN_CONFIG.SYMBOL,
    mintAccountSpace: attestationMintSpace,
    recipientTokenAccount,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  });

  // No separate size measurement: Solana rejects an over-1232-byte transaction outright, so a
  // successful send here is itself the proof this schema fits (the failure mode Samuel's brief
  // warns about — 12 fields measured 1312 bytes and would be rejected the same way).
  const { context: attestCtx } = await client.sendTransaction(createTokenizedIx);
  console.log(`   Attestation PDA: ${attestationPda}`);
  console.log(`   Attestation Mint (the NFT): ${attestationMint}`);
  console.log(`   tx ${attestCtx.signature}`);

  console.log('\n--- Done ---');
  console.log(`Explorer (attestation mint): https://explorer.solana.com/address/${attestationMint}?cluster=devnet`);
  console.log(`Explorer (tx):               https://explorer.solana.com/tx/${attestCtx.signature}?cluster=devnet`);
}

main().catch((error) => {
  console.error('Spike failed:', error);
  process.exit(1);
});
