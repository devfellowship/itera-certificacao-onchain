import { createApp } from "./app.js";
import { runStartHook } from "./chain/runs-hooks.js";
import { PgRepository } from "./domain/repository.pg.js";
import { getPool } from "./domain/pool.js";
import { PgRunsStore } from "./domain/runs-store.pg.js";

const port = Number(process.env.PORT ?? 3000);
const repo = new PgRepository(getPool());

// Lane D: the run-start Memo is built by apps/api/src/chain/run-start.ts. The proof issuer is
// wired when db/migrations/0004_proofs.sql is applied (lane D slice 2).
createApp(repo, {
  runs: {
    store: new PgRunsStore(getPool()),
    buildRunStartTx: runStartHook((id, version) => repo.getTaskPack(id, version)),
  },
}).listen(port, () => {
  console.log(`itera-agent-credentials-api listening on port ${port}`);
});
