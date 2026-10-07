import { readFile } from 'node:fs/promises';
import { lamports } from '@solana/kit';
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

  console.log('1. Setting up client and funding payer (devnet airdrop)...');
  const { client, issuer, signer } = await setupClient();
  const airdropSignature = await client.airdrop(client.payer.address, lamports(1_000_000_000n));
  console.log(`   Airdrop signature: ${airdropSignature}`);

  console.log('2. Creating Credential...');
  const credentialPda = await createCredential(client, issuer, signer.address);

  console.log('3. Creating Schema...');
  const schemaPda = await createSchema(client, issuer, credentialPda);

  console.log('4. Creating Attestation from evidence manifest...');
  // The signer's own address is the attestation's on-chain subject identity for this run.
  // A production flow should pass a stable, caller-chosen nonce instead (see client.ts).
  const attestationPda = await createAttestationFromManifest(client, signer, credentialPda, schemaPda, signer.address, data);

  console.log('\nDone.');
  console.log(`Credential:  ${credentialPda}`);
  console.log(`Schema:      ${schemaPda}`);
  console.log(`Attestation: ${attestationPda}`);
}

main().catch((error) => {
  console.error('Attestation failed:', error);
  process.exitCode = 1;
});
