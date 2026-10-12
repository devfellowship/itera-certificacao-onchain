import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { databaseUrl } from "../config.js";

let pool: Pool | null = null;

const __dirname = dirname(fileURLToPath(import.meta.url));
// Supabase's own pooler CA chain (Supavisor, the service behind *.pooler.supabase.com) — NOT an
// AWS RDS cert, despite the underlying Postgres running on RDS; confirmed via
// `openssl s_client -connect aws-1-us-west-2.pooler.supabase.com:5432 -starttls postgres
// -showcerts`, which shows issuer "O=Supabase Inc, CN=Supabase Intermediate 2021 CA" — the AWS
// RDS public bundle does NOT validate against this chain. Captured straight from the pooler host
// (3-cert chain: leaf + intermediate + root) and vendored here so a real certificate-chain check
// (verify-full) works without depending on Node's default trust store, which doesn't include this
// chain on every platform this runs on.
const CA_BUNDLE = readFileSync(join(__dirname, "../../certs/supabase-pooler-ca-bundle.pem"), "utf-8");

/**
 * Lazy singleton — created on first query, not at import time, so `npm run dev`/the test suite
 * don't need DATABASE_URL just to boot the process (only routes that actually touch the DB do).
 *
 * `databaseUrl()` must NOT include a `sslmode` query param: `pg` parses the connection string via
 * `pg-connection-string` and merges `Object.assign({}, explicitConfig, parsedConnectionString)` —
 * the parsed string wins over an explicitly-passed `ssl` object whenever `sslmode` is present,
 * silently discarding the CA config below. Keeping TLS mode out of the URL and only in this object
 * is the only way for `ca` here to actually take effect.
 */
export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: databaseUrl(), ssl: { ca: CA_BUNDLE } });
  }
  return pool;
}
