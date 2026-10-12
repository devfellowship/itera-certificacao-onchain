import { createApp } from "./app.js";
import { PgProofStore } from "./chain/proof-store.pg.js";
import { proofIssuerHook, runStartHook } from "./chain/runs-hooks.js";
import { PgCatalogStore } from "./domain/catalog-store.pg.js";
import { startModelsSync, syncModels } from "./domain/models-sync.js";
import { PgRepository } from "./domain/repository.pg.js";
import { getPool } from "./domain/pool.js";
import { PgRunsStore } from "./domain/runs-store.pg.js";

const port = Number(process.env.PORT ?? 3000);
const repo = new PgRepository(getPool());
// Needs db/migrations/0004_proofs.sql applied.
const proofs = new PgProofStore(getPool());
// U21: OpenRouter models → models/model_releases, 15 s after start and then hourly.
const catalog = new PgCatalogStore(getPool());
if (process.env.ITERA_MODELS_SYNC !== "off") startModelsSync(catalog);

createApp(repo, {
  runs: {
    store: new PgRunsStore(getPool()),
    runKeySecret: process.env.ITERA_RUN_KEY_SECRET,
    buildRunStartTx: runStartHook((id, version) => repo.getTaskPack(id, version)),
    proofIssuer: proofIssuerHook(proofs),
  },
  proofs,
  // Needs db/migrations/0007_catalog.sql (GET /models falls back to the static list without it).
  catalog,
  catalogOptions: { syncModels: () => syncModels(catalog) },
}).listen(port, () => {
  console.log(`itera-agent-credentials-api listening on port ${port}`);
});
