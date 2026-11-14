ALTER TABLE codethread.code_symbol ADD COLUMN symbol_json jsonb;

-- This migration adds a derived read projection. Its source is the immutable
-- facts envelope, and the whole migration runs under the migration lock.
DROP TRIGGER immutable_symbol ON codethread.code_symbol;
UPDATE codethread.code_symbol AS target
SET symbol_json = source.symbol
FROM codethread.repository_snapshot AS snapshot
CROSS JOIN LATERAL jsonb_array_elements(snapshot.facts_json->'symbols') AS source(symbol)
WHERE snapshot.id = target.snapshot_id
  AND source.symbol->>'id' = target.id::text;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM codethread.code_symbol
    WHERE symbol_json IS NULL
       OR symbol_json->>'snapshotId' IS DISTINCT FROM snapshot_id::text
       OR symbol_json->>'id' IS DISTINCT FROM id::text
       OR symbol_json->>'fileId' IS DISTINCT FROM file_id::text
       OR symbol_json->>'key' IS DISTINCT FROM canonical_key
       OR symbol_json->>'name' IS DISTINCT FROM name
       OR symbol_json->>'kind' IS DISTINCT FROM kind
       OR symbol_json->>'declarationEvidenceId' IS DISTINCT FROM declaration_evidence_id::text
  ) THEN
    RAISE EXCEPTION 'symbol payload backfill does not match normalized identity';
  END IF;
END $$;

ALTER TABLE codethread.code_symbol ALTER COLUMN symbol_json SET NOT NULL;
CREATE TRIGGER immutable_symbol BEFORE INSERT OR UPDATE OR DELETE ON codethread.code_symbol
FOR EACH ROW EXECUTE FUNCTION codethread.guard_snapshot_child();
