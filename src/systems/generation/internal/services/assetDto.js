/**
 * Maps a workflow database row to a product asset DTO.
 * Owned by System 1 (Generation & Workflows).
 *
 * @param {Object} workflow - Raw row or workflow record
 * @returns {Object|null}
 */
export function toAssetDto(workflow) {
  if (!workflow) return null;

  return {
    id: workflow.id,
    projectId: workflow.project_id,
    userId: workflow.user_id,
    folderId: workflow.folder_id || null,
    name: workflow.display_name || "Untitled",
    primaryMediaId: workflow.primaryMediaId || null,
    workflowType: workflow.workflow_type || null,
    favorited: Boolean(workflow.favorited),
    createdAt: workflow.create_time || workflow.created_at || null,
    updatedAt: workflow.update_time || workflow.updated_at || null,
  };
}
