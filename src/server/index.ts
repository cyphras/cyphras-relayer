import { buildApp } from "./app.js";
import { config } from "../config/index.js";
import { migrate } from "../db/migrate.js";
import { logger } from "../lib/logger.js";
import { startIndexer } from "../indexer/run.js";
import { startExecutor } from "../reveal/run.js";
import { startMaintenance } from "../maintenance/run.js";
import { channelPool } from "../channels/pool.js";

async function main(): Promise<void> {
  await migrate();
  await channelPool.ensureFunded();
  const app = await buildApp();
  await app.listen({ host: "0.0.0.0", port: config.PORT });
  logger.info({ port: config.PORT }, "relayer listening");
  startIndexer();
  await startExecutor();
  startMaintenance();
}

main().catch((err) => {
  logger.error(err, "failed to start");
  process.exit(1);
});
