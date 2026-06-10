import type { FastifyInstance } from "fastify";
import { db } from "../db/pool.js";
import { estimateFee } from "../fee/estimate.js";

const MAX_LEAF_PAGE = 10000;
const DEFAULT_LEAF_PAGE = 1000;

interface LeafRow {
  leaf_index: number;
  commitment: string;
  root: string;
}

export async function infoRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/info/fee", async () => {
    const quote = await estimateFee();
    return { asset: "XLM", ...quote };
  });

  app.get("/v1/info/pools", async () => {
    const { rows } = await db.query(
      `select address, token, asset, denomination, generation, active
       from pools order by asset, denomination`,
    );
    return { pools: rows };
  });

  app.get<{ Params: { pool: string }; Querystring: { from?: string; limit?: string } }>(
    "/v1/info/leaves/:pool",
    async (req, reply) => {
      const { pool } = req.params;
      const from = Number(req.query.from ?? "0");
      const limit = Number(req.query.limit ?? DEFAULT_LEAF_PAGE);
      if (!Number.isInteger(from) || from < 0 || !Number.isInteger(limit) || limit < 1) {
        reply.code(400);
        return { error: "from must be a non-negative integer and limit a positive integer" };
      }
      const capped = Math.min(limit, MAX_LEAF_PAGE);

      const { rows } = await db.query<LeafRow>(
        `select leaf_index, commitment, root from leaves
         where pool = $1 and leaf_index >= $2
         order by leaf_index asc limit $3`,
        [pool, from, capped],
      );

      const nextFrom = rows.length === capped ? rows[rows.length - 1].leaf_index + 1 : null;
      return { pool, from, leaves: rows, nextFrom };
    },
  );
}
