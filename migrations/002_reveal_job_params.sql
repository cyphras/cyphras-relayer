alter table reveal_jobs
  add column proof text not null,
  add column root text not null,
  add column amount_hash text not null,
  add column privacy_level text not null default 'standard',
  add column scheduled_for timestamptz not null default now(),
  add column failure_reason text;

create index reveal_jobs_due_idx on reveal_jobs (scheduled_for) where status = 'queued';
