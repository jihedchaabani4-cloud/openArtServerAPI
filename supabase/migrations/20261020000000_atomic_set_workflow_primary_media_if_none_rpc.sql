-- Migration: 20261020000000_atomic_set_workflow_primary_media_if_none_rpc.sql
-- Status: APPLIED
--
-- Description:
--   Atomic single-transaction RPC to claim the primary Cover slot for a workflow
--   strictly on initial image attachment.
--
-- Concurrency Semantics:
--   1. Serializes concurrent operations on the workflow using SELECT ... FOR UPDATE.
--   2. Verifies that the media row is linked to this workflow.
--   3. Checks if any relation with is_primary = true already exists.
--   4. If a primary relation already exists, returns { is_primary: false, established: false }
--      preserving the already established Cover ("first successful attachment wins").
--   5. If NO primary relation exists, sets is_primary = true on the specified media
--      and returns { is_primary: true, established: true }.
--   6. Strictly prevents partial unique index (idx_workflow_media_single_primary) violations
--      and prevents concurrent uploads from replacing an existing Cover or failing with 500.

CREATE OR REPLACE FUNCTION public.set_workflow_primary_media_if_none(
    p_workflow_id UUID,
    p_media_id UUID
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_has_primary BOOLEAN;
    v_relation_exists BOOLEAN;
    v_result jsonb;
BEGIN
    IF p_workflow_id IS NULL OR p_media_id IS NULL THEN
        RAISE EXCEPTION 'p_workflow_id and p_media_id are required'
            USING ERRCODE = '22004'; -- null_value_not_allowed
    END IF;

    -- 1. Serialize concurrent operations for this workflow using row-level locking
    PERFORM 1
    FROM public.workflow
    WHERE id = p_workflow_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Workflow % not found', p_workflow_id
            USING ERRCODE = 'P0002'; -- no_data_found
    END IF;

    -- 2. Verify that the media item is linked to this workflow
    SELECT EXISTS (
        SELECT 1
        FROM public.workflow_media
        WHERE workflow_id = p_workflow_id
          AND media_id = p_media_id
    ) INTO v_relation_exists;

    IF NOT v_relation_exists THEN
        RAISE EXCEPTION 'Media % is not associated with workflow %', p_media_id, p_workflow_id
            USING ERRCODE = 'P0002';
    END IF;

    -- 3. Check if any primary media relation already exists for this workflow
    SELECT EXISTS (
        SELECT 1
        FROM public.workflow_media
        WHERE workflow_id = p_workflow_id
          AND is_primary = true
    ) INTO v_has_primary;

    -- 4. If primary already exists, preserve it. Do NOT replace an established Cover.
    IF v_has_primary THEN
        RETURN jsonb_build_object(
            'workflow_id', p_workflow_id,
            'media_id', p_media_id,
            'is_primary', false,
            'established', false
        );
    END IF;

    -- 5. No primary exists: atomically set this media as primary
    UPDATE public.workflow_media
    SET is_primary = true
    WHERE workflow_id = p_workflow_id
      AND media_id = p_media_id;

    RETURN jsonb_build_object(
        'workflow_id', p_workflow_id,
        'media_id', p_media_id,
        'is_primary', true,
        'established', true
    );
END;
$$;

COMMENT ON FUNCTION public.set_workflow_primary_media_if_none(UUID, UUID) IS
'Atomically claims the primary media pin for a workflow if and only if no primary exists. Preserves first-attachment-wins semantics under concurrent uploads.';

REVOKE ALL ON FUNCTION public.set_workflow_primary_media_if_none(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_workflow_primary_media_if_none(UUID, UUID) TO service_role;
