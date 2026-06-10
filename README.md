# cyphras-relayer

Relayer service for Cyphras private payments. It indexes commit events, serves commitment
leaves so clients build their own Merkle path, submits reveal transactions through ephemeral
accounts, and keeps contract state alive via TTL bumps. Cyphras runs a single relayer; the
reveal path is permissionless on-chain, so the relayer is a convenience, never a custodian.

## Quick start

Requires a container runtime (Docker Engine, or Colima on macOS).

```
cp .env.example .env
# set RELAYER_SECRET to the relayer wallet secret (testnet throwaway for now)
docker compose up
```

This starts PostgreSQL and the relayer, runs migrations on boot, and serves the API on
`http://localhost:8080`.

Health check:

```
curl http://localhost:8080/v1/health
```

## Layout

```
src/
  config/      env loading and validation
  lib/         logging
  db/          connection pool and migration runner
  stellar/     RPC and Horizon clients, relayer keypair
  routes/      HTTP routes
  server/      Fastify app and entrypoint
migrations/    SQL migrations applied in order on boot
scripts/       operational and diagnostic scripts
```

## API (v1)

| Method | Path       | Status |
| ------ | ---------- | ------ |
| GET    | /v1/health | live   |

Additional info and relay endpoints are added incrementally.

## Scripts

```
POOL_ID=<pool address> npm run spike:simulate
```

Simulates a deployed pool call and prints the resource fee. This is the primitive the fee
estimator and the pre-submit economic guard are built on.
