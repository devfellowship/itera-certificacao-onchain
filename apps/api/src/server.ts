import { PgSelfDeclaredStore } from "./self-declared/store.pg.js";
import { selfDeclaredPerDayFromEnv } from "./self-declared/router.js";
import { PgRunOriginLookup } from "./self-declared/run-guard.js";
import { PgLocalAgentsStore } from "./local-agents/store.pg.js";
import { PgCliAuthStore } from "./cli-auth/store.pg.js";
import { createApp } from "./app.js";
import { PgProofStore } from "./chain/proof-store.pg.js";
import { proofIssuerHook, runStartHook } from "./chain/runs-hooks.js";
import { PgCatalogStore } from "./domain/catalog-store.pg.js";
import { PgGithubAgentsRepository } from "./domain/github-agents-repository.pg.js";
import { PgMyTasksStore } from "./domain/my-tasks-store.pg.js";
import { GitHubAppClient, githubAppConfigFromEnv } from "./github/app-client.js";
import { requireWallet } from "./http/auth.js";
import { startModelsSync, syncModels } from "./domain/models-sync.js";
import { PgRepository } from "./domain/repository.pg.js";
import { getPool } from "./domain/pool.js";
import { PgRankingStore } from "./domain/agent-ranking-store.pg.js";
import { PgRunsStore } from "./domain/runs-store.pg.js";
import { evaluationsConfigFromEnv } from "./evaluations/config.js";
import { runCostEstimator } from "./evaluations/estimate.js";
import { createEvaluationIssuer } from "./evaluations/issuer.js";
import { openRouterPrices } from "./domain/model-prices.js";
import { createOpenRouterKeyProbe } from "./models/openrouter-key.js";
import { platformKeyConfigFromEnv } from "./models/platform-key.js";
import { web2HostedEnabledFromEnv } from "./evaluations/web2-hosted-gate.js";
import { solUsdProvider } from "./evaluations/price.js";
import { SolanaPayGateway } from "./payments/adapters/solana-pay-gateway.js";
import { PgEvaluationsStore } from "./evaluations/store.pg.js";
import { PgPublicProfilesStore } from "./public/store.pg.js";
import { PgPublicTaskStore } from "./public/task-store.pg.js";
import { PgReputationStore } from "./domain/reputation-store.pg.js";
import { startMcpCatalogSync } from "./domain/mcp-catalog.js";
import { PgMcpCatalogStore } from "./domain/mcp-catalog-store.pg.js";
import { avatarStorageFromEnv } from "./domain/avatar.js";
import { PgAgentAvatarStore } from "./domain/agent-avatar-store.js";
import { PgFaucetStore } from "./domain/faucet-store.pg.js";
import { Web3FaucetChain } from "./chain/faucet-chain.js";
import { faucetConfigFromEnv } from "./http/faucet-router.js";
import { dflAuthConfigFromEnv } from "./config.js";
import { healthRequiresRunner } from "./http/health.js";
import { PgUsersStore } from "./domain/users-store.pg.js";

const port = Number(process.env.PORT ?? 3000);
const repo = new PgRepository(getPool());
// Needs db/migrations/0004_proofs.sql applied.
const proofs = new PgProofStore(getPool());
// U21: OpenRouter models → models/model_releases, 15 s after start and then hourly.
const catalog = new PgCatalogStore(getPool());
if (process.env.ITERA_MODELS_SYNC !== "off") startModelsSync(catalog);
const runsStore = new PgRunsStore(getPool());
// U29 (0013): MCP catalog rows from mcp/catalog/*/manifest.json + GHCR digests, on boot and every 15 min.
const mcpCatalog = new PgMcpCatalogStore(getPool());
if (process.env.ITERA_MCP_CATALOG_SYNC !== "off") {
  startMcpCatalogSync(mcpCatalog, { dir: process.env.ITERA_MCP_CATALOG_DIR ?? new URL("../mcp/catalog", import.meta.url).pathname });
}
// U27 (0010): run provenance, task reputation, run feedback.
const reputation = new PgReputationStore(getPool);
const proofIssuer = proofIssuerHook(proofs, reputation);
// Needs db/migrations/0008_evaluations_payments.sql applied.
const evaluationsStore = new PgEvaluationsStore(getPool());
// One cached OpenRouter list-price lookup: the run estimate and the platform path's low-cost rule.
const modelPrices = openRouterPrices();
createEvaluationIssuer({ store: evaluationsStore, runs: runsStore, proofIssuer }).start();

