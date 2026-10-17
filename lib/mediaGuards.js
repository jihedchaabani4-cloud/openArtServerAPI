/**
 * Server-side guard to ensure a media can be used as an input
 * (edit / upscale / set primary / reference in workflows context).
 *
 * Rules:
 * - Media must exist
 * - Media must be completed and have a URL
 * - If workflow_id is provided, media must belong to that workflow
 * - If project_id is provided, media must belong to that project
 * - If session_id is provided, media's workflow must belong to that session
 */
export async function assertMediaUsable({
    media_id,
    workflow_id = null,
    project_id = null,
    session_id = null,
}, options = {}) {
    const { allowProcessing = false } = options;
    const db = options.db || (await import("../src/container.js")).db;
    
    let targetMediaId = media_id;
    if (!targetMediaId && workflow_id) {
        const primary = await db.workflows.getPrimaryMedia(workflow_id);
        if (primary && primary.id) targetMediaId = primary.id;
    }

    if (!targetMediaId) {
        const err = new Error("media_id or workflow_id is required to resolve media");
        err.statusCode = 400;
        throw err;
    }

    const media = await db.media.findWithContext(targetMediaId);
    if (!media) {
        const err = new Error("Media not found");
        err.statusCode = 404;
        throw err;
    }

    const status = (media.status || "").toString().toLowerCase();
    const hasUrl = !!media.url;
    
    const isProcessing = ["processing", "pending", "uploading", "in_progress", "starting", "queued"].includes(status);
    const isRejected = ["rejected", "failed", "error"].includes(status);
    
    // We treat as completed if status aligns, or if it doesn't match an explicit pending/error state and has a URL.
    const isCompleted = (status === "completed" || status === "success") 
        || (hasUrl && !isProcessing && !isRejected);
    
    if (!isCompleted) {
        if (!(allowProcessing && isProcessing)) {
            const err = new Error("Media is not completed yet");
            err.statusCode = 403;
            throw err;
        }
    }

    if (workflow_id) {
        let isLinked = false;
        if (db?.workflowMedia?.isMediaLinkedToWorkflow) {
            isLinked = await db.workflowMedia.isMediaLinkedToWorkflow({
                workflowId: workflow_id,
                mediaId: targetMediaId,
            }).catch(() => false);
        } else if (db?.workflowMedia?.findByMedia) {
            const links = await db.workflowMedia.findByMedia(targetMediaId).catch(() => []);
            isLinked = links.some((row) => row.workflow_id === workflow_id);
        }
        if (!isLinked) {
            const err = new Error("Media does not belong to this workflow");
            err.statusCode = 403;
            throw err;
        }
    }

    if (project_id && media.project_id !== project_id) {
        const err = new Error("Media does not belong to this project");
        err.statusCode = 403;
        throw err;
    }

    const wfSessionId = media.workflow?.session_id ?? null;
    if (session_id && wfSessionId && wfSessionId !== session_id) {
        const err = new Error("Media does not belong to this session");
        err.statusCode = 403;
        throw err;
    }

    return media;
}

