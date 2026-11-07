-- Migration: 20261019002000_drop_legacy_workflow_and_media_columns.sql
-- Description: Drop obsolete columns workflow.primary_media_id, workflow.session_id,
-- media.generation_config_id, and drop empty legacy table public.generation_config.

-- 1. Drop foreign keys and columns on media
ALTER TABLE public.media
  DROP CONSTRAINT IF EXISTS media_generation_config_id_fkey,
  DROP COLUMN IF EXISTS generation_config_id CASCADE;

-- 2. Drop empty table public.generation_config
DROP TABLE IF EXISTS public.generation_config CASCADE;

-- 3. Drop columns on workflow
ALTER TABLE public.workflow
  DROP CONSTRAINT IF EXISTS fk_workflow_primary_media,
  DROP CONSTRAINT IF EXISTS workflow_primary_media_id_fkey,
  DROP COLUMN IF EXISTS primary_media_id CASCADE,
  DROP CONSTRAINT IF EXISTS workflow_session_id_fkey,
  DROP COLUMN IF EXISTS session_id CASCADE;

-- 4. Update create_workflow_with_placeholder_media RPC to remove references to dropped columns
CREATE OR REPLACE FUNCTION public.create_workflow_with_placeholder_media(
    p_project_id uuid,
    p_session_id uuid DEFAULT NULL::uuid, -- kept as optional parameter for backwards-compatibility
    p_display_name text DEFAULT 'Untitled'::text,
    p_workflow_type text DEFAULT 'GENERATION'::text,
    p_generation_config_id uuid DEFAULT NULL::uuid, -- kept as optional parameter for backwards-compatibility
    p_step_id text DEFAULT 'GEN'::text
)
RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE
    v_workflow_id UUID;
    v_media_id    UUID;
BEGIN
    -- 1. Insert Workflow row (no session_id column)
    INSERT INTO workflow (project_id, display_name, workflow_type)
    VALUES (p_project_id, p_display_name, p_workflow_type)
    RETURNING id INTO v_workflow_id;

    -- 2. Insert Media placeholder row (no generation_config_id column)
    INSERT INTO media (
        project_id,
        step_id,
        status,
        url,
        width,
        height
    )
    VALUES (
        p_project_id,
        p_step_id,
        'processing',
        NULL,
        1024,
        1024
    )
    RETURNING id INTO v_media_id;

    -- 3. Link as primary media in public.workflow_media (canonical relation)
    INSERT INTO workflow_media (workflow_id, media_id, role, is_primary)
    VALUES (
        v_workflow_id,
        v_media_id,
        CASE
            WHEN p_step_id = 'character_sheet' THEN 'sheet'
            WHEN p_step_id = 'character_detail' THEN 'detail'
            WHEN p_step_id IN ('element_sheet', 'element_reference') THEN 'detail'
            WHEN p_step_id = 'upload' THEN 'original'
            ELSE 'output'
        END,
        true
    )
    ON CONFLICT (workflow_id, media_id, role) 
    DO UPDATE SET is_primary = true;

    -- 4. Return both IDs to the caller
    RETURN jsonb_build_object(
        'workflow_id', v_workflow_id,
        'media_id',    v_media_id
    );

EXCEPTION
    WHEN OTHERS THEN
        RAISE;
END;
$function$;
