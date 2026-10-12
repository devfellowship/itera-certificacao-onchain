import type { Pool } from "pg";
import type { McpCatalogEntry, McpCatalogRow, McpCatalogStore } from "./mcp-catalog.js";
import { SchemaNotReadyError } from "./runs-store.js";

export const MCP_CATALOG_MIGRATION = "0012_mcp_catalog.sql";
const MISSING_SCHEMA_CODES = new Set(["42P01", "42703"]);

function rethrow(e: unknown): never {
  const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : undefined;
  if (code && MISSING_SCHEMA_CODES.has(code)) throw new SchemaNotReadyError(MCP_CATALOG_MIGRATION, e);
  throw e;
}

/**
 * Upsert: a new (name, version) is inserted; an `unpublished` row takes the new digest, tools and
 * manifest; a `published` row is immutable (only synced_at moves), and a digest that differs from
 * the published one is ignored, never written.
 */
const UPSERT_SQL = `
  insert into public.mcp_catalog
    (name, version, image, image_digest, status, transport, capabilities, tools_snapshot, manifest, commit_sha, synced_at)
  values ($1, $2, $3, $4, case when $4::text is null then 'unpublished' else 'published' end, $5, $6, $7, $8, $9, now())
  on conflict (name, version) do update set
    image          = case when mcp_catalog.status = 'published' then mcp_catalog.image else excluded.image end,
    image_digest   = case when mcp_catalog.status = 'published' then mcp_catalog.image_digest else excluded.image_digest end,
    status         = case when mcp_catalog.status in ('published', 'retired') then mcp_catalog.status else excluded.status end,
    transport      = case when mcp_catalog.status = 'published' then mcp_catalog.transport else excluded.transport end,
    capabilities   = case when mcp_catalog.status = 'published' then mcp_catalog.capabilities else excluded.capabilities end,
    tools_snapshot = case when mcp_catalog.status = 'published' then mcp_catalog.tools_snapshot else excluded.tools_snapshot end,
    manifest       = case when mcp_catalog.status = 'published' then mcp_catalog.manifest else excluded.manifest end,
    commit_sha     = case when mcp_catalog.status = 'published' then mcp_catalog.commit_sha else excluded.commit_sha end,
    synced_at      = now()
  returning (xmax = 0) as inserted, status`;

export class PgMcpCatalogStore implements McpCatalogStore {
  constructor(private readonly pool: Pool) {}

  async upsertMcpCatalog(rows: Array<McpCatalogEntry & { imageDigest: string | null; commitSha: string | null }>) {
    const counts = { inserted: 0, updated: 0, kept: 0 };
    const client = await this.pool.connect().catch(rethrow);
    try {
      await client.query("begin");
      for (const r of rows) {
        const before = await client.query<{ status: string }>(`select status from public.mcp_catalog where name = $1 and version = $2`, [r.name, r.version]);
        const res = await client.query<{ inserted: boolean }>(UPSERT_SQL, [
          r.name,
          r.version,
          r.image,
          r.imageDigest,
          r.transport,
          r.capabilities,
          JSON.stringify(r.tools),
          JSON.stringify(r.manifest),
          r.commitSha,
        ]);
        if (res.rows[0]?.inserted) counts.inserted++;
        else if (before.rows[0]?.status === "published") counts.kept++;
        else counts.updated++;
      }
      await client.query("commit");
    } catch (e) {
      await client.query("rollback").catch(() => undefined);
      rethrow(e);
    } finally {
      client.release();
    }
    return counts;
  }

  async listMcpCatalog(): Promise<McpCatalogRow[]> {
    try {
      const res = await this.pool.query(
        `select name, version, image, image_digest, status, transport, capabilities, tools_snapshot, manifest, commit_sha, synced_at
           from public.mcp_catalog order by name, version`,
      );
      return res.rows.map((r) => ({
        name: r.name,
        version: Number(r.version),
        image: r.image,
        imageDigest: r.image_digest,
        status: r.status,
        transport: r.transport,
        capabilities: r.capabilities ?? [],
        tools: r.tools_snapshot ?? [],
        manifest: r.manifest ?? {},
        commitSha: r.commit_sha,
        syncedAt: r.synced_at instanceof Date ? r.synced_at.toISOString() : String(r.synced_at),
      }));
    } catch (e) {
      rethrow(e);
    }
  }
}
