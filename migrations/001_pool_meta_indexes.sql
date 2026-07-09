CREATE INDEX IF NOT EXISTS "PoolMeta_createdBlock_id_idx"
ON "PoolMeta" ("createdBlock", id);

CREATE INDEX IF NOT EXISTS "PoolMeta_updatedAtBlock_idx"
ON "PoolMeta" ("updatedAtBlock");

CREATE INDEX IF NOT EXISTS "PoolMeta_protocol_createdBlock_idx"
ON "PoolMeta" (protocol, "createdBlock");

