import { AppError } from "../../utils/AppError.js";
import {
  indexById,
  indexChildren,
  wouldCreateCycle,
  wouldExceedDepth,
  depthForNewChild,
  collectDescendantIds,
  getDepth,
} from "../folderTree.js";

/**
 * Domain error class with structured status code and domain error code.
 */
export class FolderError extends AppError {
  constructor(message, statusCode = 400, errorCode = "FOLDER_ERROR") {
    super(message, statusCode);
    this.name = "FolderError";
    this.errorCode = errorCode;
  }
}

/**
 * FolderService
 * Domain Service — owns all folder lifecycle operations, tree validation,
 * position calculations, depth limits, cycle prevention, and usable folder resolution.
 *
 * Public methods:
 *   - list({ projectId, userId })
 *   - create({ projectId, userId, parentId, name })
 *   - update({ folderId, userId, patch })
 *   - remove({ folderId, userId })
 *   - setWorkflowService(workflowService)
 *   - assertFolderUsable(folderId, userId, projectId)
 *   - validateAndAssertUsable(folderId, userId, projectId)
 */
export class FolderService {
  constructor({
    folderRepo,
    projectRepo = null,
    workflowService = null,
    maxDepth = Number(process.env.FOLDER_MAX_DEPTH || 3),
    maxFoldersPerProject = Number(process.env.FOLDER_MAX_PER_PROJECT || 50),
  } = {}) {
    this.folderRepo = folderRepo;
    this.projectRepo = projectRepo;
    this.workflowService = workflowService;
    this.maxDepth = Number.isFinite(maxDepth) && maxDepth > 0 ? maxDepth : 3;
    this.maxFoldersPerProject =
      Number.isFinite(maxFoldersPerProject) && maxFoldersPerProject > 0
        ? maxFoldersPerProject
        : 50;
  }

  /**
   * Late-bind WorkflowService to avoid a constructor cycle
   * (WorkflowService already depends on FolderService for moveToFolder).
   */
  setWorkflowService(workflowService) {
    this.workflowService = workflowService || null;
  }

