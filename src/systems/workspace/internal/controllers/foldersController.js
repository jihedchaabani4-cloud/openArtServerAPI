import { createLogger, safePublicRouteError } from "#shared";
import { getFolderService } from "../services/serviceAccessor.js";

const controllerLogger = createLogger("workspace:folders_controller");

function handleFolderError(res, err, operation) {
  const { statusCode, errorCode, publicMessage } = safePublicRouteError(err);
  if (statusCode >= 500) {
    controllerLogger.error(
      { event: `folders_controller.${operation}_error`, err: err?.message || String(err), statusCode },
      "Folder controller internal error"
    );
  }
  return res.status(statusCode).json({
    ok: false,
    errorCode,
    message: publicMessage,
  });
}

/**
 * POST /api/projects/:projectId/folders
 * Creates a new folder/collection in the specified project.
 */
export const createProjectFolder = async (req, res) => {
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
    return handleFolderError(res, err, "createProjectFolder");
  }
};

/**
 * PATCH / PUT /api/folders/:folderId or /api/collections/:collectionId
 * Unified edit endpoint: updates only the fields provided in the body (name, color, description, parentId, position).
 */
export const updateFolder = async (req, res) => {
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
    return handleFolderError(res, err, "updateFolder");
  }
};

/**
 * DELETE /api/folders/:folderId
 * Permanently deletes the folder and its descendant subfolders after moving
 * all contained workflows to Trash and unlinking them to the project root.
 */
export const deleteFolder = async (req, res) => {
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
    return handleFolderError(res, err, "deleteFolder");
  }
};
