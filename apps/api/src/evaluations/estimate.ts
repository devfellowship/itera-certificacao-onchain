/**
 * Forecast price of one run (Tainan TG 20986: "we can predict cost? then charge the forecast"):
 *   price per run = estimated model cost of (task version, model) + base fee, rounded UP to the cent.
 *   No estimate → a flat fallback price.
 * The estimate is the same one GET /models/:id/estimate serves (lane G): the average recorded cost
 * of finished runs of (task, model), else the OpenRouter list price × the default token budget,
 * capped at the per-run cost cap. The runner's per-run hard cap (ITERA_RUN_MAX_COST_USD) still holds.
 */
import type { PriceLookup } from "../domain/model-prices.js";
import type { RunsStore } from "../domain/runs-store.js";
import { DEFAULT_RUN_TOKENS_IN, DEFAULT_RUN_TOKENS_OUT, RUN_MAX_COST_USD } from "../http/runs-router.js";

export interface RunCostEstimate {
  costUsd: number;
  basis: "history" | "list_price";
  sampleSize: number;
}

export type RunCostEstimator = (packId: string, packVersion: string, modelId: string) => Promise<RunCostEstimate | null>;

export function runCostEstimator(runs: Pick<RunsStore, "costStats">, prices: PriceLookup): RunCostEstimator {
  return async (packId, packVersion, modelId) => {
    try {
      const stats = await runs.costStats(packId, packVersion, modelId);
      if (stats.runs > 0 && stats.avgCostUsd !== null) {
        return { costUsd: Math.min(stats.avgCostUsd, RUN_MAX_COST_USD), basis: "history", sampleSize: stats.runs };
      }
    } catch {
      // No history available → list price.
    }
    const price = await prices(modelId).catch(() => null);
    if (!price) return null;
    const cost = price.prompt * DEFAULT_RUN_TOKENS_IN + price.completion * DEFAULT_RUN_TOKENS_OUT;
    return { costUsd: Math.min(cost, RUN_MAX_COST_USD), basis: "list_price", sampleSize: 0 };
  };
}

export interface RunPrice {
  modelCostEstimateUsd: number | null;
  baseFeeUsd: number;
  priceUsd: number;
  basis: "history" | "list_price" | "fallback";
}

/** Rounds up to the cent, tolerant of float noise (0.1 + 0.02 must stay 0.12). */
export function ceilCents(usd: number): number {
  return Math.ceil(Math.round(usd * 1e6) / 1e4) / 100;
}

export function priceRun(estimate: RunCostEstimate | null, baseFeeUsd: number, fallbackPriceUsd: number): RunPrice {
  // No forecast: the whole flat price is the fee, so the itemization still sums to the total.
  if (!estimate) return { modelCostEstimateUsd: null, baseFeeUsd: fallbackPriceUsd, priceUsd: fallbackPriceUsd, basis: "fallback" };
  const cost = Math.round(estimate.costUsd * 1e6) / 1e6;
  return { modelCostEstimateUsd: cost, baseFeeUsd, priceUsd: ceilCents(cost + baseFeeUsd), basis: estimate.basis };
}
