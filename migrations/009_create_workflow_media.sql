-- Migration 009: Create Workflow Media Relation
-- ─────────────────────────────────────────────────────────────────────────────
-- Scope:
-- 1. Create public.workflow_media as an additive relation table between
--    existing public.workflow containers and reusable public.media rows.
-- 2. Store the media role within a workflow without removing legacy
--    media.workflow_id or media.step_id.
-- 3. Backfill relation rows from legacy media.workflow_id and media.step_id.
--
-- Rollback Instructions (Manual / Disaster Recovery):
-- To revert this additive migration:
--   1. DROP TABLE IF EXISTS workflow_media;
-- No pre-existing rows, columns, or tables are deleted or modified by applying this migration.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.workflow_media (
  workflow_id UUID NOT NULL,
  media_id UUID NOT NULL,
  role TEXT NOT NULL DEFAULT 'output',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT workflow_media_pkey PRIMARY KEY (workflow_id, media_id, role),
  CONSTRAINT workflow_media_workflow_id_fkey
    FOREIGN KEY (workflow_id) REFERENCES public.workflow (id) ON DELETE CASCADE,
  CONSTRAINT workflow_media_media_id_fkey
    FOREIGN KEY (media_id) REFERENCES public.media (id) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS workflow_media_workflow_id_idx
  ON public.workflow_media (workflow_id, created_at);

CREATE INDEX IF NOT EXISTS workflow_media_media_id_idx
  ON public.workflow_media (media_id);

CREATE INDEX IF NOT EXISTS workflow_media_role_idx
  ON public.workflow_media (role);

INSERT INTO public.workflow_media (workflow_id, media_id, role, created_at)
SELECT
  m.workflow_id,
  m.id,
  CASE
    WHEN m.step_id IN ('image_generation', 'video_generation') THEN 'output'
    WHEN m.step_id = 'upload' THEN 'original'
    WHEN m.step_id = 'character_sheet' THEN 'sheet'
    WHEN m.step_id = 'character_detail' THEN 'detail'
    WHEN m.step_id IN ('element_sheet', 'element_reference') THEN 'detail'
    WHEN m.step_id = 'CAE' AND w.workflow_type = 'UPLOAD' THEN 'original'
    WHEN m.step_id = 'CAE' AND w.workflow_type IN ('CHARACTER', 'CHARACTER_SHEET') THEN 'sheet'
    WHEN m.step_id = 'CAE' AND w.workflow_type IN ('ELEMENT', 'ELEMENT_SHEET') THEN 'detail'
    WHEN w.workflow_type IN ('ELEMENT', 'ELEMENT_SHEET') THEN 'detail'
    ELSE 'output'
  END AS role,
  COALESCE(m.create_time, now())
FROM public.media m
JOIN public.workflow w ON w.id = m.workflow_id
WHERE m.workflow_id IS NOT NULL
ON CONFLICT DO NOTHING;
