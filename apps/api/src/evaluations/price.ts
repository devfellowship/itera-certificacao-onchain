/**
 * SOL/USD at quote time (ADR-1): Pyth first (Hermes HTTP API, feed SOL/USD), CoinGecko as the
 * fallback. Both down → PriceUnavailableError → the router answers 503.
 */
export const PYTH_SOL_USD_FEED_ID = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
export const HERMES_URL = process.env.ITERA_PYTH_HERMES_URL ?? "https://hermes.pyth.network";
export const COINGECKO_URL = process.env.ITERA_COINGECKO_URL ?? "https://api.coingecko.com";

/** A Pyth price older than this is stale and not used. */
const MAX_PYTH_AGE_S = 120;
const TIMEOUT_MS = 4_000;

export type PriceSource = "pyth" | "coingecko";

export interface SolUsdQuote {
  solUsdRate: number;
  priceSource: PriceSource;
  /** Publish time of the price (ISO). */
  publishedAt: string;
}

export class PriceUnavailableError extends Error {}

type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

async function getJson(fetchImpl: FetchLike, url: string): Promise<unknown> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

export async function pythSolUsd(fetchImpl: FetchLike = fetch as unknown as FetchLike, nowMs = Date.now()): Promise<SolUsdQuote> {
  const body = (await getJson(fetchImpl, `${HERMES_URL}/v2/updates/price/latest?ids[]=0x${PYTH_SOL_USD_FEED_ID}&parsed=true`)) as {
    parsed?: Array<{ id?: string; price?: { price?: string; expo?: number; publish_time?: number } }>;
  };
  const entry = body.parsed?.find((p) => p.id?.replace(/^0x/, "") === PYTH_SOL_USD_FEED_ID) ?? body.parsed?.[0];
  const p = entry?.price;
  if (!p || typeof p.price !== "string" || typeof p.expo !== "number" || typeof p.publish_time !== "number") {
    throw new Error("pyth: unexpected response shape");
  }
  const rate = Number(p.price) * 10 ** p.expo;
  if (!(rate > 0)) throw new Error("pyth: non-positive price");
  if (nowMs / 1000 - p.publish_time > MAX_PYTH_AGE_S) throw new Error("pyth: stale price");
  return { solUsdRate: round6(rate), priceSource: "pyth", publishedAt: new Date(p.publish_time * 1000).toISOString() };
}

export async function coinGeckoSolUsd(fetchImpl: FetchLike = fetch as unknown as FetchLike, nowMs = Date.now()): Promise<SolUsdQuote> {
  const body = (await getJson(fetchImpl, `${COINGECKO_URL}/api/v3/simple/price?ids=solana&vs_currencies=usd`)) as {
    solana?: { usd?: number };
  };
  const rate = body.solana?.usd;
  if (typeof rate !== "number" || !(rate > 0)) throw new Error("coingecko: unexpected response shape");
  return { solUsdRate: round6(rate), priceSource: "coingecko", publishedAt: new Date(nowMs).toISOString() };
}

export type SolUsdProvider = () => Promise<SolUsdQuote>;

/** Pyth, then CoinGecko. Throws PriceUnavailableError naming both causes. */
export function solUsdProvider(fetchImpl: FetchLike = fetch as unknown as FetchLike): SolUsdProvider {
  return async () => {
    const errors: string[] = [];
    try {
      return await pythSolUsd(fetchImpl);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
    try {
      return await coinGeckoSolUsd(fetchImpl);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
    throw new PriceUnavailableError(`SOL/USD price unavailable (${errors.join("; ")})`);
  };
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
