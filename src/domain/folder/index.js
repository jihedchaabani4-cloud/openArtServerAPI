/**
 * Folder Domain — Legacy Facade
 *
 * Re-exports from System 8 Workspace (#workspace/tools).
 */

export {
    FolderService,
    FolderError,
    FolderRepository,
    folderRepository,
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
} from "#workspace/tools";
