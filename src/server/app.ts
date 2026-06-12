import Fastify, { type FastifyInstance, type FastifyError } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { healthRoutes } from "../routes/health.js";
import { infoRoutes } from "../routes/info.js";
import { relayRoutes } from "../routes/relay.js";
import { metricsRoutes } from "../routes/metrics.js";
import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";

export async function buildApp(): Promise<FastifyInstance> {
  // Largest legitimate payload is a fixed-size proof plus a few hashes; anything larger or slower
  // is malformed or abusive, so cap body size and request time.
  const app = Fastify({
    logger: false,
    bodyLimit: config.BODY_LIMIT_BYTES,
    requestTimeout: config.REQUEST_TIMEOUT_MS,
    // Only honor X-Forwarded-For when explicitly deployed behind a known number of proxy hops, so
    // the rate limit keys on the real client IP without letting a direct client spoof the header.
    trustProxy: config.TRUST_PROXY_HOPS > 0 ? config.TRUST_PROXY_HOPS : false,
  });

  // Rate-limit per client to keep proof submissions and status polls from exhausting RPC and DB.
  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
  });

  // Schema-validation messages are safe to surface and help the caller fix the request. Any other
  // error is logged and returned generically so internals (DB, RPC, stack detail) never leak.
  app.setErrorHandler((err: FastifyError, _req, reply) => {
    if (err.validation) {
      reply.code(err.statusCode ?? 400).send({ error: err.message });
      return;
    }
    const status = err.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      reply.code(status).send({ error: "bad request" });
      return;
    }
    logger.error({ err }, "request failed");
    reply.code(500).send({ error: "internal error" });
  });

  app.register(healthRoutes);
  app.register(infoRoutes);
  app.register(relayRoutes);
  app.register(metricsRoutes);
  return app;
}
