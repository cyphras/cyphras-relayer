import type { FastifyInstance } from "fastify";
import { scheduleJob, getJob, poolExists, type PrivacyLevel } from "../relay/jobs.js";

const HEX = (n: number) => `^[0-9a-fA-F]{${n}}$`;
const STELLAR_CONTRACT = "^C[A-Z2-7]{55}$";
const STELLAR_ADDRESS = "^[GC][A-Z2-7]{55}$";
const UUID = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

interface ScheduleBody {
  pool: string;
  proof: string;
  root: string;
  nullifierHash: string;
  amountHash: string;
  recipient: string;
  xlmFee: string;
  privacyLevel?: PrivacyLevel;
}

const scheduleSchema = {
  body: {
    type: "object",
    required: ["pool", "proof", "root", "nullifierHash", "amountHash", "recipient", "xlmFee"],
    additionalProperties: false,
    properties: {
      pool: { type: "string", pattern: STELLAR_CONTRACT },
      proof: { type: "string", pattern: HEX(512) },
      root: { type: "string", pattern: HEX(64) },
      nullifierHash: { type: "string", pattern: HEX(64) },
      amountHash: { type: "string", pattern: HEX(64) },
      recipient: { type: "string", pattern: STELLAR_ADDRESS },
      xlmFee: { type: "string", pattern: "^[0-9]+$", maxLength: 20 },
      privacyLevel: { type: "string", enum: ["fast", "standard", "maximum"] },
    },
  },
};

const statusSchema = {
  params: {
    type: "object",
    required: ["jobId"],
    properties: { jobId: { type: "string", pattern: UUID } },
  },
};

export async function relayRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: ScheduleBody }>(
    "/v1/relay/schedule",
    { schema: scheduleSchema },
    async (req, reply) => {
      const body = req.body;
      if (!(await poolExists(body.pool))) {
        reply.code(404);
        return { error: "unknown pool" };
      }

      const job = await scheduleJob({
        pool: body.pool,
        proof: body.proof,
        root: body.root,
        nullifierHash: body.nullifierHash,
        amountHash: body.amountHash,
        recipient: body.recipient,
        xlmFee: body.xlmFee,
        privacyLevel: body.privacyLevel ?? "standard",
      });

      reply.code(job.idempotent ? 200 : 202);
      return { jobId: job.id, status: job.status, scheduledFor: job.scheduledFor };
    },
  );

  app.get<{ Params: { jobId: string } }>(
    "/v1/relay/status/:jobId",
    { schema: statusSchema },
    async (req, reply) => {
      const job = await getJob(req.params.jobId);
      if (!job) {
        reply.code(404);
        return { error: "job not found" };
      }
      return job;
    },
  );
}
