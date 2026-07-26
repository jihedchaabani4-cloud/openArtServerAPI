-- Migration Patch: Make generation_config_id and master_identity nullable for V1 direct-save flow
-- Feature: 018-element-reference-system (V1 Simplified)
-- Date: 2026-07-23

ALTER TABLE public.element
  ALTER COLUMN generation_config_id DROP NOT NULL;

ALTER TABLE public.element
  ALTER COLUMN master_identity DROP NOT NULL;
