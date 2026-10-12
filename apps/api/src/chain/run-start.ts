/**
 * Run-start Memo (Samuel's path, step 1). Moved here from services/run-issuer/src/run-start-tx.ts
 * so the API owns it and the memo carries the API runId.
 *
 * Flow:
 *   1. `buildRunStartTx(...)` — the API builds a Memo tx, the hot signer pays and signs it, and the
 *      user's wallet is a required signer with an empty slot. The browser receives the wire tx.
 *   2. The wallet signs the tx (`signTransaction`) in the browser.
 *   3. `submitRunStart(wireTxB64, runId, {ownerWallet})` — the API proves that the tx is exactly a
 *      tx it built for THIS run (see `verifyRunStartTx`), relays it, and waits for confirmation.
 *
 * services/run-issuer relayed any tx it received. This module refuses every tx that the hot
 * signer did not sign, that holds anything but one Memo instruction, or whose memo names a
 * different run or a different wallet.
 */
import { LEGACY_MEMO_PROGRAM_ADDRESS_V3, getAddMemoInstruction } from "@solana-program/memo";
import {
  appendTransactionMessageInstruction,
  createNoopSigner,
  createTransactionMessage,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  getUtf8Decoder,
  isAddress,
  partiallySignTransactionMessageWithSigners,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  verifySignature,
  type Address,
  type Base64EncodedWireTransaction,
  type KeyPairSigner,
  type Rpc,
  type Signature,
  type SignatureBytes,
  type SolanaRpcApi,
} from "@solana/kit";
import { loadHotSigner, readRpc } from "./client.js";
import { RUN_START_MEMO_PREFIX } from "./config.js";

export interface RunStartMemoPayload {
  run_id: string;
  scenario_id: string;
  agent_repo: string;
  agent_commit: string;
  model_id: string;
  evaluator_commit: string;
  fixture_hash: string;
}

export interface BuildRunStartTxInput {
  runId: string;
  userWallet: string;
  agentRepo: string;
  agentCommit: string;
  modelId: string;
  evaluatorCommit: string;
  fixtureHash: string;
  scenarioId: string;
}

export interface RunStartTx {
  wireTransactionBase64: string;
  memo: string;
}

export class RunStartError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_input" | "invalid_tx" | "wrong_run" | "wrong_wallet" | "send_failed" | "not_confirmed",
  ) {
    super(message);
  }
}

/** Fixed key order — the memo text is deterministic for one input. */
export function buildRunStartMemoText(input: BuildRunStartTxInput): string {
  const payload: RunStartMemoPayload = {
    run_id: input.runId,
    scenario_id: input.scenarioId,
    agent_repo: input.agentRepo,
    agent_commit: input.agentCommit,
    model_id: input.modelId,
    evaluator_commit: input.evaluatorCommit,
    fixture_hash: input.fixtureHash,
  };
  return `${RUN_START_MEMO_PREFIX}${JSON.stringify(payload)}`;
}

export function parseRunStartMemo(memo: string): RunStartMemoPayload | null {
  if (!memo.startsWith(RUN_START_MEMO_PREFIX)) return null;
  try {
    const parsed = JSON.parse(memo.slice(RUN_START_MEMO_PREFIX.length)) as Record<string, unknown>;
    if (typeof parsed.run_id !== "string" || typeof parsed.scenario_id !== "string") return null;
    return parsed as unknown as RunStartMemoPayload;
  } catch {
    return null;
  }
}

/** A legacy Memo tx is limited to 1232 bytes; the memo text must stay well under that. */
const MAX_MEMO_BYTES = 700;

export interface RunStartDeps {
  rpc?: Rpc<SolanaRpcApi>;
  hotSigner?: KeyPairSigner;
}

/**
 * Builds the run-start Memo tx. The hot signer pays and signs. The user's signature slot stays
 * empty for the wallet to fill.
 */
export async function buildRunStartTx(input: BuildRunStartTxInput, deps: RunStartDeps = {}): Promise<RunStartTx> {
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string" || value.length === 0) {
      throw new RunStartError(`buildRunStartTx: ${key} is required`, "invalid_input");
    }
  }
  if (!isAddress(input.userWallet)) {
    throw new RunStartError("buildRunStartTx: userWallet is not a base58 Solana address", "invalid_input");
  }
  const memo = buildRunStartMemoText(input);
  if (new TextEncoder().encode(memo).length > MAX_MEMO_BYTES) {
    throw new RunStartError(`buildRunStartTx: memo is longer than ${MAX_MEMO_BYTES} bytes`, "invalid_input");
  }

  const hotSigner = deps.hotSigner ?? (await loadHotSigner());
  const rpc = deps.rpc ?? readRpc();
  const memoIx = getAddMemoInstruction(
    { memo, signers: [createNoopSigner(input.userWallet as Address)] },
    { programAddress: LEGACY_MEMO_PROGRAM_ADDRESS_V3 },
  );
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
  const message = appendTransactionMessageInstruction(
    memoIx,
    setTransactionMessageLifetimeUsingBlockhash(
      latestBlockhash,
      setTransactionMessageFeePayerSigner(hotSigner, createTransactionMessage({ version: 0 })),
    ),
  );
  const partiallySigned = await partiallySignTransactionMessageWithSigners(message);
  return { wireTransactionBase64: getBase64EncodedWireTransaction(partiallySigned), memo };
}

