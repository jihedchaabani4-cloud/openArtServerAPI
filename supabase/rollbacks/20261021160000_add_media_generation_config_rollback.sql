-- Rollback: 20261021160000_add_media_generation_config_rollback.sql
-- Description: Drop generation_config JSONB column from public.media.

BEGIN;

DROP INDEX IF EXISTS public.idx_media_generation_config_model;

ALTER TABLE public.media
  DROP COLUMN IF EXISTS generation_config CASCADE;

COMMIT;
