-- Migration: 20261020030000_atomic_unlink_workflow_media_and_reap_orphan_rpc.sql
-- Status: APPLIED
--
-- Description:
--   Atomic single-transaction RPC to unlink a workflow_media relation and cleanly reap the media
--   record and flag storage deletion if and only if zero references remain across the entire system
--   under the canonical data model (ADR 0006 & ADR 0007).
--
-- Concurrency & Role Semantics:
--   1. Obtains an exclusive row-level lock (FOR UPDATE) on public.media for p_media_id.
--      Coordinates with attach_workflow_reference_media (FOR KEY SHARE) to ensure serializability.
--   2. Deletes relations matching (p_workflow_id, p_media_id):
--        - When p_role IS NULL: unlinks all relations for (p_workflow_id, p_media_id) regardless of role.
--          (Container-level unlinking in WorkflowMediaService.deleteMedia, releaseWorkflowMedia,
--          and ElementMediaService.removeReferenceMedia).
--        - When p_role IS NOT NULL: unlinks only the specific relation where role = p_role.
--          (Role-scoped unlinking in CharacterMediaService.removeDetailMedia, preserving other roles like 'sheet').
--   3. If the unlinked relation was marked is_primary = true, clears the primary pin on public.workflow_media
--      for that workflow with ZERO auto-promotion (per ADR 0006 Section 2 & ADR 0007 Section 1).
--   4. Counts remaining relations in public.workflow_media for p_media_id across all workflows.
--   5. If remaining_count = 0 (true orphan):
--        - Deletes the media row from public.media.
--        - Returns { unlinked: true, is_orphan: true, storage_url: media.url, remaining_links: 0, was_primary: was_primary }.
--   6. If remaining_count > 0 (shared asset):
--        - Preserves the media row in public.media.
--        - Returns { unlinked: true, is_orphan: false, storage_url: null, remaining_links: remaining_count, was_primary: was_primary }.
--   7. If the media or relation does not exist, returns unlinked: false without error.

CREATE OR REPLACE FUNCTION public.unlink_workflow_media_and_reap_orphan(
    p_workflow_id UUID,
    p_media_id UUID,
    p_role TEXT DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_media_rec RECORD;
    v_was_primary BOOLEAN := false;
    v_remaining_links INT := 0;
    v_deleted_relation_count INT := 0;
BEGIN
    IF p_workflow_id IS NULL OR p_media_id IS NULL THEN
        RAISE EXCEPTION 'p_workflow_id and p_media_id are required'
            USING ERRCODE = '22004'; -- null_value_not_allowed
    END IF;

    -- 1. Lock the media record FOR UPDATE to coordinate with concurrent attach/unlink
    SELECT id, url
    INTO v_media_rec
    FROM public.media
    WHERE id = p_media_id
    FOR UPDATE;

    IF NOT FOUND THEN
        -- Media record already removed or does not exist
        RETURN jsonb_build_object(
            'unlinked', false,
            'is_orphan', false,
            'storage_url', null,
            'remaining_links', 0,
            'reason', 'media_not_found'
        );
    END IF;

    -- 2. Check if any relation being removed was the primary cover for this workflow
    SELECT COALESCE(bool_or(is_primary), false)
    INTO v_was_primary
    FROM public.workflow_media
    WHERE workflow_id = p_workflow_id
      AND media_id = p_media_id
      AND (p_role IS NULL OR role = p_role);

    -- 3. Delete the matching workflow_media relation(s)
    DELETE FROM public.workflow_media
    WHERE workflow_id = p_workflow_id
      AND media_id = p_media_id
      AND (p_role IS NULL OR role = p_role);

    GET DIAGNOSTICS v_deleted_relation_count = ROW_COUNT;

    IF v_deleted_relation_count = 0 THEN
        RETURN jsonb_build_object(
            'unlinked', false,
            'is_orphan', false,
            'storage_url', null,
            'remaining_links', (SELECT count(*) FROM public.workflow_media WHERE media_id = p_media_id),
            'reason', 'relation_not_found'
        );
    END IF;

    -- 4. If removed relation was primary cover, clear primary pin (zero auto-promotion, per ADR 0006 & 0007)
    IF v_was_primary THEN
        UPDATE public.workflow_media
        SET is_primary = false
        WHERE workflow_id = p_workflow_id
          AND is_primary = true;
    END IF;

    -- 5. Count remaining links across all workflows in the system
    SELECT count(*)
    INTO v_remaining_links
    FROM public.workflow_media
    WHERE media_id = p_media_id;

    -- 6. Orphan evaluation and cleanup
    IF v_remaining_links = 0 THEN
        -- Delete media DB record
        DELETE FROM public.media
        WHERE id = p_media_id;

        RETURN jsonb_build_object(
            'unlinked', true,
            'is_orphan', true,
            'storage_url', v_media_rec.url,
            'remaining_links', 0,
            'was_primary', v_was_primary
        );
    ELSE
        RETURN jsonb_build_object(
            'unlinked', true,
            'is_orphan', false,
            'storage_url', null,
            'remaining_links', v_remaining_links,
            'was_primary', v_was_primary
        );
    END IF;
END;
$$;

-- Security & Privileges: Least privilege enforcement
REVOKE ALL ON FUNCTION public.unlink_workflow_media_and_reap_orphan(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unlink_workflow_media_and_reap_orphan(UUID, UUID, TEXT) TO service_role;
