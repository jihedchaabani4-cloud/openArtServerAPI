-- Migration 007: V2 Workflow Runs Targets and Metadata
-- ─────────────────────────────────────────────────────────────────────────────
-- Adds dedicated columns to v2_workflow_runs:
-- 1. metadata: General run metadata including persisted billing accumulator entries.
-- 2. v1_workflow_id: References the V1 workflow table row (public.workflow.id UUID)
--    responsible for producing media assets. Note: v2_workflow_runs.workflow_id
--    identifies the workflow definition (e.g. 'image-generation-v1').
-- 3. target_media_ids: Array of pre-allocated media row IDs (UUIDs) authorized
--    for finalization or mutation by this workflow run.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE v2_workflow_runs
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS v1_workflow_id UUID,
  ADD COLUMN IF NOT EXISTS target_media_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Informative comments distinguishing definition ID vs V1 instance row
COMMENT ON COLUMN v2_workflow_runs.v1_workflow_id IS 'References the V1 workflow table row (public.workflow.id) producing media assets. Distinct from v2_workflow_runs.workflow_id which identifies the workflow definition (e.g. image-generation-v1). No foreign key constraint enforced.';
COMMENT ON COLUMN v2_workflow_runs.target_media_ids IS 'JSON array of pre-allocated media IDs authorized for finalization by this run.';
COMMENT ON COLUMN v2_workflow_runs.metadata IS 'Run-level metadata, including persisted billing accumulator entries and runtime context.';

-- Index on v1_workflow_id for fast lookup when querying runs by V1 workflow row
CREATE INDEX IF NOT EXISTS idx_v2_workflow_runs_v1_workflow_id
  ON v2_workflow_runs (v1_workflow_id)
  WHERE v1_workflow_id IS NOT NULL;
