#!/usr/bin/env bash
# Dump the local Envio Postgres database (PoolMeta, sync state, etc.).
#
# Usage:
#   bun run backup-db
#   BACKUP_DIR=~/backups bun run backup-db
#
# Restore (stop envio dev first):
#   gunzip -c hyperindex/backups/envio-dev-YYYYMMDD-HHMMSS.sql.gz | \
#     docker exec -i envio-postgres psql -U postgres -d envio-dev

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER="${ENVIO_POSTGRES_CONTAINER:-envio-postgres}"
DB_USER="${ENVIO_POSTGRES_USER:-postgres}"
DB_NAME="${ENVIO_POSTGRES_DB:-envio-dev}"
BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_FILE="$BACKUP_DIR/${DB_NAME}-${STAMP}.sql.gz"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found in PATH" >&2
  exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "Postgres container '$CONTAINER' is not running." >&2
  echo "Start HyperIndex first (e.g. bun run dev from repo root)." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

echo "Backing up $DB_NAME from $CONTAINER -> $OUT_FILE"
docker exec "$CONTAINER" pg_dump -U "$DB_USER" --no-owner --no-acl "$DB_NAME" | gzip >"$OUT_FILE"

BYTES="$(wc -c <"$OUT_FILE" | tr -d ' ')"
echo "Done: $OUT_FILE ($BYTES bytes compressed)"
echo
echo "Restore:"
echo "  gunzip -c \"$OUT_FILE\" | docker exec -i $CONTAINER psql -U $DB_USER -d $DB_NAME"
