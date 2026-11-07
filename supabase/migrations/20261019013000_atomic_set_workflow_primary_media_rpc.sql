-- Migration: 20261019013000_atomic_set_workflow_primary_media_rpc.sql
-- Description: Atomic single-transaction primary media switching RPC.
--              Validates workflow and media relation existence, serializes concurrent switches
--              via FOR UPDATE on workflow row, clears previous primary pin before setting new one,
--              and strictly preserves idx_workflow_media_single_primary unique constraint.

CREATE OR REPLACE FUNCTION public.set_workflow_primary_media(
    p_workflow_id UUID,
    p_media_id UUID
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_relation_exists BOOLEAN;
    v_result jsonb;
BEGIN
    IF p_workflow_id IS NULL OR p_media_id IS NULL THEN
        RAISE EXCEPTION 'p_workflow_id and p_media_id are required'
            USING ERRCODE = '22004'; -- null_value_not_allowed
    END IF;

    -- 1. Serialize concurrent primary switches for this workflow using row-level locking
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

    -- 3. Clear any existing primary pin for this workflow (cleared before setting new one)
    UPDATE public.workflow_media
    SET is_primary = false
    WHERE workflow_id = p_workflow_id
      AND is_primary = true
      AND media_id != p_media_id;

    -- 4. Set the new primary pin
    UPDATE public.workflow_media
    SET is_primary = true
    WHERE workflow_id = p_workflow_id
      AND media_id = p_media_id;

    SELECT jsonb_build_object(
        'workflow_id', p_workflow_id,
        'media_id', p_media_id,
        'is_primary', true
    ) INTO v_result;

    RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.set_workflow_primary_media(UUID, UUID) IS
'Atomically sets the primary media pin for a workflow. Serializes switches via FOR UPDATE, clears previous pin, sets new pin, and enforces relation existence.';

REVOKE ALL ON FUNCTION public.set_workflow_primary_media(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_workflow_primary_media(UUID, UUID) TO authenticated, service_role;

-- 5. Drop redundant index (covered by idx_workflow_media_single_primary)
DROP INDEX IF EXISTS public.idx_workflow_media_is_primary;

