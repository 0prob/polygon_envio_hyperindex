-- Purge legacy zombie V2 DEX pools before removing enum variants from schema.
DELETE FROM "PoolMeta"
WHERE protocol IN ('DFYN_V2', 'MESHSWAP_V2', 'JETSWAP_V2', 'COMETHSWAP_V2');