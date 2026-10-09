export const CONFIG = {
  HTTP_CONNECTION_URL: 'https://api.devnet.solana.com',
  WSS_CONNECTION_URL: 'wss://api.devnet.solana.com',
  PORT: Number(process.env.PORT ?? 8787),
  // Allowed origin for the apps/web dev server and prod deployment. '*' in dev is fine (no
  // cookies/credentials involved, every request is explicit JSON); narrow this once the prod
  // apps/web origin is fixed.
  CORS_ORIGIN: process.env.ITERA_RUN_ISSUER_CORS_ORIGIN ?? '*',
} as const;

/**
 * Same split as services/attestation/src/config.ts: the hot signer is a key separate from any
 * setup-only authority, used here as both fee payer AND the account that must eventually
 * co-sign/attest the run. No default path — forgetting to set it fails loud.
 */
export function hotSignerKeypairPath(): string {
  const path = process.env.ITERA_HOT_SIGNER_KEYPAIR_PATH;
  if (!path) {
    throw new Error(
      'ITERA_HOT_SIGNER_KEYPAIR_PATH is not set. Generate one with `solana-keygen new ' +
        '--outfile <path> --no-bip39-passphrase` (or reuse the one from services/attestation setup) ' +
        'and point this env var at it before starting the server.',
    );
  }
  return path;
}
