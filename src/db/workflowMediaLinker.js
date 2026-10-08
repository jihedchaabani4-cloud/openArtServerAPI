import { crudOperationLog } from "../utils/crudOperationLog.js";

export async function linkWorkflowMediaForCreatedRow(
    db,
    { workflowId, workflow_id, mediaId, media_id, stepId, step_id, role, workflowType, workflow_type, operation = "linkWorkflowMedia" } = {}
) {
    const resolvedWorkflowId = workflowId || workflow_id;
    const resolvedMediaId = mediaId || media_id;
    const resolvedStepId = stepId || step_id;

    if (!resolvedWorkflowId || !resolvedMediaId || !db?.workflowMedia?.linkMedia) {
        return null;
    }

    try {
        return await db.workflowMedia.linkMedia({
            workflowId: resolvedWorkflowId,
            mediaId: resolvedMediaId,
            ...(role ? { role } : {}),
            ...(resolvedStepId ? { stepId: resolvedStepId } : {}),
            ...(workflowType || workflow_type ? { workflowType: workflowType || workflow_type } : {}),
        });
    } catch (err) {
        crudOperationLog({
            operation,
            status: "warning",
            workflowId: resolvedWorkflowId,
            mediaId: resolvedMediaId,
            message: err.message,
        });
        return null;
    }
}
