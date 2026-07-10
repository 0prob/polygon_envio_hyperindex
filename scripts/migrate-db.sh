#!/usr/bin/env bash
set -euo pipefail

# Apply post-Envio PoolMeta migrations (indexes + LISTEN/NOTIFY trigger).
# Usage:
#   bun run migrate-db
#   PG_URL=postgres://... bun run migrate-db

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

source_env() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  set -a
  # shellcheck disable=SC1090
  source "$file"
  set +a
}

if [[ -z "${PG_URL:-}" ]]; then
  source_env "$ROOT/.env"
fi
if [[ -z "${PG_URL:-}" ]]; then
  # Arb bot .env (sibling repo) is the usual PG_URL source when running from h/.
  source_env "$ROOT/../c/.env"
fi

PG_URL="${PG_URL:-${ENVIO_PG_URL:-${DATABASE_URL:-}}}"
if [[ -z "$PG_URL" ]]; then
  PG_HOST="${ENVIO_POSTGRES_HOST:-localhost}"
  PG_PORT="${ENVIO_POSTGRES_PORT:-5433}"
  PG_USER="${ENVIO_POSTGRES_USER:-postgres}"
  PG_PASS="${ENVIO_POSTGRES_PASSWORD:-testing}"
  PG_DB="${ENVIO_POSTGRES_DB:-envio-dev}"
  if [[ -n "$PG_PASS" ]]; then
    PG_URL="postgres://${PG_USER}:${PG_PASS}@${PG_HOST}:${PG_PORT}/${PG_DB}"
  else
    PG_URL="postgres://${PG_USER}@${PG_HOST}:${PG_PORT}/${PG_DB}"
  fi
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "psql not found in PATH" >&2
  exit 1
fi

MIGRATIONS=(
  migrations/001_pool_meta_indexes.sql
  migrations/002_notify_pool_meta.sql
  migrations/003_composite_incremental_index.sql
  migrations/004_pool_meta_updated_index.sql
  migrations/005_pool_meta_index_cleanup.sql
)

echo "Using database: ${PG_URL%%@*}@***"
for file in "${MIGRATIONS[@]}"; do
  echo "==> $file"
  psql "$PG_URL" -v ON_ERROR_STOP=1 -f "$file"
done

echo "PoolMeta migrations applied."