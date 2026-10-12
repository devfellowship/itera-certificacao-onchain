import { readFile } from "node:fs/promises";
import { createKeyPairSignerFromBytes, createSolanaRpc, type KeyPairSigner, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { createClient } from "@solana/kit";
import { solanaDevnetRpc } from "@solana/kit-plugin-rpc";
import { payerFromFile } from "@solana/kit-plugin-signer";
import { hotSignerKeypairPath } from "../config.js";
import { CHAIN } from "./config.js";

/**
 * A client whose payer is the hot signer. The hot signer pays every fee on Samuel's path and is
 * the authorized signer of the Itera Credential, so it is also the attestation authority.
 */
export async function hotSignerClient() {
  return createClient()
    .use(payerFromFile(hotSignerKeypairPath()))
    .use(solanaDevnetRpc({ rpcUrl: CHAIN.RPC_URL, rpcSubscriptionsUrl: CHAIN.WSS_URL }));
}

export type HotSignerClient = Awaited<ReturnType<typeof hotSignerClient>>;

let cachedHotSigner: Promise<KeyPairSigner> | null = null;

/** The hot signer as a standalone KeyPairSigner (memoized per process). */
export function loadHotSigner(): Promise<KeyPairSigner> {
  if (!cachedHotSigner) {
    cachedHotSigner = readFile(hotSignerKeypairPath(), "utf-8").then((raw) =>
      createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(raw) as number[])),
    );
    cachedHotSigner.catch(() => {
      cachedHotSigner = null;
    });
  }
  return cachedHotSigner;
}

/** Read-only RPC. Needs no key. */
export function readRpc(): Rpc<SolanaRpcApi> {
  return createSolanaRpc(CHAIN.RPC_URL);
}
