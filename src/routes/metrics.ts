import type { FastifyInstance } from "fastify";
import { db } from "../db/pool.js";
import { config } from "../config/index.js";

const JOB_STATUSES = ["queued", "executing", "confirmed", "failed", "dead"];

// Metrics come straight from the DB, so there are no in-memory counters to keep consistent across restarts.
export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  // Scrapers poll often, so allow a higher limit than global, but not none: the DB queries are an
  // unauthenticated DoS surface.
  const rateLimit = {
    max: config.RATE_LIMIT_MAX * 5,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
  };
  app.get("/metrics", { config: { rateLimit } }, async (_req, reply) => {
    const jobs = await db.query<{ status: string; count: number }>(
      "select status::text as status, count(*)::int as count from reveal_jobs group by status",
    );
    const ephemerals = await db.query<{ count: number }>(
      "select count(*)::int as count from ephemerals",
    );
    const leaves = await db.query<{ count: number }>("select count(*)::int as count from leaves");

    const jobCounts = new Map(jobs.rows.map((r) => [r.status, r.count]));
    const lines = [
      "# HELP cyphras_reveal_jobs Reveal jobs by status.",
      "# TYPE cyphras_reveal_jobs gauge",
      ...JOB_STATUSES.map((s) => `cyphras_reveal_jobs{status="${s}"} ${jobCounts.get(s) ?? 0}`),
      "# HELP cyphras_ephemerals_pending Ephemeral accounts awaiting reserve reclaim.",
      "# TYPE cyphras_ephemerals_pending gauge",
      `cyphras_ephemerals_pending ${ephemerals.rows[0].count}`,
      "# HELP cyphras_leaves_total Indexed commitment leaves.",
      "# TYPE cyphras_leaves_total gauge",
      `cyphras_leaves_total ${leaves.rows[0].count}`,
    ];

    reply.header("content-type", "text/plain; version=0.0.4");
    return lines.join("\n") + "\n";
  });
}
