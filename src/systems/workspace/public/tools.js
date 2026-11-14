/**
 * System 8: Workspace — Public Tools Gateway (#workspace/tools)
 *
 * Exposes inter-system programmatic tools with pure DTO contracts (Rule 8).
 * Enforces the Two-Gateway Rule (Rule 2) and isolates internal/ (Rule 1, R10).
 */

import {
    ProjectService,
    ProjectReadService,
    FolderService,
    TrashService,
    folderTree,
    indexById,
    indexChildren,
    getAncestorIds,
    getDepth,
    getSubtreeHeight,
    collectDescendantIds,
    wouldCreateCycle,
    wouldExceedDepth,
    depthForNewChild,
} from "../internal/services/index.js";

import {
    ProjectRepository,
    projectRepository,
    FolderRepository,
    folderRepository,
    TrashRepository,
    trashRepository,
} from "../internal/db/index.js";

import {
    WorkspaceError,
    WorkspaceValidationError,
    WorkspaceNotFoundError,
    WorkspaceConflictError,
    WorkspaceUnauthorizedError,
    FolderError,
} from "../internal/errors.js";

import { setWorkspaceServices } from "../internal/services/serviceAccessor.js";

// System-managed singletons (configured by container at bootstrap)
let _defaultTrashService = null;
let _defaultProjectService = null;

export function configureWorkspace(services = {}) {
    if (services.trashService) _defaultTrashService = services.trashService;
    if (services.projectService) _defaultProjectService = services.projectService;
    setWorkspaceServices(services);
}


/**
 * Asserts that the specified project exists and is owned by the given user.
 *
 * @param {Object} params
 * @param {string} params.userId
 * @param {string} params.projectId
 * @returns {Promise<{ ok: boolean, project: Object }>}
 * @throws {WorkspaceValidationError|WorkspaceNotFoundError}
 */
export async function assertProjectAccess({ userId, projectId }) {
    if (!userId) {
        throw new WorkspaceValidationError("User ID is required for project access assertion");
    }
    if (!projectId) {
        throw new WorkspaceValidationError("Project ID is required for project access assertion");
    }

    const repo = projectRepository;
    const project = await repo.findOwnedProject(projectId, userId);

    if (!project) {
        throw new WorkspaceNotFoundError(`Project ${projectId} not found or foreign to user ${userId}`);
    }

    return {
        ok: true,
        project: {
            id: project.id,
            userId: project.user_id,
            name: project.project_name,
        },
    };
}

/**
 * Programmatically moves an item (workflow, element, character) to the workspace trash.
 *
 * @param {Object} params
 * @param {string} params.userId
 * @param {string} [params.itemType='workflow'] - 'workflow' | 'element' | 'character'
 * @param {string} params.itemId
 * @param {boolean} [params.trash=true]
 * @returns {Promise<Object>}
 */
export async function moveItemToTrash({ userId, itemType = "workflow", itemId, trash = true }) {
    if (!userId) {
        throw new WorkspaceValidationError("User ID is required to move item to trash");
    }
    if (!itemId) {
        throw new WorkspaceValidationError("Item ID is required to move item to trash");
    }

    if (_defaultTrashService) {
        return await _defaultTrashService.requestDelete({
            kind: itemType,
            id: itemId,
            userId,
            trash,
        });
    }

    // Fallback: direct trash persistence
    const inserted = await trashRepository.insertIfAbsent({
        workflowId: itemId,
        userId,
        deletedBy: userId,
    });
    return {
        workflowId: itemId,
        trashed: Boolean(inserted),
        unlinkedMediaCount: 0,
        deletedOrphanCount: 0,
        deletedMediaCount: 0,
        storageFailures: [],
    };
}

// ── Facade Re-exports for 100% Backward Compatibility ──────────────
export {
    ProjectService,
    ProjectReadService,
    FolderService,
    TrashService,
    folderTree,
    indexById,
    indexChildren,
    getAncestorIds,
    getDepth,
    getSubtreeHeight,
    collectDescendantIds,
    wouldCreateCycle,
    wouldExceedDepth,
    depthForNewChild,
    ProjectRepository,
    projectRepository,
    FolderRepository,
    folderRepository,
    TrashRepository,
    trashRepository,
    WorkspaceError,
    WorkspaceValidationError,
    WorkspaceNotFoundError,
    WorkspaceConflictError,
    WorkspaceUnauthorizedError,
    FolderError,
};

export default {
    assertProjectAccess,
    moveItemToTrash,
    ProjectService,
    ProjectReadService,
    FolderService,
    TrashService,
    folderTree,
    ProjectRepository,
    projectRepository,
    FolderRepository,
    folderRepository,
    TrashRepository,
    trashRepository,
    WorkspaceError,
    WorkspaceValidationError,
    WorkspaceNotFoundError,
    WorkspaceConflictError,
    WorkspaceUnauthorizedError,
    FolderError,
};
