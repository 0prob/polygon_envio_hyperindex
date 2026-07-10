-- Canonical keyset index for bootstrap pagination:
--   WHERE ("createdBlock", id) > ($1, $2) ORDER BY "createdBlock", id
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pool_meta_keyset
    ON "PoolMeta" ("createdBlock", id);