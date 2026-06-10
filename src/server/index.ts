import { buildApp } from "./app.js";
import { config } from "../config/index.js";
import { migrate } from "../db/migrate.js";
import { logger } from "../lib/logger.js";

async function main(): Promise<void> {
  await migrate();
  const app = buildApp();
  await app.listen({ host: "0.0.0.0", port: config.PORT });
  logger.info({ port: config.PORT }, "relayer listening");
}

main().catch((err) => {
  logger.error(err, "failed to start");
  process.exit(1);
});
