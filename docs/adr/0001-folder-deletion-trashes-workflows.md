---
status: accepted
---

# Folder deletion permanently removes folders and moves contained workflows to Trash

Deleting a folder (`DELETE /api/folders/:folderId` via `FolderService.js`) previously hard-deleted every Workflow and orphaned Media inside the folder subtree, causing accidental data loss inconsistent with Trash-based deletion. We decided that folder deletion permanently removes the folder and its nested subfolders deepest-first after idempotently inserting all contained Workflows into `public.trash` (`ON CONFLICT DO NOTHING`) and clearing `workflow.folder_id = NULL`. Because `public.media`, Characters, and Elements belong to folders only through their owning container `Workflow`, trashing those Workflows preserves all user assets without adding folder-level trash semantics.

## Considered Options

1. **Hard-delete folders and contained workflows (previous behavior):** Simple, but permanently destroyed media, characters, and elements on a single click—inconsistent with the two-stage Trash model for assets.
2. **Soft-delete folders into Trash:** Would allow restoring entire folder trees, but requires a new folder-trash schema, recursive restore logic, and handling parent-folder or name collisions on restore.
3. **Permanently delete folders and move contained workflows to Trash (chosen):** Reuses the existing `public.trash` workflow model with zero schema changes, protects user content from accidental folder deletion, and keeps folder hierarchy management simple.

## Consequences

- **Restore lands at project root:** Restoring a trashed Workflow whose original folder was deleted leaves `folder_id = NULL` and places it unfiled at the project root without recreating deleted folders.
- **Already-trashed workflows must stay trashed:** Workflows previously trashed while inside the folder still hold `folder_id` pointing to it. Folder deletion must use idempotent `public.trash` insertion (`ON CONFLICT DO NOTHING`) and **must not** call `TrashService.requestDelete`, whose second-delete path permanently deletes already-trashed Workflows.
- **Order of operations enforced by FK constraint:** `workflow_folder_same_project_fk` is `ON DELETE NO ACTION`, so folder deletion must verify ownership, idempotently trash contained Workflows, clear `folder_id = NULL` on all workflows in the subtree (both newly and already trashed), and only then delete folders deepest-first.
- **Project deletion unchanged:** This decision applies only to folder deletion; deleting a Project keeps its existing cascade/permanent-delete behavior.
