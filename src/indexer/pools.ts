import { config } from "../config/index.js";
import { readContract } from "../stellar/rpc.js";
import { db } from "../db/pool.js";
import { logger } from "../lib/logger.js";

interface PoolInfo {
  token: string;
  denomination: bigint;
  generation: number;
  pool: string;
}

export async function syncPools(): Promise<void> {
  const pools = (await readContract(config.FACTORY_ID, "get_pools")) as PoolInfo[];

  for (const p of pools) {
    const asset = await assetLabel(p.token);
    await db.query(
      `insert into pools (address, token, asset, denomination, generation, active)
       values ($1, $2, $3, $4, $5, true)
       on conflict (address) do update set
         token = excluded.token,
         asset = excluded.asset,
         denomination = excluded.denomination,
         generation = excluded.generation`,
      [p.pool, p.token, asset, p.denomination.toString(), p.generation],
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
