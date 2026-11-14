-- DB-02 candidate. Apply only through a dedicated migration role.
-- Runtime workers do not execute DDL; all source/facts remain snapshot-scoped.
CREATE SCHEMA IF NOT EXISTS codethread;
REVOKE CREATE ON SCHEMA codethread FROM PUBLIC;

CREATE TABLE codethread.repository (
  id uuid PRIMARY KEY,
  local_locator text NOT NULL CHECK (char_length(local_locator) BETWEEN 1 AND 4096),
  desired_generation bigint NOT NULL DEFAULT 0 CHECK (desired_generation >= 0),
  active_job_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE codethread.scan_job (
  id uuid PRIMARY KEY,
  repository_id uuid NOT NULL REFERENCES codethread.repository(id),
  generation bigint NOT NULL CHECK (generation > 0),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  revision_selector text NOT NULL CHECK (char_length(revision_selector) BETWEEN 1 AND 1024),
  configuration_hash char(64) NOT NULL CHECK (configuration_hash ~ '^[0-9a-f]{64}$'),
  analyzer_version text NOT NULL CHECK (char_length(analyzer_version) BETWEEN 1 AND 128),
  analyzer_build_hash char(64) NOT NULL CHECK (analyzer_build_hash ~ '^[0-9a-f]{64}$'),
  git_object_format text CHECK (git_object_format IN ('sha1', 'sha256')),
  git_commit_oid text,
  git_tree_oid text,
  state text NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  activation_result text CHECK (activation_result IN ('activated', 'stale', 'not_eligible')),
  error_code text,
  error_message text,
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repository_id, generation),
  UNIQUE (repository_id, idempotency_key),
  UNIQUE (repository_id, id),
  CHECK ((git_object_format IS NULL AND git_commit_oid IS NULL)
    OR (git_object_format IS NOT NULL AND git_commit_oid IS NOT NULL)),
  CHECK (git_commit_oid IS NULL OR (
    (git_object_format = 'sha1' AND git_commit_oid ~ '^[0-9a-f]{40}$') OR
    (git_object_format = 'sha256' AND git_commit_oid ~ '^[0-9a-f]{64}$')
  ))
);
ALTER TABLE codethread.repository
  ADD CONSTRAINT repository_active_job_fk
  FOREIGN KEY (id, active_job_id)
  REFERENCES codethread.scan_job(repository_id, id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE codethread.source_object (
  sha256 char(64) PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bytes bytea NOT NULL CHECK (octet_length(bytes) <= 33554432),
  byte_length integer NOT NULL CHECK (byte_length >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (octet_length(bytes) = byte_length)
);

CREATE TABLE codethread.scan_input_file (
  scan_job_id uuid NOT NULL REFERENCES codethread.scan_job(id),
  path text NOT NULL CHECK (char_length(path) BETWEEN 1 AND 1024),
  git_blob_oid text NOT NULL CHECK (git_blob_oid ~ '^[0-9a-f]{40}$' OR git_blob_oid ~ '^[0-9a-f]{64}$'),
  git_mode text NOT NULL CHECK (git_mode IN ('100644','100755')),
  content_hash char(64) NOT NULL REFERENCES codethread.source_object(sha256),
  PRIMARY KEY (scan_job_id, path)
);

CREATE TABLE codethread.repository_snapshot (
  id uuid PRIMARY KEY,
  repository_id uuid NOT NULL REFERENCES codethread.repository(id),
  source_fingerprint char(64) NOT NULL CHECK (source_fingerprint ~ '^[0-9a-f]{64}$'),
  analyzer_version text NOT NULL,
  analyzer_build_hash char(64) NOT NULL CHECK (analyzer_build_hash ~ '^[0-9a-f]{64}$'),
  configuration_hash char(64) NOT NULL CHECK (configuration_hash ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'staging' CHECK (state IN ('staging', 'published')),
  coverage text NOT NULL CHECK (coverage IN ('complete','partial','not_analyzed','unsupported')),
  facts_json jsonb NOT NULL CHECK (jsonb_typeof(facts_json) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (repository_id, id),
  UNIQUE (repository_id, source_fingerprint, analyzer_version, analyzer_build_hash, configuration_hash),
  CHECK ((state = 'staging' AND published_at IS NULL)
      OR (state = 'published' AND published_at IS NOT NULL))
);

CREATE TABLE codethread.scan_project (
  repository_id uuid NOT NULL,
  scan_job_id uuid NOT NULL,
  project_id text NOT NULL CHECK (char_length(project_id) BETWEEN 1 AND 256),
  project_label text NOT NULL,
  status text NOT NULL CHECK (status IN ('ready','solution','invalid','unsupported','failed','not_analyzed')),
  snapshot_id uuid,
  diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(diagnostics) = 'array'),
  PRIMARY KEY (scan_job_id, project_id),
  FOREIGN KEY (repository_id, scan_job_id) REFERENCES codethread.scan_job(repository_id, id),
  FOREIGN KEY (repository_id, snapshot_id) REFERENCES codethread.repository_snapshot(repository_id, id),
  CHECK ((status = 'ready' AND snapshot_id IS NOT NULL)
      OR (status <> 'ready' AND snapshot_id IS NULL))
);
CREATE INDEX scan_project_snapshot_idx ON codethread.scan_project(snapshot_id);

CREATE TABLE codethread.snapshot_file (
  snapshot_id uuid NOT NULL REFERENCES codethread.repository_snapshot(id),
  id uuid NOT NULL,
  path text NOT NULL CHECK (char_length(path) BETWEEN 1 AND 1024),
  content_hash char(64) NOT NULL REFERENCES codethread.source_object(sha256),
  byte_length integer NOT NULL CHECK (byte_length >= 0),
  PRIMARY KEY (snapshot_id, id),
  UNIQUE (snapshot_id, path),
  UNIQUE (snapshot_id, id, content_hash)
);

CREATE TABLE codethread.source_evidence (
  snapshot_id uuid NOT NULL,
  id uuid NOT NULL,
  file_id uuid NOT NULL,
  content_hash char(64) NOT NULL,
  start_utf16 integer NOT NULL CHECK (start_utf16 >= 0),
  end_utf16 integer NOT NULL CHECK (end_utf16 >= start_utf16),
  range_json jsonb NOT NULL CHECK (jsonb_typeof(range_json) = 'object'),
  kind text NOT NULL,
  extractor_name text NOT NULL,
  extractor_version text NOT NULL,
  PRIMARY KEY (snapshot_id, id),
  FOREIGN KEY (snapshot_id, file_id, content_hash)
    REFERENCES codethread.snapshot_file(snapshot_id, id, content_hash)
);

CREATE TABLE codethread.code_symbol (
  snapshot_id uuid NOT NULL,
  id uuid NOT NULL,
  file_id uuid NOT NULL,
  canonical_key text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL,
  declaration_evidence_id uuid NOT NULL,
  PRIMARY KEY (snapshot_id, id),
  UNIQUE (snapshot_id, canonical_key),
  FOREIGN KEY (snapshot_id, file_id) REFERENCES codethread.snapshot_file(snapshot_id, id),
  FOREIGN KEY (snapshot_id, declaration_evidence_id)
    REFERENCES codethread.source_evidence(snapshot_id, id)
);

CREATE TABLE codethread.diagnostic (
  snapshot_id uuid NOT NULL REFERENCES codethread.repository_snapshot(id),
  id uuid NOT NULL,
  file_id uuid,
  code text NOT NULL,
  severity text NOT NULL,
  message text NOT NULL,
  PRIMARY KEY (snapshot_id, id),
  FOREIGN KEY (snapshot_id, file_id) REFERENCES codethread.snapshot_file(snapshot_id, id)
);

CREATE TABLE codethread.code_relation (
  snapshot_id uuid NOT NULL,
  id uuid NOT NULL,
  canonical_key text NOT NULL,
  source_symbol_id uuid NOT NULL,
  target_symbol_id uuid,
  kind text NOT NULL CHECK (kind IN ('calls','references')),
  resolution text NOT NULL CHECK (resolution IN ('exact','unresolved','ambiguous','unsupported')),
  site_evidence_id uuid NOT NULL,
  PRIMARY KEY (snapshot_id, id),
  UNIQUE (snapshot_id, canonical_key),
  FOREIGN KEY (snapshot_id, source_symbol_id) REFERENCES codethread.code_symbol(snapshot_id, id),
  FOREIGN KEY (snapshot_id, target_symbol_id) REFERENCES codethread.code_symbol(snapshot_id, id),
  FOREIGN KEY (snapshot_id, site_evidence_id) REFERENCES codethread.source_evidence(snapshot_id, id),
  CHECK ((resolution = 'exact' AND target_symbol_id IS NOT NULL)
      OR (resolution <> 'exact' AND target_symbol_id IS NULL))
);

CREATE TABLE codethread.relation_evidence (
  snapshot_id uuid NOT NULL,
  relation_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  PRIMARY KEY (snapshot_id, relation_id, evidence_id),
  FOREIGN KEY (snapshot_id, relation_id) REFERENCES codethread.code_relation(snapshot_id, id),
  FOREIGN KEY (snapshot_id, evidence_id) REFERENCES codethread.source_evidence(snapshot_id, id)
);

CREATE TABLE codethread.snapshot_capability (
  snapshot_id uuid NOT NULL REFERENCES codethread.repository_snapshot(id),
  capability_key text NOT NULL,
  coverage text NOT NULL CHECK (coverage IN ('complete','partial','not_analyzed','unsupported')),
  PRIMARY KEY (snapshot_id, capability_key)
);

-- Published facts are immutable. Operational job/pointer changes remain separate.
CREATE FUNCTION codethread.guard_snapshot_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'published' THEN
    RAISE EXCEPTION 'published snapshot is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'snapshot deletion requires explicit retention procedure' USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'published' AND (
      NEW.published_at IS NULL OR
      (to_jsonb(NEW) - 'state' - 'published_at') IS DISTINCT FROM
      (to_jsonb(OLD) - 'state' - 'published_at')
    ) THEN
    RAISE EXCEPTION 'publication may only change state and publication time' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_snapshot BEFORE UPDATE OR DELETE ON codethread.repository_snapshot
FOR EACH ROW EXECUTE FUNCTION codethread.guard_snapshot_update();

CREATE FUNCTION codethread.guard_snapshot_child() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE parent_state text;
BEGIN
  SELECT state INTO parent_state FROM codethread.repository_snapshot
  WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.snapshot_id ELSE NEW.snapshot_id END
  FOR UPDATE;
  IF parent_state = 'published' THEN
    RAISE EXCEPTION 'published snapshot payload is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_snapshot_file BEFORE INSERT OR UPDATE OR DELETE ON codethread.snapshot_file
FOR EACH ROW EXECUTE FUNCTION codethread.guard_snapshot_child();
CREATE TRIGGER immutable_evidence BEFORE INSERT OR UPDATE OR DELETE ON codethread.source_evidence
FOR EACH ROW EXECUTE FUNCTION codethread.guard_snapshot_child();
CREATE TRIGGER immutable_symbol BEFORE INSERT OR UPDATE OR DELETE ON codethread.code_symbol
FOR EACH ROW EXECUTE FUNCTION codethread.guard_snapshot_child();
CREATE TRIGGER immutable_diagnostic BEFORE INSERT OR UPDATE OR DELETE ON codethread.diagnostic
FOR EACH ROW EXECUTE FUNCTION codethread.guard_snapshot_child();
CREATE TRIGGER immutable_relation BEFORE INSERT OR UPDATE OR DELETE ON codethread.code_relation
FOR EACH ROW EXECUTE FUNCTION codethread.guard_snapshot_child();
CREATE TRIGGER immutable_relation_evidence BEFORE INSERT OR UPDATE OR DELETE ON codethread.relation_evidence
FOR EACH ROW EXECUTE FUNCTION codethread.guard_snapshot_child();
CREATE TRIGGER immutable_capability BEFORE INSERT OR UPDATE OR DELETE ON codethread.snapshot_capability
FOR EACH ROW EXECUTE FUNCTION codethread.guard_snapshot_child();

CREATE FUNCTION codethread.assert_snapshot_publication() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'staging' AND NEW.state = 'published' THEN
    IF NOT EXISTS (SELECT 1 FROM codethread.snapshot_capability WHERE snapshot_id = NEW.id) THEN
      RAISE EXCEPTION 'snapshot missing capability coverage' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM codethread.code_relation r
      WHERE r.snapshot_id = NEW.id AND NOT EXISTS (
        SELECT 1 FROM codethread.relation_evidence e
        WHERE e.snapshot_id = r.snapshot_id AND e.relation_id = r.id
      )
    ) THEN
      RAISE EXCEPTION 'relation missing evidence' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_snapshot_publication BEFORE UPDATE OF state
ON codethread.repository_snapshot FOR EACH ROW
EXECUTE FUNCTION codethread.assert_snapshot_publication();

CREATE FUNCTION codethread.guard_source_object() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'content-addressed source objects are immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER immutable_source_object BEFORE UPDATE OR DELETE ON codethread.source_object
FOR EACH ROW EXECUTE FUNCTION codethread.guard_source_object();

CREATE INDEX snapshot_file_hash_idx ON codethread.snapshot_file(content_hash);
CREATE INDEX symbol_name_idx ON codethread.code_symbol(snapshot_id, name);
CREATE INDEX relation_incoming_idx ON codethread.code_relation(snapshot_id, target_symbol_id) WHERE target_symbol_id IS NOT NULL;
CREATE INDEX job_state_idx ON codethread.scan_job(repository_id, state, created_at);
