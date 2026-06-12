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

Backups and operations details are in [docs/operations.md](docs/operations.md).
