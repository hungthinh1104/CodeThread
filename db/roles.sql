DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='codethread_runtime') THEN
    EXECUTE 'CREATE ROLE codethread_runtime NOLOGIN';
  ELSIF (SELECT rolcanlogin FROM pg_roles WHERE rolname='codethread_runtime') THEN
    RAISE EXCEPTION 'codethread_runtime must be a NOLOGIN group role';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='codethread_retention') THEN
    EXECUTE 'CREATE ROLE codethread_retention NOLOGIN';
  ELSIF (SELECT rolcanlogin FROM pg_roles WHERE rolname='codethread_retention') THEN
    RAISE EXCEPTION 'codethread_retention must be a NOLOGIN group role';
  END IF;
END $$;

REVOKE ALL ON SCHEMA codethread FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA codethread FROM PUBLIC;
GRANT USAGE ON SCHEMA codethread TO codethread_runtime,codethread_retention;
GRANT SELECT ON ALL TABLES IN SCHEMA codethread TO codethread_runtime;
GRANT INSERT ON codethread.repository,codethread.scan_job,
  codethread.scan_input_file,codethread.source_object,
  codethread.repository_snapshot,codethread.scan_project,
  codethread.snapshot_file,codethread.source_evidence,
  codethread.code_symbol,codethread.diagnostic,codethread.code_relation,
  codethread.relation_evidence,codethread.snapshot_capability
TO codethread_runtime;
GRANT UPDATE (desired_generation,active_job_id,updated_at)
  ON codethread.repository TO codethread_runtime;
GRANT UPDATE (state,attempt,activation_result,error_code,error_message,
  git_object_format,git_commit_oid,git_tree_oid,session_json,updated_at)
  ON codethread.scan_job TO codethread_runtime;
GRANT UPDATE (state,published_at)
  ON codethread.repository_snapshot TO codethread_runtime;
REVOKE ALL ON FUNCTION
  codethread.prune_inactive_data(timestamptz,integer,integer,integer)
FROM PUBLIC,codethread_runtime;
GRANT EXECUTE ON FUNCTION
  codethread.prune_inactive_data(timestamptz,integer,integer,integer)
TO codethread_retention;
