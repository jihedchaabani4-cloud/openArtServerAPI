-- Rollback Draft: 20261019040000_phase2_drop_characters_dead_media_columns_rollback.sql
-- Description: Re-adds avatar_url, turnaround_url, and reference_images to public.characters.

BEGIN;

ALTER TABLE public.characters
  ADD COLUMN IF NOT EXISTS avatar_url TEXT,
  ADD COLUMN IF NOT EXISTS turnaround_url TEXT,
  ADD COLUMN IF NOT EXISTS reference_images TEXT[] DEFAULT '{}'::TEXT[];

COMMIT;
