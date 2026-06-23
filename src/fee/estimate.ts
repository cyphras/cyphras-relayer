import { server } from "../stellar/rpc.js";
import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";
import { recentObservedRevealFee } from "../relay/jobs.js";

export interface FeeQuote {
  feeStroops: string;
  tierStroops: number;
  validForSeconds: number;
}

// The relayer pays gas for the whole ephemeral reveal flow (sponsor, reveal, merge). That resource
// cost is nearly constant per reveal, so the most accurate input is the cost observed from recent
// reveals; when none is available the configured baseline is used. The market inclusion fee is read
// live so quotes rise with congestion. The result is rounded up to a coarse tier so many users share
// one fee value, which avoids an on-chain fee fingerprint linking a commit to its reveal.
export async function estimateFee(): Promise<FeeQuote> {
  const resource = Math.max((await observedRevealFee()) ?? 0, config.REVEAL_FLOW_FEE_STROOPS);
  const inclusion = await currentInclusionFee();
  const withMargin = Math.ceil(((resource + inclusion) * (10000 + config.FEE_MARGIN_BPS)) / 10000);
  const tier = config.FEE_TIER_STROOPS;
  const feeStroops = Math.ceil(withMargin / tier) * tier;
  return {
    feeStroops: feeStroops.toString(),
    tierStroops: tier,
    validForSeconds: config.FEE_QUOTE_TTL_SECONDS,
  };
}

// Returns the cost observed from recent reveals, or null when none has been recorded yet; callers
// fall back to the configured baseline.
async function observedRevealFee(): Promise<number | null> {
  const avg = await recentObservedRevealFee(config.FEE_SAMPLE_SIZE);
  return avg === null ? null : Math.ceil(avg);
}

async function currentInclusionFee(): Promise<number> {
  try {
    const stats = await server.getFeeStats();
    // p90 is absent when the recent window held no Soroban transactions; Number() would yield NaN
    // and poison the quote, so treat any non-finite value as the fallback.
    const p90 = Number(stats.sorobanInclusionFee?.p90);
    return Number.isFinite(p90) && p90 >= 0 ? p90 : config.FEE_FALLBACK_INCLUSION_STROOPS;
  } catch (err) {
    logger.warn({ err }, "fee stats unavailable, using fallback inclusion fee");
    return config.FEE_FALLBACK_INCLUSION_STROOPS;
  }
}
