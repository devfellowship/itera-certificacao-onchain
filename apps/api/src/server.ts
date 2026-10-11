import { createApp } from "./app.js";
import { PgRepository } from "./domain/repository.pg.js";
import { getPool } from "./domain/pool.js";

const port = Number(process.env.PORT ?? 3000);

createApp(new PgRepository(getPool())).listen(port, () => {
  console.log(`itera-agent-credentials-api listening on port ${port}`);
});
