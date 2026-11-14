import { AppError, createLogger } from "#shared";
import { getFolderService } from "../services/serviceAccessor.js";

const controllerLogger = createLogger("workspace:folders_controller");

/**
 * POST /api/projects/:projectId/folders
 * Creates a new folder/collection in the specified project.
 */
export const createProjectFolder = async (req, res, next) => {
  const { projectId } = req.params;
  const userId = req.user?.id;
  const { name, parentId, color, description } = req.body || {};

  controllerLogger.debug({ projectId, userId, name, parentId, color, description }, "POST /api/projects/:projectId/folders");

  const resolvedName = (name === undefined || name === null)
    ? "Untitled collection"
    : name;

  try {
    const folderService = getFolderService();
    const folder = await folderService.create({
      projectId,
      userId,
      parentId: parentId || null,
      name: resolvedName,
      color: color ?? null,
      description: description ?? null,
    });
    return res.status(201).json(folder);
  } catch (err) {
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({
        ok: false,
        errorCode: err.errorCode || "APP_ERROR",
        message: err.message,
      });
    }
    return next(err);
  }
};

/**
 * PATCH / PUT /api/folders/:folderId or /api/collections/:collectionId
 * Unified edit endpoint: updates only the fields provided in the body (name, color, description, parentId, position).
 */
export const updateFolder = async (req, res, next) => {
  const folderId = req.params.folderId || req.params.collectionId || req.params.id;
  const userId = req.user?.id;

  controllerLogger.debug({ folderId, userId, patch: req.body }, "PATCH/PUT folder/collection");

  try {
    const folderService = getFolderService();
    const folder = await folderService.update({
      folderId,
      userId,
      patch: req.body || {},
    });
    return res.status(200).json(folder);
  } catch (err) {
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({
        ok: false,
        errorCode: err.errorCode || "APP_ERROR",
        message: err.message,
      });
    }
    return next(err);
  }
};

/**
 * DELETE /api/folders/:folderId
 * Deletes the folder, its descendant folders, and workflows in that tree.
 */
export const deleteFolder = async (req, res, next) => {
  const { folderId } = req.params;
  const userId = req.user?.id;

  controllerLogger.debug({ folderId, userId }, "DELETE /api/folders/:folderId");

  try {
    const folderService = getFolderService();
    await folderService.remove({
      folderId,
      userId,
    });
    return res.status(204).send();
  } catch (err) {
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({
        ok: false,
        errorCode: err.errorCode || "APP_ERROR",
        message: err.message,
      });
    }
    return next(err);
  }
};
