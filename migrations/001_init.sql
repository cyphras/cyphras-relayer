create table pools (
  address text primary key,
  token text not null,
  asset text not null,
  issuer text,
  denomination numeric not null,
  generation integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table leaves (
  pool text not null references pools (address),
  leaf_index integer not null,
  commitment text not null,
  root text not null,
  ledger integer not null,
  primary key (pool, leaf_index)
);

create table indexer_cursor (
  pool text primary key references pools (address),
  last_ledger integer not null
);

create type job_status as enum ('queued', 'executing', 'confirmed', 'failed', 'dead');

create table reveal_jobs (
  id uuid primary key default gen_random_uuid(),
  pool text not null references pools (address),
  nullifier_hash text not null unique,
  recipient text not null,
  relayer_fee numeric not null,
  status job_status not null default 'queued',
  tx_hash text,
  error text,
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index reveal_jobs_status_idx on reveal_jobs (status);
