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
            return res.status(500).json({ ok: false, message: "TrashService not initialized" });
        }
        const result = await trashService.restore({
            workflowId: req.params.workflowId,
            userId: req.user.id,
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
            return res.status(500).json({ ok: false, message: "TrashService not initialized" });
        }

        const result = await trashService.restoreAll({
            userId: req.user.id,
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
