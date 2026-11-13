/**
 * System 8: Workspace — Internal Services Index
 *
 * Encapsulates domain logic for Projects, Folders, and Trash.
 */

export { ProjectService } from "../../../../domain/project/ProjectService.js";
export { ProjectReadService } from "../../../../domain/project/ProjectReadService.js";
export { FolderService, FolderError } from "../../../../domain/folder/FolderService.js";
export { TrashService } from "../../../../domain/trash/TrashService.js";
export * as folderTree from "../../../../domain/folderTree.js";
export {
    indexById,
    indexChildren,
    getAncestorIds,
    getDepth,
    getSubtreeHeight,
    collectDescendantIds,
    wouldCreateCycle,
    wouldExceedDepth,
    depthForNewChild,
} from "../../../../domain/folderTree.js";
