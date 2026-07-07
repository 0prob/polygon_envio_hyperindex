-- Migration: Composite index for the incremental UNION ALL discovery query.
-- The bot's fetch_pool_meta_incremental() uses:
--   WHERE "createdBlock" > $1
--   UNION ALL
--   WHERE "updatedAtBlock" > $2 AND "createdBlock" <= $3
--   ORDER BY "sortBlock" ASC
--
-- A covering composite index on (createdBlock, updatedAtBlock) enables efficient
-- index-only scans for both branches of the UNION ALL, replacing two individual
-- index scans + bitmaps with a single ordered pass.
--
-- Run: psql $PG_URL -f migrations/003_composite_incremental_index.sql
--
-- See also: 001_pool_meta_indexes.sql (keyset bootstrap index)

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pool_meta_incr
    ON "PoolMeta" ("createdBlock", "updatedAtBlock");

ANALYZE "PoolMeta";
