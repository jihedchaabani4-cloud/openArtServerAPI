-- Migration 010: Drop Legacy Media Columns & Set Element Workflow FK to ON DELETE SET NULL (B2)
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Scope:
-- 1. Ensure public.workflow_media.role is NOT NULL with default 'output' and canonical indexes exist.
-- 2. Drop legacy column public.media.workflow_id (workflow_media is now the single source of truth).
-- 3. Drop legacy column public.element.primary_media_id (workflow.primary_media_id is authoritative).
-- 4. Update public.element.workflow_id foreign key constraint (element_workflow_id_fkey) to ON DELETE SET NULL
--    so element sidecar records survive if their workflow container is ever removed.
--
-- Rollback:
-- Primary / Lossless Rollback: Restore from full pg_dump backup (.scratch/backup_ffwcjldmmddcxlisntgt.sql).
-- Emergency SQL Rollback: See migrations/010_drop_legacy_media_columns_rollback.sql (lossy for multi-linked media).
-- ─────────────────────────────────────────────────────────────────────────────────────────────

BEGIN;

-- 1. Ensure public.workflow_media exists with role NOT NULL DEFAULT 'output' and canonical constraints
CREATE TABLE IF NOT EXISTS public.workflow_media (
  workflow_id UUID NOT NULL REFERENCES public.workflow(id) ON DELETE CASCADE,
  media_id UUID NOT NULL REFERENCES public.media(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'output',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT workflow_media_pkey PRIMARY KEY (workflow_id, media_id, role),
  CONSTRAINT workflow_media_role_check CHECK (
    role = ANY (ARRAY[
      'output',
      'original',
      'sheet',
      'detail',
      'reference',
      'avatar',
      'turnaround'
    ])
  )
);

UPDATE public.workflow_media
SET role = 'output'
WHERE role IS NULL;

ALTER TABLE public.workflow_media
  ALTER COLUMN role SET DEFAULT 'output',
  ALTER COLUMN role SET NOT NULL;

CREATE INDEX IF NOT EXISTS workflow_media_workflow_id_idx
  ON public.workflow_media (workflow_id, created_at);

CREATE INDEX IF NOT EXISTS workflow_media_media_id_idx
  ON public.workflow_media (media_id);

CREATE INDEX IF NOT EXISTS workflow_media_role_idx
  ON public.workflow_media (role);

-- 2. Drop legacy public.media.workflow_id column
ALTER TABLE public.media DROP COLUMN IF EXISTS workflow_id;

-- 3. Drop legacy public.element.primary_media_id column
ALTER TABLE public.element DROP COLUMN IF EXISTS primary_media_id;

-- 4. Update public.element.workflow_id foreign key constraint to ON DELETE SET NULL
ALTER TABLE public.element DROP CONSTRAINT IF EXISTS element_workflow_id_fkey;

ALTER TABLE public.element
  ADD CONSTRAINT element_workflow_id_fkey
  FOREIGN KEY (workflow_id) REFERENCES public.workflow(id) ON DELETE SET NULL;

COMMIT;
