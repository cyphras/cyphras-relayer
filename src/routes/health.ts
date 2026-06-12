import type { FastifyInstance } from "fastify";
import { db } from "../db/pool.js";
import { server, relayerKeypair, relayerXlmBalance } from "../stellar/rpc.js";
import { config } from "../config/index.js";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  // Liveness probes poll frequently, so this route runs a higher limit than the global one rather
  // than no limit, which would leave its DB + RPC + Horizon fan-out as an unauthenticated DoS surface.
  const rateLimit = { max: config.RATE_LIMIT_MAX * 5, timeWindow: config.RATE_LIMIT_WINDOW_MS };
  app.get("/v1/health", { config: { rateLimit } }, async (_req, reply) => {
    const checks = { db: false, rpc: false, relayer: false };
    let xlmBalance: string | null = null;

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

    try {
      xlmBalance = await relayerXlmBalance();
      checks.relayer = xlmBalance !== null;
    } catch {
      // surfaced via checks.relayer = false
    }

    const ok = checks.db && checks.rpc && checks.relayer;
    reply.code(ok ? 200 : 503);
    return {
      ok,
      checks,
      relayer: { publicKey: relayerKeypair.publicKey(), xlmBalance },
    };
  });
}
