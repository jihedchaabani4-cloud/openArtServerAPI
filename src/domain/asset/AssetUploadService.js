/**
 * AssetUploadService
 * Dedicated application service owning standalone asset upload orchestration.
 *
 * Owns:
 * - Standalone asset project and folder authorization & usability
 * - Resolution of existing media assets via WorkflowMediaService
 * - Delegation of raw binary ingestion to MediaUploadService.upload()
 * - Auto-creation of UPLOAD workflow containers
 * - Attachment of media and workflows via WorkflowMediaService.attachMediaItems()
 * - Rollback of empty UPLOAD workflow container on attach failure
 *
 * Public methods:
 * - uploadAsset(options)
 */

import { randomUUID } from "node:crypto";
import { SourceResolver } from "../../platform/media-ingestion/SourceResolver.js";
import { DEFAULT_UPLOAD_POLICY } from "../../platform/media-ingestion/UploadPolicy.js";
import { MediaUploadService } from "../../platform/media-ingestion/MediaUploadService.js";
import { WorkflowMediaService } from "../../platform/workflow/WorkflowMediaService.js";
import { WorkflowAuthorizationService } from "../../platform/workflow/WorkflowAuthorizationService.js";
import { MediaService } from "../../platform/media/MediaService.js";
import { crudOperationLog, CrudServiceError } from "../../utils/crudOperationLog.js";
import { calculateAspectRatio } from "../../utils/ratioUtils.js";

export class AssetUploadService {
    /**
     * @param {Object} deps
     * @param {Object} deps.db                          - Repositories (db.media, db.workflows, db.projects, db.folders, db.workflowMedia)
     * @param {Object} deps.mediaUploadService         - MediaUploadService instance (Ticket 01)
     * @param {Object} deps.workflowMediaService       - WorkflowMediaService instance (Ticket 03)
     * @param {Object} [deps.binaryIngestionService]    - Legacy BinaryIngestionService fallback
     * @param {Object} [deps.mediaIngestionService]     - Legacy fallback
     * @param {Object} [deps.workflowAuthService]       - WorkflowAuthorizationService instance
     * @param {Object} [deps.mediaService]              - Canonical MediaService instance
     * @param {Object} [deps.folderService]             - FolderService instance
     * @param {Object} [deps.storageService]            - StorageService for fallback orphan cleanup
     */
    constructor({
        db,
        mediaUploadService,
        workflowMediaService,
        binaryIngestionService = null,
        mediaIngestionService = null,
        workflowAuthService = null,
        mediaService = null,
        folderService = null,
        storageService = null,
    } = {}) {
        if (!mediaUploadService || typeof mediaUploadService.upload !== "function") {
            throw new Error("AssetUploadService requires mediaUploadService with an upload method.");
        }
        if (!workflowMediaService || typeof workflowMediaService.attachMediaItems !== "function") {
            throw new Error("AssetUploadService requires workflowMediaService with an attachMediaItems method.");
        }
        this.db = db;
        this.mediaUploadService = mediaUploadService;
        this.workflowMediaService = workflowMediaService;
        this.storageService = storageService;
        this.authService = workflowAuthService || new WorkflowAuthorizationService({ db });
        this.mediaService = mediaService || new MediaService({ db });
        this.folderService = folderService;
        this.binaryIngestionService = binaryIngestionService || mediaIngestionService;
    }

