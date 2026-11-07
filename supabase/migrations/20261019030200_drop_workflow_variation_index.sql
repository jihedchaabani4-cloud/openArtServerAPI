-- Migration Draft: 20261019030200_drop_workflow_variation_index.sql
-- Description: Drop check constraint and column workflow.variation_index (RESTRICT mode - no CASCADE).
-- Pre-conditions: Backend queries no longer select, insert, or order by variation_index.

BEGIN;

-- 1. Drop check constraint first
ALTER TABLE public.workflow
  DROP CONSTRAINT IF EXISTS workflow_variation_index_check;

-- 2. Drop variation_index column without CASCADE (RESTRICT)
-- PostgreSQL will abort if any unanticipated dependent object exists.
ALTER TABLE public.workflow
  DROP COLUMN IF EXISTS variation_index;

COMMIT;
