import { describe, expect, it, vi } from "vitest";
import { openRouterPrices, parsePriceList } from "./model-prices.js";

const LIST = { data: [{ id: "qwen/qwen3-coder", pricing: { prompt: "0.00000022", completion: "0.00000095" } }, { id: "broken", pricing: {} }] };

describe("model prices", () => {
  it("parses OpenRouter's public model list (USD per token, as strings)", () => {
    const prices = parsePriceList(LIST);
    expect(prices.get("qwen/qwen3-coder")).toEqual({ prompt: 0.00000022, completion: 0.00000095 });
    expect(prices.has("broken")).toBe(false);
  });

  it("caches for one hour and answers null when the fetch fails", async () => {
    let t = 0;
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(LIST))) as unknown as typeof fetch;
    const lookup = openRouterPrices(fetchFn, () => t);
    expect(await lookup("qwen/qwen3-coder")).not.toBeNull();
    expect(await lookup("qwen/qwen3-coder")).not.toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    t += 61 * 60 * 1000;
    await lookup("x");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const failing = openRouterPrices((async () => { throw new Error("offline"); }) as unknown as typeof fetch);
    expect(await failing("qwen/qwen3-coder")).toBeNull();
  });
});
