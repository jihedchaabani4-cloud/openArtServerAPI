/**
 * MediaIngestionService
 * Canonical Platform Orchestrator for Media Ingestion.
 * Implements: RAW SOURCE -> INGEST ONCE -> CANONICAL MEDIA -> USE MEDIA EVERYWHERE.
 *
 * Owns:
 * - Ingestion of raw sources (Buffer, Base64, URL, existing media)
 * - Media inspection, optimization (WebP), and storage upload
 * - Workflow container creation & attachment
 * - Project and folder usability validation for uploaded media
 *
 * Public methods:
 * - ingest(options)
 */

import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { SourceResolver } from "./SourceResolver.js";
import { SourcePolicy } from "./SourcePolicy.js";
import { SourceReader } from "./SourceReader.js";
import { MediaInspector } from "./MediaInspector.js";
import { WorkflowAuthorizationService } from "../workflow/WorkflowAuthorizationService.js";
import { MediaService } from "../media/MediaService.js";
import { crudOperationLog, CrudServiceError } from "../../utils/crudOperationLog.js";
import { calculateAspectRatio } from "../../utils/ratioUtils.js";

export class MediaIngestionService {
    /**
     * @param {Object} deps
     * @param {Object} deps.db                  - Repositories (db.media, db.workflows, db.projects)
     * @param {Object} deps.storageService       - StorageService instance
     * @param {Object} [deps.workflowAuthService] - WorkflowAuthorizationService instance
     * @param {Object} [deps.mediaService]       - Canonical MediaService instance
     * @param {Object} [deps.folderService]      - FolderService instance
     */
    constructor({ db, storageService, workflowAuthService = null, mediaService = null, folderService = null }) {
        this.db = db;
        this.storageService = storageService;
        this.authService = workflowAuthService || new WorkflowAuthorizationService({ db });
        this.mediaService = mediaService || new MediaService({ db });
        this.folderService = folderService;
    }

    _extFromMime(mime = "") {
        const map = {
            "image/jpeg": "jpg",
            "image/png": "png",
            "image/webp": "webp",
            "image/gif": "gif",
            "image/avif": "avif",
            "video/mp4": "mp4",
            "video/webm": "webm",
            "video/quicktime": "mov",
        };
        return map[mime] || "bin";
    }

    /**
     * Ingests any external source and returns a canonical Media record.
     *
     * @param {Object} params
     * @param {any} params.source              - Multipart file, URL, Base64, or existing media_id
     * @param {string} params.userId           - Authenticated User ID
     * @param {string} [params.projectId]      - Target project ID
     * @param {string} [params.sessionId]      - Target session ID
     * @param {string} [params.workflowId]     - Target workflow ID to attach to
     * @param {string} [params.purpose]        - Policy preset: "default" | "avatar" | "character_reference" | "video_reference"
     * @param {string} [params.folder]         - Storage folder override
     * @param {string} [params.displayName]    - Custom name for the asset
     * @param {Object} [params.req]            - Express request context for bypass checks
     * @returns {Promise<{
     *   media: Object,
     *   isNew: boolean,
     *   mediaId: string,
     *   url: string,
     *   type: "image" | "video",
     *   width: number,
     *   height: number,
     *   ratio: string,
     *   inspection?: Object
     * }>}
     */
    async ingest(options) {
        const {
            source,
            userId,
            projectId = null,
            workflowId = null,
            purpose = "default",
            stepId = null,
            folder = null,
            displayName = null,
            skipMediaCreate = false,
            req = null,
            imageUrl = null,
        } = options;
        const traceId = randomUUID();
        const start = Date.now();

        crudOperationLog({ traceId, operation: "mediaIngest:start", userId, purpose });

        try {
            if (!userId) {
                throw new CrudServiceError("User ID is required for media ingestion.", {
                    statusCode: 401,
                    errorCode: "UNAUTHORIZED",
                    traceId,
                    operation: "mediaIngest",
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
                            operation: "mediaIngest",
                        });
                    }
                } else if (this.db?.projects?.findById) {
                    const record = await this.db.projects.findById(projectId);
                    if (!record || record.user_id !== userId) {
                        throw new CrudServiceError(`Project ${projectId} not found`, {
                            statusCode: 404,
                            errorCode: "NOT_FOUND",
                            traceId,
                            operation: "mediaIngest",
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
                        operation: "mediaIngest",
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
                            operation: "mediaIngest",
                        });
                    }
                } else {
                    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                    if (typeof rawFolderId !== "string" || !rawFolderId.trim() || !UUID_REGEX.test(rawFolderId.trim())) {
                        throw new CrudServiceError("folderId must be a valid UUID or null", {
                            statusCode: 400,
                            errorCode: "VALIDATION_ERROR",
                            traceId,
                            operation: "mediaIngest",
                        });
                    }
                    if (this.db?.folders?.findOwnedInProject) {
                        const folder = await this.db.folders.findOwnedInProject(rawFolderId.trim(), projectId, userId);
                        if (!folder) {
                            throw new CrudServiceError(`Folder ${rawFolderId} not found in project ${projectId}`, {
                                statusCode: 404,
                                errorCode: "NOT_FOUND",
                                traceId,
                                operation: "mediaIngest",
                            });
                        }
                    }
                    validatedFolderId = rawFolderId.trim();
                }
            }

