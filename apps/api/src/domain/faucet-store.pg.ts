import type { Pool } from "pg";
import { SchemaNotReadyError } from "./runs-store.js";
import { FAUCET_MIGRATION, type FaucetGrant, type FaucetStore, type ReserveResult } from "./faucet-store.js";

const MISSING_SCHEMA_CODES = new Set(["42P01", "42703"]);

function rethrow(e: unknown): never {
  const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : undefined;
  if (code && MISSING_SCHEMA_CODES.has(code)) throw new SchemaNotReadyError(FAUCET_MIGRATION, e);
  throw e;
}

type Row = { id: string; wallet: string; lamports: string | number; status: FaucetGrant["status"]; tx_sig: string | null; error: string | null; created_at: Date };

const toGrant = (r: Row): FaucetGrant => ({
  id: r.id,
  wallet: r.wallet,
  lamports: Number(r.lamports),
  status: r.status,
  txSig: r.tx_sig,
  error: r.error,
  createdAt: r.created_at.toISOString(),
});

/** Both limits are checked under one transaction-scoped advisory lock, so two requests cannot both pass. */
export class PgFaucetStore implements FaucetStore {
  constructor(private readonly pool: () => Pool) {}

  async reserve(input: { wallet: string; lamports: number; windowMs: number; capLamports: number; now?: Date }): Promise<ReserveResult> {
    const c = await this.pool().connect();
    try {
      await c.query("begin");
      await c.query("select pg_advisory_xact_lock(hashtext('itera_faucet_grants'))");
      const since = new Date((input.now ?? new Date()).getTime() - input.windowMs);
      const mine = await c.query<Row>(
        `select * from public.faucet_grants where wallet = $1 and status <> 'failed' and created_at > $2 order by created_at desc limit 1`,
        [input.wallet, since],
      );
      if (mine.rows[0]) {
        await c.query("rollback");
        return { ok: false, reason: "wallet_recent", nextAt: new Date(mine.rows[0].created_at.getTime() + input.windowMs).toISOString() };
      }
      const used = await c.query<{ s: string }>(
        `select coalesce(sum(lamports), 0)::text as s from public.faucet_grants where status <> 'failed' and created_at > $1`,
        [since],
      );
      if (Number(used.rows[0]!.s) + input.lamports > input.capLamports) {
        await c.query("rollback");
        return { ok: false, reason: "daily_cap" };
      }
      const ins = await c.query<Row>(`insert into public.faucet_grants (wallet, lamports) values ($1, $2) returning *`, [input.wallet, input.lamports]);
      await c.query("commit");
      return { ok: true, grant: toGrant(ins.rows[0]!) };
    } catch (e) {
      await c.query("rollback").catch(() => undefined);
      rethrow(e);
    } finally {
      c.release();
    }
  }

  async complete(id: string, txSig: string) {
    await this.pool()
      .query(`update public.faucet_grants set status = 'sent', tx_sig = $2, completed_at = now() where id = $1`, [id, txSig])
      .catch(rethrow);
  }

  async fail(id: string, error: string) {
    await this.pool()
      .query(`update public.faucet_grants set status = 'failed', error = left($2, 500), completed_at = now() where id = $1`, [id, error])
      .catch(rethrow);
  }

  async lastGrant(wallet: string) {
    const r = await this.pool()
      .query<Row>(`select * from public.faucet_grants where wallet = $1 and status <> 'failed' order by created_at desc limit 1`, [wallet])
      .catch(rethrow);
    return r.rows[0] ? toGrant(r.rows[0]) : null;
  }
}
