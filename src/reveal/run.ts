import { channelPool, type Channel } from "../channels/pool.js";
import { relayerKeypairs } from "../stellar/rpc.js";
import { executeReveal } from "./execute.js";
import {
  claimDueJobs,
  markConfirmed,
  markRejected,
  markForRetry,
  requeueStuck,
  type DueJob,
} from "../relay/jobs.js";
import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";
import { beat } from "../lib/heartbeat.js";

async function processJob(job: DueJob): Promise<void> {
  let channel: Channel;
  try {
    channel = await channelPool.acquire(job.relayer);
  } catch {
    // The job's relayer is not one of our masters (e.g. config changed after it was scheduled), so
    // it can never be routed. Terminal, not a retry.
    await markRejected(job.id, "unknown_relayer");
    logger.warn({ job: job.id, relayer: job.relayer }, "no channel for relayer master");
    return;
  }
  try {
    const result = await executeReveal(job, channel);
    if (result.ok) {
      await markConfirmed(job.id, result.txHash, result.observedFee);
      logger.info({ job: job.id, tx: result.txHash }, "reveal confirmed");
    } else if (result.reason === "already_revealed") {
      await markConfirmed(job.id, null);
      logger.info({ job: job.id }, "reveal already on-chain");
    } else {
      await markRejected(job.id, result.reason);
      logger.warn({ job: job.id, reason: result.reason }, "reveal rejected");
    }
  } catch (err) {
    await markForRetry(job.id, config.REVEAL_MAX_ATTEMPTS);
    logger.error({ err, job: job.id }, "reveal errored, scheduled for retry");
  } finally {
    channelPool.release(channel);
  }
}

async function cycle(): Promise<void> {
  // Claim at most one job per channel across all masters; acquire() blocks if a master's channels
  // are all busy, so over-claiming would stall.
  const jobs = await claimDueJobs(config.CHANNEL_COUNT * relayerKeypairs.length);
  if (jobs.length === 0) {
    return;
  }
  await Promise.all(jobs.map(processJob));
}

export async function startExecutor(): Promise<void> {
  const requeued = await requeueStuck();
  if (requeued > 0) {
    logger.info({ requeued }, "requeued stuck reveal jobs");
  }

  let running = false;
  const tick = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      await cycle();
      beat("executor");
    } catch (err) {
      logger.error({ err }, "executor cycle failed");
    } finally {
      running = false;
    }
  };
  void tick();
  setInterval(() => void tick(), config.EXECUTOR_POLL_INTERVAL_MS);
}
