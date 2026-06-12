import { channelPool } from "../channels/pool.js";
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

async function processJob(job: DueJob): Promise<void> {
  const channel = await channelPool.acquire();
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
  // Claim at most one job per channel; acquire() would block unboundedly if jobs exceeded channels.
  const jobs = await claimDueJobs(config.CHANNEL_COUNT);
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
    } catch (err) {
      logger.error({ err }, "executor cycle failed");
    } finally {
      running = false;
    }
  };
  void tick();
  setInterval(() => void tick(), config.EXECUTOR_POLL_INTERVAL_MS);
}
