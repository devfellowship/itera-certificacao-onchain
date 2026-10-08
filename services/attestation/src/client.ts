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
import { createClient, generateKeyPairSigner, type Instruction, type KeyPairSigner } from '@solana/kit';
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
