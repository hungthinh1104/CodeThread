CREATE OR REPLACE FUNCTION codethread.guard_snapshot_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE table_owner text;
BEGIN
  SELECT pg_get_userbyid(relowner) INTO table_owner
    FROM pg_class WHERE oid='codethread.repository_snapshot'::regclass;
  IF TG_OP='DELETE' THEN
    IF current_user <> table_owner THEN
      RAISE EXCEPTION 'snapshot deletion requires the protected retention procedure' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.state='published' THEN
    RAISE EXCEPTION 'published snapshot is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.state='published' AND (
      NEW.published_at IS NULL OR
      (to_jsonb(NEW) - 'state' - 'published_at') IS DISTINCT FROM
      (to_jsonb(OLD) - 'state' - 'published_at')
    ) THEN
    RAISE EXCEPTION 'publication may only change state and publication time' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION codethread.guard_snapshot_child() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE parent_state text; snapshot_owner text;
BEGIN
  IF TG_OP='DELETE' THEN
    SELECT state INTO parent_state FROM codethread.repository_snapshot
      WHERE id=OLD.snapshot_id FOR UPDATE;
    IF parent_state='published' THEN
      SELECT pg_get_userbyid(relowner) INTO snapshot_owner
        FROM pg_class WHERE oid='codethread.repository_snapshot'::regclass;
      IF current_user <> snapshot_owner THEN
        RAISE EXCEPTION 'published snapshot payload is immutable' USING ERRCODE='23514';
      END IF;
    END IF;
    RETURN OLD;
  ELSIF TG_OP='INSERT' THEN
    SELECT state INTO parent_state FROM codethread.repository_snapshot
      WHERE id=NEW.snapshot_id FOR UPDATE;
    IF parent_state='published' THEN
      RAISE EXCEPTION 'published snapshot payload is immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT state INTO parent_state FROM codethread.repository_snapshot
    WHERE id=OLD.snapshot_id FOR UPDATE;
  IF parent_state='published' THEN
    RAISE EXCEPTION 'published snapshot payload is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id THEN
    SELECT state INTO parent_state FROM codethread.repository_snapshot
      WHERE id=NEW.snapshot_id FOR UPDATE;
    IF parent_state='published' THEN
      RAISE EXCEPTION 'published snapshot payload is immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION codethread.guard_source_object() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE table_owner text;
BEGIN
  IF TG_OP='DELETE' THEN
    SELECT pg_get_userbyid(relowner) INTO table_owner
      FROM pg_class WHERE oid='codethread.source_object'::regclass;
    IF current_user=table_owner THEN RETURN OLD; END IF;
  END IF;
  RAISE EXCEPTION 'content-addressed source objects are immutable' USING ERRCODE='23514';
END $$;

CREATE FUNCTION codethread.prune_inactive_data(
  p_before timestamptz,
  p_job_limit integer DEFAULT 100,
  p_snapshot_limit integer DEFAULT 100,
  p_source_limit integer DEFAULT 1000
) RETURNS TABLE(deleted_jobs integer,deleted_snapshots integer,deleted_sources integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,codethread AS $$
DECLARE candidate record;
BEGIN
  IF p_before IS NULL OR p_before > clock_timestamp() OR
     p_job_limit NOT BETWEEN 0 AND 1000 OR
     p_snapshot_limit NOT BETWEEN 0 AND 1000 OR
     p_source_limit NOT BETWEEN 0 AND 10000 THEN
    RAISE EXCEPTION 'invalid retention cutoff or batch limit' USING ERRCODE='22023';
  END IF;
  deleted_jobs := 0;
  deleted_snapshots := 0;
  deleted_sources := 0;

  FOR candidate IN
    SELECT j.id FROM codethread.scan_job j
    WHERE j.state IN ('succeeded','failed','cancelled') AND j.updated_at < p_before
      AND NOT EXISTS (
        SELECT 1 FROM codethread.repository r WHERE r.active_job_id=j.id
      )
    ORDER BY j.updated_at,j.id
    LIMIT p_job_limit FOR UPDATE OF j SKIP LOCKED
  LOOP
    IF NOT pg_try_advisory_xact_lock(1919606127, hashtext(candidate.id::text)) THEN
      CONTINUE;
    END IF;
    DELETE FROM codethread.scan_project WHERE scan_job_id=candidate.id;
    DELETE FROM codethread.scan_input_file WHERE scan_job_id=candidate.id;
    DELETE FROM codethread.scan_job WHERE id=candidate.id;
    deleted_jobs := deleted_jobs + 1;
  END LOOP;

  FOR candidate IN
    SELECT s.id FROM codethread.repository_snapshot s
    WHERE s.state='published' AND s.created_at < p_before
      AND NOT EXISTS (
        SELECT 1 FROM codethread.scan_project p WHERE p.snapshot_id=s.id
      )
    ORDER BY s.created_at,s.id
    LIMIT p_snapshot_limit FOR UPDATE OF s SKIP LOCKED
  LOOP
    IF NOT pg_try_advisory_xact_lock(1919606126, hashtext(candidate.id::text)) THEN
      CONTINUE;
    END IF;
    DELETE FROM codethread.relation_evidence WHERE snapshot_id=candidate.id;
    DELETE FROM codethread.code_relation WHERE snapshot_id=candidate.id;
    DELETE FROM codethread.code_symbol WHERE snapshot_id=candidate.id;
    DELETE FROM codethread.diagnostic WHERE snapshot_id=candidate.id;
    DELETE FROM codethread.source_evidence WHERE snapshot_id=candidate.id;
    DELETE FROM codethread.snapshot_file WHERE snapshot_id=candidate.id;
    DELETE FROM codethread.snapshot_capability WHERE snapshot_id=candidate.id;
    DELETE FROM codethread.repository_snapshot WHERE id=candidate.id;
    deleted_snapshots := deleted_snapshots + 1;
  END LOOP;

  WITH candidates AS (
    SELECT o.sha256 FROM codethread.source_object o
    WHERE NOT EXISTS (
        SELECT 1 FROM codethread.snapshot_file f WHERE f.content_hash=o.sha256
      )
      AND NOT EXISTS (
        SELECT 1 FROM codethread.scan_input_file i WHERE i.content_hash=o.sha256
      )
    ORDER BY o.created_at,o.sha256
    LIMIT p_source_limit FOR UPDATE OF o SKIP LOCKED
  )
  DELETE FROM codethread.source_object o USING candidates c
    WHERE o.sha256=c.sha256;
  GET DIAGNOSTICS deleted_sources = ROW_COUNT;
  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION codethread.prune_inactive_data(timestamptz,integer,integer,integer) FROM PUBLIC;
