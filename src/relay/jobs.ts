import { db } from "../db/pool.js";

export type PrivacyLevel = "fast" | "standard" | "maximum";

// A reveal is held for a random delay so its timing does not correlate with the commit. Wider
// ranges grow the anonymity set at the cost of latency. Math.random is fine here: the delay is a
// privacy heuristic, not a secret.
const PRIVACY_DELAY_SECONDS: Record<PrivacyLevel, { min: number; max: number }> = {
  fast: { min: 60, max: 300 },
  standard: { min: 300, max: 1200 },
  maximum: { min: 1200, max: 2700 },
};

export interface ScheduleParams {
  pool: string;
  proof: string;
  root: string;
  nullifierHash: string;
  amountHash: string;
  recipient: string;
  xlmFee: string;
  privacyLevel: PrivacyLevel;
}

export interface ScheduledJob {
  id: string;
  status: string;
  scheduledFor: string;
  idempotent: boolean;
}

function delaySeconds(level: PrivacyLevel): number {
  const { min, max } = PRIVACY_DELAY_SECONDS[level];
  return min + Math.floor(Math.random() * (max - min + 1));
}

// Idempotent on nullifier_hash. ON CONFLICT DO UPDATE (a no-op write) returns the row whether it
// was inserted or already existed and blocks on a concurrent insert of the same note, so a single
// round-trip is race-free with no missing-row window. xmax = 0 marks a fresh insert.
export async function scheduleJob(params: ScheduleParams): Promise<ScheduledJob> {
  const delay = delaySeconds(params.privacyLevel);
  const { rows } = await db.query<UpsertRow>(
    `insert into reveal_jobs
       (pool, proof, root, nullifier_hash, amount_hash, recipient, relayer_fee, privacy_level,
        scheduled_for)
     values ($1, $2, $3, $4, $5, $6, $7, $8, now() + ($9 || ' seconds')::interval)
     on conflict (nullifier_hash) do update set nullifier_hash = excluded.nullifier_hash
     returning id, status, scheduled_for, (xmax = 0) as inserted`,
    [
      params.pool,
      params.proof,
      params.root,
      params.nullifierHash,
      params.amountHash,
      params.recipient,
      params.xlmFee,
      params.privacyLevel,
      delay,
    ],
  );

  const row = rows[0];
  return {
    id: row.id,
    status: row.status,
    scheduledFor: row.scheduled_for,
    idempotent: !row.inserted,
  };
}

export interface JobStatus {
  id: string;
  pool: string;
  status: string;
  txHash: string | null;
  failureReason: string | null;
  attempts: number;
  scheduledFor: string;
  createdAt: string;
}

export async function getJob(id: string): Promise<JobStatus | null> {
  const { rows } = await db.query<StatusRow>(
    `select id, pool, status, tx_hash, failure_reason, attempts, scheduled_for, created_at
     from reveal_jobs where id = $1`,
    [id],
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    id: r.id,
    pool: r.pool,
    status: r.status,
    txHash: r.tx_hash,
    failureReason: r.failure_reason,
    attempts: r.attempts,
    scheduledFor: r.scheduled_for,
    createdAt: r.created_at,
  };
}

export async function poolExists(address: string): Promise<boolean> {
  const { rowCount } = await db.query("select 1 from pools where address = $1", [address]);
  return rowCount !== null && rowCount > 0;
}

interface UpsertRow {
  id: string;
  status: string;
  scheduled_for: string;
  inserted: boolean;
}

interface StatusRow {
  id: string;
  pool: string;
  status: string;
  tx_hash: string | null;
  failure_reason: string | null;
  attempts: number;
  scheduled_for: string;
  created_at: string;
}
