-- Rollback Migration 010: Restore Legacy Media Columns & Element Workflow Cascade (B2)
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- IMPORTANT ROLLBACK NOTICE:
-- 1. The full pg_dump backup (.scratch/backup_ffwcjldmmddcxlisntgt.sql) is the TRUE lossless rollback:
--      psql "<SUPABASE_CONNECTION_STRING>" < .scratch/backup_ffwcjldmmddcxlisntgt.sql
-- 2. This SQL rollback script is an emergency schema-level undo and is LOSSY for multi-linked media:
--    because a single column (media.workflow_id) cannot represent 1..N workflow placements in
--    public.workflow_media, re-populating media.workflow_id selects only the earliest placement
--    (DISTINCT ON (media_id) ORDER BY media_id, created_at ASC).
-- ─────────────────────────────────────────────────────────────────────────────────────────────

BEGIN;

-- 1. Re-add legacy public.media.workflow_id column
ALTER TABLE public.media
  ADD COLUMN IF NOT EXISTS workflow_id UUID REFERENCES public.workflow(id) ON DELETE CASCADE;

-- 2. Re-populate public.media.workflow_id from earliest public.workflow_media link (lossy for multi-linked media)
UPDATE public.media m
SET workflow_id = sub.workflow_id
FROM (
  SELECT DISTINCT ON (media_id)
    media_id,
    workflow_id
  FROM public.workflow_media
  ORDER BY media_id, created_at ASC
) sub
WHERE m.id = sub.media_id
  AND m.workflow_id IS NULL;

-- 3. Re-add legacy public.element.primary_media_id column and backfill from workflow.primary_media_id
ALTER TABLE public.element
  ADD COLUMN IF NOT EXISTS primary_media_id UUID REFERENCES public.media(id) ON DELETE SET NULL;

UPDATE public.element e
SET primary_media_id = w.primary_media_id
FROM public.workflow w
WHERE e.workflow_id = w.id
  AND e.primary_media_id IS NULL
  AND w.primary_media_id IS NOT NULL;

-- 4. Revert public.element.workflow_id foreign key constraint back to ON DELETE CASCADE
ALTER TABLE public.element DROP CONSTRAINT IF EXISTS element_workflow_id_fkey;

ALTER TABLE public.element
  ADD CONSTRAINT element_workflow_id_fkey
  FOREIGN KEY (workflow_id) REFERENCES public.workflow(id) ON DELETE CASCADE;

COMMIT;
