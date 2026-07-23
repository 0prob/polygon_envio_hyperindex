DROP INDEX CONCURRENTLY IF EXISTS idx_pool_meta_updated_keyset;

CREATE INDEX CONCURRENTLY idx_pool_meta_updated_keyset
    ON "PoolMeta" ("updatedAtBlock", id);

ANALYZE "PoolMeta";
