# Deploying a Cyphras relayer

Run your own relayer on a fresh VPS with one command. The relayer is self-contained:
a Node service and its own PostgreSQL, behind nginx with automatic TLS.

## Prerequisites

- A fresh Ubuntu 22.04 / 24.04 VPS, with root access.
- A domain (or subdomain) whose DNS `A` record points at the VPS IP.
- A funded Stellar account to act as the relayer master wallet (its secret seed).
- The factory contract ID for the network you are serving.

## Steps

1. Point your domain's `A` record at the VPS, and wait for it to resolve.

2. On the VPS, clone the repo:

   ```bash
   git clone https://github.com/cyphras/cyphras-relayer.git /opt/cyphras-relayer
   cd /opt/cyphras-relayer
   ```

3. Create and fill in `.env`:

   ```bash
   cp .env.example .env
   nano .env
   ```

   At minimum set:

   - `DOMAIN` - the domain you pointed at the VPS
   - `LETSENCRYPT_EMAIL` - your email for the TLS certificate
   - `POSTGRES_PASSWORD` - a strong value (`openssl rand -hex 24`)
   - `RELAYER_SECRET` - the master wallet secret seed
   - `FACTORY_ID` - the factory contract for your network
   - `INDEXER_START_LEDGER` - the factory's deploy ledger, so no commit history is missed
   - `STELLAR_RPC_URL`, `STELLAR_HORIZON_URL`, `STELLAR_NETWORK_PASSPHRASE`
   - `TRUST_PROXY_HOPS=1` - the relayer runs behind nginx
   - `ALLOWED_ORIGINS` - the browser origins allowed to call the API (or `*`)

   Optionally add `RELAYER_EXTRA_SECRETS` for additional master wallets, and
   `ALERT_WEBHOOK_URL` for balance and integrity alerts.

4. Run the setup once:

   ```bash
   bash setup.sh
   ```

   It installs Docker, nginx, and certbot, configures the firewall, writes the
   reverse proxy for your domain, obtains TLS, and starts the relayer. It is safe
   to re-run.

5. Fund the master wallet (and any extras) with XLM so it can sponsor reveals,
   fee-bump, and run the TTL keeper. See [docs/operations.md](docs/operations.md)
   for key custody, rotation, and balance monitoring.

## After setup

- API base: `https://<your-domain>/v1`
- Health: `https://<your-domain>/v1/health`
- `/metrics` is reachable from localhost only (for a Prometheus on the host).

Operations:

```bash
docker compose logs -f relayer      # logs
docker compose restart relayer      # restart
git pull && docker compose up -d --build   # update
```

Back up Postgres off-host with `scripts/backup.sh` from cron - it holds reveal jobs, merge state,
the leaf cursor, and ephemeral-channel secrets that cannot be re-derived from chain. Backup, restore,
key custody, rotation, and balance monitoring are in [docs/operations.md](docs/operations.md).

## Serving mainnet alongside testnet

One VPS can serve both networks on the same domain, sharing a single `.env`. The relayer
secrets (`RELAYER_SECRET`, `RELAYER_EXTRA_SECRETS`) are identical on both networks - the same
keypair controls the same account on each, funded independently - so only the network URLs and
factory differ. A second relayer process with its own database runs in parallel, and nginx routes
each request to the right one by the `X-Cyphras-Network` header the client sends. A request with no
header goes to testnet, so existing clients keep working.

1. In the same `.env`, set the mainnet factory (the mainnet RPC, Horizon, and passphrase are
   supplied by the mainnet compose file):

   ```
   MAINNET_FACTORY_ID=<mainnet factory contract>
   MAINNET_INDEXER_START_LEDGER=<factory deploy ledger>
   ```

2. Fund the mainnet master wallet (and any extras) with mainnet XLM. The relayer funds its channels
   from the master on boot, so do this before starting the stack. The accounts exist on both
   networks under the same secret, but each network's balance is separate.

3. Make sure nginx is the header-routing version: re-run `bash setup.sh` (it rewrites the vhost and
   the routing map), or add the `map` to `/etc/nginx/conf.d/cyphras-relayer-limits.conf` and point
   the `/v1/` `proxy_pass` at `http://$relayer_upstream` by hand, then `nginx -t && systemctl reload nginx`.

4. Start the parallel mainnet stack (its own database, bound to `127.0.0.1:8081`):

   ```bash
   docker compose -f docker-compose.mainnet.yml up -d
   ```

   It reuses every secret and tuning value from `.env`, overrides only the network vars, and runs
   migrations on its fresh database on boot.

5. In the wallet extension, fill the mainnet network's private config: the same `relayerUrl` as
   testnet (`https://<your-domain>`), the mainnet factory, and the mainnet SAC token addresses. The
   extension tags each call with `X-Cyphras-Network` from the active network, so no per-network URL
   is needed.

Testnet and mainnet never collide: separate databases (the nullifier index is per-database),
separate pools and tokens, and the header keeps every request on its own backend.

Operations for the mainnet stack mirror testnet, with the compose file flag:

```bash
docker compose -f docker-compose.mainnet.yml logs -f relayer-mainnet
docker compose -f docker-compose.mainnet.yml up -d --build   # update
```
