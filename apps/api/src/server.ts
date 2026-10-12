import { createApp } from "./app.js";
import { PgProofStore } from "./chain/proof-store.pg.js";
import { proofIssuerHook, runStartHook } from "./chain/runs-hooks.js";
import { PgRepository } from "./domain/repository.pg.js";
import { getPool } from "./domain/pool.js";
import { PgRunsStore } from "./domain/runs-store.pg.js";

const port = Number(process.env.PORT ?? 3000);
const repo = new PgRepository(getPool());
// Needs db/migrations/0004_proofs.sql applied.
const proofs = new PgProofStore(getPool());

createApp(repo, {
  runs: {
    store: new PgRunsStore(getPool()),
    buildRunStartTx: runStartHook((id, version) => repo.getTaskPack(id, version)),
    proofIssuer: proofIssuerHook(proofs),
  },
  proofs,
}).listen(port, () => {
  console.log(`itera-agent-credentials-api listening on port ${port}`);
});
