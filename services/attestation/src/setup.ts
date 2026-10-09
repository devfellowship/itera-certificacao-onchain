/**
 * Samuel's build-order item 3: idempotent setup (safe to re-run on every deploy, never fails
 * with AccountAlreadyInitialized) + the hot-signer/authority key split.
 *
 * Run once per environment: `ITERA_HOT_SIGNER_KEYPAIR_PATH=<path> npm run setup -w @itera/attestation`
 *
 * After this runs successfully, the authority keypair (~/.config/solana/id.json by default) can
 * go offline — nothing in production issuance (createTokenizedAttestation) needs it again. Only
 * the hot signer is used for day-to-day attestation issuance.
 */
import {
  ensureCredential,
  ensureHotSignerAuthorized,
  ensureSchema,
  ensureSchemaTokenized,
  loadHotSigner,
  setupClient,
} from './client.js';
import { hotSignerKeypairPath, RUN_RESULT_SCHEMA } from './config.js';

async function main(): Promise<void> {
  console.log('--- Itera attestation setup (idempotent) ---\n');

  const { client, issuer: authority } = await setupClient();
  console.log(`Authority (payer): ${authority.address}`);

  const hotSigner = await loadHotSigner(hotSignerKeypairPath());
  console.log(`Hot signer:        ${hotSigner.address}`);

  console.log('\n1. Ensuring Credential...');
  const credentialPda = await ensureCredential(client, authority, [authority.address, hotSigner.address]);
  console.log(`   Credential: ${credentialPda}`);

  console.log('\n2. Ensuring hot signer is authorized...');
  await ensureHotSignerAuthorized(client, authority, credentialPda, hotSigner.address);

  console.log('\n3. Ensuring Schema (run-result-v2)...');
  const schemaPda = await ensureSchema(client, authority, credentialPda, RUN_RESULT_SCHEMA);
  console.log(`   Schema: ${schemaPda}`);

  console.log('\n4. Ensuring Schema is tokenized...');
  await ensureSchemaTokenized(client, authority, credentialPda, schemaPda);

  console.log('\n--- Setup complete (idempotent — safe to run again) ---');
  console.log(`Credential: ${credentialPda}`);
  console.log(`Schema:     ${schemaPda}`);
  console.log(`Hot signer: ${hotSigner.address} (use this for issuance, not the authority)`);
}

main().catch((error) => {
  console.error('Setup failed:', error);
  process.exitCode = 1;
});
