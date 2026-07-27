-- Re-open Curve factory bootstrap after the historical pool_count/list bug fix
-- (factory reads were at head while metadata used the handler block).
-- Resetting lastIndex forces a re-walk; existing complete PoolMeta rows are
-- skipped, incomplete (fee null/0 or thin tokens) are re-enriched by the handler.

UPDATE "CurveBootstrapProgress"
SET
    completed = false,
    "lastIndex" = 0,
    total = 0,
    "updatedAtBlock" = 0;
