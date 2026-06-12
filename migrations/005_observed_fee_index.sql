create index reveal_jobs_observed_fee_idx on reveal_jobs (updated_at desc)
  where status = 'confirmed' and observed_fee is not null;
