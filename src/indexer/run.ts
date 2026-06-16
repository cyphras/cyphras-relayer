import { server } from "../stellar/rpc.js";
import { db } from "../db/pool.js";
import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";
import { alert } from "../lib/alert.js";
import { beat } from "../lib/heartbeat.js";
import { syncPools, activePools } from "./pools.js";
import { indexPool, LeafIntegrityError } from "./leaves.js";

async function cycle(): Promise<void> {
  await syncPools();
  const latest = (await server.getLatestLedger()).sequence;
  const pools = await activePools();
  for (const pool of pools) {
    try {
      const indexed = await indexPool(pool, latest);
      if (indexed > 0) {
        logger.info({ pool, indexed }, "indexed commit events");
      }
    } catch (err) {
      if (err instanceof LeafIntegrityError) {
        await alert("indexer leaf integrity failure, tree is incomplete", {
          pool,
          reason: err.message,
        });
      } else {
        logger.error({ err, pool }, "indexing failed for pool");
      }
    }
  }

  // The most-behind active pool sets the lag: any stale cursor serves a stale root from
  // /v1/info/leaves and breaks withdrawals. Initial backfill of a new pool can trip this briefly.
  if (pools.length > 0) {
    const { rows } = await db.query<{ min_ledger: number | null }>(
      "select min(last_ledger) as min_ledger from indexer_cursor where pool = any($1)",
      [pools],
    );
    const indexedThrough = rows[0]?.min_ledger;
    if (indexedThrough != null && latest - indexedThrough > config.INDEXER_LAG_ALERT_LEDGERS) {
      await alert("indexer is falling behind latest ledger, leaves and root may be stale", {
        behindLedgers: latest - indexedThrough,
        latest,
        indexedThrough,
      });
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
      beat("indexer");
    } catch (err) {
      logger.error({ err }, "indexer cycle failed");
    } finally {
      running = false;
    }
  };
  void tick();
  setInterval(() => void tick(), config.INDEXER_POLL_INTERVAL_MS);
}
