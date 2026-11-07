-- Migration Draft: 20261019050000_phase3_drop_element_source_images.sql
-- Description: Drop redundant element.source_images column.
-- Pre-conditions: All element media associations reside in public.workflow_media (role = 'detail').
--                 Array ordering is not a product requirement.

BEGIN;

-- 1. Verification assertion: ensure no element has source_images with unlinked media
DO $$
DECLARE
    v_missing INTEGER;
BEGIN
    SELECT count(*) INTO v_missing
    FROM (
        SELECT e.workflow_id, jsonb_array_elements_text(e.source_images)::uuid AS media_id
        FROM public.element e
        WHERE jsonb_typeof(e.source_images) = 'array'
    ) img
    WHERE NOT EXISTS (
        SELECT 1 FROM public.workflow_media wm
        WHERE wm.workflow_id = img.workflow_id AND wm.media_id = img.media_id
    );

    IF v_missing > 0 THEN
        RAISE EXCEPTION 'Safety check failed: % element source_images lack workflow_media links.', v_missing;
    END IF;
END $$;

-- 2. Drop column with RESTRICT (never CASCADE)
ALTER TABLE public.element
  DROP COLUMN IF EXISTS source_images RESTRICT;

COMMIT;
