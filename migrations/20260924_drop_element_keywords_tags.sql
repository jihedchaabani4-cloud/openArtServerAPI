-- Migration: Drop keywords and tags columns from public.element
-- Reason: Redundant with description & prompt compilation (streamlining element schema)
-- Date: 2026-09-24

ALTER TABLE public.element
  DROP COLUMN IF EXISTS keywords,
  DROP COLUMN IF EXISTS tags;
