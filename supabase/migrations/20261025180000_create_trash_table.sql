-- Migration: 20261025180000_create_trash_table.sql
--
-- Description:
--   Creates public.trash to record container workflows moved to Trash.
--   One row = one workflow in trash (workflow_id UNIQUE ON DELETE CASCADE).
--   Enables Row Level Security and restricts table access to service_role only.

CREATE TABLE public.trash (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id uuid NOT NULL UNIQUE REFERENCES public.workflow(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    deleted_at timestamptz NOT NULL DEFAULT now(),
    deleted_by uuid
);

CREATE INDEX idx_trash_user_id ON public.trash USING btree (user_id);

ALTER TABLE public.trash ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.trash FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.trash TO service_role;
