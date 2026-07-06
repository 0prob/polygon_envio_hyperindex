-- Migration: Composite indexes for pool discovery queries.
-- Run after Envio schema creation: psql $PG_URL -f migrations/001_pool_meta_indexes.sql
--
-- The bot's keyset-paginated bootstrap needs:
--   WHERE ("createdBlock", id) > ($1, $2) ORDER BY "createdBlock", id LIMIT $3
-- A composite covering index enables index-only scans for this pattern.
--
-- The incremental UNION ALL query reads by:
--   WHERE "createdBlock" > $1
--   WHERE "updatedAtBlock" > $2 AND "createdBlock" <= $3 ORDER BY "sortBlock"
-- Individual indexes on createdBlock and updatedAtBlock already exist from
-- the GraphQL @index directives. The composite below covers the keyset case.

-- ponytail: BRIN indexes would be smaller on append-mostly tables like PoolMeta
-- but the keyset ORDER BY + LIMIT needs B-tree ordering. Keep B-tree.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pool_meta_keyset
    ON "PoolMeta" ("createdBlock", id);

-- The _meta table is small (< 10 rows), no index needed beyond the PK.
-- IndexerProgress is small too. TokenMeta is a narrow table with PK on id.
-- No additional indexes needed for those.

ANALYZE "PoolMeta";
