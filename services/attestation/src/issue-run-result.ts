/**
 * Production issuance path for a run-result-v2 tokenized attestation (build-order item 5).
 * Pins the evaluator's evidence manifest to IPFS, derives manifest_sha256 from those exact bytes,
 * and mints the Itera credential NFT into the agent owner's wallet.
 *
 * NOT runnable end to end yet — two real dependencies are still missing, both intentionally left
 * as clear failures rather than silently faked:
 *   - PINATA_JWT (services/attestation/src/ipfs.ts) — no paid IPFS pinning account exists yet,
 *     asked in #chapter-web3 2026-10-09.
 *   - a real run_start_sig — item 4's server endpoint (build the unsigned Memo tx, hand it to
 *     the browser for Phantom to sign, submit the signed-back result) isn't wired yet; the
 *     mechanic itself was validated by spike-run-start-memo.ts.
 *
 * Usage once both exist:
 *   PINATA_JWT=... ITERA_HOT_SIGNER_KEYPAIR_PATH=... \
 *     npm run issue -w @itera/attestation -- <evidence-manifest.json> <run_start_sig> <recipient_wallet_address>
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createKeyPairSignerFromPrivateKeyBytes, type Address } from '@solana/kit';
import { createTokenizedAttestationFromRunResult, ensureCredential, ensureHotSignerAuthorized, ensureSchema, ensureSchemaTokenized, loadHotSigner, setupClient } from './client.js';
import { hotSignerKeypairPath, RUN_RESULT_SCHEMA } from './config.js';
import { manifestToPinnableBytes, pinBytes } from './ipfs.js';
import { buildRunResultData } from './run-result.js';

interface EvaluatorManifest {
  scenario_id: string;
  score: { total: number };
}

async function main(): Promise<void> {
  const [manifestPath, runStartSig, recipientArg] = process.argv.slice(2);
  if (!manifestPath || !runStartSig || !recipientArg) {
    throw new Error(
      'Usage: npm run issue -w @itera/attestation -- <evidence-manifest.json> <run_start_sig> <recipient_wallet_address>',
    );
  }
  const recipient = recipientArg as Address;

  const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as EvaluatorManifest;

  console.log('1. Pinning evidence manifest to IPFS...');
  const bytes = manifestToPinnableBytes(manifest);
  const pinned = await pinBytes(bytes, `${manifest.scenario_id}-${Date.now()}.json`);
  console.log(`   CID: ${pinned.cid}`);
  console.log(`   manifest_sha256: ${pinned.manifestSha256}`);

  const data = buildRunResultData({
    pinned,
    scenarioId: manifest.scenario_id,
    scoreTotal: manifest.score.total,
    runStartSig,
  });

  console.log('\n2. Setting up client + ensuring Credential/Schema (idempotent)...');
  const { client, issuer: authority } = await setupClient();
  const hotSigner = await loadHotSigner(hotSignerKeypairPath());
  const credentialPda = await ensureCredential(client, authority, [authority.address, hotSigner.address]);
  await ensureHotSignerAuthorized(client, authority, credentialPda, hotSigner.address);
  const schemaPda = await ensureSchema(client, authority, credentialPda, RUN_RESULT_SCHEMA);
  await ensureSchemaTokenized(client, authority, credentialPda, schemaPda);

  console.log('\n3. Issuing tokenized attestation...');
  // Deterministic nonce per run, per the brief: sha256(run_start_sig). 32 raw bytes of the hex
  // digest, same pattern as the earlier patch_hash-derived nonce in cli.ts.
  const nonceSeed = createHash('sha256').update(runStartSig).digest();
  const nonceSigner = await createKeyPairSignerFromPrivateKeyBytes(nonceSeed);
  const { attestationPda, attestationMint } = await createTokenizedAttestationFromRunResult(
    client,
    hotSigner,
    credentialPda,
    schemaPda,
    recipient,
    nonceSigner.address,
    data,
  );

  console.log('\nDone.');
  console.log(`Credential:  ${credentialPda}`);
  console.log(`Schema:      ${schemaPda}`);
  console.log(`Attestation: ${attestationPda}`);
  console.log(`NFT:         ${attestationMint}`);
}

main().catch((error) => {
  console.error('Issuance failed:', error);
  process.exitCode = 1;
});
