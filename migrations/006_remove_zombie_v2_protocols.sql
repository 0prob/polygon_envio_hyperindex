-- Purge legacy zombie V2 DEX pools before removing enum variants from schema.
-- Compare via ::text so this stays valid after those enum labels are dropped.
DELETE FROM "PoolMeta"
WHERE protocol::text IN ('DFYN_V2', 'MESHSWAP_V2', 'JETSWAP_V2', 'COMETHSWAP_V2');
