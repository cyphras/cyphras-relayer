import { server, readContract, relayerXlmBalance } from "../stellar/rpc.js";
import {
  instanceLiveUntil,
  extendInstanceTtl,
  contractWasmHash,
  codeLiveUntil,
  extendCodeTtl,
} from "../stellar/ttl.js";
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
  const contracts = [config.FACTORY_ID, verifier, ...(await activePools())];

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
      logger.error({ err, contract }, "ttl extend failed");
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
      logger.error({ err, wasm: hex.slice(0, 8) }, "code ttl extend failed");
    }
  }
}

// Tops up any channel that drained during operation and warns when the master wallet runs low.
async function monitor(): Promise<void> {
  await channelPool.ensureFunded();
  const balance = await relayerXlmBalance();
  if (balance !== null && stroops(balance) < BigInt(config.MASTER_MIN_BALANCE_STROOPS)) {
    await alert("relayer master balance below threshold, top up the wallet", { balance });
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
