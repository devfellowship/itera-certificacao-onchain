import { createClient, type KeyPairSigner } from '@solana/kit';
import { solanaDevnetRpc } from '@solana/kit-plugin-rpc';
import { readFile } from 'node:fs/promises';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { CONFIG } from './config.js';

export type Client = Awaited<ReturnType<typeof setupClient>>;

/** Plain RPC client — no payer bound here, since the fee payer for run-start txs is the hot
 * signer loaded separately (see loadHotSigner), never a client-wide default. */
export async function setupClient() {
  return createClient().use(
    solanaDevnetRpc({ rpcUrl: CONFIG.HTTP_CONNECTION_URL, rpcSubscriptionsUrl: CONFIG.WSS_CONNECTION_URL }),
  );
}

/** Same loader as services/attestation/src/client.ts's loadHotSigner — duplicated rather than
 * cross-imported to keep this service's dependency surface independent (same reasoning as
 * services/attestation/src/manifest.ts's EvidenceManifestSummary duplication). */
export async function loadHotSigner(path: string): Promise<KeyPairSigner> {
  const raw = JSON.parse(await readFile(path, 'utf-8')) as number[];
  return createKeyPairSignerFromBytes(new Uint8Array(raw));
}
