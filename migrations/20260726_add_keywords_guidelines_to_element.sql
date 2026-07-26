-- Migration: Add keywords and guidelines metadata columns to public.element
ALTER TABLE public.element
ADD COLUMN IF NOT EXISTS keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS guidelines JSONB NOT NULL DEFAULT '[]'::jsonb;
