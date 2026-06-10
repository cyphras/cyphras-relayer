import Fastify, { type FastifyInstance } from "fastify";
import { healthRoutes } from "../routes/health.js";
import { infoRoutes } from "../routes/info.js";
import { logger } from "../lib/logger.js";

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });

  // Keep internal error details out of responses; log the real cause server-side.
  app.setErrorHandler((err, _req, reply) => {
    logger.error({ err }, "request failed");
    reply.code(500).send({ error: "internal error" });
  });

  app.register(healthRoutes);
  app.register(infoRoutes);
  return app;
}
