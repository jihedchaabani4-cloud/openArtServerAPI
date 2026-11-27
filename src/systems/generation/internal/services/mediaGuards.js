/**
 * Server-side guard to ensure a media can be used as an input
 * (edit / upscale / set primary / reference in workflows context).
 *
 * Rules:
 * - Media must exist
 * - Media must be completed and have a URL
 * - If workflow_id is provided, media must belong to that workflow
 * - If project_id is provided, media must belong to that project
 */
import { inferMediaType, normalizeAllowedMediaTypes } from "#shared";
import { getGenerationServices } from "./serviceAccessor.js";
import { GenerationError, GenerationValidationError, GenerationNotFoundError } from "../errors.js";

export function assertAllowedMediaType(mediaInfo, allowedMediaTypes, resourceId = null) {
    const allowedSet =
        allowedMediaTypes instanceof Set ? allowedMediaTypes : normalizeAllowedMediaTypes(allowedMediaTypes);
    if (!allowedSet) return;
    const info = typeof mediaInfo === "string" ? { url: mediaInfo } : (mediaInfo || {});
    const detectedType = inferMediaType(info);
    if (!allowedSet.has(detectedType)) {
        const allowedList = [...allowedSet].join(", ");
        throw new GenerationError({
            code: "UNSUPPORTED_MEDIA_TYPE",
            message: `Unsupported media type "${detectedType}"${resourceId ? ` for resource "${resourceId}"` : ""}. Allowed media types: ${allowedList}.`,
            userMessage: `This workflow only supports ${allowedList} media.`,
            status: 400,
            statusCode: 400,
            category: "USER_FAULT",
            retryable: false,
            billingAction: "REFUND_HOLD",
            isInternal: false,
            context: {
                detectedType,
                allowedMediaTypes: [...allowedSet],
                ...(resourceId ? { resourceId } : {}),
                ...(typeof info.url === "string" && info.url.trim() ? { url: info.url.trim() } : {}),
            },
        });
    }
}

export async function assertMediaUsable({
    media_id,
    workflow_id = null,
    project_id = null,
}, options = {}) {
    const { allowProcessing = false } = options;
    const db = options.db || getGenerationServices().db;
    if (!db) {
        throw new GenerationError(
            "GENERATION_CONFIGURATION_ERROR",
            "Database repository map is required for assertMediaUsable",
            { statusCode: 500 }
        );
    }

    let targetMediaId = media_id;
    if (!targetMediaId && workflow_id) {
        const primary = await db.workflows.getPrimaryMedia(workflow_id);
        if (primary && primary.id) targetMediaId = primary.id;
    }

    if (!targetMediaId) {
        throw new GenerationValidationError("media_id or workflow_id is required to resolve media");
    }

    const media = await db.media.findWithContext(targetMediaId);
    if (!media) {
        throw new GenerationNotFoundError("Media not found", { resourceId: targetMediaId });
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
            throw new GenerationError("MEDIA_NOT_COMPLETED", "Media is not completed yet", {
                statusCode: 403,
                category: "USER_FAULT",
            });
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
            throw new GenerationError("MEDIA_WORKFLOW_MISMATCH", "Media does not belong to this workflow", {
                statusCode: 403,
                category: "USER_FAULT",
            });
        }
    }

    if (project_id && media.project_id !== project_id) {
        throw new GenerationError("MEDIA_PROJECT_MISMATCH", "Media does not belong to this project", {
            statusCode: 403,
            category: "USER_FAULT",
        });
    }

    return media;
}
