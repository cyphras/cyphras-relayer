-- recentObservedRevealFee now averages observed_fee across confirmed reveals AND fee_below_gas
-- rejections, so the supporting index can no longer be partial on status = 'confirmed'.
drop index if exists reveal_jobs_observed_fee_idx;
create index reveal_jobs_observed_fee_idx on reveal_jobs (updated_at desc)
  where observed_fee is not null;
