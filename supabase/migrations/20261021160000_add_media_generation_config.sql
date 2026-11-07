-- Migration: 20261021160000_add_media_generation_config.sql
-- Description: Add generation_config JSONB column to public.media for immutable per-media configuration.

BEGIN;

ALTER TABLE public.media
  ADD COLUMN IF NOT EXISTS generation_config JSONB DEFAULT NULL;

COMMENT ON COLUMN public.media.generation_config IS
  'Immutable per-media generation configuration snapshot (prompt, prompt_optimized, model, provider, aspect_ratio, parameters).';

CREATE INDEX IF NOT EXISTS idx_media_generation_config_model
  ON public.media (((generation_config->>'model')))
  WHERE generation_config IS NOT NULL;

COMMIT;