  /**
   * Normalizes and validates folder name string.
   */
  _validateName(name) {
    if (typeof name !== "string") {
      throw new FolderError("Folder name must be a string", 400, "FOLDER_NAME_INVALID");
    }
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > 100) {
      throw new FolderError(
        "Folder name must be between 1 and 100 characters",
        400,
        "FOLDER_NAME_INVALID"
      );
    }
    return trimmed;
  }

  /**
   * Maps raw database folder row to camelCase public Folder DTO.
   */
  _toFolderDto(folder, assetCount = 0) {
    return {
      id: folder.id,
      projectId: folder.project_id,
      parentId: folder.parent_id ?? null,
      name: folder.name,
      position: folder.position ?? 0,
      assetCount,
      createdAt: folder.created_at,
      updatedAt: folder.updated_at,
    };
  }

  /**
   * Lists all folders in a project with direct asset counts.
   */
  async list({ projectId, userId }) {
    if (!projectId || !userId) {
      throw new FolderError("Project and User ID required", 400, "VALIDATION_ERROR");
    }

    if (this.projectRepo?.findByUser) {
      const projects = await this.projectRepo.findByUser(userId, projectId);
      if (!projects || projects.length === 0) {
        throw new FolderError(`Project ${projectId} not found or not owned by user`, 404, "NOT_FOUND");
      }
    }

    const [folders, counts] = await Promise.all([
      this.folderRepo.listByProject(projectId, userId),
      this.folderRepo.countAssetsByFolder(projectId, userId),
    ]);

    const items = folders.map((f) => this._toFolderDto(f, counts[f.id] || 0));
    return { items };
  }

  /**
   * Creates a new folder within a project.
   */
  async create({ projectId, userId, parentId = null, name }) {
    if (!projectId || !userId) {
      throw new FolderError("Project and User ID required", 400, "VALIDATION_ERROR");
    }

    if (this.projectRepo?.findByUser) {
      const projects = await this.projectRepo.findByUser(userId, projectId);
      if (!projects || projects.length === 0) {
        throw new FolderError(`Project ${projectId} not found or not owned by user`, 404, "NOT_FOUND");
      }
    }

    const resolvedName = (name === undefined || name === null) ? "Untitled collection" : name;
    let cleanName = this._validateName(resolvedName);
    const normalizedParentId = parentId || null;

    // Check project total folder limit
    const currentCount = await this.folderRepo.countByProject(projectId, userId);
    if (currentCount >= this.maxFoldersPerProject) {
      throw new FolderError(
        `Project cannot exceed ${this.maxFoldersPerProject} folders`,
        400,
        "FOLDER_LIMIT_REACHED"
      );
    }

    // Load existing folders for sibling and depth validation
    const existingFolders = await this.folderRepo.listByProject(projectId, userId);
    const byId = indexById(existingFolders);

    // If parentId provided, verify it exists and is owned in this project
    if (normalizedParentId) {
      const parentFolder = byId.get(normalizedParentId);
      if (!parentFolder) {
        throw new FolderError("Parent folder not found", 404, "NOT_FOUND");
      }

      // Check depth limit
      const targetDepth = depthForNewChild(byId, normalizedParentId);
      if (targetDepth > this.maxDepth) {
        throw new FolderError(
          `Folder depth cannot exceed ${this.maxDepth}`,
          400,
          "FOLDER_DEPTH_EXCEEDED"
        );
      }
    }

    // Check sibling name uniqueness (case-insensitive)
    const siblings = existingFolders.filter(
      (f) => (f.parent_id || null) === normalizedParentId
    );

    // If default name or starts with "Untitled collection", auto-increment if duplicate exists
    if (name === undefined || name === null || cleanName.toLowerCase().startsWith("untitled collection")) {
      let candidate = cleanName;
      let counter = 2;
      while (siblings.some((s) => s.name.toLowerCase() === candidate.toLowerCase())) {
        candidate = `Untitled collection ${counter++}`;
      }
      cleanName = candidate;
    } else {
      const nameLower = cleanName.toLowerCase();
      if (siblings.some((s) => s.name.toLowerCase() === nameLower)) {
        throw new FolderError(
          `Folder name "${cleanName}" already exists in this directory`,
          409,
          "FOLDER_NAME_TAKEN"
        );
      }
    }

    // Calculate position: largest sibling position + 1 (or 0)
    const maxSiblingPos = siblings.reduce(
      (max, s) => (s.position > max ? s.position : max),
      -1
    );
    const position = maxSiblingPos + 1;

    try {
      const created = await this.folderRepo.create({
        projectId,
        userId,
        parentId: normalizedParentId,
        name: cleanName,
        position,
      });

      return this._toFolderDto(created, 0);
    } catch (err) {
      if (err.code === "23505") {
        throw new FolderError(
          `Folder name "${cleanName}" already exists in this directory`,
          409,
          "FOLDER_NAME_TAKEN"
        );
      }
      throw err;
    }
  }

  /**
   * Updates an existing folder (rename, move, reorder).
   */
  async update({ folderId, userId, patch = {} }) {
    if (!folderId || !userId) {
      throw new FolderError("Folder and User ID required", 400, "VALIDATION_ERROR");
    }

    const folder = await this.folderRepo.findOwned(folderId, userId);
    if (!folder) {
      throw new FolderError("Folder not found", 404, "NOT_FOUND");
    }

    const cleanPatch = {};

    // 1. Rename validation
    if (patch.name !== undefined) {
      cleanPatch.name = this._validateName(patch.name);
    }

    // 2. Position reorder
    if (patch.position !== undefined) {
      if (!Number.isInteger(patch.position) || patch.position < 0) {
        throw new FolderError("Position must be a non-negative integer", 400, "VALIDATION_ERROR");
      }
      cleanPatch.position = patch.position;
    }

    // 3. Move / parent change validation
    const hasParentChange = patch.parentId !== undefined || patch.parent_id !== undefined;
    const targetParentId = hasParentChange
      ? (patch.parentId ?? patch.parent_id ?? null)
      : folder.parent_id;

    if (hasParentChange) {
      cleanPatch.parentId = targetParentId;

      if (targetParentId === folderId) {
        throw new FolderError("Cannot move folder into itself", 400, "FOLDER_CYCLE");
      }

      const existingFolders = await this.folderRepo.listByProject(folder.project_id, userId);
      const byId = indexById(existingFolders);
      const children = indexChildren(existingFolders);

      if (targetParentId !== null) {
        const parentExists = byId.get(targetParentId);
        if (!parentExists) {
          throw new FolderError("Target parent folder not found", 404, "NOT_FOUND");
        }
      }

      // Check cycles
      if (wouldCreateCycle(byId, folderId, targetParentId)) {
        throw new FolderError(
          "Moving folder would create a parent-child cycle",
          400,
          "FOLDER_CYCLE"
        );
      }

      // Check depth
      if (wouldExceedDepth(byId, children, folderId, targetParentId, this.maxDepth)) {
        throw new FolderError(
          `Moving folder exceeds maximum allowed depth of ${this.maxDepth}`,
          400,
          "FOLDER_DEPTH_EXCEEDED"
        );
      }
    }

    // 4. Sibling uniqueness check under target parent
    if (cleanPatch.name !== undefined || hasParentChange) {
      const existingFolders = await this.folderRepo.listByProject(folder.project_id, userId);
      const effectiveName = cleanPatch.name || folder.name;
      const effectiveParent = targetParentId || null;
      const nameLower = effectiveName.toLowerCase();

      const conflictingSibling = existingFolders.find(
        (f) =>
          f.id !== folderId &&
          (f.parent_id || null) === effectiveParent &&
          f.name.toLowerCase() === nameLower
      );

      if (conflictingSibling) {
        throw new FolderError(
          `Folder name "${effectiveName}" already exists in the target directory`,
          409,
          "FOLDER_NAME_TAKEN"
        );
      }
    }

    try {
      const updated = await this.folderRepo.updateOwned(folderId, userId, cleanPatch);
      if (!updated) {
        throw new FolderError("Folder not found", 404, "NOT_FOUND");
      }
      return this._toFolderDto(updated, 0);
    } catch (err) {
      if (err.code === "23505") {
        throw new FolderError(
          "Folder name already exists in target directory",
          409,
          "FOLDER_NAME_TAKEN"
        );
      }
      throw err;
    }
  }

  /**
   * Deletes a folder, every descendant folder, and every workflow in that tree.
   * Workflow deletion is owned by WorkflowService (unlink media, then delete orphan media).
   */
  async remove({ folderId, userId }) {
    if (!folderId || !userId) {
      throw new FolderError("Folder and User ID required", 400, "VALIDATION_ERROR");
    }

    const folder = await this.folderRepo.findOwned(folderId, userId);
    if (!folder) {
      throw new FolderError("Folder not found", 404, "NOT_FOUND");
    }

    const projectFolders = await this.folderRepo.listByProject(folder.project_id, userId);
    const byId = indexById(projectFolders);
    const children = indexChildren(projectFolders);
    const treeIds = [...collectDescendantIds(children, folderId)];

    if (this.workflowService?.deleteWorkflowsInFolders) {
      await this.workflowService.deleteWorkflowsInFolders({
        folderIds: treeIds,
        userId,
        projectId: folder.project_id,
      });
    }

    const deepestFirst = treeIds
      .slice()
      .sort((a, b) => getDepth(byId, b) - getDepth(byId, a));

    try {
      for (const id of deepestFirst) {
        const deleted = await this.folderRepo.deleteOwned(id, userId);
        if (!deleted && id === folderId) {
          throw new FolderError("Folder not found", 404, "NOT_FOUND");
        }
      }
      return true;
    } catch (err) {
      if (err instanceof FolderError) throw err;
      if (err.code === "23503") {
        throw new FolderError(
          "Cannot delete folder that still has dependent rows",
          409,
          "FOLDER_NOT_EMPTY"
        );
      }
      throw err;
    }
  }

  /**
   * Validates that a folder exists, belongs to the user, and belongs to the specified project.
   * Null folderId is accepted as valid (represents project root).
   */
  async assertFolderUsable(folderId, userId, projectId) {
    if (folderId === null || folderId === undefined || folderId === "none") {
      return null;
    }

    const folder = await this.folderRepo.findOwnedInProject(folderId.trim(), projectId, userId);
    if (!folder) {
      throw new FolderError(
        `Folder ${folderId} not found in project ${projectId}`,
        404,
        "NOT_FOUND"
      );
    }

    return folder;
  }

  /**
   * Validates that a folderId is a valid UUID and usable within a project.
   * Null, undefined, or "none" (case-insensitive) resolves to null (project root).
   * Throws VALIDATION_ERROR (400) if folderId is not a valid UUID string.
   * Throws NOT_FOUND (404) if folder does not exist or does not belong to user & project.
   *
   * @param {string|null} folderId
   * @param {string} userId
   * @param {string} projectId
   * @returns {Promise<string|null>} The validated folderId or null
   */
  async validateAndAssertUsable(folderId, userId, projectId) {
    if (folderId === null || folderId === undefined) {
      return null;
    }
    const trimmed = typeof folderId === "string" ? folderId.trim() : String(folderId);
    if (!trimmed || ["none", "null", "undefined"].includes(trimmed.toLowerCase())) {
      return null;
    }

    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_REGEX.test(trimmed)) {
      throw new FolderError("folderId must be a valid UUID", 400, "VALIDATION_ERROR");
    }

    await this.assertFolderUsable(trimmed, userId, projectId);
    return trimmed;
  }
}
