/**
 * Solana Pay (`@solana/pay`) for the fee: the transfer request (recipient = ITERA treasury, amount =
 * the quoted lamports, reference = a fresh key per quote, memo = the evaluation Memo), and the
 * server-side check `validateTransfer` before any run is queued.
 *
 * @solana/pay 0.2.x (web3.js v1) is used on purpose: 1.x peers on @solana/kit ^6 and this API is
 * on kit 8. Only this file touches web3.js v1. The `solana_pay` payment adapter
 * (`solana-pay.ts`) is its only caller in the run flow.
 */
import { createTransfer, encodeURL, findReference, validateTransfer, ValidateTransferError } from "@solana/pay";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import BigNumber from "bignumber.js";
import { LAMPORTS_PER_SOL } from "../../evaluations/config.js";

export interface TransferFields {
  recipient: string;
  lamports: number;
  reference: string;
  memo: string;
}

export type VerifyResult =
  | { ok: true; txSig: string; payer: string | null; blockTimeMs: number | null }
  | { ok: false; code: "not_found" | "invalid"; message: string };

export interface PaymentGateway {
  newReference(): string;
  transferUrl(fields: TransferFields & { label: string; message: string }): string;
  /** Unsigned legacy tx (fee payer = `payer`, the only signer): [Memo, transfer + reference]. Base64. */
  buildTransferTx(payer: string, fields: TransferFields): Promise<string>;
  /** Finds the tx by reference when `txSig` is absent, then validates it. */
  verify(fields: TransferFields, txSig: string | null): Promise<VerifyResult>;
}

function solAmount(lamports: number): BigNumber {
  return new BigNumber(lamports).div(LAMPORTS_PER_SOL);
}

export class SolanaPayGateway implements PaymentGateway {
  private readonly connection: Connection;

  constructor(rpcUrl: string = process.env.ITERA_SOLANA_RPC_URL ?? "https://api.devnet.solana.com") {
    this.connection = new Connection(rpcUrl, "confirmed");
  }

  newReference(): string {
    return Keypair.generate().publicKey.toBase58();
  }

  transferUrl(f: TransferFields & { label: string; message: string }): string {
    return encodeURL({
      recipient: new PublicKey(f.recipient),
      amount: solAmount(f.lamports),
      reference: new PublicKey(f.reference),
      memo: f.memo,
      label: f.label,
      message: f.message,
    }).toString();
  }

  async buildTransferTx(payer: string, f: TransferFields): Promise<string> {
    const tx = await createTransfer(this.connection, new PublicKey(payer), {
      recipient: new PublicKey(f.recipient),
      amount: solAmount(f.lamports),
      reference: new PublicKey(f.reference),
      memo: f.memo,
    });
    return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  }

  async verify(f: TransferFields, txSig: string | null): Promise<VerifyResult> {
    let signature = txSig;
    if (!signature) {
      try {
        signature = (await findReference(this.connection, new PublicKey(f.reference), { finality: "confirmed" })).signature;
      } catch {
        return { ok: false, code: "not_found", message: "no transaction with this quote's reference yet" };
      }
    }
    try {
      const response = await validateTransfer(
        this.connection,
        signature,
        { recipient: new PublicKey(f.recipient), amount: solAmount(f.lamports), reference: new PublicKey(f.reference), memo: f.memo },
        { commitment: "confirmed" },
      );
      const payer = response.transaction.message.accountKeys[0]?.toBase58() ?? null;
      return { ok: true, txSig: signature, payer, blockTimeMs: response.blockTime ? response.blockTime * 1000 : null };
    } catch (e) {
      if (e instanceof ValidateTransferError && e.message === "not found") {
        return { ok: false, code: "not_found", message: "transaction not found or not confirmed yet" };
      }
      const message = e instanceof Error ? e.message : typeof e === "object" ? JSON.stringify(e) : String(e);
      return { ok: false, code: "invalid", message: `payment does not match the quote: ${message}` };
    }
  }
}
