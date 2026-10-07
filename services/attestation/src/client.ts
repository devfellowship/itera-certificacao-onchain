import {
  fetchSchema,
  findAttestationPda,
  findCredentialPda,
  findSchemaPda,
  getCreateAttestationInstruction,
  getCreateCredentialInstruction,
  getCreateSchemaInstruction,
  serializeAttestationData,
} from '@solana/attestation';
import { createClient, generateKeyPairSigner, type Instruction } from '@solana/kit';
import { solanaDevnetRpc } from '@solana/kit-plugin-rpc';
import { generatedPayer } from '@solana/kit-plugin-signer';
import { CONFIG } from './config.js';
import type { AttestationData } from './manifest.js';

export type Client = Awaited<ReturnType<typeof setupClient>>['client'];

/**
 * Sets up an RPC client with an ephemeral, auto-generated fee payer (matches the official SAS
 * example's `setupWallets`). The payer needs devnet SOL before any instruction below will land —
 * see services/attestation/README.md for the known devnet faucet rate-limit blocker and the two
 * documented workarounds (manual faucet.solana.com funding, or a local validator).
 *
 * The issuer/signer keys here are also freshly generated per run. That is correct for a one-shot
 * demo but NOT for production use: a real Credential needs a stable, persisted issuer authority
 * so the same Credential PDA can be reused across runs. Persisting a @solana/kit KeyPairSigner to
 * disk safely is still open — do not invent an API for it; research the real one before wiring
 * this up for a non-demo deployment.
 */
export async function setupClient() {
  const client = await createClient()
    .use(generatedPayer())
    .use(solanaDevnetRpc({ rpcUrl: CONFIG.HTTP_CONNECTION_URL, rpcSubscriptionsUrl: CONFIG.WSS_CONNECTION_URL }));
  const issuer = await generateKeyPairSigner();
  const signer = await generateKeyPairSigner();
  return { client, issuer, signer };
}

async function send(client: Client, instruction: Instruction, description: string): Promise<void> {
  const { context } = await client.sendTransaction(instruction);
  console.log(`${description} — signature: ${context.signature}`);
}

export async function createCredential(client: Client, issuer: Awaited<ReturnType<typeof generateKeyPairSigner>>, signerAddress: Awaited<ReturnType<typeof generateKeyPairSigner>>['address']) {
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

export async function createSchema(client: Client, issuer: Awaited<ReturnType<typeof generateKeyPairSigner>>, credentialPda: Awaited<ReturnType<typeof findCredentialPda>>[0]) {
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
  signer: Awaited<ReturnType<typeof generateKeyPairSigner>>,
  credentialPda: Awaited<ReturnType<typeof findCredentialPda>>[0],
  schemaPda: Awaited<ReturnType<typeof findSchemaPda>>[0],
  nonce: Awaited<ReturnType<typeof generateKeyPairSigner>>['address'],
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
