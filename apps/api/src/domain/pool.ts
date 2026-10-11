import { Pool } from "pg";
import { databaseUrl } from "../config.js";

let pool: Pool | null = null;

/**
 * Lazy singleton — created on first query, not at import time, so `npm run dev`/the test suite
 * don't need DATABASE_URL just to boot the process (only routes that actually touch the DB do).
 * Supabase's pooled connection requires TLS; rejectUnauthorized is off because Supabase's pooler
 * cert chain isn't in Node's default trust store on every platform this runs on (same tradeoff
 * Supabase's own connection examples make).
 */
export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: databaseUrl(), ssl: { rejectUnauthorized: false } });
  }
  return pool;
}
