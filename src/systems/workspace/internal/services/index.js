/**
 * System 8: Workspace — Internal Services Index
 *
 * Encapsulates domain logic for Projects, Folders, and Trash.
 */

export { ProjectService } from "./ProjectService.js";
export { ProjectReadService } from "./ProjectReadService.js";
export { FolderService, FolderError } from "./FolderService.js";
export { TrashService } from "./TrashService.js";
export * as folderTree from "./folderTree.js";
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
} from "./folderTree.js";
