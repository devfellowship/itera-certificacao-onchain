import { SchemaDataType } from '@solana/attestation';

export const CONFIG = {
  HTTP_CONNECTION_URL: 'https://api.devnet.solana.com',
  WSS_CONNECTION_URL: 'wss://api.devnet.solana.com',
  CREDENTIAL_NAME: 'itera-agent-proof',
  SCHEMA_NAME: 'coding-benchmark-score-v1',
  SCHEMA_VERSION: 1,
  SCHEMA_DESCRIPTION: 'Itera coding-agent benchmark result: scenario, patch/fixture hashes, and total score.',
  SCHEMA_LAYOUT: [
    SchemaDataType.String, // scenario_id
    SchemaDataType.String, // fixture_hash
    SchemaDataType.String, // patch_hash
    SchemaDataType.U8, // score_total (0-100)
    SchemaDataType.String, // generated_at (ISO 8601)
  ],
  SCHEMA_FIELDS: ['scenario_id', 'fixture_hash', 'patch_hash', 'score_total', 'generated_at'],
  // 0 = never expires. An evidence manifest is a historical record, not a time-boxed claim.
  ATTESTATION_EXPIRY_DAYS: 0,
} as const;

// Samuel's brief (2026-10-09): the production on-chain record is a TOKENIZED attestation (an
// intransferable NFT in the agent owner's wallet), anchored to this 5-field schema. Validated on
// devnet 2026-10-09 (services/attestation/src/spike-tokenized.ts): tx size 854 bytes, well under
// the 1232-byte tokenized-transaction limit. Do NOT add fields — 12 fields measured 1312 bytes
// and would be rejected. agent_commit/model_id/evaluator_commit/fixture_hash live in the Memo
// (run-start transaction) and the off-chain manifest instead.
export const RUN_RESULT_SCHEMA = {
  NAME: 'run-result-v2',
  VERSION: 1,
  DESCRIPTION:
    'Itera benchmark run result: manifest digest, evidence CID, scenario, score, and the run-start tx signature it binds to.',
  FIELD_NAMES: ['manifest_sha256', 'evidence_cid', 'scenario_id', 'score_total', 'run_start_sig'],
  LAYOUT: [
    SchemaDataType.String, // manifest_sha256
    SchemaDataType.String, // evidence_cid
    SchemaDataType.String, // scenario_id
    SchemaDataType.U8, // score_total (0-100)
    SchemaDataType.String, // run_start_sig
  ],
} as const;

export const TOKEN_CONFIG = {
  NAME: 'Itera Run Result',
  SYMBOL: 'ITERA',
  // Cosmetic only — confirmed against the official SAS example that this uri is never resolved
  // for CreateTokenizedAttestation to succeed, it only affects how a wallet renders the token.
  // Swap for a real pinned {name,symbol,image} JSON when one exists (build-order item 5, IPFS).
  METADATA_URI: 'https://example.com/itera-run-result-metadata.json',
} as const;

/**
 * Path to the hot signer's keypair file — the key that actually signs CreateTokenizedAttestation
 * calls in production. Kept separate from the Credential AUTHORITY (the CLI default keypair,
 * ~/.config/solana/id.json), which per Samuel's brief is only used once during setup
 * (ChangeAuthorizedSigners) and then goes offline. Required via env var on purpose — there is no
 * default path, so forgetting to set it fails loudly instead of silently reusing the authority
 * key as the hot signer.
 */
export function hotSignerKeypairPath(): string {
  const path = process.env.ITERA_HOT_SIGNER_KEYPAIR_PATH;
  if (!path) {
    throw new Error(
      'ITERA_HOT_SIGNER_KEYPAIR_PATH is not set. The hot signer must be a key separate from the ' +
        'Credential authority (which goes offline after setup) — generate one with ' +
        '`solana-keygen new --outfile <path> --no-bip39-passphrase` and point this env var at it.',
    );
  }
  return path;
}
