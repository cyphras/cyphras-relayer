# Cyphras Relayer Operations

Production operations guide for running the cyphras-relayer service. All
configuration names below are the real environment variables read by
`src/config/index.ts`; see `.env.example` for defaults and inline notes.

## Key custody

The relayer's master secret is the single Stellar account that signs and pays
for everything the service does on chain. It is supplied through the
`RELAYER_SECRET` environment variable: a 56-character Stellar secret seed (the
`S...` form), validated as exactly 56 characters in `src/config/index.ts`. The
key is loaded into memory once in `src/stellar/rpc.ts`
(`Keypair.fromSecret(config.RELAYER_SECRET)`) and used to derive every channel
account and to sign master-sourced transactions.

`RELAYER_SECRET` is intentionally blank in `.env.example` and must never be
committed. Treat it as the most sensitive value in the deployment.

The optional `RELAYER_EXTRA_SECRETS` (comma-separated) adds further master wallets,
each funding its own channels and collecting its own fees. Everything in this guide
about the master, storage, rotation, and balance monitoring, applies to each.

### Recommended storage

Pick one of the following, in rough order of preference:

- A secrets manager (for example AWS Secrets Manager, GCP Secret Manager, HashiCorp
  Vault), injected into the process environment at start time.
- A Docker or Compose secret mounted at runtime, read into the environment by the
  entrypoint.
- A restricted-permission env file (for example `0600`, owned by the service user)
  that is outside the repository and excluded from any image build context.

Never place the secret in the repository, in a built image layer, in shell
history, or in logs. The application never logs the secret, and `alert()` in
`src/lib/alert.ts` only posts the message and the explicit context fields it is
given; do not add the secret to any log or alert context.

### Rotation procedure

Rotating the master key changes the public key, which changes every derived
channel account and the account that holds the master XLM balance. Follow this
order to avoid stranding funds:

1. Generate a new Stellar keypair to serve as the new master.
2. Fund the new master account with XLM.
3. If possible, drain or merge the existing channel accounts and any reserves
   back to the current (old) master first, while the service is still running on
   the old key, so no balance is stranded on accounts derived from the old
   secret. Run a maintenance cycle and confirm ephemeral reserves have been swept
   back before proceeding.
4. Update `RELAYER_SECRET` in the configured secret store to the new seed.
5. Restart the service. On boot the channels re-derive from the new master and
   are re-funded from the new master wallet, in stroops, per `CHANNEL_COUNT`,
   `CHANNEL_FUND_STROOPS`, and `CHANNEL_MIN_BALANCE_STROOPS`.

## Wallet balance monitoring

The master account pays for the full set of on-chain costs:

- Ephemeral sponsor reserves for each reveal (the sponsor transaction in
  `src/reveal/execute.ts`).
- Reveal fee bumps. Each reveal is fee-bumped by the master so it covers the
  inner reveal's resource fee plus inclusion headroom.
- Channel funding and top-ups, derived from and funded by the master on boot and
  topped up each maintenance cycle.
- The TTL keeper, whose `extendFootprintTtl` and any `RestoreFootprint`
  transactions are master-sourced and master-paid.

The maintenance loop in `src/maintenance/run.ts` runs every
`MAINTENANCE_INTERVAL_MS` and, in its `monitor()` step, reads each master's XLM
balance from Horizon (`xlmBalanceOf()` in `src/stellar/rpc.ts`) and compares it,
in stroops, against `MASTER_MIN_BALANCE_STROOPS`. When any master falls below that
threshold it raises an alert via `alert()` in `src/lib/alert.ts`.

How the alert fires:

- It is always written to the logs at error level, with the current balance in
  the context.
- If `ALERT_WEBHOOK_URL` is set, the same message and context are also POSTed to
  that webhook as JSON (`{ "service": "cyphras-relayer", "message": ..., "balance": ... }`).
  `ALERT_WEBHOOK_URL` is optional; with it unset the alert is log-only. Webhook
  delivery is best-effort: a failed POST is logged as a warning and never
  interrupts the maintenance cycle.

What to watch:

- The low-balance alert (message: "relayer master balance below threshold, top up
  the wallet"). When it fires, top up the master wallet promptly so reveals,
  channel top-ups, and TTL maintenance can keep running.
- Set `MASTER_MIN_BALANCE_STROOPS` high enough to leave headroom for several
  maintenance cycles and a burst of reveals between the alert firing and a human
  topping up. The default is 500000000 stroops (50 XLM).
- Configure `ALERT_WEBHOOK_URL` in production so on-call tooling sees the alert
  without scraping logs.

## Contract TTL maintenance

The keeper runs inside the same maintenance loop (`keeper()` in
`src/maintenance/run.ts`, using the helpers in `src/stellar/ttl.ts`). Each cycle
it checks, and when needed extends, the TTL of the contracts the relayer depends
on, paid by the master:

- The instance storage TTL of the factory (`FACTORY_ID`), the verifier (read from
  the factory via `get_verifier`), and every active pool.
- The code (Wasm) TTL of those contracts. Pools share a single Wasm hash, so the
  set of unique code entries to extend is small.

For each entry, the keeper compares the entry's `liveUntilLedgerSeq` against the
latest ledger and extends it by `KEEPER_EXTEND_LEDGERS` only when it is within
`KEEPER_THRESHOLD_LEDGERS` of expiry. The extend is raise-only, so repeating it
is safe. The Merkle frontier and other commit working state live in instance
storage, so a single bump per contract keeps that working set live. Extending the
code entry avoids a restore on the first call to a contract that has sat idle past
its code entry's TTL.

### Persistent storage is restore-on-demand, not proactively extended

The pool's persistent storage, specifically its root history and its
spent-nullifier set, is intentionally NOT extended by the keeper. Under Protocol
23, persistent entries are archived, never deleted: an expired persistent entry
can always be restored. The reveal path handles this automatically. When
simulation reports an archived footprint, `executeReveal()` in
`src/reveal/execute.ts` submits a `RestoreFootprint` (master-sourced) before
submitting the reveal, so any archived pool state is brought back on demand.

Persistent storage is not kept proactively live because it is unbounded: the
spent-nullifier set grows with every reveal, so keeping it live would cost
indefinitely. It is allowed to archive and is restored only when a reveal touches
it.

## Self-reclaim and zero relayer fee

A depositor never has to trust the relayer with their funds, because they can
always reveal their own note directly to the pool contract. The pool's `reveal`
entry point is permissionless: anyone can submit a valid proof. A depositor can
submit a reveal where the recipient is themselves and the `relayer_fee` is `0`,
paying their own transaction gas, without involving the relayer service at all.
The contract accepts `relayer_fee = 0`.

The relayer service itself will not submit a zero-fee (or otherwise underpriced)
reveal. Its economic guard in `src/reveal/execute.ts` simulates the reveal and
refuses any job whose bound fee is below the simulated resource fee plus the
flow overhead it must cover (the sponsor, the merge, and the reveal fee-bump).
A job that fails this check is rejected with reason `fee_below_gas` (a
`relayer_fee` of `0` always falls below gas), so the relayer never submits a
money-losing transaction.

This is the fund-safety escape hatch: because the self-reveal path depends on
nothing the relayer controls, a depositor can always reclaim their full deposit
directly from the pool if the relayer is unavailable, censoring, or overpricing
reveals.
