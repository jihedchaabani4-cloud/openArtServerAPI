-- Rollback for Migration 013: Drop color and description from folders table
ALTER TABLE public.folders
  DROP COLUMN IF EXISTS color,
  DROP COLUMN IF EXISTS description;
