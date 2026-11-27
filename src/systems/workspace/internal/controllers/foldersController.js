import { AppError, createLogger } from "#shared";
import { getFolderService } from "../services/serviceAccessor.js";

const controllerLogger = createLogger("workspace:folders_controller");

function handleFolderError(res, err, next) {
  if (err instanceof AppError && err.statusCode < 500) {
    return res.status(err.statusCode).json({
      ok: false,
      errorCode: err.errorCode || "APP_ERROR",
      message: err.message,
    });
  }
  if (err instanceof AppError) {
    controllerLogger.error({ err: err.message, statusCode: err.statusCode }, "Folder controller internal error");
    return res.status(500).json({ ok: false, errorCode: "INTERNAL_ERROR", message: "Internal server error" });
  }
  return next(err);
}

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
    return handleFolderError(res, err, next);
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
    return handleFolderError(res, err, next);
  }
};

/**
 * DELETE /api/folders/:folderId
 * Permanently deletes the folder and its descendant subfolders after moving
 * all contained workflows to Trash and unlinking them to the project root.
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
    return handleFolderError(res, err, next);
  }
};
