import { supabase, supabaseAdmin } from "./mediaClient.js";
import { createLogger } from "#shared";
import { createMediaInWorkflow, linkWorkflowMediaForCreatedRow } from "./workflowMediaLinker.js";
import { inferWorkflowMediaRole } from "./workflowMediaRole.js";

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

    if (error && typeof error.getDisplayMessage === "function") {
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
        if (db.workflowMedia?.setPrimaryMedia) {
            await db.workflowMedia.setPrimaryMedia({ workflowId: workflow_id, mediaId: media.id });
        } else if (db.workflows?.updatePrimaryMedia) {
            await db.workflows.updatePrimaryMedia(workflow_id, media.id);
        }
    }

    return media;
}

/**
 * Collapses generation intake placeholder creation (project ownership check + workflow insert +
 * placeholder media insert with generation_config + workflow_media primary link) into a single
 * atomic SQL RPC (`create_generation_placeholder_atomic`).
 *
 * Safely falls back to the multi-step `db` repository calls when:
 *   - plain mock `db` objects or monkey-patched repository methods are injected in unit tests, OR
 *   - the RPC is not yet present in PostgREST schema cache (PGRST202).
 *
 * @param {Object} db
 * @param {Object} params
 * @returns {Promise<{ workflowId: string, mediaId: string, role?: string, atomic: boolean }>}
 */
export async function createGenerationPlaceholderAtomic(
    db,
    {
        workflowId,
        mediaId,
        projectId,
        userId,
        displayName,
        workflowType = "GENERATION",
        folderId = null,
        stepId = "GEN",
        width = 1024,
        height = 1024,
        role = null,
        generationConfig = null,
        operation = "createGenerationPlaceholderAtomic:linkWorkflowMedia",
        rpcClient = null,
    }
) {
    const resolvedRole = inferWorkflowMediaRole({ role, stepId, workflowType });
    const resolvedWidth = Number(width) > 0 ? Number(width) : 1024;
    const resolvedHeight = Number(height) > 0 ? Number(height) : 1024;

    const hasMockedRepos = Boolean(
        (db?.workflows && (
            Object.prototype.hasOwnProperty.call(db.workflows, "createWorkflow") ||
            Object.getPrototypeOf(db.workflows) === Object.prototype
        )) ||
        (db?.media && (
            Object.prototype.hasOwnProperty.call(db.media, "createMedia") ||
            Object.getPrototypeOf(db.media) === Object.prototype
        ))
    );

    const client =
        rpcClient ||
        (typeof db?.rpc === "function" ? db : null) ||
        (!hasMockedRepos ? (supabaseAdmin || supabase) : null);

    if (client && typeof client.rpc === "function") {
        const { data, error } = await client.rpc("create_generation_placeholder_atomic", {
            p_project_id: projectId,
            p_user_id: userId,
            p_display_name: displayName || "Untitled Workflow",
            p_workflow_type: workflowType,
            p_folder_id: folderId ?? null,
            p_step_id: stepId,
            p_width: resolvedWidth,
            p_height: resolvedHeight,
            p_role: resolvedRole,
            p_generation_config: generationConfig ?? null,
            p_workflow_id: workflowId || null,
            p_media_id: mediaId || null,
        });

        if (!error && data?.workflow_id && data?.media_id) {
            return {
                workflowId: data.workflow_id,
                mediaId: data.media_id,
                role: data.role || resolvedRole,
                atomic: true,
            };
        }

        const isMissingRpc = Boolean(
            error && (error.code === "PGRST202" || String(error.message || "").toLowerCase().includes("schema cache"))
        );

        if (error && !isMissingRpc) {
            throw error;
        }

        if (isMissingRpc) {
            workflowMediaOpsLogger.warn(
                { rpc: "create_generation_placeholder_atomic", err: error.message },
                "RPC create_generation_placeholder_atomic not found in schema cache, falling back to multi-step persistence"
            );
        }
    }

    // Multi-step fallback (for injected mock db objects in tests or pre-migration environments)
    await db.workflows.createWorkflow({
        id: workflowId,
        project_id: projectId,
        display_name: displayName,
        workflow_type: workflowType,
        folder_id: folderId,
        user_id: userId,
    });

    await db.media.createMedia({
        id: mediaId,
        project_id: projectId,
        step_id: stepId,
        url: null,
        width,
        height,
        status: "processing",
        generation_config: generationConfig,
    });

    await createMediaInWorkflow(db, {
        workflowId,
        mediaId,
        stepId,
        workflowType,
        ...(role ? { role } : {}),
        operation,
    });

    return {
        workflowId,
        mediaId,
        role: resolvedRole,
        atomic: false,
    };
}
