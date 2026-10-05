-- Migration: Convert guidelines to plain TEXT in public.element
-- Feature: 018-element-reference-system
-- Date: 2026-09-25

-- 1. Drop old default
ALTER TABLE public.element 
  ALTER COLUMN guidelines DROP DEFAULT;

-- 2. Ensure column type is TEXT
ALTER TABLE public.element 
  ALTER COLUMN guidelines TYPE TEXT;

-- 3. Set standard text default
ALTER TABLE public.element 
  ALTER COLUMN guidelines SET DEFAULT '';

-- 4. Clean up any residual empty array strings
UPDATE public.element
SET guidelines = ''
WHERE guidelines = '[]' 
   OR guidelines = '[""]' 
   OR guidelines IS NULL;
