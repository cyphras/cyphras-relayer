import { nativeToScVal } from "@stellar/stellar-sdk";
import { config } from "../config/index.js";
import { readContract } from "../stellar/rpc.js";
import { db } from "../db/pool.js";
import { logger } from "../lib/logger.js";

const POOL_PAGE = 100;

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
