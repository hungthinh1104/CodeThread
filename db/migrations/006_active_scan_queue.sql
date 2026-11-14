CREATE INDEX active_scan_job_queue_idx
  ON codethread.scan_job(state, created_at, id)
  WHERE state IN ('queued','running');
