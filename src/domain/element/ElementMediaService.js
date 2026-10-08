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
import { linkWorkflowMediaForCreatedRow } from "../../db/workflowMediaLinker.js";

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
                    workflow_id: workflowId,
                    project_id: projectId,
                    url: finalUrl,
                    step_id: stepId,
                    width: meta.width,
                    height: meta.height,
                    status: "success",
                });
                await linkWorkflowMediaForCreatedRow(this.db, {
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
                    workflow_id: wfId,
                    project_id: effectiveProjectId,
                    url: resolvedUrl,
                    step_id: "element_reference",
                    width: meta.width,
                    height: meta.height,
                    status: "success",
                });
                await linkWorkflowMediaForCreatedRow(this.db, {
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

            // 1. Delete media record via workflowService or direct db
            if (this.workflowService?.deleteMedia) {
                await this.workflowService.deleteMedia({ mediaId, userId, req });
            } else {
                const mediaRec = await this.db.media.findById(mediaId).catch(() => null);
                if (mediaRec?.url && this.storageService) {
                    await this.storageService.deleteByUrl(mediaRec.url).catch(() => null);
                }
                await this.db.media.deleteById(mediaId);
            }

            // 2. Remove mediaId from element.source_images
            if (elementId && this.db.elements) {
                const element = await this.db.elements.resolveRecord(elementId).catch(() => null);
                if (element && Array.isArray(element.source_images)) {
                    const filtered = element.source_images.filter((id) => id !== mediaId);
                    await this.db.elements.update(element.id, { source_images: filtered }).catch(() => null);
                }
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
                    workflow_id: wfId,
                    project_id: effectiveProjectId,
                    url: resolvedUrl,
                    step_id: "element_sheet",
                    width: meta.width,
                    height: meta.height,
                    status: "success",
                });
                await linkWorkflowMediaForCreatedRow(this.db, {
                    workflowId: wfId,
                    mediaId: mediaRecord?.id,
                    stepId: "element_sheet",
                    workflowType: "ELEMENT_SHEET",
                    operation: "setSheetMedia:linkWorkflowMedia",
                });
            }

            // Update primary_media_id on workflow and element
            if (mediaRecord?.id) {
                await this.db.workflows.updatePrimaryMedia(wfId, mediaRecord.id).catch(() => null);
                if (element) {
                    await this.db.elements.update(element.id, {
                        primary_media_id: mediaRecord.id,
                    }).catch(() => null);
                }
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
}
