-- Rollback Draft: 20261019030200_drop_workflow_variation_index_rollback.sql
-- Description: Re-adds workflow.variation_index and restores check constraint.

BEGIN;

ALTER TABLE public.workflow
  ADD COLUMN IF NOT EXISTS variation_index SMALLINT DEFAULT 0,
  ADD CONSTRAINT workflow_variation_index_check CHECK (variation_index >= 0);

COMMIT;
