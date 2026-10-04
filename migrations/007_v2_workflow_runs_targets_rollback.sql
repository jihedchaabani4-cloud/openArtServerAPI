-- Rollback Migration 007: Drop targets & metadata from v2_workflow_runs
DROP INDEX IF EXISTS idx_v2_workflow_runs_v1_workflow_id;

ALTER TABLE v2_workflow_runs
  DROP COLUMN IF EXISTS target_media_ids,
  DROP COLUMN IF EXISTS v1_workflow_id,
  DROP COLUMN IF EXISTS metadata;
