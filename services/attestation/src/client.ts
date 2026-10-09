import {
  fetchMaybeCredential,
  fetchMaybeSchema,
  fetchSchema,
  findAttestationPda,
  findCredentialPda,
  findSchemaPda,
  getChangeAuthorizedSignersInstruction,
  getCreateAttestationInstruction,
  getCreateCredentialInstruction,
  getCreateSchemaInstruction,
  serializeAttestationData,
} from '@solana/attestation';
import { readFile } from 'node:fs/promises';
import { createClient, createKeyPairSignerFromBytes, generateKeyPairSigner, type Instruction, type KeyPairSigner } from '@solana/kit';
import { solanaDevnetRpc } from '@solana/kit-plugin-rpc';
import { payerFromFile } from '@solana/kit-plugin-signer';
import { CONFIG } from './config.js';
import type { AttestationData } from './manifest.js';

export type Client = Awaited<ReturnType<typeof setupClient>>['client'];

/**
 * Sets up an RPC client using a persisted keypair file as the fee payer, loaded via
 * @solana/kit-plugin-signer's `payerFromFile` (real API, found by reading its .d.ts — not
 * guessed). Defaults to the Solana CLI's own keypair path so `solana-keygen`/`solana airdrop`
 * and this client share the same funded address.
 *
 * The same keypair also acts as the Credential issuer and its sole authorized signer — correct
 * for a single-issuer MVP (Itera is the one issuing agent-proof credentials). A multi-issuer
 * setup would need separate persisted keys per issuer, not implemented here.
 */
export async function setupClient(keypairPath = `${process.env.USERPROFILE ?? process.env.HOME}/.config/solana/id.json`) {
  const client = await createClient()
    .use(payerFromFile(keypairPath))
    .use(solanaDevnetRpc({ rpcUrl: CONFIG.HTTP_CONNECTION_URL, rpcSubscriptionsUrl: CONFIG.WSS_CONNECTION_URL }));
  // payerFromFile sets client.payer; the same signer doubles as issuer and authorized signer.
  const issuer = client.payer as KeyPairSigner;
  const signer = client.payer as KeyPairSigner;
  return { client, issuer, signer };
}

async function send(client: Client, instruction: Instruction, description: string): Promise<void> {
  const { context } = await client.sendTransaction(instruction);
  console.log(`${description} — signature: ${context.signature}`);
}

/**
 * Loads a KeyPairSigner from a raw JSON keypair file (the same format `solana-keygen` writes)
 * WITHOUT making it the client's payer/identity — unlike payerFromFile, which binds a keypair to
 * the client object. This is how the hot signer is loaded: it signs attestation issuance, but the
 * CLI-default keypair stays the payer (it funds transactions and is the Credential authority).
 */
export async function loadHotSigner(path: string): Promise<KeyPairSigner> {
  const raw = JSON.parse(await readFile(path, 'utf-8')) as number[];
  return createKeyPairSignerFromBytes(new Uint8Array(raw));
}

/**
 * Idempotent: fetches the Credential first and returns its PDA if it already exists instead of
 * calling CreateCredential again, which fails with AccountAlreadyInitialized on a second run —
 * the exact bug Samuel's brief flags in the original cli.ts. Safe to call on every run/deploy.
 */
export async function ensureCredential(client: Client, authority: KeyPairSigner, initialSigners: Array<KeyPairSigner['address']>) {
  const [credentialPda] = await findCredentialPda({ authority: authority.address, name: CONFIG.CREDENTIAL_NAME });
  const existing = await fetchMaybeCredential(client.rpc, credentialPda);
  if (existing.exists) {
    console.log(`Credential already exists, reusing: ${credentialPda}`);
    return credentialPda;
  }
  const instruction = getCreateCredentialInstruction({
    payer: client.payer,
    credential: credentialPda,
    authority,
    name: CONFIG.CREDENTIAL_NAME,
    signers: initialSigners,
  });
  await send(client, instruction, 'Credential created');
  return credentialPda;
}

/**
 * Idempotent: adds `hotSignerAddress` to the Credential's authorized_signers list ONLY if it
 * isn't already there. ChangeAuthorizedSigners replaces the whole list, so this reads the current
 * one first rather than assuming it knows the prior contents.
 */
export async function ensureHotSignerAuthorized(
  client: Client,
  authority: KeyPairSigner,
  credentialPda: Awaited<ReturnType<typeof findCredentialPda>>[0],
  hotSignerAddress: KeyPairSigner['address'],
): Promise<void> {
  const credential = await fetchMaybeCredential(client.rpc, credentialPda);
  if (!credential.exists) {
    throw new Error(`Credential ${credentialPda} does not exist — call ensureCredential first.`);
  }
  if (credential.data.authorizedSigners.includes(hotSignerAddress)) {
    console.log(`Hot signer ${hotSignerAddress} already authorized.`);
    return;
  }
  const instruction = getChangeAuthorizedSignersInstruction({
    payer: client.payer,
    authority,
    credential: credentialPda,
    signers: [...credential.data.authorizedSigners, hotSignerAddress],
  });
  await send(client, instruction, 'Hot signer authorized');
}

/**
 * Idempotent: fetches the Schema first and returns its PDA if it already exists instead of
 * calling CreateSchema again (same AccountAlreadyInitialized failure mode as ensureCredential).
 */
