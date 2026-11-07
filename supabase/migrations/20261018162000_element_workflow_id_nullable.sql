-- Migration: 20261018162000_element_workflow_id_nullable.sql
-- Description: Drop NOT NULL constraint on public.element.workflow_id
--              This harmonizes element.workflow_id with its foreign key constraint
--              (element_workflow_id_fkey REFERENCES workflow(id) ON DELETE SET NULL),
--              preventing 23502 (NOT NULL violation) errors when a workflow is deleted.

ALTER TABLE public.element
  ALTER COLUMN workflow_id DROP NOT NULL;
