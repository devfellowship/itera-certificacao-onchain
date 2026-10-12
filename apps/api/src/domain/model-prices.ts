/**
 * OpenRouter list prices (USD per token), read from the public model list
 * `GET https://openrouter.ai/api/v1/models` (no key). Cached in memory for one hour.
 * Used only by GET /models/:id/estimate when a (task, model) has no recorded run cost yet.
 */
export interface ModelPrice {
  /** USD per prompt token. */
  prompt: number;
  /** USD per completion token. */
  completion: number;
}

export type PriceLookup = (modelId: string) => Promise<ModelPrice | null>;

const MODELS_URL = "https://openrouter.ai/api/v1/models";
const TTL_MS = 60 * 60 * 1000;

export function parsePriceList(doc: unknown): Map<string, ModelPrice> {
  const out = new Map<string, ModelPrice>();
  const data = (doc as { data?: unknown })?.data;
  if (!Array.isArray(data)) return out;
  for (const m of data) {
    const id = (m as { id?: unknown })?.id;
    const p = (m as { pricing?: { prompt?: unknown; completion?: unknown } })?.pricing;
    const prompt = Number(p?.prompt);
    const completion = Number(p?.completion);
    if (typeof id === "string" && Number.isFinite(prompt) && Number.isFinite(completion) && prompt >= 0 && completion >= 0) {
      out.set(id, { prompt, completion });
    }
  }
  return out;
}

/** A cached PriceLookup over OpenRouter's public model list. A failed fetch answers null (no price). */
export function openRouterPrices(fetchFn: typeof fetch = fetch, now: () => number = Date.now): PriceLookup {
  let cache: { at: number; prices: Map<string, ModelPrice> } | null = null;
  let inflight: Promise<Map<string, ModelPrice>> | null = null;
  const load = async (): Promise<Map<string, ModelPrice>> => {
    if (cache && now() - cache.at < TTL_MS) return cache.prices;
    inflight ??= (async () => {
      try {
        const res = await fetchFn(MODELS_URL, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) return cache?.prices ?? new Map<string, ModelPrice>();
        const prices = parsePriceList(await res.json());
        cache = { at: now(), prices };
        return prices;
      } catch {
        return cache?.prices ?? new Map<string, ModelPrice>();
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };
  return async (modelId) => (await load()).get(modelId) ?? null;
}
