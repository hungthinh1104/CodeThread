ALTER TABLE codethread.scan_job
  ADD COLUMN session_json jsonb
  CHECK (session_json IS NULL OR jsonb_typeof(session_json)='object');

ALTER TABLE codethread.scan_project
  ADD COLUMN project_json jsonb;
UPDATE codethread.scan_project SET project_json=jsonb_build_object(
  'id',project_id,
  'configPath',CASE WHEN project_label='Default context' THEN NULL ELSE project_label END,
  'status',status,
  'rootPaths','[]'::jsonb,
  'diagnostics',diagnostics
);
ALTER TABLE codethread.scan_project
  ALTER COLUMN project_json SET NOT NULL;
ALTER TABLE codethread.scan_project
  ADD CONSTRAINT scan_project_json_object CHECK (jsonb_typeof(project_json)='object');
