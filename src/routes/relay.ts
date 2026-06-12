import type { FastifyInstance } from "fastify";
import { scheduleJob, getJob, poolExists, type PrivacyLevel } from "../relay/jobs.js";

const HEX = (n: number) => `^[0-9a-fA-F]{${n}}$`;
const STELLAR_CONTRACT = "^C[A-Z2-7]{55}$";
const STELLAR_ADDRESS = "^[GC][A-Z2-7]{55}$";
const UUID = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

// BN254 scalar field modulus. Public inputs are field elements, so the contract reduces them mod r.
// A value at or above r is a non-canonical encoding of a smaller element: rejecting it stops the
// same nullifier from being resubmitted in an alternate 32-byte form that slips past dedup.
const FIELD_MODULUS = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617",
);

function isCanonicalField(hex: string): boolean {
  return BigInt("0x" + hex) < FIELD_MODULUS;
}

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
      if (
        !isCanonicalField(body.root) ||
        !isCanonicalField(body.nullifierHash) ||
        !isCanonicalField(body.amountHash)
      ) {
        reply.code(400);
        return { error: "non-canonical field element" };
      }
      if (!(await poolExists(body.pool))) {
        reply.code(404);
        return { error: "unknown pool" };
      }

      // Lowercase hex so a case variant of the same nullifier cannot slip past the unique-nullifier dedup.
      const job = await scheduleJob({
        pool: body.pool,
        proof: body.proof.toLowerCase(),
        root: body.root.toLowerCase(),
        nullifierHash: body.nullifierHash.toLowerCase(),
        amountHash: body.amountHash.toLowerCase(),
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
