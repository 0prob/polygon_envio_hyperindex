CREATE OR REPLACE FUNCTION notify_pool_meta_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify(
    'pool_meta_channel',
    json_build_object(
      'id', NEW.id,
      'address', NEW.address,
      'protocol', NEW.protocol,
      'createdBlock', NEW."createdBlock",
      'updatedAtBlock', NEW."updatedAtBlock"
    )::text
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pool_meta_notify_trigger ON "PoolMeta";

CREATE TRIGGER pool_meta_notify_trigger
AFTER INSERT OR UPDATE ON "PoolMeta"
FOR EACH ROW
EXECUTE FUNCTION notify_pool_meta_change();

