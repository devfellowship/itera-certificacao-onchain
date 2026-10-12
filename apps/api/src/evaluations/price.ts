/**
 * SOL/USD at quote time (ADR-1). Order:
 *   1. Pyth on Solana: the sponsored SOL/USD PriceUpdateV2 account, read with getAccountInfo.
 *   2. Pyth Hermes HTTP API (answers 401 "unauthorized" without a key since 2026-10; kept as a hop).
 *   3. CoinGecko.
 * All down → PriceUnavailableError → the router answers 503.
 */
export const PYTH_SOL_USD_FEED_ID = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
export const HERMES_URL = process.env.ITERA_PYTH_HERMES_URL ?? "https://hermes.pyth.network";
export const COINGECKO_URL = process.env.ITERA_COINGECKO_URL ?? "https://api.coingecko.com";

/** A Pyth price older than this is stale and not used. */
const MAX_PYTH_AGE_S = 120;
const TIMEOUT_MS = 4_000;

export type PriceSource = "pyth" | "coingecko";

/** Pyth push-oracle SOL/USD feed account (shard 0), same address on devnet and mainnet. */
export const PYTH_SOL_USD_ACCOUNT = process.env.ITERA_PYTH_SOL_USD_ACCOUNT ?? "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE";
/** Pyth Solana Receiver program: the owner of every PriceUpdateV2 account. */
export const PYTH_RECEIVER_PROGRAM = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";
const SOLANA_RPC_URL = process.env.ITERA_SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

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

/**
 * PriceUpdateV2 layout (pyth-solana-receiver-sdk): 8 discriminator · 32 write_authority ·
 * verification_level (1 byte tag; Partial = tag 0 + 1 byte num_signatures, Full = tag 1) ·
 * PriceFeedMessage { feed_id 32, price i64, conf u64, exponent i32, publish_time i64, ... }.
 */
export function parsePriceUpdateV2(data: Uint8Array): { feedId: string; price: number; publishTime: number; fullyVerified: boolean } {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 8 + 32;
  const tag = data[o]!;
  o += tag === 0 ? 2 : 1;
  const feedId = Buffer.from(data.subarray(o, o + 32)).toString("hex");
  o += 32;
  const price = view.getBigInt64(o, true);
  const exponent = view.getInt32(o + 16, true);
  const publishTime = Number(view.getBigInt64(o + 20, true));
  return { feedId, price: Number(price) * 10 ** exponent, publishTime, fullyVerified: tag === 1 };
}

export async function pythOnChainSolUsd(fetchImpl: FetchLike = fetch as unknown as FetchLike, nowMs = Date.now()): Promise<SolUsdQuote> {
  const res = await (fetchImpl as unknown as (u: string, i: unknown) => ReturnType<FetchLike>)(SOLANA_RPC_URL, {
    method: "POST",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [PYTH_SOL_USD_ACCOUNT, { encoding: "base64" }] }),
  });
  if (!res.ok) throw new Error(`pyth on-chain: HTTP ${res.status}`);
  const body = (await res.json()) as { result?: { value?: { owner?: string; data?: [string, string] } | null } };
  const acc = body.result?.value;
  if (!acc?.data) throw new Error("pyth on-chain: feed account not found");
  if (acc.owner !== PYTH_RECEIVER_PROGRAM) throw new Error("pyth on-chain: account is not owned by the Pyth receiver");
  const p = parsePriceUpdateV2(Buffer.from(acc.data[0], "base64"));
  if (p.feedId !== PYTH_SOL_USD_FEED_ID) throw new Error("pyth on-chain: wrong feed id");
  if (!(p.price > 0)) throw new Error("pyth on-chain: non-positive price");
  if (nowMs / 1000 - p.publishTime > MAX_PYTH_AGE_S) throw new Error("pyth on-chain: stale price");
  return { solUsdRate: round6(p.price), priceSource: "pyth", publishedAt: new Date(p.publishTime * 1000).toISOString() };
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

/** Pyth on Solana, Pyth Hermes, then CoinGecko. Throws PriceUnavailableError naming every cause. */
export function solUsdProvider(fetchImpl: FetchLike = fetch as unknown as FetchLike): SolUsdProvider {
  return async () => {
    const errors: string[] = [];
    try {
      return await pythOnChainSolUsd(fetchImpl);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
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