            // 1. Resolve source format
            const descriptor = SourceResolver.resolve(source);

            // ── Case 1: Existing Media ID (UUID) or Workflow UUID ─────────────────
            if (descriptor.kind === "media_id") {
                const assetId = descriptor.value;

                // 1. Resolve media record: try direct media table first
                let existingMedia = await this.mediaService.findById(assetId);

                // 2. If not found in media table, assetId might be a workflow ID
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

                // 3. Fallback: if not found by UUID but caller provided imageUrl/fallbackUrl
                if (!existingMedia && (options.imageUrl || descriptor.fallbackUrl)) {
                    const fallbackSource = options.imageUrl || descriptor.fallbackUrl;
                    return this.ingest({ ...options, source: fallbackSource });
                }

                if (!existingMedia) {
                    throw new CrudServiceError(`Media or workflow record "${assetId}" not found.`, {
                        statusCode: 404,
                        errorCode: "NOT_FOUND",
                        traceId,
                        operation: "mediaIngest",
                    });
                }

                const isAuthorized = await this.authService.verifyMediaOwnership(existingMedia.id, userId, req);
                if (!isAuthorized) {
                    crudOperationLog({
                        traceId,
                        operation: "mediaIngest",
                        status: "error",
                        userId,
                        resourceId: existingMedia.id,
                        resourceType: "media",
                        errorCode: "NOT_FOUND",
                        message: "Media not found.",
                    });
                    throw new CrudServiceError("Media not found.", {
                        statusCode: 404,
                        errorCode: "NOT_FOUND",
                        traceId,
                        operation: "mediaIngest",
                    });
                }

                crudOperationLog({
                    traceId,
                    operation: "mediaIngest:existing",
                    status: "ok",
                    durationMs: Date.now() - start,
                    mediaId: existingMedia.id,
                });

                return {
                    media: existingMedia,
                    isNew: false,
                    mediaId: existingMedia.id,
                    url: existingMedia.url,
                    type: existingMedia.url?.match(/\.(mp4|webm|mov)$/i) ? "video" : "image",
                    width: existingMedia.width || 1024,
                    height: existingMedia.height || 1024,
                    ratio: calculateAspectRatio(existingMedia.width || 1024, existingMedia.height || 1024),
                };
            }

            // ── Case 2: New Ingestion (File / Base64 / URL) ────────────────────────
            const profile = SourcePolicy.getProfile(purpose);

            // 2. Read content safely (enforcing streaming byte limits & SSRF checks)
            const { buffer, originalName, mimeHint } = await SourceReader.read(descriptor, profile);

            // 3. Inspect content deeply (magic bytes, true MIME, dimensions, duration)
            const inspection = await MediaInspector.inspect(buffer, mimeHint);

            // 4. Validate inspected metadata against policy constraints
            SourcePolicy.validateMetadata(inspection, profile);

            // 4.1 Optimize oversized (4K+) images for ultra-fast, smooth web rendering
            let uploadBuffer = buffer;
            let uploadMime = inspection.detectedMime;
            let finalWidth = inspection.width;
            let finalHeight = inspection.height;
            let finalSizeBytes = inspection.sizeBytes;
            let finalRatio = inspection.ratio;

            if (inspection.type === "image" && (inspection.width > 2048 || inspection.height > 2048)) {
                try {
                    const optimized = await sharp(buffer)
                        .rotate()
                        .resize({
                            width: 2048,
                            height: 2048,
                            fit: "inside",
                            withoutEnlargement: true,
                        })
                        .webp({ quality: 85 })
                        .toBuffer({ resolveWithObject: true });

                    uploadBuffer = optimized.data;
                    uploadMime = "image/webp";
                    finalWidth = optimized.info.width;
                    finalHeight = optimized.info.height;
                    finalSizeBytes = optimized.data.length;
                    finalRatio = calculateAspectRatio(finalWidth, finalHeight);
                } catch (optErr) {
                    crudOperationLog({
                        traceId,
                        operation: "mediaIngest:optimize4k",
                        status: "warning",
                        message: optErr?.message,
                    });
                }
            }

