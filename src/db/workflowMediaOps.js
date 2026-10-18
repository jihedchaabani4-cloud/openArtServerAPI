import { GenerationError } from "../errors/GenerationErrors.js";
import { supabase } from "../../lib/supabase.js";
import { createLogger } from "../infrastructure/logging/index.js";
import { createMediaInWorkflow, linkWorkflowMediaForCreatedRow } from "./workflowMediaLinker.js";

export { createMediaInWorkflow, linkWorkflowMediaForCreatedRow };

const workflowMediaOpsLogger = createLogger("workflow-media-ops");

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

    if (error?.message) {
        workflowMediaOpsLogger.error({ mediaId: media_id, message: error.message }, "markMediaFailed technical details");
    }

    return markMediaStatus(db, media_id, "failed", message);
}

/**
 * Create a brand-new workflow, then create its first media,
 * and optionally set it as primary media.
 * ⚠️  Three separate DB calls — not atomic. Prefer createWorkflowWithMediaAtomic.
 */
export async function createWorkflowWithMedia(
    db,
    { workflowData, mediaData, setAsPrimary = true, initialStatus = null }
) {
    let workflow = null;
    let media = null;
    try {
        workflow = await db.workflows.createWorkflow(workflowData);
        const { workflow_id: _ignoredWfId, ...cleanMediaData } = mediaData || {};
        media = await db.media.createMedia({
            ...cleanMediaData,
            ...(initialStatus ? { status: initialStatus } : {}),
        });
        const linkRes = await createMediaInWorkflow(db, {
            workflowId: workflow.id,
            mediaId: media?.id,
            stepId: mediaData?.step_id,
            workflowType: workflowData?.workflow_type,
            operation: "createWorkflowWithMedia:linkWorkflowMedia",
        });

        if (!linkRes && media?.id) {
            throw new Error("Failed to link media to workflow in workflow_media");
        }

        if (setAsPrimary && media?.id) {
            await db.workflows.updatePrimaryMedia(workflow.id, media.id);
        }

        return { workflow, media };
    } catch (err) {
        // Compensating rollback for atomicity
        if (media?.id && db.media?.deleteMedia) {
            try { await db.media.deleteMedia(media.id); } catch (_) {}
        }
        if (workflow?.id && db.workflows?.deleteWorkflow) {
            try { await db.workflows.deleteWorkflow(workflow.id); } catch (_) {}
        }
        throw err;
    }
}

/**
 * Atomically create a workflow + media placeholder in the backend code.
 *
 * Implements the atomic creation pattern purely in the backend application,
 * eliminating runtime dependency on live Supabase RPC drift, while providing
 * automatic compensating rollback if media creation or workflow_media link fails.
 *
 * @param {Object} db              — the container db object
 * @param {Object} opts
 * @param {Object} opts.workflowData  — { project_id, session_id, display_name, workflow_type }
 * @param {Object} opts.mediaData     — { project_id, generation_config_id, step_id, width, height, status }
 * @returns {{ workflow: { id: string }, media: { id: string } }}
 */
export async function createWorkflowWithMediaAtomic(db, { workflowData, mediaData }) {
    // If the db container provides repository methods, execute directly in backend code
    if (db?.workflows?.createWorkflow && db?.media?.createMedia) {
        return createWorkflowWithMedia(db, {
            workflowData,
            mediaData,
            setAsPrimary: true,
            initialStatus: mediaData?.status || "processing",
        });
    }

    // Compatibility fallback for environments or test mocks providing only supabase.rpc
    if (typeof supabase?.rpc === "function") {
        try {
            const { data, error } = await supabase.rpc("create_workflow_with_placeholder_media", {
                p_project_id:           workflowData.project_id         || null,
                p_session_id:           workflowData.session_id         || null,
                p_display_name:         workflowData.display_name       || "Untitled",
                p_workflow_type:        workflowData.workflow_type       || "GENERATION",
                p_generation_config_id: mediaData.generation_config_id  || null,
                p_step_id:              mediaData.step_id                || "GEN",
            });

            if (!error && data?.workflow_id && data?.media_id) {
                await createMediaInWorkflow(db, {
                    workflowId: data.workflow_id,
                    mediaId: data.media_id,
                    stepId: mediaData?.step_id,
                    workflowType: workflowData?.workflow_type,
                    operation: "createWorkflowWithMediaAtomic:linkWorkflowMedia",
                });

                return {
                    workflow: { id: data.workflow_id },
                    media:    { id: data.media_id },
                };
            }
        } catch (_) {
            // Fall back to backend creation
        }
    }

    return createWorkflowWithMedia(db, {
        workflowData,
        mediaData,
        setAsPrimary: true,
        initialStatus: mediaData?.status || "processing",
    });
}

/**
 * Add a new media item to an existing workflow,
 * and optionally set it as primary media.
 */
export async function appendMediaToWorkflow(
    db,
    { workflow_id, mediaData, setAsPrimary = true, initialStatus = null }
) {
    const { workflow_id: _ignoredWfId, ...cleanMediaData } = mediaData || {};
    const media = await db.media.createMedia({
        ...cleanMediaData,
        ...(initialStatus ? { status: initialStatus } : {}),
    });
    await createMediaInWorkflow(db, {
        workflowId: workflow_id,
        mediaId: media?.id,
        stepId: mediaData.step_id,
        operation: "appendMediaToWorkflow:linkWorkflowMedia",
    });

    if (setAsPrimary) {
        await db.workflows.updatePrimaryMedia(workflow_id, media.id);
    }

    return media;
}
