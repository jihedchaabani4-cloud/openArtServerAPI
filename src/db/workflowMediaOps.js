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
    const workflow = await db.workflows.createWorkflow(workflowData);
    const { workflow_id: _ignoredWfId, ...cleanMediaData } = mediaData || {};
    const media = await db.media.createMedia({
        ...cleanMediaData,
        ...(initialStatus ? { status: initialStatus } : {}),
    });
    await createMediaInWorkflow(db, {
        workflowId: workflow.id,
        mediaId: media?.id,
        stepId: mediaData.step_id,
        workflowType: workflowData.workflow_type,
        operation: "createWorkflowWithMedia:linkWorkflowMedia",
    });

    if (setAsPrimary) {
        await db.workflows.updatePrimaryMedia(workflow.id, media.id);
    }

    return { workflow, media };
}

/**
 * Atomically create a workflow + media placeholder inside a single PostgreSQL
 * transaction via the `create_workflow_with_placeholder_media` Supabase RPC.
 *
 * If the RPC is not yet deployed, falls back to the sequential 3-step approach.
 *
 * @param {Object} db              — the container db object
 * @param {Object} opts
 * @param {Object} opts.workflowData  — { project_id, session_id, display_name, workflow_type }
 * @param {Object} opts.mediaData     — { project_id, generation_config_id, step_id, width, height, status }
 * @returns {{ workflow: { id: string }, media: { id: string } }}
 */
export async function createWorkflowWithMediaAtomic(db, { workflowData, mediaData }) {
    try {
        const { data, error } = await supabase.rpc("create_workflow_with_placeholder_media", {
            p_project_id:           workflowData.project_id         || null,
            p_session_id:           workflowData.session_id         || null,
            p_display_name:         workflowData.display_name       || "Untitled",
            p_workflow_type:        workflowData.workflow_type       || "GENERATION",
            p_generation_config_id: mediaData.generation_config_id  || null,
            p_step_id:              mediaData.step_id                || "GEN",
        });

        if (error) {
            // RPC not deployed yet — fallback to sequential inserts
            if (
                error.code === "PGRST202" ||
                error.code === "42883"    ||
                (error.message && error.message.includes("create_workflow_with_placeholder_media"))
            ) {
                workflowMediaOpsLogger.warn(
                    { code: error.code },
                    "RPC not found; falling back to sequential workflow/media inserts"
                );
                return createWorkflowWithMedia(db, {
                    workflowData,
                    mediaData,
                    setAsPrimary: true,
                    initialStatus: mediaData.status || "processing",
                });
            }
            throw error;
        }

        await createMediaInWorkflow(db, {
            workflowId: data.workflow_id,
            mediaId: data.media_id,
            stepId: mediaData?.step_id,
            workflowType: workflowData?.workflow_type,
            operation: "createWorkflowWithMediaAtomic:linkWorkflowMedia",
        });

        // RPC returns { workflow_id, media_id } as JSONB
        return {
            workflow: { id: data.workflow_id },
            media:    { id: data.media_id },
        };
    } catch (err) {
        // If anything unexpected happens at network level, fall back
        workflowMediaOpsLogger.warn(
            { message: err.message },
            "RPC error; falling back to sequential workflow/media inserts"
        );
        return createWorkflowWithMedia(db, {
            workflowData,
            mediaData,
            setAsPrimary: true,
            initialStatus: mediaData.status || "processing",
        });
    }
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
