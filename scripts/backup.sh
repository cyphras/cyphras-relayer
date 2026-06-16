#!/usr/bin/env bash
# Off-host Postgres backup for the relayer. Reveal jobs, merge state, the leaf cursor, and ephemeral
# channel secrets live ONLY in Postgres - none of it is re-derivable from chain - so a lost volume with
# no backup permanently strands in-flight reveals and the funds held in ephemeral channels. Run from
# cron and ship the output off the host.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

BACKUP_DIR="${BACKUP_DIR:-/opt/cyphras-relayer-backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"

dump() {
  # $1 compose file, $2 postgres service, $3 db name
  local out="$BACKUP_DIR/$3-$STAMP.sql.gz"
  echo "dumping $3 -> $out"
  # --clean --if-exists so the restore drops and recreates objects, working whether the target DB is
  # empty or already has the migrated schema.
  docker compose -f "$1" exec -T "$2" pg_dump -U relayer -d "$3" --clean --if-exists | gzip >"$out"
  # A truncated dump is worse than none: drop an empty file so a restore never trusts it.
  local size
  size="$(stat -c%s "$out" 2>/dev/null || stat -f%z "$out")"
  if [ "$size" -lt 100 ]; then
    echo "ERROR: $3 dump looks empty, removing" >&2
    rm -f "$out"
    return 1
  fi
}

dump docker-compose.yml postgres relayer

# The mainnet stack is optional; back it up only when its container is running.
if docker compose -f docker-compose.mainnet.yml ps --status running 2>/dev/null | grep -q postgres-mainnet; then
  dump docker-compose.mainnet.yml postgres-mainnet relayer_mainnet
fi

# Prune old local copies.
find "$BACKUP_DIR" -name '*.sql.gz' -mtime +"$RETENTION_DAYS" -delete

# Ship off-host so losing the host or its disk does not also lose the backups. Set BACKUP_REMOTE to an
# rclone remote (e.g. "s3:cyphras-relayer-backups") configured beforehand with `rclone config`.
if [ -n "${BACKUP_REMOTE:-}" ]; then
  echo "copying to $BACKUP_REMOTE"
  rclone copy "$BACKUP_DIR" "$BACKUP_REMOTE" --include '*.sql.gz'
fi

echo "backup complete: $STAMP"