export async function ensureSchema(
  client: Client,
  authority: KeyPairSigner,
  credentialPda: Awaited<ReturnType<typeof findCredentialPda>>[0],
  schema: { NAME: string; VERSION: number; DESCRIPTION: string; FIELD_NAMES: readonly string[]; LAYOUT: readonly number[] },
) {
  const [schemaPda] = await findSchemaPda({ credential: credentialPda, name: schema.NAME, version: schema.VERSION });
  const existing = await fetchMaybeSchema(client.rpc, schemaPda);
  if (existing.exists) {
    console.log(`Schema already exists, reusing: ${schemaPda}`);
    return schemaPda;
  }
  const instruction = getCreateSchemaInstruction({
    authority,
    payer: client.payer,
    name: schema.NAME,
    credential: credentialPda,
    description: schema.DESCRIPTION,
    fieldNames: [...schema.FIELD_NAMES],
    schema: schemaPda,
    layout: [...schema.LAYOUT],
  });
  await send(client, instruction, 'Schema created');
  return schemaPda;
}

/**
 * Idempotent: TokenizeSchema creates the schema's group mint once and `maxSize` can never
 * change afterward, so calling it twice would be a real mistake, not just a wasted transaction —
 * this checks the mint account exists first and skips if so.
 */
export async function ensureSchemaTokenized(
  client: Client,
  authority: KeyPairSigner,
  credentialPda: Awaited<ReturnType<typeof findCredentialPda>>[0],
  schemaPda: Awaited<ReturnType<typeof findSchemaPda>>[0],
): Promise<void> {
  const { findSchemaMintPda, findSasAuthorityPda, getTokenizeSchemaInstruction } = await import('@solana/attestation');
  const { TOKEN_2022_PROGRAM_ADDRESS, getMintSize, fetchMaybeMint } = await import('@solana-program/token-2022');

  const [schemaMint] = await findSchemaMintPda({ schema: schemaPda });
  const existing = await fetchMaybeMint(client.rpc, schemaMint);
  if (existing.exists) {
    console.log(`Schema already tokenized, reusing mint: ${schemaMint}`);
    return;
  }
  const [sasPda] = await findSasAuthorityPda();
  const maxSize = getMintSize([{ __kind: 'GroupPointer', authority: sasPda, groupAddress: schemaMint }]);
  const instruction = getTokenizeSchemaInstruction({
    payer: client.payer,
    authority,
    credential: credentialPda,
    schema: schemaPda,
    mint: schemaMint,
    sasPda,
    maxSize,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  });
  await send(client, instruction, 'Schema tokenized');
}

export async function createCredential(client: Client, issuer: KeyPairSigner, signerAddress: KeyPairSigner['address']) {
  const [credentialPda] = await findCredentialPda({ authority: issuer.address, name: CONFIG.CREDENTIAL_NAME });
  const instruction = getCreateCredentialInstruction({
    payer: client.payer,
    credential: credentialPda,
    authority: issuer,
    name: CONFIG.CREDENTIAL_NAME,
    signers: [signerAddress],
  });
  await send(client, instruction, 'Credential created');
  return credentialPda;
}

export async function createSchema(client: Client, issuer: KeyPairSigner, credentialPda: Awaited<ReturnType<typeof findCredentialPda>>[0]) {
  const [schemaPda] = await findSchemaPda({ credential: credentialPda, name: CONFIG.SCHEMA_NAME, version: CONFIG.SCHEMA_VERSION });
  const instruction = getCreateSchemaInstruction({
    authority: issuer,
    payer: client.payer,
    name: CONFIG.SCHEMA_NAME,
    credential: credentialPda,
    description: CONFIG.SCHEMA_DESCRIPTION,
    fieldNames: [...CONFIG.SCHEMA_FIELDS],
    schema: schemaPda,
    layout: [...CONFIG.SCHEMA_LAYOUT],
  });
  await send(client, instruction, 'Schema created');
  return schemaPda;
}

/**
 * Issues one Attestation for a scored evaluator run. `nonce` is the on-chain identity this
 * attestation is filed under — pass something stable per subject (e.g. the agent/run's own
 * address, or a deterministic PDA-friendly key); the demo config has no default because this is
 * the one field callers must choose deliberately.
 */
export async function createAttestationFromManifest(
  client: Client,
  signer: KeyPairSigner,
  credentialPda: Awaited<ReturnType<typeof findCredentialPda>>[0],
  schemaPda: Awaited<ReturnType<typeof findSchemaPda>>[0],
  nonce: KeyPairSigner['address'],
  data: AttestationData,
) {
  const [attestationPda] = await findAttestationPda({ credential: credentialPda, schema: schemaPda, nonce });
  const schema = await fetchSchema(client.rpc, schemaPda);
  const expiry = CONFIG.ATTESTATION_EXPIRY_DAYS === 0 ? 0 : Math.floor(Date.now() / 1000) + CONFIG.ATTESTATION_EXPIRY_DAYS * 24 * 60 * 60;

  const instruction = getCreateAttestationInstruction({
    payer: client.payer,
    authority: signer,
    credential: credentialPda,
    schema: schemaPda,
    attestation: attestationPda,
    nonce,
    expiry,
    data: serializeAttestationData(schema.data, data),
  });
  await send(client, instruction, 'Attestation created');
  return attestationPda;
}
