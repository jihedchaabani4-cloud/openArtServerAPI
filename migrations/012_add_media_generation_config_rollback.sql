-- Migration 012 Rollback: Revert Per-Media Generation Configuration Column
-- ─────────────────────────────────────────────────────────────────────────────
-- Warning: Dropping public.media.generation_config will permanently discard
-- stored per-media generation configuration snapshots.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

DROP INDEX IF EXISTS public.idx_media_generation_config_model;

ALTER TABLE public.media
  DROP COLUMN IF EXISTS generation_config CASCADE;

COMMIT;
