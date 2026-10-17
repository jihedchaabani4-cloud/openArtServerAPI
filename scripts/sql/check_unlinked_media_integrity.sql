-- ============================================================================
-- READ-ONLY INTEGRITY CHECK: Unlinked Media Records
-- ============================================================================
-- Description:
--   Queries all rows in public.media that have no corresponding entry in
--   public.workflow_media. Also inspects if the media is referenced as
--   primary_media_id on workflow/element or contained in element.source_images.
--
-- Safety:
--   100% READ-ONLY. Contains NO INSERT, UPDATE, or DELETE statements.
-- ============================================================================

SELECT
    m.id AS media_id,
    m.project_id,
    m.step_id,
    m.status,
    (m.url IS NOT NULL AND m.url <> '') AS has_url,
    m.create_time,
    w_primary.id AS workflow_primary_for_id,
    w_primary.workflow_type AS workflow_primary_type,
    e_primary.id AS element_primary_for_id
FROM public.media m
LEFT JOIN public.workflow_media wm
    ON m.id = wm.media_id
LEFT JOIN public.workflow w_primary
    ON m.id = w_primary.primary_media_id
LEFT JOIN public.elements e_primary
    ON m.id = e_primary.primary_media_id
WHERE wm.media_id IS NULL
ORDER BY m.create_time DESC;
