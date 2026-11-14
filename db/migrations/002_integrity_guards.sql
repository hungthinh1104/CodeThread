ALTER TABLE codethread.source_evidence
  ADD CONSTRAINT source_evidence_snapshot_id_id_file_key
  UNIQUE (snapshot_id, id, file_id);

ALTER TABLE codethread.code_symbol
  DROP CONSTRAINT code_symbol_snapshot_id_declaration_evidence_id_fkey;
ALTER TABLE codethread.code_symbol
  ADD CONSTRAINT code_symbol_declaration_owner_fk
  FOREIGN KEY (snapshot_id, declaration_evidence_id, file_id)
  REFERENCES codethread.source_evidence(snapshot_id, id, file_id);

ALTER TABLE codethread.scan_job
  ADD CONSTRAINT scan_job_git_provenance_complete CHECK (
    (git_object_format IS NULL AND git_commit_oid IS NULL AND git_tree_oid IS NULL)
    OR (git_object_format = 'sha1'
      AND git_commit_oid ~ '^[0-9a-f]{40}$'
      AND git_tree_oid ~ '^[0-9a-f]{40}$')
    OR (git_object_format = 'sha256'
      AND git_commit_oid ~ '^[0-9a-f]{64}$'
      AND git_tree_oid ~ '^[0-9a-f]{64}$')
  );

ALTER TABLE codethread.scan_input_file
  ADD COLUMN input_kind text NOT NULL DEFAULT 'source'
  CHECK (input_kind IN ('source','metadata'));

CREATE OR REPLACE FUNCTION codethread.guard_snapshot_child() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE parent_state text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT state INTO parent_state FROM codethread.repository_snapshot
      WHERE id = OLD.snapshot_id FOR UPDATE;
    IF parent_state = 'published' THEN
      RAISE EXCEPTION 'published snapshot payload is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  ELSIF TG_OP = 'INSERT' THEN
    SELECT state INTO parent_state FROM codethread.repository_snapshot
      WHERE id = NEW.snapshot_id FOR UPDATE;
    IF parent_state = 'published' THEN
      RAISE EXCEPTION 'published snapshot payload is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT state INTO parent_state FROM codethread.repository_snapshot
    WHERE id = OLD.snapshot_id FOR UPDATE;
  IF parent_state = 'published' THEN
    RAISE EXCEPTION 'published snapshot payload is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id THEN
    SELECT state INTO parent_state FROM codethread.repository_snapshot
      WHERE id = NEW.snapshot_id FOR UPDATE;
    IF parent_state = 'published' THEN
      RAISE EXCEPTION 'published snapshot payload is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION codethread.guard_scan_job_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.repository_id, NEW.generation, NEW.idempotency_key,
      NEW.request_hash, NEW.revision_selector, NEW.configuration_hash,
      NEW.analyzer_version, NEW.analyzer_build_hash)
     IS DISTINCT FROM
     (OLD.id, OLD.repository_id, OLD.generation, OLD.idempotency_key,
      OLD.request_hash, OLD.revision_selector, OLD.configuration_hash,
      OLD.analyzer_version, OLD.analyzer_build_hash) THEN
    RAISE EXCEPTION 'scan request identity is immutable' USING ERRCODE = '23514';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
       (OLD.state = 'queued' AND NEW.state IN ('running', 'cancelled'))
       OR (OLD.state = 'running' AND NEW.state IN ('queued', 'succeeded', 'failed', 'cancelled'))
     ) THEN
    RAISE EXCEPTION 'invalid scan job state transition' USING ERRCODE = '23514';
  END IF;

  IF NEW.attempt IS DISTINCT FROM OLD.attempt AND NOT (
       OLD.state = 'queued' AND NEW.state = 'running'
       AND NEW.attempt = OLD.attempt + 1
     ) THEN
    RAISE EXCEPTION 'scan attempt may increase only when claiming queued work' USING ERRCODE = '23514';
  END IF;

  IF OLD.git_commit_oid IS NOT NULL AND (
       NEW.git_object_format IS DISTINCT FROM OLD.git_object_format
       OR NEW.git_commit_oid IS DISTINCT FROM OLD.git_commit_oid
       OR NEW.git_tree_oid IS DISTINCT FROM OLD.git_tree_oid
     ) THEN
    RAISE EXCEPTION 'pinned Git provenance is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.git_commit_oid IS NULL AND NEW.git_commit_oid IS NOT NULL AND
       (OLD.state <> 'running' OR NEW.git_object_format IS NULL OR NEW.git_tree_oid IS NULL) THEN
    RAISE EXCEPTION 'Git provenance may be pinned only by a running scan' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_scan_job_update BEFORE UPDATE ON codethread.scan_job
FOR EACH ROW EXECUTE FUNCTION codethread.guard_scan_job_update();

CREATE FUNCTION codethread.guard_scan_input_file() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE object_format text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'scan input provenance is immutable' USING ERRCODE = '23514';
  END IF;
  SELECT git_object_format INTO object_format FROM codethread.scan_job
    WHERE id = NEW.scan_job_id FOR UPDATE;
  IF object_format IS NULL OR
     (object_format = 'sha1' AND NEW.git_blob_oid !~ '^[0-9a-f]{40}$') OR
     (object_format = 'sha256' AND NEW.git_blob_oid !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'scan input blob does not match pinned object format' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_scan_input_file_insert BEFORE INSERT OR UPDATE
ON codethread.scan_input_file FOR EACH ROW
EXECUTE FUNCTION codethread.guard_scan_input_file();

CREATE FUNCTION codethread.guard_active_job() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE job_state text; activation text;
BEGIN
  IF NEW.active_job_id IS NULL THEN RETURN NEW; END IF;
  SELECT state,activation_result INTO job_state,activation
    FROM codethread.scan_job WHERE id=NEW.active_job_id AND repository_id=NEW.id;
  IF job_state IS DISTINCT FROM 'succeeded' OR activation IS DISTINCT FROM 'activated' THEN
    RAISE EXCEPTION 'active job must be successfully activated' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER guard_repository_active_job
AFTER INSERT OR UPDATE ON codethread.repository
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION codethread.guard_active_job();
