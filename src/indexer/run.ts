import { server } from "../stellar/rpc.js";
import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";
import { syncPools, activePools } from "./pools.js";
import { indexPool } from "./leaves.js";

async function cycle(): Promise<void> {
  await syncPools();
  const latest = (await server.getLatestLedger()).sequence;
  for (const pool of await activePools()) {
    try {
      const indexed = await indexPool(pool, latest);
      if (indexed > 0) {
        logger.info({ pool, indexed }, "indexed commit events");
      }
    } catch (err) {
      logger.error({ err, pool }, "indexing failed for pool");
    }
  }
}

export function startIndexer(): void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await cycle();
    } catch (err) {
      logger.error({ err }, "indexer cycle failed");
    } finally {
      running = false;
    }
  };
  void tick();
  setInterval(() => void tick(), config.INDEXER_POLL_INTERVAL_MS);
}
