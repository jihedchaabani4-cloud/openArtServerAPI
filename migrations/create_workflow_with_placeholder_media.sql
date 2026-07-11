-- ============================================================
-- MIGRATION: create_workflow_with_placeholder_media
-- 
-- PURPOSE:
--   Atomically create a workflow row AND its first media
--   placeholder row in a single PostgreSQL transaction.
--   If either INSERT fails, the entire transaction rolls back
--   so the database is never left in an inconsistent state.
--
-- USAGE:
--   Copy-paste this script into the Supabase SQL Editor and
--   click "Run". No restart is needed — the RPC is immediately
--   available to the Supabase JS client.
--
-- CALLED FROM:
--   apiOpenArt/src/db/workflowMediaOps.js → createWorkflowWithMediaAtomic()
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
