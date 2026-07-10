-- Drop redundant indexes that duplicate bot composite indexes or are unused by
-- the arb bot's discovery queries. Envio schema @index fields recreate some of
-- these on fresh deploy; run this after schema trim + migrations 001-004.
--
-- Run: psql $PG_URL -f migrations/005_pool_meta_index_cleanup.sql

DROP INDEX CONCURRENTLY IF EXISTS "PoolMeta_createdBlock_id_idx";
DROP INDEX CONCURRENTLY IF EXISTS "PoolMeta_createdBlock_idx";
DROP INDEX CONCURRENTLY IF EXISTS "PoolMeta_updatedAtBlock_idx";
DROP INDEX CONCURRENTLY IF EXISTS "PoolMeta_protocol_createdBlock_idx";
DROP INDEX CONCURRENTLY IF EXISTS "PoolMeta_protocol_idx";
DROP INDEX CONCURRENTLY IF EXISTS "PoolMeta_tokens_idx";
DROP INDEX CONCURRENTLY IF EXISTS "PoolMeta_poolId_idx";

ANALYZE "PoolMeta";