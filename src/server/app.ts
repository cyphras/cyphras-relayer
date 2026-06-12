import Fastify, { type FastifyInstance, type FastifyError } from "fastify";
import { healthRoutes } from "../routes/health.js";
import { infoRoutes } from "../routes/info.js";
import { relayRoutes } from "../routes/relay.js";
import { logger } from "../lib/logger.js";

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });

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
  return app;
}
