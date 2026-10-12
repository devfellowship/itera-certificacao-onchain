/**
 * Price inputs of the ranking rows (U8): the run price in USD (ADR-1, config, never in the UI) and
 * an indicative SOL/USD rate for "Run · x SOL". The quote of POST /evaluations/quote (U7) stays the
 * only binding price: screen 03 re-quotes before any transfer.
 */
export const DEFAULT_RUN_PRICE_USD = 0.1;

export function runPriceUsd(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ITERA_RUN_PRICE_USD ?? env.RUN_PRICE_USD;
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RUN_PRICE_USD;
}

export interface SolUsdRate {
  rate: number;
  source: string;
  at: string;
}

export interface SolPriceSource {
  /** null when no source answers: the rows then carry USD only (runCostSol = null). */
  solUsd(): Promise<SolUsdRate | null>;
}

const CACHE_MS = 60_000;
const TIMEOUT_MS = 2_000;

/**
 * CoinGecko simple price, cached 60 s. Pyth Hermes (the quote's first source) answers 401 without
 * an API key from this network (checked 2026-10-12), so an indicative rate uses CoinGecko only.
 */
export class CoinGeckoSolPriceSource implements SolPriceSource {
  private cached: { value: SolUsdRate; at: number } | null = null;

  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async solUsd(): Promise<SolUsdRate | null> {
    if (this.cached && Date.now() - this.cached.at < CACHE_MS) return this.cached.value;
    try {
      const res = await this.fetchFn("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", {
        headers: { Accept: "application/json", "User-Agent": "itera-agent-credentials-api" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return this.stale();
      const body = (await res.json()) as { solana?: { usd?: number } };
      const rate = body.solana?.usd;
      if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return this.stale();
      const value = { rate, source: "coingecko", at: new Date().toISOString() };
      this.cached = { value, at: Date.now() };
      return value;
    } catch {
      return this.stale();
    }
  }

  /** A rate up to 10 min old is still a fair hint for a button label; older is dropped. */
  private stale(): SolUsdRate | null {
    return this.cached && Date.now() - this.cached.at < 10 * CACHE_MS ? this.cached.value : null;
  }
}

/** Lamports for a USD amount at a rate (integer, rounded half up). */
export function usdToLamports(usd: number, solUsdRate: number): number {
  return Math.round((usd / solUsdRate) * 1e9);
}

/** 917431 → "0.000917431"; trailing zeros dropped, at least one decimal. */
export function lamportsToSol(lamports: number): string {
  const whole = Math.floor(lamports / 1e9);
  const frac = String(lamports % 1e9).padStart(9, "0").replace(/0+$/, "");
  return `${whole}.${frac || "0"}`;
}
