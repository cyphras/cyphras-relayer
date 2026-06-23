import { db } from "../db/pool.js";
import { alert } from "../lib/alert.js";

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
  relayer: string;
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

// Keyed on nullifier_hash (unique). A brand-new note inserts a queued job. A repeat schedule for a
// note whose job has terminally failed or gone dead (exhausted its retry budget) re-arms it with the
// new proof/recipient and re-queues it - this is how a sender retries delivery or recovers a stuck
// deposit to their own account (the recipient is a reveal-time input, not bound in the commitment).
// A job that is queued, executing, or already confirmed is left untouched: its nullifier is in flight
// or spent, so re-revealing would be wasteful or impossible.
export async function scheduleJob(params: ScheduleParams): Promise<ScheduledJob> {
  const delay = delaySeconds(params.privacyLevel);
  const values = [
    params.pool,
    params.proof,
    params.root,
    params.nullifierHash,
    params.amountHash,
    params.recipient,
    params.relayer,
    params.xlmFee,
    params.privacyLevel,
    delay,
  ];
  const { rows } = await db.query<UpsertRow>(
    `insert into reveal_jobs
       (pool, proof, root, nullifier_hash, amount_hash, recipient, relayer, relayer_fee,
        privacy_level, scheduled_for)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + ($10 || ' seconds')::interval)
     on conflict (nullifier_hash) do update set
       proof = excluded.proof,
       root = excluded.root,
       amount_hash = excluded.amount_hash,
       recipient = excluded.recipient,
       relayer = excluded.relayer,
       relayer_fee = excluded.relayer_fee,
       privacy_level = excluded.privacy_level,
       scheduled_for = excluded.scheduled_for,
       status = 'queued',
       attempts = 0,
       failure_reason = null,
       updated_at = now()
     where reveal_jobs.status in ('failed', 'dead')
     returning id, status, scheduled_for, (xmax = 0) as inserted`,
    values,
  );

  if (rows[0]) {
    return {
      id: rows[0].id,
      status: rows[0].status,
      scheduledFor: rows[0].scheduled_for,
      idempotent: !rows[0].inserted,
    };
  }

  // Conflict on a job that is queued, executing, or confirmed: the DO UPDATE WHERE filtered it out,
  // so return the existing job unchanged rather than disturbing an in-flight or completed reveal.
  const existing = await db.query<{ id: string; status: string; scheduled_for: string }>(
    `select id, status, scheduled_for from reveal_jobs where nullifier_hash = $1`,
    [params.nullifierHash],
  );
  const row = existing.rows[0];
  return {
    id: row.id,
    status: row.status,
    scheduledFor: row.scheduled_for,
    idempotent: true,
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

export interface DueJob {
  id: string;
  pool: string;
  proof: string;
  root: string;
  nullifierHash: string;
  amountHash: string;
  recipient: string;
  relayer: string;
  xlmFee: string;
}

// Atomically claims up to `limit` jobs whose delay has elapsed, flipping them to executing so a
// concurrent worker cannot grab the same row.
export async function claimDueJobs(limit: number): Promise<DueJob[]> {
  const { rows } = await db.query<DueJobRow>(
    `update reveal_jobs set status = 'executing', updated_at = now()
     where id in (
       select id from reveal_jobs
       where status = 'queued' and scheduled_for <= now()
       order by scheduled_for
       limit $1
       for update skip locked
     )
     returning id, pool, proof, root, nullifier_hash, amount_hash, recipient, relayer, relayer_fee`,
    [limit],
  );
  return rows.map((r) => ({
    id: r.id,
    pool: r.pool,
    proof: r.proof,
    root: r.root,
    nullifierHash: r.nullifier_hash,
    amountHash: r.amount_hash,
    recipient: r.recipient,
    relayer: r.relayer,
    xlmFee: r.relayer_fee,
  }));
}

// txHash is null when the reveal was already on-chain (a spent nullifier), so the relayer confirms
// the outcome without having submitted the transaction itself. observedFee is the resource fee this
// reveal actually cost, recorded to drive future fee quotes; it is absent on the already-on-chain path.
export async function markConfirmed(
  id: string,
  txHash: string | null,
  observedFee?: number,
): Promise<void> {
  await db.query(
    `update reveal_jobs set status = 'confirmed', tx_hash = $2, observed_fee = $3, updated_at = now()
     where id = $1`,
    [id, txHash, observedFee ?? null],
  );
}

// Average full reveal-flow cost observed on recent reveals, both confirmed ones and fee_below_gas
// rejections (which record the cost they needed). Including rejections lets the quote rise to meet a
// risen cost instead of staying stuck below it. Null until one is recorded.
export async function recentObservedRevealFee(sampleSize: number): Promise<number | null> {
  const { rows } = await db.query<{ avg: number | null }>(
    `select avg(observed_fee)::float8 as avg from (
       select observed_fee from reveal_jobs
       where observed_fee is not null
       order by updated_at desc limit $1
     ) recent`,
    [sampleSize],
  );
  return rows[0]?.avg ?? null;
}

// Privacy hygiene: a terminal job's recipient, proof, and timing link a deposit to its withdrawal.
// Past the retention window none of it is needed, so the row is deleted. Replay protection does not
// depend on this row; the pool's on-chain nullifier check at reveal is the authority, so any
// resubmission is judged on-chain.
export async function purgeTerminalJobs(retentionHours: number): Promise<number> {
  const { rowCount } = await db.query(
    `delete from reveal_jobs
     where status in ('confirmed', 'failed', 'dead')
       and updated_at < now() - ($1 || ' hours')::interval`,
    [retentionHours],
  );
  return rowCount ?? 0;
}

// A reveal the simulation refused (bad proof, fee below gas) is terminal: the locked proof and fee
// will not become valid on retry.
export async function markRejected(
  id: string,
  reason: string,
  observedFee?: number,
): Promise<void> {
  await db.query(
    `update reveal_jobs set status = 'failed', failure_reason = $2,
       observed_fee = coalesce($3, observed_fee), updated_at = now()
     where id = $1`,
    [id, reason, observedFee ?? null],
  );
}

// A transient error (RPC, timeout, on-chain failure mid-flight) is retried with exponential backoff
// until REVEAL_MAX_ATTEMPTS, then dead-lettered.
export async function markForRetry(id: string, maxAttempts: number): Promise<void> {
  const { rows } = await db.query<{ status: string; attempts: number }>(
    `update reveal_jobs set
       attempts = attempts + 1,
       status = (case when attempts + 1 >= $2 then 'dead' else 'queued' end)::job_status,
       scheduled_for = now() + (least(power(2, attempts)::int, 60) || ' minutes')::interval,
       failure_reason = case when attempts + 1 >= $2 then 'max_attempts' else failure_reason end,
       updated_at = now()
     where id = $1
     returning status, attempts`,
    [id, maxAttempts],
  );
  if (rows[0]?.status === "dead") {
    await alert(
      "reveal job dead-lettered after max attempts; recipient unpaid until the owner self-reclaims",
      {
        job: id,
        attempts: rows[0].attempts,
      },
    );
  }
}

// On startup, jobs left in executing by a crash mid-flight are returned to the queue.
export async function requeueStuck(): Promise<number> {
  const { rowCount } = await db.query(
    "update reveal_jobs set status = 'queued', updated_at = now() where status = 'executing'",
  );
  return rowCount ?? 0;
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

interface DueJobRow {
  id: string;
  pool: string;
  proof: string;
  root: string;
  nullifier_hash: string;
  amount_hash: string;
  recipient: string;
  relayer: string;
  relayer_fee: string;
}