// T5 Login with DFL (needs 0018_users_principal.sql). Fails at boot on an invalid TMA_MIN_IAM_LEVEL.
// DFL_SUPABASE_ANON_KEY is read per request: without it only POST /auth/dfl/exchange answers 503.
dflAuthConfigFromEnv();
const users = new PgUsersStore(getPool);

let tasksGithub: GitHubAppClient | null = null;

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
  // U19 My tasks (needs 0009_user_tasks.sql).
  myTasks: {
    store: new PgMyTasksStore(getPool()),
    catalog,
    github: () => (tasksGithub ??= new GitHubAppClient(githubAppConfigFromEnv())),
    installations: new PgGithubAgentsRepository(getPool),
    requireWallet,
  },
  catalogOptions: { syncModels: () => syncModels(catalog), ranking: new PgRankingStore(getPool), evaluations: evaluationsStore },
  evaluations: {
    store: evaluationsStore,
    config: evaluationsConfigFromEnv(),
    price: solUsdProvider(),
    payments: new SolanaPayGateway(),
    estimate: runCostEstimator(runsStore, modelPrices),
    runKeySecret: process.env.ITERA_RUN_KEY_SECRET,
    // T8: the OpenRouter `GET /key` probe of the free BYOK path, and the platform-key flag (off by default).
    probeModelKey: createOpenRouterKeyProbe(),
    platformKey: platformKeyConfigFromEnv(),
    modelPrice: modelPrices,
    // L15a: web2 = ingested only for now. TMA_WEB2_HOSTED_ENABLED=true (default false) turns the hosted
    // dfl path back on; off → 403 hosted_not_available_web2 on the three start routes.
    web2Hosted: web2HostedEnabledFromEnv(),
    web2BaseUrl: process.env.TMA_WEB2_BASE_URL,
  },
  // U14: public evaluation profile (needs 0008).
  publicProfiles: new PgPublicProfilesStore(getPool()),
  reputation,
  // U30: public task profile (needs 0007; results need 0008, reputation 0010).
  publicTasks: new PgPublicTaskStore(getPool()),
  mcpCatalog,
  // U36 (0015): profile pictures in the TestMyAgent Supabase Storage (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).
  avatarStorage: avatarStorageFromEnv(),
  agentAvatars: new PgAgentAvatarStore(getPool()),
  // U37 (0016): devnet faucet from the hot signer.
  faucet: { store: new PgFaucetStore(getPool), chain: new Web3FaucetChain(), config: faucetConfigFromEnv(), requireWallet },
  dflAuth: { users },
  // T12: /health pings the DB; TMA_HEALTH_REQUIRE_RUNNER=true also fails it on a runner heartbeat older than 5 min (0020).
  health: { db: getPool, requireRunner: healthRequiresRunner() },
  // L3: POST /self-declared-results (needs 0021; 503 schema_not_ready before it). TMA_SELF_DECLARED_PER_DAY (default 50).
  selfDeclared: {
    store: new PgSelfDeclaredStore(getPool()),
    perDay: selfDeclaredPerDayFromEnv(),
    web2BaseUrl: process.env.TMA_WEB2_BASE_URL,
  },
  // L3, Q4 = C: a self-declared run is visible only to its owner (no-op before 0021).
  runOrigins: new PgRunOriginLookup(getPool),
  // L4: local agents and custom models (writes need 0021; 503 schema_not_ready before it).
  localAgents: { store: new PgLocalAgentsStore(getPool) },
  // L5: tma login (device code approved on web2 /cli) and CLI session revocation (needs 0021).
  cliAuth: { store: new PgCliAuthStore(getPool), web2BaseUrl: process.env.TMA_WEB2_BASE_URL },
}).listen(port, () => {
  console.log(`testmyagent-api listening on port ${port}`);
});
