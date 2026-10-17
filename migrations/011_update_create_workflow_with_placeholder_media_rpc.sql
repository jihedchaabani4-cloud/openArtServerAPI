-- ============================================================
-- MIGRATION: 011_update_create_workflow_with_placeholder_media_rpc.sql
-- 
-- PURPOSE:
--   Update create_workflow_with_placeholder_media to atomically
--   insert into workflow_media so that placeholder media are
--   linked to their workflows from creation time.
-- ============================================================

CREATE OR REPLACE FUNCTION create_workflow_with_placeholder_media(
    p_project_id           UUID,
    p_session_id           UUID    DEFAULT NULL,
    p_display_name         TEXT    DEFAULT 'Untitled',
    p_workflow_type        TEXT    DEFAULT 'GENERATION',
    p_generation_config_id UUID    DEFAULT NULL,
    p_step_id              TEXT    DEFAULT 'GEN'
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_workflow_id UUID;
    v_media_id    UUID;
BEGIN
    -- 1. Insert Workflow row
    INSERT INTO workflow (project_id, session_id, display_name, workflow_type)
    VALUES (p_project_id, p_session_id, p_display_name, p_workflow_type)
    RETURNING id INTO v_workflow_id;

    -- 2. Insert Media placeholder row (url = NULL, status = 'processing')
    INSERT INTO media (
        project_id,
        workflow_id,
        generation_config_id,
        step_id,
        status,
        url,
        width,
        height
    )
    VALUES (
        p_project_id,
        v_workflow_id,
        p_generation_config_id,
        p_step_id,
        'processing',
        NULL,
        1024,
        1024
    )
    RETURNING id INTO v_media_id;

    -- 3. Link the media as primary media on the workflow
    UPDATE workflow
    SET primary_media_id = v_media_id
    WHERE id = v_workflow_id;

    -- 3.1. Link in public.workflow_media table (canonical relation)
    INSERT INTO workflow_media (workflow_id, media_id, role)
    VALUES (
        v_workflow_id,
        v_media_id,
        CASE
            WHEN p_step_id = 'character_sheet' THEN 'sheet'
            WHEN p_step_id = 'character_detail' THEN 'detail'
            WHEN p_step_id IN ('element_sheet', 'element_reference') THEN 'detail'
            WHEN p_step_id = 'upload' THEN 'original'
            ELSE 'output'
        END
    )
    ON CONFLICT (workflow_id, media_id, role) DO NOTHING;

    -- 4. Return both IDs to the caller
    RETURN jsonb_build_object(
        'workflow_id', v_workflow_id,
        'media_id',    v_media_id
    );

EXCEPTION
    WHEN OTHERS THEN
        -- Any error rolls back all changes automatically (plpgsql default)
        RAISE;
END;
$$;
