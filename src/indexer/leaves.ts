import { server } from "../stellar/rpc.js";
import { config } from "../config/index.js";
import { db } from "../db/pool.js";
import { logger } from "../lib/logger.js";
import { isCommitEvent, parseCommitEvent } from "../stellar/events.js";

const PAGE_LIMIT = 100;

async function storedCursor(pool: string): Promise<number> {
  const { rows } = await db.query<{ last_ledger: number }>(
    "select last_ledger from indexer_cursor where pool = $1",
    [pool],
  );
  return rows[0]?.last_ledger ?? config.INDEXER_START_LEDGER;
}

async function setCursor(pool: string, ledger: number): Promise<void> {
  await db.query(
    `insert into indexer_cursor (pool, last_ledger) values ($1, $2)
     on conflict (pool) do update set last_ledger = excluded.last_ledger`,
    [pool, ledger],
  );
}

export async function indexPool(pool: string, latestLedger: number): Promise<number> {
  let start = await storedCursor(pool);

  // getEvents only retains a recent window. Starting before it errors, so clamp forward and
  // warn: any leaves older than the window were never captured (run the indexer from creation).
  const floor = latestLedger - config.INDEXER_MAX_WINDOW;
  if (start < floor) {
    logger.warn({ pool, start, floor }, "start ledger before retention window, clamping");
    start = floor;
  }
  if (start > latestLedger) return 0;

  let cursor: string | undefined;
  let count = 0;
  let frontier = start;

  // getEvents scans a bounded ledger window per call and returns a cursor, even when that window
  // held no matching events. Page on the cursor until it reaches the latest ledger; a short or
  // empty page does not mean the scan is finished.
  for (;;) {
    const res = await server.getEvents({
      startLedger: cursor ? undefined : start,
      cursor,
      filters: [{ type: "contract", contractIds: [pool] }],
      limit: PAGE_LIMIT,
    });

    for (const event of res.events) {
      try {
        if (!isCommitEvent(event)) continue;
        const leaf = parseCommitEvent(event);
        await db.query(
          `insert into leaves (pool, leaf_index, commitment, root, ledger)
           values ($1, $2, $3, $4, $5)
           on conflict (pool, leaf_index) do nothing`,
          [pool, leaf.leafIndex, leaf.commitment, leaf.root, leaf.ledger],
        );
        count += 1;
      } catch (err) {
        // one malformed event must not wedge the pool: log it and keep scanning
        logger.error({ err, pool, ledger: event.ledger }, "skipping unparseable event");
      }
    }

    frontier = res.latestLedger;
    const cursorLedger = Number(BigInt(res.cursor.split("-")[0]) >> 32n);
    if (cursorLedger >= res.latestLedger) break;
    cursor = res.cursor;
  }

  // Resume from the frontier the scan actually reached, not the ledger captured before it ran.
  await setCursor(pool, frontier + 1);
  return count;
}
