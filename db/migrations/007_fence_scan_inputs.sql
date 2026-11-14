-- A queued legacy job which already exhausted its attempts must fail without
-- executing the analyzer a sixth time. Preserve all other existing fences.
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
       OR (OLD.state = 'queued' AND NEW.state = 'failed' AND OLD.attempt >= 5
           AND NEW.error_code = 'RETRY_LIMIT_EXCEEDED')
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

-- A completed or cancelled scan must not acquire new provenance rows, even
-- through a direct runtime-role write outside the application worker.
CREATE OR REPLACE FUNCTION codethread.guard_scan_input_file() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE object_format text;
DECLARE job_state text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'scan input provenance is immutable' USING ERRCODE = '23514';
  END IF;
  SELECT git_object_format, state INTO object_format, job_state
    FROM codethread.scan_job WHERE id = NEW.scan_job_id FOR UPDATE;
  IF job_state IS DISTINCT FROM 'running' THEN
    RAISE EXCEPTION 'scan inputs require a running job' USING ERRCODE = '23514';
  END IF;
  IF object_format IS NULL OR
     (object_format = 'sha1' AND NEW.git_blob_oid !~ '^[0-9a-f]{40}$') OR
     (object_format = 'sha256' AND NEW.git_blob_oid !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'scan input blob does not match pinned object format' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION codethread.guard_scan_project() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE job_state text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'scan project provenance is immutable' USING ERRCODE = '23514';
  END IF;
  SELECT state INTO job_state FROM codethread.scan_job
    WHERE id = NEW.scan_job_id AND repository_id = NEW.repository_id FOR UPDATE;
  IF job_state IS DISTINCT FROM 'running' THEN
    RAISE EXCEPTION 'scan projects require a running job' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_scan_project_insert BEFORE INSERT OR UPDATE
  ON codethread.scan_project FOR EACH ROW EXECUTE FUNCTION codethread.guard_scan_project();

CREATE FUNCTION codethread.guard_terminal_scan_result() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('succeeded', 'failed', 'cancelled') AND
     (NEW.activation_result, NEW.error_code, NEW.error_message, NEW.session_json)
       IS DISTINCT FROM
     (OLD.activation_result, OLD.error_code, OLD.error_message, OLD.session_json) THEN
    RAISE EXCEPTION 'terminal scan result is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_terminal_scan_result BEFORE UPDATE ON codethread.scan_job
  FOR EACH ROW EXECUTE FUNCTION codethread.guard_terminal_scan_result();
