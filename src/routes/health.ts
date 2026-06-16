import type { FastifyInstance } from "fastify";
import { db } from "../db/pool.js";
import { server, relayerKeypairs, xlmBalanceOf } from "../stellar/rpc.js";
import { config } from "../config/index.js";
import { lastBeat } from "../lib/heartbeat.js";

// A background loop is alive if it beat within several poll intervals; the slack tolerates one slow cycle
// without flapping, while a wedged loop still trips the check.
function fresh(name: string, intervalMs: number): boolean {
  const last = lastBeat(name);
  return last !== null && Date.now() - last < intervalMs * 5;
}

function stroops(balance: string): bigint {
  return BigInt(balance.replace(".", ""));
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  // Liveness probes poll frequently, so this route runs a higher limit than the global one rather
  // than no limit, which would leave its DB + RPC + Horizon fan-out as an unauthenticated DoS surface.
  const rateLimit = { max: config.RATE_LIMIT_MAX * 5, timeWindow: config.RATE_LIMIT_WINDOW_MS };
  app.get("/v1/health", { config: { rateLimit } }, async (_req, reply) => {
    const checks = { db: false, rpc: false, indexer: false, executor: false };

    try {
      await db.query("select 1");
      checks.db = true;
    } catch {
      // surfaced via checks.db = false
    }

    try {
      const health = await server.getHealth();
      checks.rpc = health.status === "healthy";
    } catch {
      // surfaced via checks.rpc = false
    }

    checks.indexer = fresh("indexer", config.INDEXER_POLL_INTERVAL_MS);
    checks.executor = fresh("executor", config.EXECUTOR_POLL_INTERVAL_MS);

    // Balances are informational: a low master is paged by the maintenance monitor, not treated as a
    // liveness failure here (a 503 would trigger restarts that do not refill the wallet).
    const masters = await Promise.all(
      relayerKeypairs.map(async (kp) => {
        let xlmBalance: string | null = null;
        try {
          xlmBalance = await xlmBalanceOf(kp.publicKey());
        } catch {
          // xlmBalance stays null
        }
        const low =
          xlmBalance === null || stroops(xlmBalance) < BigInt(config.MASTER_MIN_BALANCE_STROOPS);
        return { publicKey: kp.publicKey(), xlmBalance, low };
      }),
    );

    const ok = checks.db && checks.rpc && checks.indexer && checks.executor;
    reply.code(ok ? 200 : 503);
    return { ok, checks, masters };
  });
}
