-- Migration: Focused index for incremental updatedAtBlock queries.
-- The bot's fetch_pool_meta_incremental() UNION ALL has two branches:
--   1. WHERE "createdBlock" > $1              ← covered by idx_pool_meta_keyset
--   2. WHERE "updatedAtBlock" > $2            ← needs its own index
--
-- Branch 2 is a pure > scan on updatedAtBlock. A composite index with
-- createdBlock as the leading column (idx_pool_meta_incr) cannot serve this
-- as an exact index condition — Postgres must scan createdBlock <= $3 first,
-- then filter. A standalone descending index on updatedAtBlock alone gives
-- exact access for the second branch.
--
-- The partial WHERE clause filters out rows that will never match (> 0),
-- keeping the index smaller.
--
-- Run: psql $PG_URL -f migrations/004_pool_meta_updated_index.sql

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pool_meta_updated
    ON "PoolMeta" ("updatedAtBlock" DESC)
    WHERE "updatedAtBlock" > 0;

ANALYZE "PoolMeta";
