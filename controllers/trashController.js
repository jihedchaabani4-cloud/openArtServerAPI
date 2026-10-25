import { trashService } from "../src/container.js";
import { createLogger } from "../src/infrastructure/logging/index.js";
import { safePublicRouteError } from "../src/utils/safePublicRouteError.js";

const controllerLogger = createLogger("controller");

/**
 * GET /api/trash
 * Lists trashed workflows owned by the authenticated user.
 */
export async function listTrash(req, res) {
    try {
        const items = await trashService.list({ userId: req.user.id });
        return res.json({ ok: true, items });
    } catch (err) {
        controllerLogger.error({ userId: req.user?.id, err }, `listTrash error: ${err.message}`);
        const { statusCode, errorCode, publicMessage } = safePublicRouteError(err);
        return res.status(statusCode).json({ ok: false, errorCode, message: publicMessage });
    }
}

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
