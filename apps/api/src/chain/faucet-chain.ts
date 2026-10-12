/**
 * Chain side of the devnet faucet (U37): balances, a devnet check and a plain SOL transfer from the
 * hot signer. web3.js v1, like evaluations/solana-pay.ts (already a dependency of this API).
 */
import { readFile } from "node:fs/promises";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { hotSignerKeypairPath } from "../config.js";
import { CHAIN } from "./config.js";

/** Genesis hash of Solana devnet. Any other cluster (mainnet-beta, testnet, a local validator) is refused. */
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export interface FaucetChain {
  rpcUrl: string;
  genesisHash(): Promise<string>;
  balance(address: string): Promise<number>;
  signerAddress(): Promise<string>;
  /** Sends `lamports` from the hot signer to `to`; resolves with the confirmed signature. */
  transfer(to: string, lamports: number): Promise<string>;
}

export class Web3FaucetChain implements FaucetChain {
  private readonly connection: Connection;
  private signer: Promise<Keypair> | null = null;

  constructor(readonly rpcUrl: string = CHAIN.RPC_URL) {
    this.connection = new Connection(rpcUrl, "confirmed");
  }

  private keypair(): Promise<Keypair> {
    if (!this.signer) {
      this.signer = readFile(hotSignerKeypairPath(), "utf-8").then((raw) => Keypair.fromSecretKey(new Uint8Array(JSON.parse(raw) as number[])));
      this.signer.catch(() => (this.signer = null));
    }
    return this.signer;
  }

  genesisHash() {
    return this.connection.getGenesisHash();
  }

  balance(address: string) {
    return this.connection.getBalance(new PublicKey(address), "confirmed");
  }

  async signerAddress() {
    return (await this.keypair()).publicKey.toBase58();
  }

  async transfer(to: string, lamports: number) {
    const from = await this.keypair();
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: new PublicKey(to), lamports }));
    return sendAndConfirmTransaction(this.connection, tx, [from], { commitment: "confirmed" });
  }
}
