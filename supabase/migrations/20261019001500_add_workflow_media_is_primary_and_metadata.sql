-- Migration: 20261019001500_add_workflow_media_is_primary_and_metadata.sql
-- Description: Add is_primary and metadata columns to public.workflow_media,
-- backfill existing valid primary_media_id pins, create partial unique index,
-- and update create_workflow_with_placeholder_media RPC.

-- 1. Additive columns on workflow_media
ALTER TABLE public.workflow_media
  ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

-- 2. Safe Backfill of existing explicit primary pins
-- Only sets is_primary = true where the media item actually has a corresponding workflow_media row.
DO $$
DECLARE
    v_missing_relations INTEGER;
BEGIN
    -- Audit: check any workflows where primary_media_id exists but has NO workflow_media link
    SELECT count(*) INTO v_missing_relations
    FROM public.workflow w
    WHERE w.primary_media_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.workflow_media wm
        WHERE wm.workflow_id = w.id AND wm.media_id = w.primary_media_id
      );

    IF v_missing_relations > 0 THEN
        RAISE WARNING 'Backfill audit: Found % workflows with primary_media_id but no matching workflow_media row.', v_missing_relations;
    END IF;

    -- Update workflow_media.is_primary for all matching links
    UPDATE public.workflow_media wm
    SET is_primary = true
    FROM public.workflow w
    WHERE wm.workflow_id = w.id
      AND wm.media_id = w.primary_media_id;
END $$;

-- 3. Partial Unique Index: at most ONE primary media per workflow
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_media_single_primary
ON public.workflow_media (workflow_id)
WHERE is_primary = true;

-- 4. Lookup index on is_primary
CREATE INDEX IF NOT EXISTS idx_workflow_media_is_primary
ON public.workflow_media (is_primary)
WHERE is_primary = true;

-- 5. Update RPC create_workflow_with_placeholder_media to set is_primary = true in workflow_media
CREATE OR REPLACE FUNCTION public.create_workflow_with_placeholder_media(
    p_project_id uuid,
    p_session_id uuid DEFAULT NULL::uuid,
    p_display_name text DEFAULT 'Untitled'::text,
    p_workflow_type text DEFAULT 'GENERATION'::text,
    p_generation_config_id uuid DEFAULT NULL::uuid,
    p_step_id text DEFAULT 'GEN'::text
)
RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE
    v_workflow_id UUID;
    v_media_id    UUID;
BEGIN
    -- 1. Insert Workflow row
    INSERT INTO workflow (project_id, session_id, display_name, workflow_type)
    VALUES (p_project_id, p_session_id, p_display_name, p_workflow_type)
    RETURNING id INTO v_workflow_id;

    -- 2. Insert Media placeholder row
    INSERT INTO media (
        project_id,
        generation_config_id,
        step_id,
        status,
        url,
        width,
        height
    )
    VALUES (
        p_project_id,
        p_generation_config_id,
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
