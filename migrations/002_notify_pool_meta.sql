-- Migration: PostgreSQL LISTEN/NOTIFY trigger for real-time pool discovery.
-- When Envio inserts/updates PoolMeta rows, this sends a NOTIFY so the
-- Rust bot can trigger immediate discovery instead of waiting for the
-- next poll interval.
-- Run: psql $PG_URL -f migrations/002_notify_pool_meta.sql

-- Notification payload: JSON with pool address and protocol for early routing.
CREATE OR REPLACE FUNCTION notify_pool_meta_change()
RETURNS trigger AS $$
BEGIN
    PERFORM pg_notify(
        'pool_meta_channel',
        json_build_object(
            'address', NEW."address",
            'protocol', NEW.protocol,
            'action', TG_OP
        )::text
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop first to make this idempotent for re-runs.
DROP TRIGGER IF EXISTS trg_pool_meta_notify ON "PoolMeta";

CREATE TRIGGER trg_pool_meta_notify
    AFTER INSERT OR UPDATE OF "address", protocol, tokens
    ON "PoolMeta"
    FOR EACH ROW
    EXECUTE FUNCTION notify_pool_meta_change();
