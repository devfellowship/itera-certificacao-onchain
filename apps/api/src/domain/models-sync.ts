/**
 * OpenRouter models sync (U21, plan 20261012-itera-testmyagent-ui-refactor).
 *
 * Reads the public model list `GET https://openrouter.ai/api/v1/models` (no key) and upserts
 * `models` + `model_releases` (0007_catalog.sql):
 *   - models: provider and label from the OpenRouter name ("Anthropic: Claude Haiku 4.5"), context
 *     length, prices per 1M tokens, supports_tools = "tools" in supported_parameters, created.
 *   - A NEW model arrives with enabled = false. The sync never changes `enabled`: it is ITERA's
 *     allow-list (ITERA pays the tokens, Gate Q2), so "what the user can access" = enabled.
 *   - Releases: OpenRouter has no release list per model. The release of a model is its
 *     `canonical_slug` (dated, e.g. anthropic/claude-4.5-haiku-20251001), released_at = `created`.
 *     When the canonical slug changes, the new one becomes is_latest and the old one stays.
 *
 * Runs inside the API process: once shortly after start, then every hour (startModelsSync), and on
 * demand through POST /admin/models/sync.
 */

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
export const MODELS_SYNC_INTERVAL_MS = 60 * 60 * 1000;

export interface SyncedModel {
  id: string;
  label: string;
  provider: string;
  contextLength: number | null;
  promptPriceUsdPerM: number | null;
  completionPriceUsdPerM: number | null;
  supportsTools: boolean;
  createdAt: string | null;
  release: { id: string; releasedAt: string | null };
}

export interface ModelsSyncResult {
  fetched: number;
  inserted: number;
  updated: number;
  newReleases: number;
  syncedAt: string;
}

export interface ModelsSyncStore {
  /** Upserts in one transaction; returns counts. Never writes `enabled` of an existing row. */
  applyModelsSync(models: SyncedModel[], syncedAt: string): Promise<Omit<ModelsSyncResult, "fetched" | "syncedAt">>;
}

// Skips the floating "~provider/x-latest" aliases: they are not pinnable, so they are not a release.
const ID_RE = /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9._:~-]+$/;

/** USD per token (OpenRouter string) → USD per 1M tokens, rounded to 6 decimals. Negative = "varies". */
function perMillion(v: unknown): number | null {
  const n = Number(v);
  if (v === undefined || v === null || v === "" || !Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 1_000_000 * 1e6) / 1e6;
}

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  "x-ai": "xAI",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  moonshotai: "Moonshot AI",
  "meta-llama": "Meta",
  mistralai: "Mistral",
};

export function parseOpenRouterModels(doc: unknown): SyncedModel[] {
  const data = (doc as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new Error("OpenRouter /models: no data[]");
  const out: SyncedModel[] = [];
  const seen = new Set<string>();
  for (const raw of data) {
    const m = raw as Record<string, unknown>;
    const id = m.id;
    if (typeof id !== "string" || !ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    const name = typeof m.name === "string" ? m.name : id;
    const colon = name.indexOf(": ");
    const prefix = id.split("/")[0]!;
    const provider = PROVIDER_NAMES[prefix] ?? (colon > 0 ? name.slice(0, colon) : prefix);
    const label = colon > 0 ? name.slice(colon + 2) : name;
    const created = typeof m.created === "number" && m.created > 0 ? new Date(m.created * 1000).toISOString() : null;
    const pricing = (m.pricing ?? {}) as Record<string, unknown>;
    const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
    const canonical = typeof m.canonical_slug === "string" && ID_RE.test(m.canonical_slug) ? m.canonical_slug : id;
    out.push({
      id,
      label: label.slice(0, 120),
      provider: provider.slice(0, 60),
      contextLength: typeof m.context_length === "number" && m.context_length > 0 ? Math.floor(m.context_length) : null,
      promptPriceUsdPerM: perMillion(pricing.prompt),
      completionPriceUsdPerM: perMillion(pricing.completion),
      supportsTools: params.includes("tools"),
      createdAt: created,
      release: { id: canonical, releasedAt: created },
    });
  }
  // Variants (":free", ":thinking", …) share the canonical slug of their base model. A release id
  // belongs to one model, so the base id (no ":") keeps the canonical slug and a variant uses its id.
  const owner = new Map<string, string>();
  for (const m of out) {
    const cur = owner.get(m.release.id);
    if (!cur || (cur.includes(":") && !m.id.includes(":"))) owner.set(m.release.id, m.id);
  }
  for (const m of out) if (owner.get(m.release.id) !== m.id) m.release = { ...m.release, id: m.id };
  // A variant's id may itself equal another model's canonical slug: last guard, drop duplicates.
  const used = new Set<string>();
  for (const m of out) {
    if (used.has(m.release.id)) m.release = { ...m.release, id: `${m.id}#release` };
    used.add(m.release.id);
  }
  return out;
}

export async function syncModels(
  store: ModelsSyncStore,
  fetchFn: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): Promise<ModelsSyncResult> {
  const res = await fetchFn(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`OpenRouter /models answered ${res.status}`);
  const models = parseOpenRouterModels(await res.json());
  if (models.length === 0) throw new Error("OpenRouter /models returned no model; refusing to sync");
  const syncedAt = now().toISOString();
  const counts = await store.applyModelsSync(models, syncedAt);
  return { fetched: models.length, ...counts, syncedAt };
}

/** Starts the in-process sync: first run after `initialDelayMs`, then every `intervalMs`. */
export function startModelsSync(
  store: ModelsSyncStore,
  opts: { intervalMs?: number; initialDelayMs?: number; fetchFn?: typeof fetch; log?: (msg: string) => void } = {},
): () => void {
  const log = opts.log ?? ((msg: string) => console.log(msg));
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await syncModels(store, opts.fetchFn);
      log(`models-sync: fetched ${r.fetched}, inserted ${r.inserted}, updated ${r.updated}, new releases ${r.newReleases}`);
    } catch (e) {
      log(`models-sync: failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void tick(), opts.initialDelayMs ?? 15_000);
  const every = setInterval(() => void tick(), opts.intervalMs ?? MODELS_SYNC_INTERVAL_MS);
  first.unref();
  every.unref();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
