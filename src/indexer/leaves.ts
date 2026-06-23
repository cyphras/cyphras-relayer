import { server, rpcOldestEventLedger, FLOOR_SAFETY_LEDGERS } from "../stellar/rpc.js";
import { config } from "../config/index.js";
import { db } from "../db/pool.js";
import { logger } from "../lib/logger.js";
import { isCommitEvent, parseCommitEvent } from "../stellar/events.js";

const PAGE_LIMIT = 100;

// A permanent data-integrity failure (missed or non-contiguous leaves) as opposed to a transient
// RPC error: the caller alerts on it instead of retrying, since retrying cannot fix it.
export class LeafIntegrityError extends Error {}

async function storedCursor(pool: string): Promise<number> {
  const { rows } = await db.query<{ last_ledger: number }>(
    "select last_ledger from indexer_cursor where pool = $1",
    [pool],
  );
  if (rows[0]) return rows[0].last_ledger;

  // No cursor yet: anchor to this pool's own creation ledger, not a shared global start, so history
  // begins when the pool existed.
  const { rows: poolRows } = await db.query<{ created_ledger: number | null }>(
    "select created_ledger from pools where address = $1",
    [pool],
  );
  return poolRows[0]?.created_ledger ?? config.INDEXER_START_LEDGER;
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

  const oldest = await rpcOldestEventLedger(pool, latestLedger, config.INDEXER_MAX_WINDOW);
  if (start < oldest) {
    const { rows } = await db.query<{ c: number }>(
      "select count(*)::int as c from leaves where pool = $1",
      [pool],
    );
    if (rows[0].c > 0) {
      throw new LeafIntegrityError(
        `indexer cursor ${start} for pool ${pool} is before the RPC oldest ledger ${oldest}; leaves ` +
          `were missed and cannot be backfilled. Restore the leaves table from a backup, then resume.`,
      );
    }
    logger.warn(
      { pool, cursor: start, oldest },
      "no leaves indexed yet; bootstrapping indexer from the RPC's oldest available ledger",
    );
    start = oldest + FLOOR_SAFETY_LEDGERS;
  }
  if (start > latestLedger) return 0;

  let cursor: string | undefined;
  let count = 0;
  let frontier = start;

  // getEvents scans a bounded ledger window per call and returns a cursor, even when that window
  // held no matching events. Page on the cursor until it reaches the latest ledger; a short or
  // empty page does not mean the scan is finished.
  for (;;) {
    const filters = [{ type: "contract" as const, contractIds: [pool] }];
    const res = await server.getEvents(
      cursor
        ? { cursor, filters, limit: PAGE_LIMIT }
        : { startLedger: start, filters, limit: PAGE_LIMIT },
    );

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

  // The tree is only usable if every leaf index from 0 is present. A gap means a commit event was
  // dropped: refuse to advance the cursor past it so the hole stays visible instead of being served.
  await assertContiguousLeaves(pool);

  // Resume from the frontier the scan actually reached, not the ledger captured before it ran.
  await setCursor(pool, frontier + 1);
  return count;
}

async function assertContiguousLeaves(pool: string): Promise<void> {
  const { rows } = await db.query<{ c: number; m: number | null }>(
    "select count(*)::int as c, max(leaf_index) as m from leaves where pool = $1",
    [pool],
  );
  const c = rows[0].c;
  const m = rows[0].m;
  if (c > 0 && m !== c - 1) {
    throw new LeafIntegrityError(`leaf index gap for pool ${pool}: ${c} leaves but max index ${m}`);
  }
}
