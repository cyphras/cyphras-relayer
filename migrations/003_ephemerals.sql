create table ephemerals (
  pubkey text primary key,
  secret text not null,
  channel text not null,
  job_id uuid references reveal_jobs (id) on delete set null,
  created_at timestamptz not null default now()
);

create index ephemerals_created_idx on ephemerals (created_at);
