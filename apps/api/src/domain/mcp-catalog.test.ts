import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { catalogView, readCatalog, resolveGhcrDigest, syncMcpCatalog, type McpCatalogRow, type McpCatalogStore } from "./mcp-catalog.js";

const CATALOG = join(import.meta.dirname, "..", "..", "..", "..", "mcp", "catalog");
const DIGEST = `sha256:${"a".repeat(64)}`;

function ghcr(published: Record<string, string>): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("https://ghcr.io/token")) return new Response(JSON.stringify({ token: "anon" }), { status: 200 });
    const m = /\/v2\/devfellowship\/itera-mcp-([a-z0-9_-]+)\/manifests\/(\d+)$/.exec(u);
    expect(init?.method).toBe("HEAD");
    const digest = m ? published[`${m[1]}:${m[2]}`] : undefined;
    return digest ? new Response(null, { status: 200, headers: { "docker-content-digest": digest } }) : new Response(null, { status: 404 });
  }) as typeof fetch;
}

class MemoryStore implements McpCatalogStore {
  rows = new Map<string, McpCatalogRow>();
  async upsertMcpCatalog(rows: Parameters<McpCatalogStore["upsertMcpCatalog"]>[0]) {
    const c = { inserted: 0, updated: 0, kept: 0 };
    for (const r of rows) {
      const key = `${r.name}@${r.version}`;
      const prev = this.rows.get(key);
      if (prev?.status === "published") {
        c.kept++;
        continue;
      }
      prev ? c.updated++ : c.inserted++;
      this.rows.set(key, { ...r, status: r.imageDigest ? "published" : "unpublished", syncedAt: "now" });
    }
    return c;
  }
  async listMcpCatalog() {
    return [...this.rows.values()];
  }
}

describe("MCP catalog sync (U29)", () => {
  it("reads every catalog server of the repository with its tools snapshot", async () => {
    const { entries, errors } = await readCatalog(CATALOG);
    expect(errors).toEqual([]);
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(byName.helpdesk?.version).toBe(1);
    expect(byName.helpdesk?.tools.map((t) => t.name)).toEqual(["search_tickets", "get_customer", "get_order", "issue_refund", "close_ticket", "add_note"]);
    expect(byName.memory?.transport).toBe("stdio");
    expect(byName.memory?.image).toBe("ghcr.io/devfellowship/itera-mcp-memory");
  });

  it("resolves a published tag to its digest and an unpublished one to null", async () => {
    const f = ghcr({ "helpdesk:1": DIGEST });
    expect(await resolveGhcrDigest("ghcr.io/devfellowship/itera-mcp-helpdesk", "1", f)).toBe(DIGEST);
    expect(await resolveGhcrDigest("ghcr.io/devfellowship/itera-mcp-memory", "1", f)).toBeNull();
  });

  it("upserts unpublished rows, then publishes them, then keeps a published row immutable", async () => {
    const store = new MemoryStore();
    const first = await syncMcpCatalog(store, { dir: CATALOG, fetchFn: ghcr({}), commit: "abc1234" });
    expect(first).toMatchObject({ servers: 2, published: 0, inserted: 2 });
    const second = await syncMcpCatalog(store, { dir: CATALOG, fetchFn: ghcr({ "helpdesk:1": DIGEST, "memory:1": DIGEST }) });
    expect(second).toMatchObject({ published: 2, updated: 2 });
    const third = await syncMcpCatalog(store, { dir: CATALOG, fetchFn: ghcr({ "helpdesk:1": `sha256:${"b".repeat(64)}`, "memory:1": DIGEST }) });
    expect(third).toMatchObject({ kept: 2 });
    const helpdesk = (await store.listMcpCatalog()).find((r) => r.name === "helpdesk")!;
    expect(helpdesk.imageDigest).toBe(DIGEST);
    expect(catalogView(helpdesk)).toMatchObject({ ref: "helpdesk@1", status: "published", image: `ghcr.io/devfellowship/itera-mcp-helpdesk@${DIGEST}` });
  });
});
