// Hermetic web3 e2e guard (T14): fresh keys for ONE CI job, made on the runner and never stored.
//
//   node scripts/e2e/hermetic/keys.mjs <dir>
//
// Writes <dir>/hot-signer.json (the API hot signer: attestation authority and fee payer, appended to
// the Credential of the local validator by setup-chain.mjs) and <dir>/keys.env with:
//   HOT_SIGNER_ADDRESS, TREASURY_ADDRESS, E2E_WALLET_ADDRESS, E2E_WALLET_SECRET_B58.
// The wallet secret is the paying user's key on the local validator only. Every key here is worthless
// outside the job: it holds only SOL airdropped by the job's own solana-test-validator.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getBase58Decoder } from '@solana/kit';
import { Keypair } from '@solana/web3.js';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: keys.mjs <dir>');
  process.exit(2);
}
mkdirSync(dir, { recursive: true, mode: 0o700 });
const hot = Keypair.generate();
const treasury = Keypair.generate();
const user = Keypair.generate();
writeFileSync(join(dir, 'hot-signer.json'), JSON.stringify(Array.from(hot.secretKey)), { mode: 0o600 });
writeFileSync(
  join(dir, 'keys.env'),
  [
    `HOT_SIGNER_ADDRESS=${hot.publicKey.toBase58()}`,
    `TREASURY_ADDRESS=${treasury.publicKey.toBase58()}`,
    `E2E_WALLET_ADDRESS=${user.publicKey.toBase58()}`,
    `E2E_WALLET_SECRET_B58=${getBase58Decoder().decode(user.secretKey)}`,
    '',
  ].join('\n'),
  { mode: 0o600 },
);
console.log(`hot signer ${hot.publicKey.toBase58()}, treasury ${treasury.publicKey.toBase58()}, wallet ${user.publicKey.toBase58()}`);
