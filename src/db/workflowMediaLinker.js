import { crudOperationLog } from "../utils/crudOperationLog.js";
import { WorkflowMediaRepository } from "./WorkflowMediaRepository.js";

let fallbackRepo = null;

async function resolveWorkflowMediaRepo(db) {
    if (db?.workflowMedia?.linkMedia) {
        return db.workflowMedia;
    }
    try {
        const container = await import("../container.js");
        if (container?.db?.workflowMedia?.linkMedia) {
            return container.db.workflowMedia;
        }
    } catch {
        // Ignore container load failures in isolated environments
    }
    if (!fallbackRepo) {
        fallbackRepo = new WorkflowMediaRepository();
    }
    return fallbackRepo;
}

/**
 * Canonical write helper that links a media record to a workflow strictly in `public.workflow_media`.
 * Never writes or updates `media.workflow_id`.
 *
 * Supports calling conventions:
 *   - createMediaInWorkflow({ workflowId, mediaId, role, stepId, workflowType, db, operation })
 *   - createMediaInWorkflow(db, { workflowId, mediaId, role, stepId, workflowType, operation })
 *   - createMediaInWorkflow(workflowId, mediaId, role, db)
 */
export async function createMediaInWorkflow(firstArg, secondArg, thirdArg, fourthArg) {
    let db = null;
    let opts = {};

    if (typeof firstArg === "string") {
        opts = {
            workflowId: firstArg,
            mediaId: secondArg,
            role: thirdArg,
        };
        db = fourthArg || null;
    } else if (secondArg && typeof secondArg === "object") {
        db = firstArg;
        opts = secondArg;
    } else if (firstArg && typeof firstArg === "object") {
        if (firstArg.workflowMedia || firstArg.media || firstArg.workflows) {
            db = firstArg;
            opts = {};
        } else {
            opts = firstArg;
            db = firstArg.db || null;
        }
    }

    const {
        workflowId,
        workflow_id,
        mediaId,
        media_id,
        stepId,
        step_id,
        role,
        workflowType,
        workflow_type,
        operation = "createMediaInWorkflow",
    } = opts;

    const resolvedWorkflowId = workflowId || workflow_id;
    const resolvedMediaId = mediaId || media_id;
    const resolvedStepId = stepId || step_id;

    if (!resolvedWorkflowId || !resolvedMediaId) {
        return null;
    }

    const workflowMediaRepo = db ? db.workflowMedia : await resolveWorkflowMediaRepo(null);
    if (!workflowMediaRepo?.linkMedia) {
        return null;
    }

    try {
        return await workflowMediaRepo.linkMedia({
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

export async function linkWorkflowMediaForCreatedRow(db, options = {}) {
    return createMediaInWorkflow(db, options);
}

