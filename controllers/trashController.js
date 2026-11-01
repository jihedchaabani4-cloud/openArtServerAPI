import { trashService } from "../src/container.js";
import { createLogger } from "../src/infrastructure/logging/index.js";
import { safePublicRouteError } from "../src/utils/safePublicRouteError.js";

const controllerLogger = createLogger("controller");

/**
 * POST /api/trash/:workflowId/restore
 * Restores a workflow from the authenticated user's Trash.
 */
export async function restoreWorkflow(req, res) {
    try {
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
