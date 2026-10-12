import { describe, expect, it } from "vitest";
import { FakeCatalogStore } from "./catalog-store.js";
import { parseOpenRouterModels, syncModels } from "./models-sync.js";

const doc = {
  data: [
    {
      id: "anthropic/claude-haiku-4.5",
      canonical_slug: "anthropic/claude-4.5-haiku-20251001",
      name: "Anthropic: Claude Haiku 4.5",
      created: 1760547638,
      context_length: 200000,
      pricing: { prompt: "0.000001", completion: "0.000005" },
      supported_parameters: ["tools", "temperature"],
    },
    {
      id: "qwen/qwen3-coder:free",
      canonical_slug: "qwen/qwen3-coder-480b-a35b-07-25",
      name: "Qwen: Qwen3 Coder (free)",
      created: 1753230546,
      context_length: 262144,
      pricing: { prompt: "0", completion: "0" },
      supported_parameters: ["temperature"],
    },
    {
      id: "qwen/qwen3-coder",
      canonical_slug: "qwen/qwen3-coder-480b-a35b-07-25",
      name: "Qwen: Qwen3 Coder 480B A35B",
      created: 1753230546,
      context_length: 262144,
      pricing: { prompt: "0.0000003", completion: "0.000001" },
      supported_parameters: ["tools"],
    },
    { id: "openrouter/auto", name: "Auto Router", pricing: { prompt: "-1", completion: "-1" } },
    { id: 42, name: "broken" },
  ],
};

describe("parseOpenRouterModels", () => {
  it("maps provider, label, prices per 1M, tools and the canonical release", () => {
    const models = parseOpenRouterModels(doc);
    expect(models.map((m) => m.id)).toEqual(["anthropic/claude-haiku-4.5", "qwen/qwen3-coder:free", "qwen/qwen3-coder", "openrouter/auto"]);
    expect(models[0]).toEqual({
      id: "anthropic/claude-haiku-4.5",
      label: "Claude Haiku 4.5",
      provider: "Anthropic",
      contextLength: 200000,
      promptPriceUsdPerM: 1,
      completionPriceUsdPerM: 5,
      supportsTools: true,
      createdAt: "2025-10-15T17:00:38.000Z",
      release: { id: "anthropic/claude-4.5-haiku-20251001", releasedAt: "2025-10-15T17:00:38.000Z" },
    });
    // The base id keeps the shared canonical slug; the ":free" variant uses its own id.
    expect(models[2]!.release.id).toBe("qwen/qwen3-coder-480b-a35b-07-25");
    expect(models[1]!.release.id).toBe("qwen/qwen3-coder:free");
    expect(models[1]!.supportsTools).toBe(false);
    expect(models[3]).toMatchObject({ promptPriceUsdPerM: null, release: { id: "openrouter/auto" } });
  });

  it("refuses a document without data[]", () => {
    expect(() => parseOpenRouterModels({})).toThrow();
  });
});

describe("syncModels", () => {
  const fetchOk = (async () => new Response(JSON.stringify(doc), { status: 200 })) as typeof fetch;

  it("new models arrive disabled; the allow-list and labels stay; releases move to the canonical slug", async () => {
    const store = new FakeCatalogStore();
    store.models = [
      {
        id: "anthropic/claude-haiku-4.5",
        label: "Claude Haiku 4.5 (ours)",
        provider: "Anthropic",
        contextLength: null,
        promptPriceUsdPerM: null,
        completionPriceUsdPerM: null,
        supportsTools: true,
        enabled: true,
        sort: 1,
        openrouterCreatedAt: null,
        syncedAt: null,
        releases: [{ id: "anthropic/claude-haiku-4.5", releasedAt: null, isLatest: true }],
      },
    ];
    const r = await syncModels(store, fetchOk, () => new Date("2026-10-12T20:00:00Z"));
    expect(r).toMatchObject({ fetched: 4, inserted: 3, updated: 1, newReleases: 4, syncedAt: "2026-10-12T20:00:00.000Z" });
    const haiku = store.models.find((m) => m.id === "anthropic/claude-haiku-4.5")!;
    expect(haiku).toMatchObject({ enabled: true, label: "Claude Haiku 4.5 (ours)", promptPriceUsdPerM: 1, contextLength: 200000 });
    expect(haiku.releases).toEqual([{ id: "anthropic/claude-4.5-haiku-20251001", releasedAt: "2025-10-15T17:00:38.000Z", isLatest: true }]);
    expect(store.models.filter((m) => m.enabled).map((m) => m.id)).toEqual(["anthropic/claude-haiku-4.5"]);
    expect(await store.isModelEnabled("qwen/qwen3-coder")).toBe(false);
    expect(await store.isModelEnabled("nope/nope")).toBeNull();
  });

  it("fails on a non-200 and on an empty list", async () => {
    const store = new FakeCatalogStore();
    await expect(syncModels(store, (async () => new Response("x", { status: 502 })) as typeof fetch)).rejects.toThrow(/502/);
    await expect(syncModels(store, (async () => new Response(JSON.stringify({ data: [] }))) as typeof fetch)).rejects.toThrow(/no model/);
  });
});