            // 5. Generate storage path and upload
            const ext = this._extFromMime(uploadMime);
            const targetFolder = folder || (inspection.type === "video" ? "video_uploads" : "uploads");
            const filename = `${Date.now()}_${randomUUID().substring(0, 8)}.${ext}`;
            const storagePath = this.storageService.paths.projectAsset(userId, targetFolder, filename);

            const publicUrl = await this.storageService.upload(storagePath, uploadBuffer, {
                contentType: uploadMime,
            });

            // If caller manages DB records (e.g. CharacterMediaService), return uploaded asset directly
            // No workflow, no media row, and NO session created!
            if (skipMediaCreate) {
                crudOperationLog({
                    traceId,
                    operation: "mediaIngest:uploadedOnly",
                    status: "ok",
                    durationMs: Date.now() - start,
                    url: publicUrl,
                });

                return {
                    media: null,
                    isNew: true,
                    mediaId: null,
                    workflowId,
                    url: publicUrl,
                    type: inspection.type,
                    width: finalWidth,
                    height: finalHeight,
                    ratio: finalRatio,
                    format: uploadMime.split("/")[1]?.toUpperCase() || inspection.format,
                    sizeBytes: finalSizeBytes,
                    inspection,
                };
            }

            // 6. Ensure Workflow container exists
            let targetWorkflowId = workflowId;
            let targetProjectId = projectId;
            let containerWf = null;

            if (targetWorkflowId) {
                const isWfAuthorized = await this.authService.verifyWorkflowOwnership(targetWorkflowId, userId, req);
                if (!isWfAuthorized) {
                    crudOperationLog({
                        traceId,
                        operation: "mediaIngest",
                        status: "error",
                        userId,
                        resourceId: targetWorkflowId,
                        resourceType: "workflow",
                        errorCode: "NOT_FOUND",
                        message: "Workflow not found.",
                    });
                    throw new CrudServiceError("Workflow not found.", {
                        statusCode: 404,
                        errorCode: "NOT_FOUND",
                        traceId,
                        operation: "mediaIngest",
                    });
                }
                if (!targetProjectId) {
                    const existingWf = await this.db.workflows.findById(targetWorkflowId, "project_id").catch(() => null);
                    if (existingWf?.project_id) targetProjectId = existingWf.project_id;
                }
            } else {
                if (!targetProjectId) {
                    const { data: userProj } = await this.db.projects.client()
                        .from("project")
                        .select("id")
                        .eq("user_id", userId)
                        .order("create_time", { ascending: false })
                        .limit(1)
                        .maybeSingle();
                    targetProjectId = userProj?.id || null;
                }

                // Auto-create an UPLOAD workflow container so workflow_media relation is linked
                containerWf = await this.db.workflows.createWorkflow({
                    project_id: targetProjectId,
                    session_id: null,
                    display_name: displayName || originalName || "Ingested Asset",
                    workflow_type: "UPLOAD",
                    variation_index: null,
                    folder_id: validatedFolderId,
                    user_id: userId,
                });
                targetWorkflowId = containerWf.id;
            }

            const effectiveStepId = stepId || (
                purpose === "character_detail" ? "character_detail" :
                purpose === "character_sheet" ? "character_sheet" :
                purpose === "character_reference" ? "character_reference" :
                purpose === "element_sheet" ? "element_sheet" :
                purpose === "element_reference" ? "element_reference" :
                "upload"
            );
            const mediaRecord = await this.mediaService.createMedia({
                workflowId: targetWorkflowId,
                projectId: targetProjectId,
                generationConfigId: null,
                stepId: effectiveStepId,
                url: publicUrl,
                width: finalWidth,
                height: finalHeight,
                status: "success",
            });

            // 9. If we created a container workflow, update its primary_media_id
            if (containerWf) {
                await this.db.workflows.updatePrimaryMedia(targetWorkflowId, mediaRecord.id).catch(() => null);
            }

            crudOperationLog({
                traceId,
                operation: "mediaIngest:success",
                status: "ok",
                durationMs: Date.now() - start,
                mediaId: mediaRecord.id,
                url: publicUrl,
            });

            return {
                media: mediaRecord,
                isNew: true,
                mediaId: mediaRecord.id,
                workflowId: targetWorkflowId,
                folderId: validatedFolderId,
                folder_id: validatedFolderId,
                url: publicUrl,
                type: inspection.type,
                width: finalWidth,
                height: finalHeight,
                ratio: finalRatio,
                format: uploadMime.split("/")[1]?.toUpperCase() || inspection.format,
                sizeBytes: finalSizeBytes,
                inspection,
            };
        } catch (err) {
            crudOperationLog({
                traceId,
                operation: "mediaIngest:error",
                status: "error",
                durationMs: Date.now() - start,
                errorCode: err.statusCode || 500,
                message: err.message,
            });
            throw err;
        }
    }
}

export default MediaIngestionService;
