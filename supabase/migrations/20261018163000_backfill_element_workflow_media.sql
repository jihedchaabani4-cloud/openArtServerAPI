-- Migration: 20261018163000_backfill_element_workflow_media.sql
-- Description: Backfill missing workflow_media links for element source images
--              (specifically element_692 and vvvv discovered during live audit).

INSERT INTO public.workflow_media (workflow_id, media_id, role)
SELECT 
    e.workflow_id,
    img.media_id::uuid,
    'detail' AS role
FROM public.element e
CROSS JOIN LATERAL jsonb_array_elements_text(e.source_images) AS img(media_id)
JOIN public.media m ON m.id = img.media_id::uuid
WHERE e.workflow_id IS NOT NULL
ON CONFLICT (workflow_id, media_id, role) DO NOTHING;
