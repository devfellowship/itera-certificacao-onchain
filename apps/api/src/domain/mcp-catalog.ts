/**
 * MCP catalog sync (U29, ADR-11; docs/architecture/mcp-sandbox.md "Registration flow", step 4).
 *
 * The catalog servers are directories of this repository (mcp/catalog/<name>/manifest.json +
 * tools.json). The API image ships those two JSON files of every server. On boot and every 15 min
 * the API:
 *   1. reads every manifest + tools snapshot at the deployed commit;
 *   2. resolves ghcr.io/devfellowship/itera-mcp-<name>:<version> to its digest (anonymous pull token:
 *      the packages are public, the repository is public);
 *   3. upserts one `mcp_catalog` row per (name, version) — 0012_mcp_catalog.sql.
 * A row that is already `published` never changes its digest, tools or manifest (a published version
 * is immutable; CI refuses to push a version twice). The runner reads the rows to pin a task's
 * `catalog: name@version` to an image digest.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const MCP_CATALOG_SYNC_INTERVAL_MS = 15 * 60 * 1000;
export const MCP_IMAGE_REPO = "ghcr.io/devfellowship/itera-mcp-";
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export interface McpCatalogEntry {
  name: string;
  version: number;
  image: string;
  transport: "http" | "stdio";
  capabilities: string[];
  manifest: Record<string, unknown>;
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
}

export interface McpCatalogRow extends McpCatalogEntry {
  imageDigest: string | null;
  status: "unpublished" | "published" | "retired";
  commitSha: string | null;
  syncedAt: string;
}

export interface McpCatalogStore {
  upsertMcpCatalog(rows: Array<McpCatalogEntry & { imageDigest: string | null; commitSha: string | null }>): Promise<{ inserted: number; updated: number; kept: number }>;
  listMcpCatalog(): Promise<McpCatalogRow[]>;
}

/** Read mcp/catalog/<name>/{manifest,tools}.json. A malformed server is skipped with an error. */
export async function readCatalog(dir: string): Promise<{ entries: McpCatalogEntry[]; errors: string[] }> {
  const entries: McpCatalogEntry[] = [];
  const errors: string[] = [];
  let names: string[] = [];
  try {
    names = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return { entries, errors: [`no MCP catalog directory at ${dir}`] };
  }
  for (const name of names) {
    try {
      const manifest = JSON.parse(await readFile(join(dir, name, "manifest.json"), "utf-8")) as Record<string, any>;
      const tools = JSON.parse(await readFile(join(dir, name, "tools.json"), "utf-8"));
      if (!NAME_RE.test(name) || manifest.name !== name) throw new Error("manifest.name must equal the directory name");
      if (!Number.isInteger(manifest.version) || manifest.version < 1) throw new Error("manifest.version must be a positive integer");
      if (manifest.transport !== "http" && manifest.transport !== "stdio") throw new Error("manifest.transport must be http or stdio");
      if (!Array.isArray(tools) || tools.some((t) => typeof t?.name !== "string")) throw new Error("tools.json must be an array of tools");
      entries.push({
        name,
        version: manifest.version,
        image: `${MCP_IMAGE_REPO}${name}`,
        transport: manifest.transport,
        capabilities: Array.isArray(manifest.capabilities) ? manifest.capabilities.map(String) : [],
        manifest,
        tools,
      });
    } catch (err) {
      errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { entries, errors };
}

/** Digest of ghcr.io/<repo>:<tag> through the registry API, or null when the tag is not published. */
export async function resolveGhcrDigest(image: string, tag: string, fetchFn: typeof fetch = fetch): Promise<string | null> {
  const repo = image.replace(/^ghcr\.io\//, "");
  const tokenRes = await fetchFn(`https://ghcr.io/token?scope=repository:${repo}:pull&service=ghcr.io`, { signal: AbortSignal.timeout(10_000) });
  if (!tokenRes.ok) return null;
  const { token } = (await tokenRes.json()) as { token?: string };
  if (!token) return null;
  const res = await fetchFn(`https://ghcr.io/v2/${repo}/manifests/${tag}`, {
    method: "HEAD",
    headers: {
      authorization: `Bearer ${token}`,
      accept: [
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json",
      ].join(", "),
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const digest = res.headers.get("docker-content-digest");
  return digest && DIGEST_RE.test(digest) ? digest : null;
}

export function deployedCommit(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.ITERA_GIT_COMMIT ?? env.SOURCE_COMMIT ?? null;
  return value && /^[0-9a-f]{7,40}$/.test(value) ? value : null;
}

export async function syncMcpCatalog(
  store: McpCatalogStore,
  opts: { dir: string; fetchFn?: typeof fetch; commit?: string | null },
): Promise<{ servers: number; published: number; inserted: number; updated: number; kept: number; errors: string[] }> {
  const { entries, errors } = await readCatalog(opts.dir);
  const rows = [];
  let published = 0;
  for (const e of entries) {
    let digest: string | null = null;
    try {
      digest = await resolveGhcrDigest(e.image, String(e.version), opts.fetchFn);
    } catch (err) {
      errors.push(`${e.name}@${e.version}: digest lookup failed (${err instanceof Error ? err.message : String(err)})`);
    }
    if (digest) published++;
    rows.push({ ...e, imageDigest: digest, commitSha: opts.commit ?? null });
  }
  const counts = rows.length > 0 ? await store.upsertMcpCatalog(rows) : { inserted: 0, updated: 0, kept: 0 };
  return { servers: entries.length, published, ...counts, errors };
}

export function startMcpCatalogSync(
  store: McpCatalogStore,
  opts: { dir: string; intervalMs?: number; initialDelayMs?: number; fetchFn?: typeof fetch; log?: (msg: string) => void },
): () => void {
  const log = opts.log ?? ((msg: string) => console.log(msg));
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await syncMcpCatalog(store, { dir: opts.dir, fetchFn: opts.fetchFn, commit: deployedCommit() });
      log(JSON.stringify({ event: "mcp_catalog_sync", ...r }));
    } catch (err) {
      log(JSON.stringify({ event: "mcp_catalog_sync_failed", error: err instanceof Error ? err.message : String(err) }));
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, opts.initialDelayMs ?? 10_000);
  const timer = setInterval(tick, opts.intervalMs ?? MCP_CATALOG_SYNC_INTERVAL_MS);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

/** Public view of one catalog row (no internal ids; the manifest keeps its seed_schema: it is public data). */
export function catalogView(r: McpCatalogRow) {
  return {
    name: r.name,
    version: r.version,
    ref: `${r.name}@${r.version}`,
    status: r.status,
    image: r.imageDigest ? `${r.image}@${r.imageDigest}` : null,
    transport: r.transport,
    capabilities: r.capabilities,
    description: typeof r.manifest.description === "string" ? r.manifest.description : null,
    license: r.manifest.license ?? null,
    upstream: r.manifest.upstream ?? null,
    tools: r.tools.map((t) => ({ name: t.name, description: t.description ?? null, inputSchema: t.inputSchema ?? null })),
    commit: r.commitSha,
    syncedAt: r.syncedAt,
  };
}
