-- ============================================================================
-- SCRIPT: check_live_schema.sql
-- PURPOSE: Read-only schema verification against the live Supabase database.
-- SAFETY:  100% READ-ONLY. No writes, updates, alters, or drops.
-- USAGE:   Copy and paste this into the Supabase Dashboard SQL Editor and click "Run".
-- ============================================================================

WITH
-- 1. Check media table: workflow_id must NOT exist
check_1 AS (
  SELECT
    1 AS check_num,
    'media has no workflow_id' AS check_name,
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS status,
    CASE WHEN COUNT(*) = 0
      THEN 'PASS: Column media.workflow_id is absent (dropped in Migration 010)'
      ELSE 'FAIL: Column media.workflow_id still exists'
    END AS details
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'media' AND column_name = 'workflow_id'
),

-- 2. Check element table: primary_media_id must NOT exist
check_2 AS (
  SELECT
    2 AS check_num,
    'element has no primary_media_id' AS check_name,
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS status,
    CASE WHEN COUNT(*) = 0
      THEN 'PASS: Column element.primary_media_id is absent (dropped in Migration 010)'
      ELSE 'FAIL: Column element.primary_media_id still exists'
    END AS details
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'element' AND column_name = 'primary_media_id'
),

-- 3. Check workflow_media: columns, primary key, and lookup indexes
wm_cols AS (
  SELECT column_name
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'workflow_media'
    AND column_name IN ('workflow_id', 'media_id', 'role', 'created_at')
),
wm_pk AS (
  SELECT array_agg(kcu.column_name::text ORDER BY kcu.ordinal_position) AS pk_cols
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
  WHERE tc.table_schema = 'public' AND tc.table_name = 'workflow_media' AND tc.constraint_type = 'PRIMARY KEY'
),
wm_idx AS (
  SELECT count(*) AS idx_count
  FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'workflow_media'
    AND indexname IN ('workflow_media_workflow_id_idx', 'workflow_media_media_id_idx', 'workflow_media_role_idx')
),
check_3 AS (
  SELECT
    3 AS check_num,
    'workflow_media columns, constraints, and indexes' AS check_name,
    CASE
      WHEN (SELECT count(*) FROM wm_cols) = 4
       AND (SELECT pk_cols FROM wm_pk) = ARRAY['workflow_id', 'media_id', 'role']
       AND (SELECT idx_count FROM wm_idx) >= 3
      THEN 'PASS'
      ELSE 'FAIL'
    END AS status,
    'Columns: ' || (SELECT count(*) FROM wm_cols) || '/4; PK: ' ||
      coalesce((SELECT pk_cols::text FROM wm_pk), 'missing') ||
      '; Lookup indexes: ' || (SELECT idx_count FROM wm_idx) || '/3' AS details
),

-- 4. Check element.workflow_id foreign key: must be ON DELETE SET NULL (confdeltype = 'n')
check_4 AS (
  SELECT
    4 AS check_num,
    'element.workflow_id ON DELETE SET NULL' AS check_name,
    CASE
      WHEN confdeltype = 'n' THEN 'PASS'
      WHEN confdeltype = 'c' THEN 'FAIL (is ON DELETE CASCADE)'
      WHEN confdeltype = 'a' THEN 'FAIL (is ON DELETE NO ACTION)'
      ELSE 'FAIL (unexpected confdeltype: ' || coalesce(confdeltype::text, 'null') || ')'
    END AS status,
    'Foreign key element_workflow_id_fkey confdeltype=' || coalesce(confdeltype::text, 'none') || ' (n = SET NULL)' AS details
  FROM pg_constraint
  WHERE conrelid = 'public.element'::regclass
    AND contype = 'f'
    AND conname = 'element_workflow_id_fkey'
  UNION ALL
  SELECT
    4 AS check_num,
    'element.workflow_id ON DELETE SET NULL' AS check_name,
    'FAIL' AS status,
    'Constraint element_workflow_id_fkey not found on table public.element' AS details
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.element'::regclass AND contype = 'f' AND conname = 'element_workflow_id_fkey'
  )
),

-- 5. Check body of create_workflow_with_placeholder_media in pg_proc
check_5 AS (
  SELECT
    5 AS check_num,
    'create_workflow_with_placeholder_media body' AS check_name,
    CASE
      WHEN count(*) = 0 THEN 'FAIL (RPC not found)'
      WHEN bool_and(prosrc NOT ILIKE '%INSERT INTO media%workflow_id%')
       AND bool_and(prosrc ILIKE '%INSERT INTO workflow_media%') THEN 'PASS'
      WHEN bool_and(prosrc ILIKE '%INSERT INTO media%workflow_id%') THEN 'FAIL (still references media.workflow_id)'
      WHEN NOT bool_and(prosrc ILIKE '%INSERT INTO workflow_media%') THEN 'FAIL (does not insert into workflow_media)'
      ELSE 'FAIL'
    END AS status,
    CASE
      WHEN count(*) = 0 THEN 'Function create_workflow_with_placeholder_media not found in pg_proc'
      WHEN bool_and(prosrc NOT ILIKE '%INSERT INTO media%workflow_id%')
       AND bool_and(prosrc ILIKE '%INSERT INTO workflow_media%')
        THEN 'PASS: No media.workflow_id reference, inserts into workflow_media with role mapping'
      WHEN bool_and(prosrc ILIKE '%INSERT INTO media%workflow_id%')
        THEN 'FAIL: Body still attempts to INSERT INTO media (..., workflow_id, ...)'
      ELSE 'FAIL: Function body does not match expected v3 implementation'
    END AS details
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public' AND p.proname = 'create_workflow_with_placeholder_media'
)

SELECT check_num, check_name, status, details FROM check_1
UNION ALL
SELECT check_num, check_name, status, details FROM check_2
UNION ALL
SELECT check_num, check_name, status, details FROM check_3
UNION ALL
SELECT check_num, check_name, status, details FROM check_4
UNION ALL
SELECT check_num, check_name, status, details FROM check_5
ORDER BY check_num;
