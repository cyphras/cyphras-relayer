# Incident runbooks

Operational playbooks for the relayer. Throughout, the fund-safety backstop holds: a depositor can
always self-reclaim directly from the pool (recipient = self, fee = 0), so no relayer incident can
lose user funds - the worst case is delayed delivery until the relayer recovers or the user reclaims.

Alerts arrive via `ALERT_WEBHOOK_URL` (required in production). Each alert names the condition; the
runbook below maps conditions to actions.

## Relayer down / not responding

Symptom: external monitor on `/v1/health` fails, or `/v1/health` returns 503.

1. `docker compose ps` and `docker compose logs -f relayer` to see why.
2. The 503 body's `checks` field shows which dependency failed (`db`, `rpc`, `indexer`, `executor`).
   - `db` false -> see "Database loss / restore".
   - `rpc` false -> see "RPC outage".
   - `indexer`/`executor` false -> a background loop is wedged: `docker compose restart relayer`.
3. If the container is unhealthy, `docker compose up -d --build relayer`.
4. In-flight reveals resume from the DB on boot (`requeueStuck`); no fund loss.

## Master wallet low or drained

Symptom: alert "relayer master balance below threshold", or reveals stop landing.

1. The master sponsors reveals, fee-bumps, and funds channels. If it runs low, channel top-ups and
   reveals stall (queued, not lost).
2. Send XLM to the master account(s) shown in the alert / in `/v1/health` `masters[]`.
3. On the next maintenance cycle the keeper refunds channels from the master automatically; no
   restart needed. Confirm reveals resume in the logs.
4. If a master key is suspected compromised, rotate it (see operations.md) and refund the new one.

## Contract TTL lapse

Symptom: alert "contract TTL maintenance failed" or a pool/verifier nearing archival.

1. The keeper extends instance + code TTL each maintenance cycle below `KEEPER_THRESHOLD_LEDGERS`.
   Repeated failures usually mean RPC trouble or a low master balance - resolve those first.
2. Persistent pool storage is restore-on-demand: a reveal touching archived state submits a
   `RestoreFootprint` automatically, so an archived pool still works on the next reveal.
3. If a contract has already archived and the keeper is healthy again, the next cycle re-extends it;
   force one by `docker compose restart relayer` (maintenance runs on boot).

## RPC outage

Symptom: alert "indexer falling behind", executor errors, or `/v1/health` `rpc` false.

1. Confirm the configured `STELLAR_RPC_URL` is the problem (curl its health).
2. Point `STELLAR_RPC_URL` (and `STELLAR_HORIZON_URL` if also affected) at a healthy provider in
   `.env`, then `docker compose up -d relayer`.
3. The indexer backfills from its stored cursor and the executor drains the queue once RPC is back;
   no data is lost across the outage.

## Database loss / restore

Symptom: `/v1/health` `db` false, or a lost/corrupt Postgres volume.

Postgres holds non-re-derivable state (reveal jobs, merge state, leaf cursor, ephemeral-channel
secrets). Restore from the most recent off-host backup - see "Backups and restore" in
[operations.md](operations.md). Restore priority: leaf cursor and ephemeral secrets first, then jobs.
Any job row lost without a backup still leaves the user able to self-reclaim.

## Factory admin key compromise

Symptom: admin key suspected leaked, or an unexpected `propose_pool_wasm` / pool deployment appears.

1. A stolen admin key cannot touch funds in existing pools or forge proofs - it can only deploy rogue
   new pools, rotate denominations, or propose a new pool WASM (the latter behind a ~24h timelock).
2. Immediately `set_admin` to a safe key or multisig you control (see [TRUST.md in
   cyphras-contracts](https://github.com/cyphras/cyphras-contracts/blob/main/TRUST.md)).
3. If a malicious `propose_pool_wasm` is pending, the timelock buys time: rotate admin before it can
   be enacted.
4. Tell clients to verify pool addresses against the factory registry (the extension already does
   this before every commit), so a rogue pool cannot capture deposits.

## Verifier / proving-key (zkey) compromise

1. Testnet uses a development trusted setup whose toxic waste is known - the testnet zkey is forgeable
   by design and testnet pools must hold no real value. A "compromise" there is expected; no action.
2. Mainnet uses a Phase-2 MPC ceremony VK (cyphras-extension Issue #9). The VK is immutable in the
   verifier, so a compromised mainnet VK has no in-place fix: redeploy the verifier with a fresh
   ceremony VK, stand up a new factory + pools, and migrate. Existing depositors withdraw from the
   old pools first.
