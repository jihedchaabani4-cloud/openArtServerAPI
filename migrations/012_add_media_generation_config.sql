-- Migration 012: Add Per-Media Generation Configuration JSONB Column
-- ─────────────────────────────────────────────────────────────────────────────
-- Scope:
-- 1. Add nullable generation_config column to public.media for immutable per-media configuration.
-- 2. Add partial functional index on (generation_config->>'model') for efficient model-based queries.
--
-- Safety:
-- 100% Additive. No tables, columns, or routes dropped or renamed.
-- Existing media rows retain generation_config = NULL.
-- Uploaded media items retain generation_config = NULL.
-- Generated and edited media items store immutable structured configuration.
--
-- Rollback Instructions (Manual / Disaster Recovery):
-- To revert this migration run:
--   DROP INDEX IF EXISTS public.idx_media_generation_config_model;
--   ALTER TABLE public.media DROP COLUMN IF EXISTS generation_config CASCADE;
-- (See migrations/012_add_media_generation_config_rollback.sql)
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE public.media
  ADD COLUMN IF NOT EXISTS generation_config JSONB DEFAULT NULL;

COMMENT ON COLUMN public.media.generation_config IS
  'Immutable per-media generation configuration snapshot (prompt, prompt_optimized, model, provider, aspect_ratio, parameters).';

CREATE INDEX IF NOT EXISTS idx_media_generation_config_model
  ON public.media (((generation_config->>'model')))
  WHERE generation_config IS NOT NULL;

COMMIT;
