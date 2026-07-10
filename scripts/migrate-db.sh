#!/usr/bin/env bash
set -euo pipefail

# Apply post-Envio PoolMeta migrations (indexes + LISTEN/NOTIFY trigger).
# Usage:
#   bun run migrate-db
#   PG_URL=postgres://... bun run migrate-db

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -z "${PG_URL:-}" ]]; then
  if [[ -f .env ]]; then
    set -a
    # shellcheck disable=SC1091
    source .env
    set +a
  fi
fi

PG_URL="${PG_URL:-${ENVIO_PG_URL:-${DATABASE_URL:-}}}"
if [[ -z "$PG_URL" ]]; then
  echo "PG_URL is not set (set PG_URL, ENVIO_PG_URL, or DATABASE_URL)" >&2
  exit 1
fi

MIGRATIONS=(
  migrations/001_pool_meta_indexes.sql
  migrations/002_notify_pool_meta.sql
  migrations/003_composite_incremental_index.sql
  migrations/004_pool_meta_updated_index.sql
  migrations/005_pool_meta_index_cleanup.sql
)

for file in "${MIGRATIONS[@]}"; do
  echo "==> $file"
  psql "$PG_URL" -v ON_ERROR_STOP=1 -f "$file"
done

echo "PoolMeta migrations applied."