import { createApp } from "./app.js";
import { PgRepository } from "./domain/repository.pg.js";
import { getPool } from "./domain/pool.js";
import { PgRunsStore } from "./domain/runs-store.pg.js";

const port = Number(process.env.PORT ?? 3000);

// Lane D wires buildRunStartTx and proofIssuer here when apps/api/src/chain lands.
createApp(new PgRepository(getPool()), { runs: { store: new PgRunsStore(getPool()) } }).listen(port, () => {
  console.log(`itera-agent-credentials-api listening on port ${port}`);
});
