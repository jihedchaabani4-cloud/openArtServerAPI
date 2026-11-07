-- Rollback Draft: 20261024000000_add_auto_primary_to_attach_reference_media_rollback.sql
-- Restores the 4-argument signature of attach_workflow_reference_media and drops the 5-argument version.

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
            USING ERRCODE = '22004';
    END IF;

    -- 1. Serialize concurrent attachments for this workflow container
    PERFORM 1
    FROM public.workflow
    WHERE id = p_workflow_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Workflow % not found', p_workflow_id
            USING ERRCODE = 'P0002';
    END IF;

    -- 2. Verify media exists and coordinate with concurrent unlink/reap via FOR KEY SHARE lock
    PERFORM 1
    FROM public.media
    WHERE id = p_media_id
    FOR KEY SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Media % not found', p_media_id
            USING ERRCODE = 'P0002';
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
                USING ERRCODE = '23514';
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

-- Drop the 5-argument signature
DROP FUNCTION IF EXISTS public.attach_workflow_reference_media(UUID, UUID, TEXT, INT, BOOLEAN);

-- Security & Privileges: Least privilege enforcement
REVOKE ALL ON FUNCTION public.attach_workflow_reference_media(UUID, UUID, TEXT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attach_workflow_reference_media(UUID, UUID, TEXT, INT) TO service_role;
