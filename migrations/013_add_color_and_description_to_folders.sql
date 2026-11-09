-- Migration 013: Add color and description to folders table
-- ─────────────────────────────────────────────────────────────────────────────
-- Scope:
-- 1. Add color TEXT NULL to public.folders
-- 2. Add description TEXT NULL to public.folders
--
-- Rollback Instructions (Manual / Disaster Recovery):
-- To revert this additive migration:
--   ALTER TABLE public.folders DROP COLUMN IF EXISTS color;
--   ALTER TABLE public.folders DROP COLUMN IF EXISTS description;
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.folders
  ADD COLUMN IF NOT EXISTS color TEXT NULL,
  ADD COLUMN IF NOT EXISTS description TEXT NULL;
