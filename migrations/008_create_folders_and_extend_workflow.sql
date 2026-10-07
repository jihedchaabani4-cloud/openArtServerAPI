-- Migration 008: Create Folders Table and Extend Workflow (Path A)
-- ─────────────────────────────────────────────────────────────────────────────
-- Scope:
-- 1. Create public.folders hierarchy table scoped by project_id and user_id.
--    Self-referencing composite FK (parent_id, project_id) uses default NO ACTION
--    so cascade deletes on project can complete without premature RESTRICT abort.
-- 2. Add folder_id UUID NULL to public.workflow with composite foreign key
--    ensuring assets only point to folders within the exact same project.
-- 3. Add user_id UUID NULL to public.workflow with idempotent backfill from
--    parent project.user_id.
--
-- Handling of projects with user_id IS NULL:
-- If a workflow belongs to a project whose user_id is NULL, the backfill leaves
-- workflow.user_id as NULL. When any user (e.g. User B) queries this workflow,
-- server ownership checks (assertOwns) require a matching userId, and project
-- lookup via findByUser returns no matches, consistently returning HTTP 404.
--
-- Rollback Instructions (Manual / Disaster Recovery):
-- To revert this additive migration:
--   1. ALTER TABLE workflow DROP CONSTRAINT IF EXISTS workflow_folder_same_project_fk;
--   2. ALTER TABLE workflow DROP CONSTRAINT IF EXISTS workflow_folder_needs_project_ck;
--   3. DROP INDEX IF EXISTS workflow_project_folder_idx;
--   4. ALTER TABLE workflow DROP COLUMN IF EXISTS folder_id;
--   5. DROP INDEX IF EXISTS idx_workflow_user_id;
--   6. ALTER TABLE workflow DROP COLUMN IF EXISTS user_id;
--   7. DROP TABLE IF EXISTS folders CASCADE;
-- No pre-existing rows, columns, or tables are deleted or modified by applying this migration.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Create Folders Table
CREATE TABLE IF NOT EXISTS folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  parent_id UUID NULL,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT folders_project_folder_uq UNIQUE (id, project_id),
  CONSTRAINT folders_parent_same_project_fk
    FOREIGN KEY (parent_id, project_id) REFERENCES folders (id, project_id)
);

-- Indices for folder lookup and ordering
CREATE INDEX IF NOT EXISTS folders_project_parent_idx
  ON folders (project_id, parent_id, position);

-- Sibling names unique per parent, case-insensitive; root siblings share all-zeros sentinel parent UUID
CREATE UNIQUE INDEX IF NOT EXISTS folders_sibling_name_uq
  ON folders (project_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

-- 2. Extend Workflow Table with folder_id (Path A)
ALTER TABLE workflow
  ADD COLUMN IF NOT EXISTS folder_id UUID NULL;

-- Enforce composite foreign key and check constraint idempotently
DO $$
BEGIN
  BEGIN
    ALTER TABLE workflow
      ADD CONSTRAINT workflow_folder_same_project_fk
      FOREIGN KEY (folder_id, project_id) REFERENCES folders (id, project_id);
  EXCEPTION
    WHEN duplicate_object THEN NULL;
  END;

  BEGIN
    ALTER TABLE workflow
      ADD CONSTRAINT workflow_folder_needs_project_ck
      CHECK (folder_id IS NULL OR project_id IS NOT NULL);
  EXCEPTION
    WHEN duplicate_object THEN NULL;
  END;
END $$;

CREATE INDEX IF NOT EXISTS workflow_project_folder_idx
  ON workflow (project_id, folder_id, created_at DESC);

-- 3. Extend Workflow Table with user_id and Idempotent Backfill
ALTER TABLE workflow
  ADD COLUMN IF NOT EXISTS user_id UUID NULL;

-- Idempotent backfill: populate workflow.user_id from parent project owner
UPDATE workflow w
SET user_id = p.user_id
FROM projects p
WHERE w.project_id = p.id
  AND w.user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_workflow_user_id
  ON workflow (user_id)
  WHERE user_id IS NOT NULL;
