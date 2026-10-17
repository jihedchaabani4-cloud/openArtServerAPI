/**
 * ElementMediaService
 * Canonical owner of all Element media lifecycle, storage uploads, and media DB rows.
 *
 * Clean Architecture Boundary:
 *   - Coordinates with MediaIngestionService for clean source ingestion (URLs, Files, Base64, UUIDs).
 *   - Defines canonical step_ids:
 *       - "element_sheet": The primary visual / reference sheet (primary_media_id).
 *       - "element_reference": Secondary reference images and angles.
 *   - Never creates or associates session_id (Elements are project-level assets).
 *
 * Feature: 018-element-reference-system
 */

import { randomUUID } from "node:crypto";
import { crudOperationLog, CrudServiceError } from "../../utils/crudOperationLog.js";
import { resolveMediaMetadata } from "../../platform/media/mediaMetadataResolver.js";
import { createMediaInWorkflow } from "../../db/workflowMediaLinker.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ElementMediaService {
    /**
     * @param {Object} deps
     * @param {Object} deps.db                   - Repository map (db.elements, db.workflows, db.media, db.projects)
     * @param {Object} deps.storageService       - StorageService instance
     * @param {Object} [deps.mediaIngestionService] - MediaIngestionService instance
     * @param {Object} [deps.workflowService]    - WorkflowLifecycleService instance
     */
    constructor({ db, storageService, mediaIngestionService, workflowService }) {
        this.db = db;
        this.storageService = storageService;
        this.mediaIngestionService = mediaIngestionService;
        this.workflowService = workflowService;
    }

    /**
     * Ingest 1 to 6 source images for a newly created or existing element workflow.
     * - First image (index 0) is the primary visual: step_id = "element_sheet".
     * - Subsequent images (1..N) are supporting references: step_id = "element_reference".
     *
     * @param {Object} params
     * @param {string} params.workflowId
     * @param {Array<string|Buffer|Object>} params.sourceImages
     * @param {string} params.projectId
     * @param {string} params.userId
     * @returns {Promise<{ mediaRecords: Array<Object>, primaryMedia: Object, storageUrls: Array<string> }>}
     */
    async ingestElementSources({ workflowId, sourceImages, projectId, userId }) {
        const traceId = randomUUID();
        const start = Date.now();

        crudOperationLog({ traceId, operation: "ingestElementSources", workflowId, count: sourceImages?.length });

        if (!Array.isArray(sourceImages) || sourceImages.length === 0) {
            throw new CrudServiceError("At least 1 source image is required", {
                statusCode: 400,
                errorCode: "VALIDATION_ERROR",
                traceId,
                operation: "ingestElementSources",
            });
        }

        const safeUserId = userId || "anonymous";
        const mediaRecords = [];
        const storageUrls = [];

        for (let i = 0; i < sourceImages.length; i++) {
            const src = sourceImages[i];
            const isPrimary = i === 0;
            const stepId = isPrimary ? "element_sheet" : "element_reference";
            const purpose = stepId;

            let mediaRecord = null;
            let finalUrl = null;

            if (this.mediaIngestionService) {
                const ingested = await this.mediaIngestionService.ingest({
                    source: src,
                    userId: safeUserId,
                    projectId,
                    workflowId,
                    purpose,
                    stepId,
                    folder: "element-sheets",
                    skipMediaCreate: false,
                });

                mediaRecord = ingested.media;
                finalUrl = ingested.url;
            } else {
                // Direct fallback: create media row directly
                finalUrl = typeof src === "string" ? src : (src?.url || "");
                const meta = resolveMediaMetadata(typeof src === "object" ? src : {});
                mediaRecord = await this.db.media.createMedia({
                    project_id: projectId,
                    url: finalUrl,
                    step_id: stepId,
                    width: meta.width,
                    height: meta.height,
                    status: "success",
                });
                await createMediaInWorkflow(this.db, {
                    workflowId,
                    mediaId: mediaRecord?.id,
                    stepId,
                    workflowType: isPrimary ? "ELEMENT_SHEET" : "ELEMENT",
                    operation: "ingestElementSources:linkWorkflowMedia",
                });
            }

            if (mediaRecord) {
                mediaRecords.push(mediaRecord);
                if (finalUrl) storageUrls.push(finalUrl);
            }
        }

        const primaryMedia = mediaRecords[0] || null;

        if (primaryMedia && this.db.workflows?.updatePrimaryMedia) {
            await this.db.workflows.updatePrimaryMedia(workflowId, primaryMedia.id).catch((err) => {
                crudOperationLog({
                    traceId,
                    operation: "ingestElementSources:updatePrimaryMedia",
                    status: "warning",
                    workflowId,
                    mediaId: primaryMedia.id,
                    message: err.message,
                });
            });
        }

        crudOperationLog({
            traceId,
            operation: "ingestElementSources",
            status: "ok",
            durationMs: Date.now() - start,
            workflowId,
            mediaCount: mediaRecords.length,
        });

        return { mediaRecords, primaryMedia, storageUrls };
    }

    /**
     * Add a single reference image to an existing element.
     * step_id: "element_reference"
     */
    async addReferenceMedia({ elementId, source, imageUrl, file, mediaId, projectId, userId }) {
        const traceId = randomUUID();
        const start = Date.now();

        crudOperationLog({ traceId, operation: "addReferenceMedia", elementId });

        try {
            if (!elementId || !UUID_REGEX.test(elementId)) {
                throw new CrudServiceError(`Invalid element ID: "${elementId}" — must be a valid UUID`, {
                    statusCode: 400,
                    errorCode: "VALIDATION_ERROR",
                    traceId,
                    operation: "addReferenceMedia",
                });
            }

            const inputSource = file || mediaId || imageUrl || source;
            if (!inputSource) {
                throw new CrudServiceError("Image file, mediaId, or imageUrl is required", {
                    statusCode: 400,
                    errorCode: "VALIDATION_ERROR",
                    traceId,
                    operation: "addReferenceMedia",
                });
            }

            const element = await this.db.elements.resolveRecord(elementId);
            const wfId = element?.workflow_id || elementId;
            const effectiveProjectId = projectId || element?.project_id || null;
            const safeUserId = userId || "anonymous";

            // Direct Asset/Workflow ID resolution to media relation
            if (mediaId) {
                const sourceMedia = await this._resolveSourceMedia(mediaId, {
                    userId: safeUserId,
                    projectId: effectiveProjectId,
                });
                if (sourceMedia) {
                    await createMediaInWorkflow(this.db, {
                        workflowId: wfId,
                        mediaId: sourceMedia.id,
                        role: "detail",
                        stepId: "element_reference",
                        workflowType: "ELEMENT",
                        operation: "addReferenceMedia:linkWorkflowMedia",
                    });
                    if (element) {
                        const existingImages = Array.isArray(element.source_images) ? element.source_images : [];
                        if (!existingImages.includes(sourceMedia.id)) {
                            await this.db.elements.update(element.id, {
                                source_images: [...existingImages, sourceMedia.id],
                            }).catch((err) => {
                                crudOperationLog({
                                    traceId,
                                    operation: "addReferenceMedia:updateSourceImages",
                                    status: "warning",
                                    elementId,
                                    message: err?.message,
                                });
                            });
                        }
                    }
                    crudOperationLog({
                        traceId,
                        operation: "addReferenceMedia",
                        status: "ok",
                        durationMs: Date.now() - start,
                        elementId,
                        mediaId: sourceMedia.id,
                    });
                    return {
                        ok: true,
                        media: {
                            ...sourceMedia,
                            workflow_id: wfId,
                            workflowId: wfId,
                            role: "detail",
                            mediaRole: "detail",
                        },
                    };
                }
            }

            let mediaRecord = null;
            let resolvedUrl = typeof inputSource === "string" ? inputSource : null;

            if (this.mediaIngestionService) {
                const ingested = await this.mediaIngestionService.ingest({
                    source: inputSource,
                    userId: safeUserId,
                    projectId: effectiveProjectId,
                    workflowId: wfId,
                    purpose: "element_reference",
                    stepId: "element_reference",
                    folder: "element-references",
                    skipMediaCreate: false,
                    imageUrl: imageUrl || (typeof inputSource === "string" ? inputSource : null),
                });
                mediaRecord = ingested.media;
                resolvedUrl = ingested.url;
            } else {
                const meta = resolveMediaMetadata(typeof inputSource === "object" ? inputSource : {});
                mediaRecord = await this.db.media.createMedia({
                    project_id: effectiveProjectId,
                    url: resolvedUrl,
                    step_id: "element_reference",
                    width: meta.width,
                    height: meta.height,
                    status: "success",
                });
                await createMediaInWorkflow(this.db, {
                    workflowId: wfId,
                    mediaId: mediaRecord?.id,
                    stepId: "element_reference",
                    workflowType: "ELEMENT",
                    operation: "addReferenceMedia:linkWorkflowMedia",
                });
            }

            // Sync element.source_images array
            if (mediaRecord?.id && element) {
                const existingImages = Array.isArray(element.source_images) ? element.source_images : [];
                if (!existingImages.includes(mediaRecord.id)) {
                    await this.db.elements.update(element.id, {
                        source_images: [...existingImages, mediaRecord.id],
                    }).catch((err) => {
                        crudOperationLog({
                            traceId,
                            operation: "addReferenceMedia:syncSourceImages",
                            status: "warning",
                            elementId,
                            mediaId: mediaRecord.id,
                            message: err.message,
                        });
                    });
                }
            }

            crudOperationLog({
                traceId,
                operation: "addReferenceMedia",
                status: "ok",
                durationMs: Date.now() - start,
                elementId,
                mediaId: mediaRecord?.id,
            });

            return {
                ok: true,
                media: { ...(mediaRecord || {}), url: resolvedUrl },
                url: resolvedUrl,
            };
        } catch (err) {
            crudOperationLog({
                traceId,
                operation: "addReferenceMedia",
                status: "error",
                durationMs: Date.now() - start,
                errorCode: err.errorCode || 500,
                message: err.message,
            });
            throw err;
        }
    }

    /**
     * Remove a reference image from an element.
     */
    async removeReferenceMedia({ elementId, mediaId, userId, req = null }) {
        const traceId = randomUUID();
        const start = Date.now();

        crudOperationLog({ traceId, operation: "removeReferenceMedia", elementId, mediaId });

        try {
            if (!mediaId) {
                throw new CrudServiceError("mediaId is required", {
                    statusCode: 400,
                    errorCode: "VALIDATION_ERROR",
                    traceId,
                    operation: "removeReferenceMedia",
                });
            }

            const element = elementId && this.db.elements
                ? await this.db.elements.resolveRecord(elementId).catch(() => null)
                : null;
            const wfId = element?.workflow_id || elementId || null;

            // 1. Unlink workflow_media relation for this element workflow
            if (this.db?.workflowMedia?.unlink) {
                await this.db.workflowMedia.unlink(
                    wfId ? { workflowId: wfId, mediaId } : { mediaId }
                ).catch(() => null);
            }

            // 2. If this reference was pinned as primary_media_id on the workflow, nullify it
            if (wfId && this.db?.workflows) {
                const wfRec = await this.db.workflows.findById?.(wfId, "primary_media_id").catch(() => null);
                if (wfRec?.primary_media_id === mediaId) {
                    if (this.db.workflows.updatePrimaryMedia) {
                        await this.db.workflows.updatePrimaryMedia(wfId, null).catch(() => null);
                    } else if (this.db.workflows.updateFields) {
                        await this.db.workflows.updateFields(wfId, { primary_media_id: null }).catch(() => null);
                    }
                }
            }

            // 3. Reference-counted orphan check: delete DB row and storage ONLY when 0 links remain
            let remainingLinks = 0;
            if (this.db?.workflowMedia?.countLinksForMedia) {
                remainingLinks = await this.db.workflowMedia.countLinksForMedia(mediaId).catch(() => 0);
            }

            if (remainingLinks === 0) {
                if (this.workflowService?.deleteMedia && !this.db?.workflowMedia?.countLinksForMedia) {
                    await this.workflowService.deleteMedia({ mediaId, userId, req });
                } else {
                    const mediaRec = await this.db.media?.findById?.(mediaId).catch(() => null);
                    if (this.db.media?.deleteById) {
                        await this.db.media.deleteById(mediaId);
                    } else if (this.db.media?.deleteByIdAndWorkflow) {
                        await this.db.media.deleteByIdAndWorkflow(mediaId, wfId);
                    }
                    if (mediaRec?.url && this.storageService?.deleteByUrl) {
                        await this.storageService.deleteByUrl(mediaRec.url).catch((err) => {
                            crudOperationLog({
                                traceId,
                                operation: "removeReferenceMedia:storageDelete",
                                status: "warning",
                                elementId,
                                mediaId,
                                message: err.message,
                            });
                        });
                    }
                }
            }

            // 4. Remove mediaId from element.source_images
            if (element && Array.isArray(element.source_images)) {
                const filtered = element.source_images.filter((id) => id !== mediaId);
                await this.db.elements.update(element.id, { source_images: filtered }).catch(() => null);
            }

            crudOperationLog({
                traceId,
                operation: "removeReferenceMedia",
                status: "ok",
                durationMs: Date.now() - start,
                elementId,
                mediaId,
            });

            return { ok: true, deletedMediaId: mediaId };
        } catch (err) {
            crudOperationLog({
                traceId,
                operation: "removeReferenceMedia",
                status: "error",
                durationMs: Date.now() - start,
                errorCode: err.errorCode || 500,
                message: err.message,
            });
            throw err;
        }
    }

    /**
     * Set or replace the primary sheet media for an element.
     * step_id: "element_sheet"
     */
    async setSheetMedia({ elementId, source, imageUrl, file, mediaId, projectId, userId }) {
        const traceId = randomUUID();
        const start = Date.now();

        crudOperationLog({ traceId, operation: "setSheetMedia", elementId });

        try {
            const inputSource = file || mediaId || imageUrl || source;
            if (!inputSource) {
                throw new CrudServiceError("Either file, mediaId, or imageUrl is required", {
                    statusCode: 400,
                    errorCode: "VALIDATION_ERROR",
                    traceId,
                    operation: "setSheetMedia",
                });
            }

            const element = await this.db.elements.resolveRecord(elementId);
            const wfId = element?.workflow_id || elementId;
            const effectiveProjectId = projectId || element?.project_id || null;
            const safeUserId = userId || "anonymous";

            let mediaRecord = null;
            let resolvedUrl = typeof inputSource === "string" ? inputSource : null;

            if (this.mediaIngestionService) {
                const ingested = await this.mediaIngestionService.ingest({
                    source: inputSource,
                    userId: safeUserId,
                    projectId: effectiveProjectId,
                    workflowId: wfId,
                    purpose: "element_sheet",
                    stepId: "element_sheet",
                    folder: "element-sheets",
                    skipMediaCreate: false,
                    imageUrl: imageUrl || (typeof inputSource === "string" ? inputSource : null),
                });
                mediaRecord = ingested.media;
                resolvedUrl = ingested.url;
            } else {
                const meta = resolveMediaMetadata(typeof inputSource === "object" ? inputSource : {});
                mediaRecord = await this.db.media.createMedia({
                    project_id: effectiveProjectId,
                    url: resolvedUrl,
                    step_id: "element_sheet",
                    width: meta.width,
                    height: meta.height,
                    status: "success",
                });
                await createMediaInWorkflow(this.db, {
                    workflowId: wfId,
                    mediaId: mediaRecord?.id,
                    stepId: "element_sheet",
                    workflowType: "ELEMENT_SHEET",
                    operation: "setSheetMedia:linkWorkflowMedia",
                });
            }

            // Update primary_media_id on workflow
            if (mediaRecord?.id) {
                await this.db.workflows.updatePrimaryMedia(wfId, mediaRecord.id).catch(() => null);
            }

            crudOperationLog({
                traceId,
                operation: "setSheetMedia",
                status: "ok",
                durationMs: Date.now() - start,
                elementId,
                mediaId: mediaRecord?.id,
            });

            return {
                ok: true,
                media: { ...(mediaRecord || {}), url: resolvedUrl },
                url: resolvedUrl,
            };
        } catch (err) {
            crudOperationLog({
                traceId,
                operation: "setSheetMedia",
                status: "error",
                durationMs: Date.now() - start,
                errorCode: err.errorCode || 500,
                message: err.message,
            });
            throw err;
        }
    }

    /**
     * Internal helper to find source media across media and workflow tables,
     * enforcing tenant (user) and project boundary isolation.
     */
    async _resolveSourceMedia(mediaId, { userId = null, projectId = null } = {}) {
        if (!mediaId) return null;
        let sourceMedia = await this.db.media.findById(mediaId).catch(() => null);
        let sourceWf = null;
        if (!sourceMedia && this.db.media.findMediaByIdOrWorkflow) {
            sourceMedia = await this.db.media.findMediaByIdOrWorkflow(mediaId).catch(() => null);
        }
        if (!sourceMedia && this.db.media.findByWorkflow) {
            const wfMedia = await this.db.media.findByWorkflow(mediaId).catch(() => []);
            sourceMedia = wfMedia.find((m) => m.url && m.status !== "failed") || wfMedia[0] || null;
        }
        if (this.db.workflows?.getWorkflow) {
            sourceWf = await this.db.workflows.getWorkflow(mediaId).catch(() => null);
            if (!sourceMedia && sourceWf?.primary_media_id) {
                sourceMedia = await this.db.media.findById(sourceWf.primary_media_id).catch(() => null);
            }
        }
        if (!sourceMedia) return null;

        // Verify workflow_media link presence and load parent workflow context if needed
        if (typeof this.db.workflowMedia?.findByMedia === "function") {
            const links = await this.db.workflowMedia.findByMedia(sourceMedia.id).catch(() => []);
            if (!Array.isArray(links) || links.length === 0) {
                throw new CrudServiceError("Media not found", {
                    statusCode: 404,
                    errorCode: "MEDIA_NOT_FOUND",
                    mediaId,
                });
            }
            const linkedWfId = links[0]?.workflow_id;
            if (!sourceWf && linkedWfId && this.db.workflows?.getWorkflow) {
                sourceWf = await this.db.workflows.getWorkflow(linkedWfId).catch(() => null);
            }
        }

        // Ownership verification (cross-tenant)
        const ownerUserId = sourceMedia.user_id || sourceWf?.user_id;
        if (userId && userId !== "anonymous" && ownerUserId && ownerUserId !== userId) {
            throw new CrudServiceError("Media not found", {
                statusCode: 404,
                errorCode: "MEDIA_NOT_FOUND",
                mediaId,
            });
        }

        // Project boundary verification (cross-project)
        const ownerProjectId = sourceMedia.project_id || sourceWf?.project_id;
        if (projectId && ownerProjectId && ownerProjectId !== projectId) {
            throw new CrudServiceError("Media not found", {
                statusCode: 404,
                errorCode: "MEDIA_NOT_FOUND",
                mediaId,
            });
        }

        return sourceMedia;
    }
}
