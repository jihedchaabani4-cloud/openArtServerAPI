import { GenerationError } from "../errors/GenerationErrors.js";

async function safe(fn) {
    try {
        return await fn();
    } catch {
        return null;
    }
}

export async function markMediaStatus(db, media_id, status, error_message = null) {
    return safe(() => db.media.updateFields(media_id, { status, error_message }));
}

/**
 * Specifically marks a media as failed and records the error message.
 * Handles both Error objects and string messages.
 */
export async function markMediaFailed(db, media_id, error) {
    let message = "sorry famam mouchkla 7awel a fuie momment";

    if (error instanceof GenerationError) {
        message = error.getDisplayMessage();
    } else if (typeof error === 'string') {
        message = error;
    }

    // Always log the technical error to console for dev logging
    if (error?.message) {
        console.error(`[markMediaFailed] Technical Details (${media_id}):`, error.message);
    }

    return markMediaStatus(db, media_id, "failed", message);
}

/**
 * Create a brand-new workflow, then create its first media,
 * and optionally set it as primary media.
 */
export async function createWorkflowWithMedia(
    db,
    { workflowData, mediaData, setAsPrimary = true, initialStatus = null }
) {
    const workflow = await db.workflows.createWorkflow(workflowData);
    const media = await db.media.createMedia({
        ...mediaData,
        ...(initialStatus ? { status: initialStatus } : {}),
        workflow_id: workflow.id,
    });

    if (setAsPrimary) {
        await db.workflows.updatePrimaryMedia(workflow.id, media.id);
    }

    return { workflow, media };
}

/**
 * Add a new media item to an existing workflow,
 * and optionally set it as primary media.
 */
export async function appendMediaToWorkflow(
    db,
    { workflow_id, mediaData, setAsPrimary = true, initialStatus = null }
) {
    const media = await db.media.createMedia({
        ...mediaData,
        ...(initialStatus ? { status: initialStatus } : {}),
        workflow_id,
    });

    if (setAsPrimary) {
        await db.workflows.updatePrimaryMedia(workflow_id, media.id);
    }

    return media;
}
