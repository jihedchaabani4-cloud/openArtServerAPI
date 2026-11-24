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
            if (db.workflowMedia?.setPrimaryMedia) {
                await db.workflowMedia.setPrimaryMedia({ workflowId: workflow.id, mediaId: media.id });
            } else if (db.workflows?.updatePrimaryMedia) {
                await db.workflows.updatePrimaryMedia(workflow.id, media.id);
            }
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
        session_id: null,
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