    /**
     * Orchestrates standalone asset upload, workflow container creation, and media row persistence.
     *
     * @param {Object} options
     * @param {any} options.source              - Multipart file, URL, Base64, or existing media_id
     * @param {string} options.userId           - Authenticated User ID
     * @param {string} [options.projectId]      - Target project ID
     * @param {string} [options.sessionId]      - Target session ID
     * @param {string} [options.workflowId]     - Target workflow ID to attach to
     * @param {string} [options.purpose]        - Deprecated preset; DEFAULT_UPLOAD_POLICY is enforced unconditionally
     * @param {string} [options.folder]         - Deprecated folder override; policy.storageFolder is enforced
     * @param {string} [options.displayName]    - Custom name for the asset
     * @param {string} [options.folderId]       - Folder/collection ID
     * @param {Object} [options.req]            - Express request context for bypass checks
     * @returns {Promise<Object>}
     */
    async uploadAsset(options) {
        const {
            source,
            userId,
            projectId = null,
            workflowId = null,
            stepId = null,
            folder = null,
            displayName = null,
            req = null,
            imageUrl = null,
        } = options;

        const traceId = randomUUID();
        const start = Date.now();

        crudOperationLog({ traceId, operation: "assetUpload:start", userId, purpose: "default" });

        try {
            if (!userId) {
                throw new CrudServiceError("User ID is required for asset upload.", {
                    statusCode: 401,
                    errorCode: "UNAUTHORIZED",
                    traceId,
                    operation: "assetUpload",
                });
            }

            // Project ownership verification
            if (projectId) {
                if (this.db?.projects?.findByUser) {
                    const projects = await this.db.projects.findByUser(userId, projectId);
                    if (!projects || projects.length === 0) {
                        throw new CrudServiceError(`Project ${projectId} not found`, {
                            statusCode: 404,
                            errorCode: "NOT_FOUND",
                            traceId,
                            operation: "assetUpload",
                        });
                    }
                } else if (this.db?.projects?.findById) {
                    const record = await this.db.projects.findById(projectId);
                    if (!record || record.user_id !== userId) {
                        throw new CrudServiceError(`Project ${projectId} not found`, {
                            statusCode: 404,
                            errorCode: "NOT_FOUND",
                            traceId,
                            operation: "assetUpload",
                        });
                    }
                }
            }

            // Folder validation & usability verification
            const rawFolderId = options.folderId ?? options.folder_id ?? options.collectionId ?? options.collection_id ?? null;
            let validatedFolderId = null;

            if (rawFolderId && !["none", "null", "undefined"].includes(String(rawFolderId).trim().toLowerCase())) {
                if (!projectId) {
                    throw new CrudServiceError("project_id is required when folderId is specified", {
                        statusCode: 400,
                        errorCode: "VALIDATION_ERROR",
                        traceId,
                        operation: "assetUpload",
                    });
                }
                if (this.folderService) {
                    try {
                        validatedFolderId = await this.folderService.validateAndAssertUsable(rawFolderId, userId, projectId);
                    } catch (folderErr) {
                        throw new CrudServiceError(folderErr.message, {
                            statusCode: folderErr.statusCode || (folderErr.status === 404 ? 404 : 400),
                            errorCode: folderErr.errorCode || (folderErr.statusCode === 404 ? "NOT_FOUND" : "VALIDATION_ERROR"),
                            traceId,
                            operation: "assetUpload",
                        });
                    }
                } else {
                    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                    if (typeof rawFolderId !== "string" || !rawFolderId.trim() || !UUID_REGEX.test(rawFolderId.trim())) {
                        throw new CrudServiceError("folderId must be a valid UUID or null", {
                            statusCode: 400,
                            errorCode: "VALIDATION_ERROR",
                            traceId,
                            operation: "assetUpload",
                        });
                    }
                    if (this.db?.folders?.findOwnedInProject) {
                        const folderRecord = await this.db.folders.findOwnedInProject(rawFolderId.trim(), projectId, userId);
                        if (!folderRecord) {
                            throw new CrudServiceError(`Folder ${rawFolderId} not found in project ${projectId}`, {
                                statusCode: 404,
                                errorCode: "NOT_FOUND",
                                traceId,
                                operation: "assetUpload",
                            });
                        }
                    }
                    validatedFolderId = rawFolderId.trim();
                }
            }

            const descriptor = SourceResolver.resolve(source);

            // ── Case 1: Existing Media ID (UUID) or Workflow UUID ─────────────────
            if (descriptor.kind === "media_id") {
                const assetId = descriptor.value;
                let existingMedia = null;

                if (this.workflowMediaService?.resolveOwnedSourceMedia) {
                    try {
                        existingMedia = await this.workflowMediaService.resolveOwnedSourceMedia({
                            mediaId: assetId,
                            userId,
                            projectId,
                            req,
                        });
                    } catch (resolveErr) {
                        if (options.imageUrl || descriptor.fallbackUrl) {
                            const fallbackSource = options.imageUrl || descriptor.fallbackUrl;
                            return this.uploadAsset({ ...options, source: fallbackSource });
                        }
                        throw resolveErr;
                    }
                } else {
                    existingMedia = await this.mediaService.findById(assetId);
                    if (!existingMedia) {
                        const sourceWf = await this.db.workflows.getWorkflow(assetId).catch(() => null);
                        if (sourceWf?.primary_media_id) {
                            existingMedia = await this.mediaService.findById(sourceWf.primary_media_id);
                        }
                        if (!existingMedia) {
                            const wfMedia = await this.mediaService.findByWorkflow(assetId);
                            existingMedia = wfMedia.find((m) => m.url && m.status !== "failed") || wfMedia[0] || null;
                        }
                    }

                    if (!existingMedia && (options.imageUrl || descriptor.fallbackUrl)) {
                        const fallbackSource = options.imageUrl || descriptor.fallbackUrl;
                        return this.uploadAsset({ ...options, source: fallbackSource });
                    }

                    if (!existingMedia) {
                        throw new CrudServiceError(`Media or workflow record "${assetId}" not found.`, {
                            statusCode: 404,
                            errorCode: "NOT_FOUND",
                            traceId,
                            operation: "assetUpload",
                        });
                    }

                    const isAuthorized = await this.authService.verifyMediaOwnership(existingMedia.id, userId, req);
                    if (!isAuthorized) {
                        throw new CrudServiceError("Media not found.", {
                            statusCode: 404,
                            errorCode: "NOT_FOUND",
                            traceId,
                            operation: "assetUpload",
                        });
                    }
                }

                // If a target workflowId is provided, verify ownership and attach existing media
                if (workflowId && this.workflowMediaService?.attachMediaItems) {
                    const isWfAuthorized = await this.authService.verifyWorkflowOwnership(workflowId, userId, req);
                    if (!isWfAuthorized) {
                        throw new CrudServiceError("Workflow not found.", {
                            statusCode: 404,
                            errorCode: "NOT_FOUND",
                            traceId,
                            operation: "assetUpload",
                        });
                    }
                    await this.workflowMediaService.attachMediaItems({
                        workflowId,
                        projectId,
                        userId,
                        role: "output",
                        maxAllowed: null,
                        items: [{ kind: "existing", mediaId: existingMedia.id }],
                        req,
                    });
                }

                crudOperationLog({
                    traceId,
                    operation: "assetUpload:existing",
                    status: "ok",
                    durationMs: Date.now() - start,
                    mediaId: existingMedia.id,
                });

                return {
                    media: existingMedia,
                    isNew: false,
                    mediaId: existingMedia.id,
                    workflowId: workflowId || null,
                    url: existingMedia.url,
                    type: existingMedia.url?.match(/\.(mp4|webm|mov)$/i) ? "video" : "image",
                    width: existingMedia.width || 1024,
                    height: existingMedia.height || 1024,
                    ratio: calculateAspectRatio(existingMedia.width || 1024, existingMedia.height || 1024),
                };
            }

            // ── Case 2: New Ingestion via pure binary pipeline ───────────────────
            let targetProjectId = projectId || null;

            if (!targetProjectId && !workflowId) {
                const latestProject = await this.db.projects.findMostRecentForUser(userId);
                if (!latestProject?.id) {
                    throw new CrudServiceError(
                        "project_id is required: the user has no project available for this upload.",
                        {
                            statusCode: 400,
                            errorCode: "VALIDATION_ERROR",
                            traceId,
                            operation: "assetUpload",
                        }
                    );
                }
                targetProjectId = latestProject.id;
            }

            // Perform binary upload via MediaUploadService (or legacy binaryIngestionService fallback)
            let uploadItem;
            if (this.mediaUploadService) {
                const uploadResult = await this.mediaUploadService.upload({
                    files: [source],
                    policy: DEFAULT_UPLOAD_POLICY,
                    maxFiles: 1,
                    userId,
                });
                uploadItem = uploadResult.uploaded[0];
            } else if (this.binaryIngestionService) {
                const binaryResult = await this.binaryIngestionService.ingestBinary({
                    source,
                    userId,
                    purpose: "default",
                    displayName,
                });
                uploadItem = {
                    url: binaryResult.url,
                    storageKey: binaryResult.storageKey || null,
                    mimeType: binaryResult.mimeType || (binaryResult.type === "video" ? "video/mp4" : "image/webp"),
                    size: binaryResult.sizeBytes,
                    type: binaryResult.type,
                    width: binaryResult.width,
                    height: binaryResult.height,
                    ratio: binaryResult.ratio,
                    format: binaryResult.format,
                    originalName: binaryResult.originalName || displayName,
                    inspection: binaryResult.inspection,
                };
            } else {
                throw new Error("No media upload service or binary ingestion service available");
            }

            // Ensure Workflow container exists
            let targetWorkflowId = workflowId;
            let containerWf = null;

            try {
                if (targetWorkflowId) {
                    const isWfAuthorized = await this.authService.verifyWorkflowOwnership(targetWorkflowId, userId, req);
                    if (!isWfAuthorized) {
                        throw new CrudServiceError("Workflow not found.", {
                            statusCode: 404,
                            errorCode: "NOT_FOUND",
                            traceId,
                            operation: "assetUpload",
                        });
                    }
                    if (!targetProjectId) {
                        const existingWf = await this.db.workflows.findById(targetWorkflowId, "project_id");
                        if (!existingWf?.project_id) {
                            throw new CrudServiceError("Workflow not found.", {
                                statusCode: 404,
                                errorCode: "NOT_FOUND",
                                traceId,
                                operation: "assetUpload",
                            });
                        }
                        targetProjectId = existingWf.project_id;
                    }
                } else {
                    // Auto-create an UPLOAD workflow container so workflow_media relation is linked
                    containerWf = await this.db.workflows.createWorkflow({
                        project_id: targetProjectId,
                        display_name: displayName || uploadItem.originalName || "Ingested Asset",
                        workflow_type: "UPLOAD",
                        folder_id: validatedFolderId,
                        user_id: userId,
                    });
                    targetWorkflowId = containerWf.id;
                }
            } catch (containerErr) {
                // If workflow verification or container creation failed, discard the uploaded file
                if (uploadItem.storageKey && this.mediaUploadService?.discard) {
                    await this.mediaUploadService.discard([uploadItem.storageKey]).catch(() => null);
                }
                throw containerErr;
            }

            const effectiveStepId = (stepId && !["character_detail", "character_sheet", "character_reference", "element_sheet", "element_reference"].includes(stepId))
                ? stepId
                : "upload";

            const effectiveRole = containerWf ? "original" : "output";

            try {
                let mediaRecord;
                if (this.workflowMediaService?.attachMediaItems) {
                    const attachResult = await this.workflowMediaService.attachMediaItems({
                        workflowId: targetWorkflowId,
                        projectId: targetProjectId,
                        userId,
                        role: effectiveRole,
                        maxAllowed: null,
                        items: [
                            {
                                kind: "uploaded",
                                uploadedFile: uploadItem,
                                stepId: effectiveStepId,
                            },
                        ],
                        req,
                    });
                    mediaRecord = attachResult.attached[0].media;
                } else {
                    mediaRecord = await this.mediaService.createMedia({
                        workflowId: targetWorkflowId,
                        projectId: targetProjectId,
                        generationConfigId: null,
                        stepId: effectiveStepId,
                        role: effectiveRole,
                        is_primary: Boolean(containerWf),
                        isPrimary: Boolean(containerWf),
                        workflowType: containerWf ? "UPLOAD" : undefined,
                        url: uploadItem.url,
                        width: uploadItem.width,
                        height: uploadItem.height,
                        status: "success",
                    });
                }

                crudOperationLog({
                    traceId,
                    operation: "assetUpload:success",
                    status: "ok",
                    durationMs: Date.now() - start,
                    mediaId: mediaRecord.id,
                    url: uploadItem.url,
                });

                return {
                    media: mediaRecord,
                    isNew: true,
                    mediaId: mediaRecord.id,
                    workflowId: targetWorkflowId,
                    folderId: validatedFolderId,
                    folder_id: validatedFolderId,
                    url: uploadItem.url,
                    type: uploadItem.type,
                    width: uploadItem.width,
                    height: uploadItem.height,
                    ratio: uploadItem.ratio,
                    format: uploadItem.format,
                    sizeBytes: uploadItem.size || uploadItem.sizeBytes,
                    inspection: uploadItem.inspection,
                };
            } catch (attachErr) {
                // If containerWf was created in this call, clean it up only when rollback is complete
                if (containerWf) {
                    const rollbackResult = attachErr?.rollbackResult;
                    if (rollbackResult && rollbackResult.complete === false) {
                        crudOperationLog({
                            traceId,
                            operation: "assetUpload:containerWfPreserved",
                            status: "error",
                            workflowId: containerWf.id,
                            skippedStorageKeys: rollbackResult.skippedStorageKeys || [],
                            message: "Container workflow preserved because rollback was incomplete (media row or link remains)",
                        });
                    } else {
                        try {
                            if (this.db?.workflows?.deleteById) {
                                await this.db.workflows.deleteById(containerWf.id);
                            }
                        } catch (deleteWfErr) {
                            crudOperationLog({
                                traceId,
                                operation: "assetUpload:containerCleanup",
                                status: "warning",
                                message: deleteWfErr?.message,
                            });
                        }
                    }
                }

                throw attachErr;
            }
        } catch (err) {
            crudOperationLog({
                traceId,
                operation: "assetUpload:error",
                status: "error",
                durationMs: Date.now() - start,
                errorCode: err.statusCode || 500,
                message: err.message,
            });
            throw err;
        }
    }
}

export default AssetUploadService;
