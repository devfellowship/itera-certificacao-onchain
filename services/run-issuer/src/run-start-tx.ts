/**
 * Builds and submits the run-start Memo transaction (Samuel's brief, step 1 of the on-chain
 * flow): Itera pays the fee, the user's wallet co-signs via a real Phantom signature obtained in
 * the browser — the server never holds the user's key, only their address, represented here by a
 * noop signer (a placeholder that marks the account as a required signer without being able to
 * produce a signature itself; see @solana/signers' createNoopSigner).
 *
 * Mechanic validated end to end on devnet first in
 * services/attestation/src/spike-run-start-memo.ts (a zero-SOL local keypair standing in for
 * Phantom) before wiring this real two-step API around it.
 */
import { LEGACY_MEMO_PROGRAM_ADDRESS_V3, getAddMemoInstruction } from '@solana-program/memo';
import {
  appendTransactionMessageInstruction,
  type Address,
  type KeyPairSigner,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import type { Client } from './client.js';

export interface RunStartMemoPayload {
  run_id: string;
  scenario_id: string;
  agent_repo: string;
  agent_commit: string;
  model_id: string;
  evaluator_commit: string;
  fixture_hash: string;
}

export function buildRunStartMemoText(payload: RunStartMemoPayload): string {
  return `itera-run:v1:${JSON.stringify(payload)}`;
}

/**
 * Builds a run-start Memo transaction, signs it with the hot signer (the fee payer), and returns
 * it in the still-partially-signed wire format — the user's signature slot is present but empty,
 * ready for the browser to fill via `wallet.signTransaction`.
 */
export async function buildPartiallySignedRunStartTx(
  client: Client,
  hotSigner: KeyPairSigner,
  userWallet: Address,
  payload: RunStartMemoPayload,
): Promise<{ wireTransactionBase64: string; memo: string }> {
  const memo = buildRunStartMemoText(payload);
  const memoIx = getAddMemoInstruction(
    { memo, signers: [createNoopSigner(userWallet)] },
    { programAddress: LEGACY_MEMO_PROGRAM_ADDRESS_V3 },
  );

  const { value: latestBlockhash } = await client.rpc.getLatestBlockhash().send();

  const message = appendTransactionMessageInstruction(
    memoIx,
    setTransactionMessageLifetimeUsingBlockhash(
      latestBlockhash,
      setTransactionMessageFeePayerSigner(hotSigner, createTransactionMessage({ version: 0 })),
    ),
  );

  // Signs with every TransactionSigner the message references that CAN sign: the hot signer
  // (a real KeyPairSigner) produces a real signature; the noop signer for userWallet produces an
  // empty one, leaving that slot for the browser to fill.
  const partiallySigned = await partiallySignTransactionMessageWithSigners(message);
  return { wireTransactionBase64: getBase64EncodedWireTransaction(partiallySigned), memo };
}

/** Submits a FULLY signed (hot signer + user wallet) wire transaction and returns its signature. */
export async function submitSignedRunStartTx(client: Client, wireTransactionBase64: string): Promise<string> {
  const signature = await client.rpc
    .sendTransaction(wireTransactionBase64 as Parameters<Client['rpc']['sendTransaction']>[0], {
      encoding: 'base64',
      preflightCommitment: 'confirmed',
    })
    .send();
  return signature;
}
