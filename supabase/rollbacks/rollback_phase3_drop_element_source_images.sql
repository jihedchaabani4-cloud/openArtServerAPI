-- Rollback Draft: 20261019050000_phase3_drop_element_source_images_rollback.sql
-- Description: Re-adds source_images to public.element and backfills from public.workflow_media.

BEGIN;

-- 1. Re-add column
ALTER TABLE public.element
  ADD COLUMN IF NOT EXISTS source_images JSONB DEFAULT '[]'::jsonb;

-- 2. Backfill from workflow_media relations
UPDATE public.element e
SET source_images = COALESCE(
  (
    SELECT jsonb_agg(wm.media_id)
    FROM public.workflow_media wm
    WHERE wm.workflow_id = e.workflow_id
      AND wm.role = 'detail'
  ),
  '[]'::jsonb
);

COMMIT;