export interface VerifiedRunStartTx {
  memo: string;
  payload: RunStartMemoPayload;
  userWallet: string;
}

/**
 * Proves that `wireTxB64` is a run-start tx this API built for `runId`, now signed by the user.
 * Pure: no RPC. Throws RunStartError on any mismatch.
 *
 * The hot signer's signature is the key check: only this API holds that key, so a valid hot-signer
 * signature over the message bytes proves that the message is byte-for-byte one we built.
 */
export async function verifyRunStartTx(
  wireTxB64: string,
  runId: string,
  hotSignerAddress: Address,
  opts: { ownerWallet?: string } = {},
): Promise<VerifiedRunStartTx> {
  let tx;
  let message;
  try {
    tx = getTransactionDecoder().decode(getBase64Encoder().encode(wireTxB64));
    message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  } catch (error) {
    throw new RunStartError(`not a valid wire transaction: ${error instanceof Error ? error.message : String(error)}`, "invalid_tx");
  }

  if (message.version !== 0) {
    throw new RunStartError("expected a v0 transaction message", "invalid_tx");
  }
  const accounts = message.staticAccounts;
  if (message.header.numSignerAccounts !== 2 || accounts.length < 3) {
    throw new RunStartError("expected exactly two signers (hot signer + user wallet)", "invalid_tx");
  }
  if (accounts[0] !== hotSignerAddress) {
    throw new RunStartError("fee payer is not the Itera hot signer", "invalid_tx");
  }
  const userWallet = accounts[1];

  const hotSig = tx.signatures[hotSignerAddress];
  if (!hotSig || !(await verifySignature(await getPublicKeyFromAddress(hotSignerAddress), hotSig as SignatureBytes, tx.messageBytes))) {
    throw new RunStartError("the hot signer signature is missing or invalid — this tx was not built by this API", "invalid_tx");
  }
  const userSig = tx.signatures[userWallet];
  if (!userSig || userSig.every((byte) => byte === 0)) {
    throw new RunStartError("the user wallet has not signed the tx", "invalid_tx");
  }
  if (!(await verifySignature(await getPublicKeyFromAddress(userWallet), userSig as SignatureBytes, tx.messageBytes))) {
    throw new RunStartError("the user wallet signature is invalid", "invalid_tx");
  }

  if (message.instructions.length !== 1) {
    throw new RunStartError("expected exactly one instruction (the Memo)", "invalid_tx");
  }
  const [ix] = message.instructions;
  if (accounts[ix.programAddressIndex] !== LEGACY_MEMO_PROGRAM_ADDRESS_V3) {
    throw new RunStartError("the instruction is not a Memo", "invalid_tx");
  }
  const memo = getUtf8Decoder().decode(ix.data ?? new Uint8Array());
  const payload = parseRunStartMemo(memo);
  if (!payload) throw new RunStartError(`memo does not start with ${RUN_START_MEMO_PREFIX}`, "invalid_tx");
  if (payload.run_id !== runId) {
    throw new RunStartError(`memo is for run ${payload.run_id}, not ${runId}`, "wrong_run");
  }
  if (opts.ownerWallet && userWallet !== opts.ownerWallet) {
    throw new RunStartError("the tx is signed by a wallet that does not own this run", "wrong_wallet");
  }
  return { memo, payload, userWallet };
}

export interface SubmittedRunStart extends VerifiedRunStartTx {
  signature: string;
}

/**
 * Verifies, relays and waits for `confirmed`. Returns the tx signature (= `runs.run_start_sig`).
 * The NFT nonce is sha256(signature), so the signature must be final before any proof uses it.
 */
export async function submitRunStart(
  wireTxB64: string,
  runId: string,
  opts: { ownerWallet?: string; timeoutMs?: number } & RunStartDeps = {},
): Promise<SubmittedRunStart> {
  const hotSigner = opts.hotSigner ?? (await loadHotSigner());
  const rpc = opts.rpc ?? readRpc();
  const verified = await verifyRunStartTx(wireTxB64, runId, hotSigner.address, { ownerWallet: opts.ownerWallet });

  let signature: Signature;
  try {
    signature = await rpc
      .sendTransaction(wireTxB64 as Base64EncodedWireTransaction, { encoding: "base64", preflightCommitment: "confirmed" })
      .send();
  } catch (error) {
    throw new RunStartError(`devnet rejected the tx: ${error instanceof Error ? error.message : String(error)}`, "send_failed");
  }

  const deadline = Date.now() + (opts.timeoutMs ?? 45_000);
  while (Date.now() < deadline) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (status?.err) throw new RunStartError(`tx ${signature} failed on chain: ${JSON.stringify(status.err)}`, "send_failed");
    if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) {
      return { ...verified, signature };
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new RunStartError(`tx ${signature} was sent but not confirmed in time`, "not_confirmed");
}

/** Re-encodes raw bytes as base64 — a small helper for tests and scripts. */
export function toBase64(bytes: Uint8Array): string {
  return getBase64Decoder().decode(bytes);
}
