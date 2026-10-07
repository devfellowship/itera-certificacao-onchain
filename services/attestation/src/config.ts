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
