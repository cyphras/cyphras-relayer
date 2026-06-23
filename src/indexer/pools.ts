import { nativeToScVal } from "@stellar/stellar-sdk";
import { config } from "../config/index.js";
import {
  readContract,
  server,
  rpcOldestEventLedger,
  FLOOR_SAFETY_LEDGERS,
} from "../stellar/rpc.js";
import { db } from "../db/pool.js";
import { logger } from "../lib/logger.js";
import { isPoolCreatedEvent, parsePoolCreatedEvent } from "../stellar/events.js";

const POOL_PAGE = 100;
const EVENT_PAGE_LIMIT = 100;

interface PoolInfo {
  token: string;
  denomination: bigint;
  generation: number;
  pool: string;
}

export async function syncPools(): Promise<void> {
  // Page the registry rather than reading the whole list in one call, so sync stays bounded as the
  // factory accrues pools across generations.
  const pools: PoolInfo[] = [];
  for (let start = 0; ; start += POOL_PAGE) {
    const page = (await readContract(config.FACTORY_ID, "get_pools_page", [
      nativeToScVal(start, { type: "u32" }),
      nativeToScVal(POOL_PAGE, { type: "u32" }),
    ])) as PoolInfo[];
    pools.push(...page);
    if (page.length < POOL_PAGE) {
      break;
    }
  }

  for (const p of pools) {
    const asset = await assetLabel(p.token);
    await db.query(
      `insert into pools (address, token, asset, denomination, generation, active)
       values ($1, $2, $3, $4, $5, true)
       on conflict (address) do update set
         token = excluded.token,
         asset = excluded.asset,
         denomination = excluded.denomination,
         generation = excluded.generation,
         active = true`,
      [p.pool, p.token, asset, p.denomination.toString(), p.generation],
    );
  }

  await seedCreatedLedgers();

  // A pool the factory no longer lists is retired: stop indexing and keepering it. Its already
  // indexed leaves stay queryable, so notes still held in it remain revealable. Skip deactivation
  // when the factory returned no pools at all: that is a fresh/empty factory or a transient read,
  // not a signal to retire every pool (which would halt indexing and TTL upkeep network-wide).
  if (pools.length > 0) {
    await db.query(
      "update pools set active = false where active = true and not (address = any($1))",
      [pools.map((p) => p.pool)],
    );
  }

  logger.info({ count: pools.length }, "pools synced");
}

// Records each pool's creation ledger so the leaf indexer can seed its cursor independent of the
// RPC sliding window. The null-guarded UPDATE makes this write-once.
async function seedCreatedLedgers(): Promise<void> {
  const { rows: pending } = await db.query<{ c: number }>(
    "select count(*)::int as c from pools where created_ledger is null",
  );
  if (pending[0].c === 0) return;

  try {
    const latest = (await server.getLatestLedger()).sequence;
    const oldest = await rpcOldestEventLedger(config.FACTORY_ID, latest, config.INDEXER_MAX_WINDOW);
    const start = Math.max(config.INDEXER_START_LEDGER, oldest + FLOOR_SAFETY_LEDGERS);
    let cursor: string | undefined;

    for (;;) {
      const filters = [{ type: "contract" as const, contractIds: [config.FACTORY_ID] }];
      const res = await server.getEvents(
        cursor
          ? { cursor, filters, limit: EVENT_PAGE_LIMIT }
          : { startLedger: start, filters, limit: EVENT_PAGE_LIMIT },
      );

      for (const event of res.events) {
        try {
          if (!isPoolCreatedEvent(event)) continue;
          const created = parsePoolCreatedEvent(event);
          await db.query(
            "update pools set created_ledger = $2 where address = $1 and created_ledger is null",
            [created.pool, created.ledger],
          );
        } catch (err) {
          logger.error({ err, ledger: event.ledger }, "skipping unparseable pool_created event");
        }
      }

      const cursorLedger = Number(BigInt(res.cursor.split("-")[0]) >> 32n);
      if (cursorLedger >= res.latestLedger) break;
      cursor = res.cursor;
    }
  } catch (err) {
    logger.warn({ err }, "seedCreatedLedgers scan failed; retrying next cycle");
  }
}

export async function activePools(): Promise<string[]> {
  const { rows } = await db.query<{ address: string }>(
    "select address from pools where active = true",
  );
  return rows.map((r) => r.address);
}

// A Stellar Asset Contract reports the classic asset code, or "native" for XLM.
async function assetLabel(token: string): Promise<string> {
  const symbol = (await readContract(token, "symbol")) as string;
  return symbol === "native" ? "XLM" : symbol;
}
