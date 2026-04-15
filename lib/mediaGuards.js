import { db } from "../src/container.js";

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
    
    if (!media_id) {
        const err = new Error("media_id is required");
        err.statusCode = 400;
        throw err;
    }

    const media = await db.media.findWithContext(media_id);
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

    if (workflow_id && media.workflow_id !== workflow_id) {
        const err = new Error("Media does not belong to this workflow");
        err.statusCode = 403;
        throw err;
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

