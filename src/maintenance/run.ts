import { server, readContract, relayerKeypairs, xlmBalanceOf } from "../stellar/rpc.js";
import {
  instanceLiveUntil,
  extendInstanceTtl,
  contractWasmHash,
  codeLiveUntil,
  extendCodeTtl,
  readWithPersistentKeys,
  minLiveUntil,
  extendPersistentTtl,
} from "../stellar/ttl.js";
import { xdr } from "@stellar/stellar-sdk";
import { activePools } from "../indexer/pools.js";
import { channelPool } from "../channels/pool.js";
import { sweepEphemerals } from "../reveal/ephemerals.js";
import { purgeTerminalJobs } from "../relay/jobs.js";
import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";
import { alert } from "../lib/alert.js";

// Keeper and monitor run in one serial loop to avoid redundant work within a cycle.

// Bumps the instance TTL of the factory, verifier, and every active pool before it nears archival.
// The whole commit working set lives in instance storage, so one bump per contract keeps it alive.
async function keeper(): Promise<void> {
  const latest = (await server.getLatestLedger()).sequence;
  const verifier = (await readContract(config.FACTORY_ID, "get_verifier")) as string;
  const pools = await activePools();
  const contracts = [config.FACTORY_ID, verifier, ...pools];

  const wasmHashes = new Map<string, Buffer>();
  for (const contract of contracts) {
    try {
      const liveUntil = await instanceLiveUntil(contract);
      if (liveUntil === null) {
        continue;
      }
      if (liveUntil - latest < config.KEEPER_THRESHOLD_LEDGERS) {
        await extendInstanceTtl(contract, config.KEEPER_EXTEND_LEDGERS);
        logger.info({ contract }, "instance ttl extended");
      }
      const hash = await contractWasmHash(contract);
      if (hash) {
        wasmHashes.set(hash.toString("hex"), hash);
      }
    } catch (err) {
      await alert("contract TTL maintenance failed, it may drift toward archival", {
        contract,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Every pool shares one Wasm hash, so the unique set is small. Keeping the code alive avoids a
  // restore on the first call to a contract that has sat idle past the code entry's TTL.
  for (const [hex, hash] of wasmHashes) {
    try {
      const liveUntil = await codeLiveUntil(hash);
      if (liveUntil !== null && liveUntil - latest < config.KEEPER_THRESHOLD_LEDGERS) {
        await extendCodeTtl(hash, config.KEEPER_EXTEND_LEDGERS);
        logger.info({ wasm: hex.slice(0, 8) }, "code ttl extended");
      }
    } catch (err) {
      await alert("contract code TTL maintenance failed, it may drift toward archival", {
        wasm: hex.slice(0, 8),
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await keepPersistentState(latest, pools);
}

// Keeps alive the persistent entries the instance keeper does not cover: each pool's latest root
// state (so long-held notes stay revealable) and the factory registry (so pools stay discoverable).
// On-chain those get a TTL bump only when written, so an idle pool or a dormant registry drifts
// toward archival. Only still-live entries are extended: an already-archived entry cannot be
// extended (only restored), and simulation reads it via an in-sim restore, so trying to extend it
// is a no-op that would re-fire every cycle. Archived entries are left to the reveal path's
// restore-on-demand instead.
async function keepPersistentState(latest: number, pools: string[]): Promise<void> {
  const targets: { label: string; keys: xdr.LedgerKey[] }[] = [];

  try {
    const registry = await readWithPersistentKeys(config.FACTORY_ID, "get_pools");
    targets.push({ label: "factory registry", keys: registry.persistentKeys });
  } catch (err) {
    await alert("factory registry TTL discovery failed, it may drift toward archival", {
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  for (const pool of pools) {
    try {
      const history = await readWithPersistentKeys(pool, "get_last_root");
      const known = await readWithPersistentKeys(pool, "is_known_root", [
        xdr.ScVal.scvBytes(Buffer.from(history.value as Uint8Array)),
      ]);
      const keys = [...history.persistentKeys, ...known.persistentKeys];
      if (keys.length === 0) {
        logger.warn(
          { pool },
          "pool root state harvested no persistent keys, contract layout may have changed",
        );
      }
      targets.push({ label: `pool ${pool} root state`, keys });
    } catch (err) {
      await alert("pool root-state TTL discovery failed, it may drift toward archival", {
        pool,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const { label, keys } of targets) {
    if (keys.length === 0) {
      continue;
    }
    try {
      const liveUntil = await minLiveUntil(keys);
      if (
        liveUntil !== null &&
        liveUntil > latest &&
        liveUntil - latest < config.KEEPER_THRESHOLD_LEDGERS
      ) {
        await extendPersistentTtl(keys, config.KEEPER_EXTEND_LEDGERS, label);
        logger.info({ target: label }, "persistent ttl extended");
      }
    } catch (err) {
      await alert("persistent-entry TTL maintenance failed, it may drift toward archival", {
        target: label,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// Tops up any channel that drained during operation and warns when the master wallet runs low.
async function monitor(): Promise<void> {
  await channelPool.ensureFunded();
  for (const master of relayerKeypairs) {
    const balance = await xlmBalanceOf(master.publicKey());
    if (balance !== null && stroops(balance) < BigInt(config.MASTER_MIN_BALANCE_STROOPS)) {
      await alert("relayer master balance below threshold, top up the wallet", {
        master: master.publicKey(),
        balance,
      });
    }
  }
}

// A Stellar balance is always a 7-decimal string, so dropping the dot yields stroops.
function stroops(balance: string): bigint {
  return BigInt(balance.replace(".", ""));
}

export function startMaintenance(): void {
  let running = false;
  const tick = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      await keeper();
      await monitor();
      const reclaimed = await sweepEphemerals();
      if (reclaimed > 0) {
        logger.info({ reclaimed }, "reclaimed orphaned ephemeral reserves");
      }
      const purged = await purgeTerminalJobs(config.JOB_RETENTION_HOURS);
      if (purged > 0) {
        logger.info({ purged }, "purged terminal reveal jobs past retention");
      }
    } catch (err) {
      logger.error({ err }, "maintenance cycle failed");
    } finally {
      running = false;
    }
  };
  void tick();
  setInterval(() => void tick(), config.MAINTENANCE_INTERVAL_MS);
}
