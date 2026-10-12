/**
 * Evaluations and the SOL fee (plan 20261012-itera-testmyagent-ui-refactor, ADR-1, ADR-2, Gate Q1/Q2).
 * Every value is env-overridable. The UI never hard-codes a price: it reads the quote.
 */
export interface EvaluationsConfig {
  /** US$ per run (one agent × one task). ADR-1: 0.10. */
  runPriceUsd: number;
  /** Quote window. ADR-1: 120 s. */
  quoteTtlMs: number;
  /** Accept a transfer whose block time is at most this much after the quote expiry (clock skew). */
  quoteGraceMs: number;
  /** ITERA-owned devnet address that receives the fee. Absent → quote answers 503. */
  treasury: string | null;
  /** Runs per wallet per 24 h across evaluations, checked at quote time (before the user pays). */
  runsPerWalletPerDay: number;
  /** Tasks per evaluation. Bounded by the size of the one payment tx (transfer + Memo). */
  maxTasks: number;
  /** Public web origin, for share URLs. */
  webBaseUrl: string;
}

export function evaluationsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EvaluationsConfig {
  return {
    runPriceUsd: Number(env.ITERA_RUN_PRICE_USD ?? 0.1),
    quoteTtlMs: Number(env.ITERA_QUOTE_TTL_MS ?? 120_000),
    quoteGraceMs: Number(env.ITERA_QUOTE_GRACE_MS ?? 15_000),
    treasury: env.ITERA_TREASURY_ADDRESS?.trim() || null,
    runsPerWalletPerDay: Number(env.ITERA_EVALUATION_RUNS_PER_WALLET_PER_DAY ?? 30),
    maxTasks: Number(env.ITERA_EVALUATION_MAX_TASKS ?? 9),
    webBaseUrl: (env.ITERA_PUBLIC_WEB_BASE_URL ?? "https://itera-agent-credentials.devfellowship.com").replace(/\/+$/, ""),
  };
}

export const LAMPORTS_PER_SOL = 1_000_000_000;

/** USD → lamports at a SOL/USD rate, rounded up so ITERA never receives less than the price. */
export function usdToLamports(usd: number, solUsdRate: number): number {
  if (!(usd > 0) || !(solUsdRate > 0)) throw new Error("usd and solUsdRate must be positive");
  return Math.ceil((usd / solUsdRate) * LAMPORTS_PER_SOL);
}

/** Lamports as a SOL decimal string with 9 decimals, trailing zeros trimmed. */
export function lamportsToSol(lamports: number): string {
  const whole = Math.floor(lamports / LAMPORTS_PER_SOL);
  const frac = String(lamports % LAMPORTS_PER_SOL).padStart(9, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

/** Money to 4 decimals (numeric(10,4)). */
export function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
