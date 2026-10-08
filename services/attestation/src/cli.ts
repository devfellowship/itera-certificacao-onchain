import { readFile } from 'node:fs/promises';
import { createKeyPairSignerFromPrivateKeyBytes } from '@solana/kit';
import { createAttestationFromManifest, createCredential, createSchema, setupClient } from './client.js';
import { manifestToAttestationData } from './manifest.js';
import type { EvidenceManifestSummary } from './manifest.js';

async function main(): Promise<void> {
  const manifestPath = process.argv[2];
  if (!manifestPath) {
    throw new Error('Usage: npm run cli -- <path-to-evidence-manifest.json>\n\nTakes the JSON output of services/evaluator\'s CLI and anchors it as a Solana Attestation.');
  }

  const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as EvidenceManifestSummary;
  const data = manifestToAttestationData(manifest);

  console.log('1. Setting up client (persisted, pre-funded devnet keypair)...');
  const { client, issuer, signer } = await setupClient();
  console.log(`   Payer/issuer: ${client.payer.address}`);

  console.log('2. Creating Credential...');
  const credentialPda = await createCredential(client, issuer, signer.address);

  console.log('3. Creating Schema...');
  const schemaPda = await createSchema(client, issuer, credentialPda);

  console.log('4. Creating Attestation from evidence manifest...');
  // Derive a deterministic nonce from the patch hash so re-running the CLI on the SAME
  // manifest always resolves to the SAME attestation PDA (idempotent), instead of a random
  // one each time. Not a real wallet address, just a stable 32-byte seed for findAttestationPda.
  const seed = new TextEncoder().encode(data.patch_hash.padEnd(32, '0')).slice(0, 32);
  const nonceSigner = await createKeyPairSignerFromPrivateKeyBytes(seed);
  const attestationPda = await createAttestationFromManifest(client, signer, credentialPda, schemaPda, nonceSigner.address, data);

  console.log('\nDone.');
  console.log(`Credential:  ${credentialPda}`);
  console.log(`Schema:      ${schemaPda}`);
  console.log(`Attestation: ${attestationPda}`);
}

main().catch((error) => {
  console.error('Attestation failed:', error);
  process.exitCode = 1;
});
