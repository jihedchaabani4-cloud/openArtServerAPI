import { createLogger, safePublicRouteError } from "#shared";
import { getTrashService } from "../services/serviceAccessor.js";

const controllerLogger = createLogger("workspace:trash_controller");

/**
 * POST /api/trash/:workflowId/restore
 * Restores a workflow from the authenticated user's Trash.
 */
export async function restoreWorkflow(req, res) {
    try {
        const trashService = getTrashService();
        if (!trashService) {
            controllerLogger.error({ event: "trash_controller.restoreWorkflow_uninitialized" }, "TrashService not initialized");
            return res.status(500).json({ ok: false, errorCode: "INTERNAL_ERROR", message: "Internal server error" });
        }
        const result = await trashService.restore({
            workflowId: req.params.workflowId,
            userId: req.user?.id,
        });
        return res.json({ ok: true, workflow_id: result.workflow_id, restored: true });
    } catch (err) {
        controllerLogger.error({ workflowId: req.params?.workflowId, err }, `restoreWorkflow error: ${err.message}`);
        const { statusCode, errorCode, publicMessage } = safePublicRouteError(err);
        return res.status(statusCode).json({ ok: false, errorCode, message: publicMessage });
    }
}

/**
 * POST /api/trash/restore-all
 * Restores all workflows from the authenticated user's Trash, optionally scoped to a project.
 */
export async function restoreAllWorkflows(req, res) {
    try {
        const projectId = req.body?.project_id || req.body?.projectId || req.query?.project_id || req.query?.projectId || null;
        const workflowIds = req.body?.workflow_ids || req.body?.workflowIds || null;

        const trashService = getTrashService();
        if (!trashService) {
            controllerLogger.error({ event: "trash_controller.restoreAllWorkflows_uninitialized" }, "TrashService not initialized");
            return res.status(500).json({ ok: false, errorCode: "INTERNAL_ERROR", message: "Internal server error" });
        }

        const result = await trashService.restoreAll({
            userId: req.user?.id,
            projectId,
            workflowIds,
        });

        return res.json({
            ok: true,
            restored: true,
            count: result.count,
            workflow_ids: result.workflow_ids,
        });
    } catch (err) {
        controllerLogger.error({ projectId: req.body?.project_id, err }, `restoreAllWorkflows error: ${err.message}`);
        const { statusCode, errorCode, publicMessage } = safePublicRouteError(err);
        return res.status(statusCode).json({ ok: false, errorCode, message: publicMessage });
    }
}

/**
 * POST /api/workspace/bulk-delete
 * Unified explicit Move-to-Trash bulk delete for folders, workflows, characters, and elements.
 */
export async function bulkDeleteWorkspace(req, res) {
    try {
        const trashService = getTrashService();
        if (!trashService) {
            controllerLogger.error({ event: "trash_controller.bulkDeleteWorkspace_uninitialized" }, "TrashService not initialized");
            return res.status(500).json({ ok: false, errorCode: "INTERNAL_ERROR", message: "Internal server error" });
        }

        const body = req.body && typeof req.body === "object" ? req.body : {};
        const result = await trashService.bulkDeleteWorkspace({
            userId: req.user?.id,
            folder_ids: body.folder_ids,
            folderIds: body.folderIds,
            workflow_ids: body.workflow_ids,
            workflowIds: body.workflowIds,
            character_ids: body.character_ids,
            characterIds: body.characterIds,
            element_ids: body.element_ids,
            elementIds: body.elementIds,
        });

        return res.status(200).json(result);
    } catch (err) {
        controllerLogger.error({ userId: req.user?.id, err }, `bulkDeleteWorkspace error: ${err.message}`);
        const { statusCode, errorCode, publicMessage } = safePublicRouteError(err);
        return res.status(statusCode).json({ ok: false, errorCode, message: publicMessage });
    }
}

/**
 * POST /api/trash/delete
 * Explicit permanent bulk delete for selected trashed workflows or Empty Trash ({ all: true, project_id? }).
 */
export async function deleteTrashed(req, res) {
    try {
        const trashService = getTrashService();
        if (!trashService) {
            controllerLogger.error({ event: "trash_controller.deleteTrashed_uninitialized" }, "TrashService not initialized");
            return res.status(500).json({ ok: false, errorCode: "INTERNAL_ERROR", message: "Internal server error" });
        }

        const body = req.body && typeof req.body === "object" ? req.body : {};
        const result = await trashService.deleteTrashed({
            userId: req.user?.id,
            workflow_ids: body.workflow_ids,
            workflowIds: body.workflowIds,
            folder_ids: body.folder_ids,
            folderIds: body.folderIds,
            all: body.all,
            project_id: body.project_id,
            projectId: body.projectId,
        });

        return res.status(200).json(result);
    } catch (err) {
        controllerLogger.error({ userId: req.user?.id, err }, `deleteTrashed error: ${err.message}`);
        const { statusCode, errorCode, publicMessage } = safePublicRouteError(err);
        return res.status(statusCode).json({ ok: false, errorCode, message: publicMessage });
    }
}
