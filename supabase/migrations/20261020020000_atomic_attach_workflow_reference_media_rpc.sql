-- Migration: 20261020020000_atomic_attach_workflow_reference_media_rpc.sql
-- Status: APPLIED
--
-- Description:
--   Atomic single-transaction RPC to attach a reference media relation to a workflow
--   under the canonical data model (ADR 0006 & ADR 0007).
--   Authoritatively enforces strict maximum media quota under concurrent execution,
--   guarantees attachment idempotency, and preserves primary cover pin.
--
-- Canonical Schema & Concurrency Invariants:
--   1. Relation Identity: Uniquely defined by the composite primary key (workflow_id, media_id, role).
--      The role column is TEXT NOT NULL DEFAULT 'output' with CHECK constraint on supported values.
--   2. Concurrency Control:
--      - Serializes concurrent attachments for the workflow using SELECT ... FOR UPDATE on public.workflow.
--      - Coordinates with concurrent unlink/reap using row-level key share lock
--        (SELECT ... FOR KEY SHARE on public.media).
--   3. Idempotent Attachment:
--      - If the exact canonical relation (workflow_id, media_id, role) already exists, quota is NOT
--        consumed (even if quota is full) and the existing is_primary state is strictly preserved.
--   4. Quota Enforcement:
--      - Evaluated solely on genuinely new attachments against the current count of relations for that role.
--      - If current_count >= p_max_allowed, raises exception 'LIMIT_EXCEEDED' (SQLSTATE 23514).
--   5. Primary Cover Assignment:
--      - If no primary cover exists for this workflow (idx_workflow_media_single_primary), the first
--        attachment atomically receives is_primary = true.
--      - Otherwise, newly attached items receive is_primary = false.

CREATE OR REPLACE FUNCTION public.attach_workflow_reference_media(
    p_workflow_id UUID,
    p_media_id UUID,
    p_role TEXT DEFAULT 'detail',
    p_max_allowed INT DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_is_existing BOOLEAN := false;
    v_current_count INT;
    v_is_primary BOOLEAN := false;
    v_has_primary BOOLEAN;
    v_post_count INT;
BEGIN
    IF p_workflow_id IS NULL OR p_media_id IS NULL THEN
        RAISE EXCEPTION 'p_workflow_id and p_media_id are required'
            USING ERRCODE = '22004'; -- null_value_not_allowed
    END IF;

    -- 1. Serialize concurrent attachments for this workflow container
    PERFORM 1
    FROM public.workflow
    WHERE id = p_workflow_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Workflow % not found', p_workflow_id
            USING ERRCODE = 'P0002'; -- no_data_found
    END IF;

    -- 2. Verify media exists and coordinate with concurrent unlink/reap via FOR KEY SHARE lock
    PERFORM 1
    FROM public.media
    WHERE id = p_media_id
    FOR KEY SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Media % not found', p_media_id
            USING ERRCODE = 'P0002'; -- no_data_found
    END IF;

    -- 3. Check if exact canonical relation (workflow_id, media_id, role) already exists
    SELECT is_primary
    INTO v_is_primary
    FROM public.workflow_media
    WHERE workflow_id = p_workflow_id
      AND media_id = p_media_id
      AND role = p_role;

    v_is_existing := FOUND;

    -- 4. Count current canonical relations for this workflow and role
    SELECT COUNT(*)
    INTO v_current_count
    FROM public.workflow_media
    WHERE workflow_id = p_workflow_id
      AND role = p_role;

    -- 5. Attachment / Idempotency handling
    IF NOT v_is_existing THEN
        -- Genuinely new attachment: enforce quota
        IF p_max_allowed IS NOT NULL AND v_current_count >= p_max_allowed THEN
            RAISE EXCEPTION 'Maximum % reference images allowed per element. Current: %', p_max_allowed, v_current_count
                USING ERRCODE = '23514'; -- check_violation
        END IF;

        -- Determine if this should automatically become primary (first attachment wins)
        SELECT EXISTS (
            SELECT 1
            FROM public.workflow_media
            WHERE workflow_id = p_workflow_id
              AND is_primary = true
        ) INTO v_has_primary;

        v_is_primary := NOT v_has_primary;

        -- Insert canonical relation
        INSERT INTO public.workflow_media (
            workflow_id,
            media_id,
            role,
            is_primary,
            metadata,
            created_at
        )
        VALUES (
            p_workflow_id,
            p_media_id,
            p_role,
            v_is_primary,
            '{}'::jsonb,
            NOW()
        );

        v_post_count := v_current_count + 1;
    ELSE
        -- Idempotent re-attachment:
        -- Quota is NOT consumed again (even if quota is full).
        -- Primary state is strictly preserved from the existing relation.
        v_post_count := v_current_count;
    END IF;

    -- 6. Return authoritative resulting state
    RETURN jsonb_build_object(
        'workflow_id', p_workflow_id,
        'media_id', p_media_id,
        'role', p_role,
        'is_primary', v_is_primary,
        'current_count', v_post_count,
        'max_allowed', p_max_allowed,
        'is_existing', v_is_existing
    );
END;
$$;

-- Security & Privileges: Least privilege enforcement
REVOKE ALL ON FUNCTION public.attach_workflow_reference_media(UUID, UUID, TEXT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attach_workflow_reference_media(UUID, UUID, TEXT, INT) TO service_role;
