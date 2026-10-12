import { folderService } from "../src/container.js";
import { AppError } from "../src/utils/AppError.js";
import { createLogger } from "../src/infrastructure/logging/index.js";

const controllerLogger = createLogger("controller");

/**
 * GET /api/projects/:projectId/folders
 * Returns flat list of project folders with asset counts, ordered by position then name.
 */
export const listProjectFolders = async (req, res, next) => {
  const { projectId } = req.params;
  const userId = req.user?.id;

  controllerLogger.debug({ projectId, userId }, "GET /api/projects/:projectId/folders");

  try {
    const result = await folderService.list({ projectId, userId });
    return res.status(200).json(result);
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
 * POST /api/projects/:projectId/folders
 * Creates a new folder in the specified project.
 */
export const createProjectFolder = async (req, res, next) => {
  const { projectId } = req.params;
  const userId = req.user?.id;
  const { name, parentId } = req.body || {};

  controllerLogger.debug({ projectId, userId, name, parentId }, "POST /api/projects/:projectId/folders");

  try {
    const folder = await folderService.create({
      projectId,
      userId,
      parentId: parentId || null,
      name,
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
 * PATCH /api/folders/:folderId
 * Renames, moves, or reorders an existing folder.
 */
export const updateFolder = async (req, res, next) => {
  const { folderId } = req.params;
  const userId = req.user?.id;

  controllerLogger.debug({ folderId, userId, patch: req.body }, "PATCH /api/folders/:folderId");

  try {
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
