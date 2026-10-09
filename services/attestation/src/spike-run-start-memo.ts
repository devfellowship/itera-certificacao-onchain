/**
 * Spike (Samuel's build order, item 4, core mechanic): prove a wallet with ZERO SOL can co-sign
 * a run-start Memo transaction while Itera's hot key pays the fee, on real devnet.
 *
 * Simulates the browser wallet with a freshly generated, never-funded local keypair instead of
 * a real Phantom session — Phantom itself only ever produces a signature over a transaction it's
 * handed, it doesn't change how the transaction is built or who else must sign it. Proving the
 * mechanic here (Kit auto-collects every signer an instruction references, @solana-program/memo's
 * `signers` input requires the named account's signature) is what de-risks wiring the real
 * frontend signing flow next, same pattern as item 1's devnet spike before any UI work.
 *
 * Does NOT implement the server API endpoint (build tx → hand to browser → receive signed-back
 * tx → submit) — that's the remaining real-network-boundary half of item 4, a frontend+API task,
 * not provable by a standalone script. This spike is the "does the on-chain mechanic actually
 * work" half.
 */
import { LEGACY_MEMO_PROGRAM_ADDRESS_V3, getAddMemoInstruction } from '@solana-program/memo';
import { generateKeyPairSigner, lamports } from '@solana/kit';
import { setupClient } from './client.js';

async function main() {
  console.log('--- Itera run-start Memo spike (devnet) ---\n');

  // Itera's side: the hot signer, already funded, acts as fee payer for this spike (production
  // uses the real hot signer from setup.ts; any funded devnet keypair proves the mechanic).
  const { client: iteraClient } = await setupClient();
  console.log(`Itera fee payer: ${iteraClient.payer.address}`);

  // The "wallet" side: a brand-new keypair, NEVER airdropped, NEVER funded — this is the whole
  // point of the spike.
  const userWallet = await generateKeyPairSigner();
  const balanceBefore = await iteraClient.rpc.getBalance(userWallet.address).send();
  console.log(`Simulated user wallet: ${userWallet.address} (balance: ${balanceBefore.value} lamports)`);
  if (balanceBefore.value !== 0n) {
    throw new Error('Spike invariant broken: the simulated wallet already has a balance.');
  }

  const runId = `spike-${Date.now()}`;
  const memoText = `itera-run:v1:${JSON.stringify({
    run_id: runId,
    scenario_id: 'webhook-ledger',
    agent_repo: 'D0ingC0des/itera-agent-manifests',
    agent_commit: 'spike0000',
    model_id: 'claude-sonnet',
    evaluator_commit: 'spike0000',
    fixture_hash: 'a'.repeat(64),
  })}`;
  console.log(`\nMemo: ${memoText}`);

  // `signers: [userWallet]` is what makes the program require userWallet's signature on this
  // instruction — @solana/kit's client.sendTransaction auto-collects every KeyPairSigner
  // referenced anywhere in the instruction (same mechanism already used for
  // CreateCredential's `authority` vs `payer` split in client.ts) and co-signs with all of them.
  // Using the V3 program id (not the package default V2) because it's the one Explorer and most
  // wallet UIs recognize and label "Memo Program".
  const memoIx = getAddMemoInstruction(
    { memo: memoText, signers: [userWallet] },
    { programAddress: LEGACY_MEMO_PROGRAM_ADDRESS_V3 },
  );

  console.log('\nSending (Itera pays, user wallet co-signs with 0 SOL)...');
  const { context } = await iteraClient.sendTransaction(memoIx);
  console.log(`Signature: ${context.signature}`);

  const balanceAfter = await iteraClient.rpc.getBalance(userWallet.address).send();
  console.log(`\nUser wallet balance after: ${balanceAfter.value} lamports (still 0 — Itera paid)`);
  if (balanceAfter.value !== 0n) {
    throw new Error('Spike invariant broken: the simulated wallet was charged a fee.');
  }

  console.log('\n--- Done ---');
  console.log(`Explorer: https://explorer.solana.com/tx/${context.signature}?cluster=devnet`);
}

main().catch((error) => {
  console.error('Spike failed:', error);
  process.exit(1);
});
