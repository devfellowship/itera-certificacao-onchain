import { createApp } from "./app.js";
import { PgProofStore } from "./chain/proof-store.pg.js";
import { proofIssuerHook, runStartHook } from "./chain/runs-hooks.js";
import { PgCatalogStore } from "./domain/catalog-store.pg.js";
import { startModelsSync, syncModels } from "./domain/models-sync.js";
import { PgRepository } from "./domain/repository.pg.js";
import { getPool } from "./domain/pool.js";
import { PgRunsStore } from "./domain/runs-store.pg.js";
import { evaluationsConfigFromEnv } from "./evaluations/config.js";
import { runCostEstimator } from "./evaluations/estimate.js";
import { createEvaluationIssuer } from "./evaluations/issuer.js";
import { openRouterPrices } from "./domain/model-prices.js";
import { solUsdProvider } from "./evaluations/price.js";
import { SolanaPayGateway } from "./evaluations/solana-pay.js";
import { PgEvaluationsStore } from "./evaluations/store.pg.js";

const port = Number(process.env.PORT ?? 3000);
const repo = new PgRepository(getPool());
// Needs db/migrations/0004_proofs.sql applied.
const proofs = new PgProofStore(getPool());
// U21: OpenRouter models → models/model_releases, 15 s after start and then hourly.
const catalog = new PgCatalogStore(getPool());
if (process.env.ITERA_MODELS_SYNC !== "off") startModelsSync(catalog);
const runsStore = new PgRunsStore(getPool());
const proofIssuer = proofIssuerHook(proofs);
// Needs db/migrations/0008_evaluations_payments.sql applied.
const evaluationsStore = new PgEvaluationsStore(getPool());
createEvaluationIssuer({ store: evaluationsStore, runs: runsStore, proofIssuer }).start();

createApp(repo, {
  runs: {
    store: runsStore,
    runKeySecret: process.env.ITERA_RUN_KEY_SECRET,
    buildRunStartTx: runStartHook((id, version) => repo.getTaskPack(id, version)),
    proofIssuer,
  },
  proofs,
  // Needs db/migrations/0007_catalog.sql (GET /models falls back to the static list without it).
  catalog,
  catalogOptions: { syncModels: () => syncModels(catalog) },
  evaluations: {
    store: evaluationsStore,
    config: evaluationsConfigFromEnv(),
    price: solUsdProvider(),
    payments: new SolanaPayGateway(),
    estimate: runCostEstimator(runsStore, openRouterPrices()),
    runKeySecret: process.env.ITERA_RUN_KEY_SECRET,
  },
}).listen(port, () => {
  console.log(`itera-agent-credentials-api listening on port ${port}`);
});
