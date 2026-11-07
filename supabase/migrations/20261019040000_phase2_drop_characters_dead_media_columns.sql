-- Migration Draft: 20261019040000_phase2_drop_characters_dead_media_columns.sql
-- Description: Drop dead legacy columns avatar_url, turnaround_url, and reference_images from public.characters.
-- Pre-conditions: Character media is fully stored and resolved via public.workflow_media (roles: sheet, detail, avatar).

BEGIN;

ALTER TABLE public.characters
  DROP COLUMN IF EXISTS avatar_url CASCADE,
  DROP COLUMN IF EXISTS turnaround_url CASCADE,
  DROP COLUMN IF EXISTS reference_images CASCADE;

COMMIT;
