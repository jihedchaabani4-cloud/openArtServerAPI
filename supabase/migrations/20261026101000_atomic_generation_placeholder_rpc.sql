-- Migration: 20261026101000_atomic_generation_placeholder_rpc.sql
-- Description:
--   P1-1: Collapse sequential generation intake DB hops (workflow insert + media placeholder insert +
--         workflow_media link + project ownership verification) into a single atomic SQL RPC
--         supporting generation_config, folder_id, width, height, workflow_type, step_id, role, user_id.
--   Hardened with SECURITY DEFINER, fixed search_path, and service_role-only execution (Rule R6).

CREATE OR REPLACE FUNCTION public.create_generation_placeholder_atomic(
    p_project_id        uuid,
    p_user_id           uuid,
    p_display_name      text        DEFAULT 'Untitled Workflow',
    p_workflow_type     text        DEFAULT 'GENERATION',
    p_folder_id         uuid        DEFAULT NULL,
    p_step_id           text        DEFAULT 'GEN',
    p_width             integer     DEFAULT 1024,
    p_height            integer     DEFAULT 1024,
    p_role              text        DEFAULT 'output',
    p_generation_config jsonb       DEFAULT NULL,
    p_workflow_id       uuid        DEFAULT NULL,
    p_media_id          uuid        DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_workflow_id  uuid;
    v_media_id     uuid;
    v_display_name text;
    v_width        integer;
    v_height       integer;
    v_role         text;
BEGIN
    IF p_project_id IS NULL THEN
        RAISE EXCEPTION 'p_project_id is required';
    END IF;

    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'p_user_id is required';
    END IF;

    -- 1. Enforce project ownership inside the same atomic transaction
    IF NOT EXISTS (
        SELECT 1
        FROM public.project
        WHERE id = p_project_id
          AND user_id = p_user_id
    ) THEN
        RAISE EXCEPTION 'Project % not found or access denied', p_project_id;
    END IF;

    v_workflow_id  := COALESCE(p_workflow_id, gen_random_uuid());
    v_media_id     := COALESCE(p_media_id, gen_random_uuid());
    v_display_name := COALESCE(NULLIF(p_display_name, ''), 'Untitled Workflow');
    v_width        := CASE WHEN p_width IS NOT NULL AND p_width > 0 THEN p_width ELSE 1024 END;
    v_height       := CASE WHEN p_height IS NOT NULL AND p_height > 0 THEN p_height ELSE 1024 END;
    v_role         := COALESCE(NULLIF(p_role, ''), 'output');

    -- 2. Insert workflow row
    INSERT INTO public.workflow (
        id,
        project_id,
        display_name,
        workflow_type,
        folder_id,
        user_id
    )
    VALUES (
        v_workflow_id,
        p_project_id,
        v_display_name,
        COALESCE(NULLIF(p_workflow_type, ''), 'GENERATION'),
        p_folder_id,
        p_user_id
    )
    RETURNING id INTO v_workflow_id;

    -- 3. Insert placeholder media row with pre-persisted generation_config
    INSERT INTO public.media (
        id,
        project_id,
        step_id,
        url,
        width,
        height,
        status,
        generation_config
    )
    VALUES (
        v_media_id,
        p_project_id,
        COALESCE(NULLIF(p_step_id, ''), 'GEN'),
        NULL,
        v_width,
        v_height,
        'processing',
        p_generation_config
    )
    RETURNING id INTO v_media_id;

    -- 4. Link placeholder media as primary in public.workflow_media
    INSERT INTO public.workflow_media (
        workflow_id,
        media_id,
        role,
        is_primary
    )
    VALUES (
        v_workflow_id,
        v_media_id,
        v_role,
        true
    )
    ON CONFLICT (workflow_id, media_id, role)
    DO UPDATE SET is_primary = true;

    RETURN jsonb_build_object(
        'workflow_id', v_workflow_id,
        'media_id',    v_media_id,
        'role',        v_role
    );
END;
$$;

COMMENT ON FUNCTION public.create_generation_placeholder_atomic(
    uuid, uuid, text, text, uuid, text, integer, integer, text, jsonb, uuid, uuid
) IS 'Atomically verifies project ownership, inserts workflow + processing placeholder media (with generation_config) + workflow_media primary link in a single DB round-trip.';

REVOKE ALL ON FUNCTION public.create_generation_placeholder_atomic(
    uuid, uuid, text, text, uuid, text, integer, integer, text, jsonb, uuid, uuid
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_generation_placeholder_atomic(
    uuid, uuid, text, text, uuid, text, integer, integer, text, jsonb, uuid, uuid
) TO service_role;
