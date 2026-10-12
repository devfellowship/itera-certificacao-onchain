import { Router, type Request, type Response } from "express";
import { catalogView, type McpCatalogStore } from "../domain/mcp-catalog.js";
import { SchemaNotReadyError } from "../domain/runs-store.js";

/**
 * GET /mcp-catalog — public list of the Itera MCP catalog (U29): name@version, image digest, tools
 * snapshot, capabilities, license. The task page (U30) and the task editor (U31) read it.
 */
export function createMcpCatalogRouter(store: McpCatalogStore): Router {
  const router = Router();
  router.get("/mcp-catalog", async (_req: Request, res: Response) => {
    try {
      const rows = await store.listMcpCatalog();
      res.json({ servers: rows.map(catalogView) });
    } catch (e) {
      if (e instanceof SchemaNotReadyError) {
        res.status(503).json({ error: e.message });
        return;
      }
      res.status(500).json({ error: "the MCP catalog could not be read" });
    }
  });
  return router;
}
