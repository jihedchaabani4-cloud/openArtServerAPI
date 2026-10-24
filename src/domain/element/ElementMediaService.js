/**
 * ElementMediaService
 * Canonical owner of all Element media lifecycle, storage uploads, and media DB rows.
 *
 * Clean Architecture Boundary:
 *   - Coordinates with MediaUploadService for stateless upload & policy validation.
 *   - Coordinates with WorkflowMediaService for atomic attachment and rollback via RPC.
 *   - Follows ADR-0008 decoupled architecture:
 *       - Media relationship roles ('detail', 'reference') are stored in workflow_media.role.
 *       - media.step_id captures technical provenance only ('upload', 'GEN', etc.).
 *   - Never creates or associates session_id (Elements are project-level assets).
 *
 * Feature: 018-element-reference-system
 */

import { randomUUID } from "node:crypto";
import { crudOperationLog, CrudServiceError } from "../../utils/crudOperationLog.js";
import {
    ELEMENT_REFERENCE_UPLOAD_POLICY,
    ELEMENT_SHEET_UPLOAD_POLICY,
} from "../../platform/media-ingestion/UploadPolicy.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function getElementMaxMedia() {
    const raw = process.env.ELEMENT_MAX_MEDIA || process.env.ELEMENT_MAX_REFERENCE_MEDIA;
    if (raw !== undefined && raw !== null && raw !== "") {
        const parsed = parseInt(raw, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
            return parsed;
        }
    }
    return 6;
}

export class ElementMediaService {
    /**
     * @param {Object} deps
     * @param {Object} deps.db                   - Repository map (db.elements, db.workflows, db.media, db.workflowMedia)
     * @param {Object} deps.storageService       - StorageService instance
     * @param {Object} deps.mediaUploadService   - MediaUploadService instance (upload, discard)
     * @param {Object} deps.workflowMediaService - WorkflowMediaService instance (attachMediaItems, rollbackAttachedMedia)
     * @param {Object} deps.authService          - WorkflowAuthorizationService instance (verifyWorkflowOwnership)
     */
    constructor({
        db,
        storageService,
        mediaUploadService,
        workflowMediaService,
        authService,
    } = {}) {
        if (!mediaUploadService || typeof mediaUploadService.upload !== "function") {
            throw new Error("ElementMediaService requires mediaUploadService with an upload method");
        }
        if (!workflowMediaService || typeof workflowMediaService.attachMediaItems !== "function") {
            throw new Error("ElementMediaService requires workflowMediaService with an attachMediaItems method");
        }
        if (!authService || typeof authService.verifyWorkflowOwnership !== "function") {
            throw new Error("ElementMediaService requires authService with a verifyWorkflowOwnership method");
        }

        this.db = db;
        this.storageService = storageService;
        this.mediaUploadService = mediaUploadService;
        this.workflowMediaService = workflowMediaService;
        this.authService = authService;
    }

    /**
     * Ingest 1 to 6 source images for a newly created or existing element workflow.
     * Preserves media.step_id provenance ('upload' or source step_id).
     * Relationship roles are canonically set in workflow_media.role ('detail').
     *
     * @deprecated Scheduled for removal in Ticket 11 (ADR-0010).
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

        if (!userId || userId === "anonymous") {
            throw new CrudServiceError("Authentication required", {
                statusCode: 401,
                errorCode: "UNAUTHORIZED",
                traceId,
                operation: "ingestElementSources",
            });
        }

        if (!Array.isArray(sourceImages) || sourceImages.length === 0) {
            throw new CrudServiceError("At least 1 source image is required", {
                statusCode: 400,
                errorCode: "VALIDATION_ERROR",
                traceId,
                operation: "ingestElementSources",
            });
        }

        const maxAllowed = getElementMaxMedia();
        if (sourceImages.length > maxAllowed) {
            throw new CrudServiceError(`Maximum ${maxAllowed} reference images allowed per element`, {
                statusCode: 400,
                errorCode: "LIMIT_EXCEEDED",
                traceId,
                operation: "ingestElementSources",
            });
        }

        const isAuthorized = await this.authService.verifyWorkflowOwnership(workflowId, userId);
        if (!isAuthorized) {
            throw new CrudServiceError("Workflow not found", {
                statusCode: 404,
                errorCode: "NOT_FOUND",
                traceId,
                operation: "ingestElementSources",
            });
        }

        const uploadResult = await this.mediaUploadService.upload({
            files: sourceImages,
            policy: ELEMENT_SHEET_UPLOAD_POLICY,
            maxFiles: maxAllowed,
            userId,
        });

        const uploadedFiles = uploadResult.uploaded || uploadResult.files || [];
        const items = uploadedFiles.map((uploadedFile) => ({
            kind: "uploaded",
            uploadedFile,
            stepId: "upload",
        }));

        const attachResult = await this.workflowMediaService.attachMediaItems({
            workflowId,
            projectId,
            userId,
            role: "detail",
            maxAllowed,
            setPrimary: true,
            workflowType: "ELEMENT_SHEET",
            items,
        });

        const mediaRecords = (attachResult.attached || []).map((a) => a.media);
        const primaryMedia = mediaRecords[0] || null;
        const storageUrls = mediaRecords.map((m) => m.url).filter(Boolean);

        if (primaryMedia?.id && this.db.workflows?.updatePrimaryMedia) {
            await this.db.workflows.updatePrimaryMedia(workflowId, primaryMedia.id).catch(() => null);
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

    async _determineShouldBePrimary(wfId) {
        if (!wfId) return false;
        try {
            const existingPrimary = await (this.db.workflowMedia?.getPrimaryMedia?.(wfId)
                || this.db.workflows?.getPrimaryMedia?.(wfId));
            return !existingPrimary;
        } catch {
            return false;
        }
    }

    /**
     * Atomically set the primary cover media for an element workflow.
     */
    async setElementCover({ workflowId, mediaId }) {
        if (!workflowId || !mediaId) return null;
        if (this.db.workflowMedia?.setPrimaryMedia) {
            return this.db.workflowMedia.setPrimaryMedia({ workflowId, mediaId });
        }
        if (this.db.workflows?.updatePrimaryMedia) {
            return this.db.workflows.updatePrimaryMedia(workflowId, mediaId);
        }
        return null;
    }

    /**
     * Atomically clear the primary cover media for an element workflow.
     */
    async clearElementCover({ workflowId }) {
        if (!workflowId) return null;
        if (this.db.workflowMedia?.clearPrimaryMedia) {
            return this.db.workflowMedia.clearPrimaryMedia({ workflowId });
        }
        if (this.db.workflows?.updateFields) {
            return this.db.workflows.updateFields(workflowId, { primary_media_id: null });
        }
        return null;
    }

    /**
     * Atomically claim cover if no cover exists for this workflow.
     * Enforces "first successful attachment wins" rule without replacing existing Cover.
     */
    async setCoverIfNone({ workflowId, mediaId }) {
        if (!workflowId || !mediaId) return false;
        if (this.db.workflowMedia?.setPrimaryMediaIfNone) {
            return this.db.workflowMedia.setPrimaryMediaIfNone({ workflowId, mediaId });
        }
        const shouldBePrimary = await this._determineShouldBePrimary(workflowId);
        if (shouldBePrimary) {
            await this.setElementCover({ workflowId, mediaId });
            return true;
        }
        return false;
    }

    /**
     * Pre-upload capacity check — authoritative backend guard.
     * Returns capacity metrics if upload is allowed.
     * Throws CrudServiceError (400 LIMIT_EXCEEDED) if the element is full.
     * Throws CrudServiceError (404 NOT_FOUND) for cross-tenant access attempts.
     *
     * Must be called BEFORE the multipart upload stream is consumed.
     *
     * @param {{ elementId: string, userId: string, incomingCount?: number }} params
     * @returns {Promise<{ allowed: boolean, currentCount: number, maxAllowed: number, remainingSlots: number, workflowId: string }>}
     */
    async assertUploadAllowed({ elementId, userId, incomingCount = 1 } = {}) {
        const traceId = randomUUID();
        if (!elementId) {
            throw new CrudServiceError("Element ID is required", {
                statusCode: 400,
                errorCode: "VALIDATION_ERROR",
                traceId,
                operation: "assertUploadAllowed",
            });
        }

        let element = null;
        try {
            if (this.db.elements?.resolveRecord) {
                element = await this.db.elements.resolveRecord(elementId);
            } else if (this.db.elements?.findById) {
                element = await this.db.elements.findById(elementId);
            }
        } catch {
            element = null;
        }

        if (!element) {
            throw new CrudServiceError(`Element not found: ${elementId}`, {
                statusCode: 404,
                errorCode: "NOT_FOUND",
                traceId,
                operation: "assertUploadAllowed",
            });
        }

        const wfId = element.workflow_id || elementId;

        // Cross-tenant ownership check - returns 404 (not 403) to prevent enumeration
        if (userId && userId !== "anonymous") {
            const isAuthorized = await this.authService.verifyWorkflowOwnership(wfId, userId);
            if (!isAuthorized) {
                throw new CrudServiceError(`Element not found: ${elementId}`, {
                    statusCode: 404,
                    errorCode: "NOT_FOUND",
                    traceId,
                    operation: "assertUploadAllowed",
                });
            }
        } else if (element.user_id && userId && element.user_id !== userId) {
            throw new CrudServiceError(`Element not found: ${elementId}`, {
                statusCode: 404,
                errorCode: "NOT_FOUND",
                traceId,
                operation: "assertUploadAllowed",
            });
        }

        const maxAllowed = getElementMaxMedia();
        const existingLinks = await (this.db.workflowMedia?.findByWorkflow?.(wfId)
            || this.db.media?.findByWorkflow?.(wfId)
            || []);
        const currentCount = existingLinks.filter((m) => !m.role || m.role === "detail").length;
        const remainingSlots = Math.max(0, maxAllowed - currentCount);

        if (currentCount >= maxAllowed) {
            throw new CrudServiceError(`Maximum ${maxAllowed} reference images allowed per element`, {
                statusCode: 400,
                errorCode: "LIMIT_EXCEEDED",
                traceId,
                operation: "assertUploadAllowed",
                details: { currentCount, maxAllowed, remainingSlots: 0 },
            });
        }

        return { allowed: true, currentCount, maxAllowed, remainingSlots, workflowId: wfId };
    }

    /**
     * Add a single reference image to an existing element.
     * Sets workflow_media.role = "detail" and preserves technical step_id ("upload").
     */
    async addReferenceMedia({ elementId, source, imageUrl, file, mediaId, projectId, userId }) {
        const traceId = randomUUID();
        const start = Date.now();

        crudOperationLog({ traceId, operation: "addReferenceMedia", elementId });

        try {
            if (!userId || userId === "anonymous") {
                throw new CrudServiceError("Authentication required", {
                    statusCode: 401,
                    errorCode: "UNAUTHORIZED",
                    traceId,
                    operation: "addReferenceMedia",
                });
            }

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
            if (!element) {
                throw new CrudServiceError(`Element not found: ${elementId}`, {
                    statusCode: 404,
                    errorCode: "NOT_FOUND",
                    traceId,
                    operation: "addReferenceMedia",
                });
            }

            const wfId = element.workflow_id || elementId;
            const effectiveProjectId = projectId || element.project_id || null;

            const isAuthorized = await this.authService.verifyWorkflowOwnership(wfId, userId);
            if (!isAuthorized) {
                throw new CrudServiceError(`Element not found: ${elementId}`, {
                    statusCode: 404,
                    errorCode: "NOT_FOUND",
                    traceId,
                    operation: "addReferenceMedia",
                });
            }

            if (projectId && element.project_id && element.project_id !== projectId) {
                throw new CrudServiceError(`Element not found: ${elementId}`, {
                    statusCode: 404,
                    errorCode: "NOT_FOUND",
                    traceId,
                    operation: "addReferenceMedia",
                });
            }

            const maxAllowed = getElementMaxMedia();
            const existingLinks = await (this.db.workflowMedia?.findByWorkflow?.(wfId)
                || this.db.media?.findByWorkflow?.(wfId)
                || []);
            const detailCount = existingLinks.filter((m) => !m.role || m.role === "detail").length;
            const remaining = maxAllowed - detailCount;

            if (remaining <= 0) {
                throw new CrudServiceError(`Maximum ${maxAllowed} reference images allowed per element`, {
                    statusCode: 400,
                    errorCode: "LIMIT_EXCEEDED",
                    traceId,
                    operation: "addReferenceMedia",
                    details: { currentCount: detailCount, maxAllowed, remainingSlots: 0 },
                });
            }

            if (mediaId) {
                const attachResult = await this.workflowMediaService.attachMediaItems({
                    workflowId: wfId,
                    projectId: effectiveProjectId,
                    userId,
                    role: "detail",
                    maxAllowed,
                    items: [{ kind: "existing", mediaId }],
                });
                const attachedEntry = attachResult.attached?.[0];
                const isPrimary = attachedEntry?.is_primary ?? false;

                crudOperationLog({
                    traceId,
                    operation: "addReferenceMedia",
                    status: "ok",
                    durationMs: Date.now() - start,
                    elementId,
                    mediaId,
                });

                return {
                    ok: true,
                    media: {
                        ...(attachedEntry?.media || {}),
                        workflow_id: wfId,
                        workflowId: wfId,
                        role: "detail",
                        mediaRole: "detail",
                        step_id: attachedEntry?.media?.step_id || "upload",
                        is_primary: isPrimary,
                        isPrimary: isPrimary,
                    },
                };
            }

            // New upload source: strictly enforce policy folder, ignoring any client folder parameter
            const uploadResult = await this.mediaUploadService.upload({
                files: [inputSource],
                policy: ELEMENT_REFERENCE_UPLOAD_POLICY,
                maxFiles: remaining,
                userId,
            });

            const uploadedFile = (uploadResult.uploaded || uploadResult.files || [])[0];
            if (!uploadedFile) {
                throw new CrudServiceError("Upload failed to produce any file", {
                    statusCode: 500,
                    errorCode: "UPLOAD_FAILED",
                    traceId,
                    operation: "addReferenceMedia",
                });
            }

            const attachResult = await this.workflowMediaService.attachMediaItems({
                workflowId: wfId,
                projectId: effectiveProjectId,
                userId,
                role: "detail",
                maxAllowed,
                items: [{ kind: "uploaded", uploadedFile, stepId: "upload" }],
            });

            const attachedEntry = attachResult.attached?.[0];
            const isPrimary = attachedEntry?.is_primary ?? false;

            crudOperationLog({
                traceId,
                operation: "addReferenceMedia",
                status: "ok",
                durationMs: Date.now() - start,
                elementId,
                mediaId: attachedEntry?.media?.id,
            });

            return {
                ok: true,
                media: {
                    ...(attachedEntry?.media || {}),
                    workflow_id: wfId,
                    workflowId: wfId,
                    role: "detail",
                    mediaRole: "detail",
                    step_id: attachedEntry?.media?.step_id || "upload",
                    is_primary: isPrimary,
                    isPrimary: isPrimary,
                },
                url: attachedEntry?.media?.url || uploadedFile.url,
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
            if (elementId && this.db.elements && !element) {
                throw new CrudServiceError(`Element not found: ${elementId}`, {
                    statusCode: 404,
                    errorCode: "NOT_FOUND",
                    traceId,
                    operation: "removeReferenceMedia",
                });
            }
            const wfId = element?.workflow_id || elementId || null;
            if (!wfId) {
                throw new CrudServiceError("workflowId could not be resolved for element", {
                    statusCode: 404,
                    errorCode: "NOT_FOUND",
                    traceId,
                    operation: "removeReferenceMedia",
                });
            }

            // Check if this media was primary before unlinking
            let wasPrimary = false;
            if (wfId && this.db?.workflowMedia?.getPrimaryMedia) {
                const currentPrimary = await this.db.workflowMedia.getPrimaryMedia(wfId).catch(() => null);
                const currentPrimaryId = currentPrimary?.media_id || currentPrimary?.id;
                wasPrimary = Boolean(currentPrimaryId && currentPrimaryId === mediaId);
            }

            // Atomic unlink and orphan reaping protocol
            if (typeof this.db?.workflowMedia?.unlinkAndReapOrphan === "function") {
                const reapResult = await this.db.workflowMedia.unlinkAndReapOrphan({
                    workflowId: wfId,
                    mediaId,
                });
                if (reapResult?.unlinked && reapResult.is_orphan) {
                    if (this.db.media?.deleteById) {
                        await this.db.media.deleteById(mediaId).catch(() => null);
                    }
                    const mediaRec = await this.db.media?.findById?.(mediaId).catch(() => null);
                    const storageUrl = reapResult.storage_url || mediaRec?.url;
                    if (storageUrl && this.storageService?.deleteByUrl) {
                        await this.storageService.deleteByUrl(storageUrl).catch((err) => {
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
            } else {
                // Legacy sequential fallback for minimal mock harnesses
                if (this.db?.workflowMedia?.unlink) {
                    await this.db.workflowMedia.unlink({ workflowId: wfId, mediaId });
                }
                if (wfId && wasPrimary) {
                    if (this.db?.workflowMedia?.clearPrimaryMedia) {
                        await this.db.workflowMedia.clearPrimaryMedia({ workflowId: wfId });
                    } else if (this.db?.workflows?.updateFields) {
                        await this.db.workflows.updateFields(wfId, { primary_media_id: null });
                    }
                }
                let remainingLinks = 0;
                if (this.db?.workflowMedia?.countLinksForMedia) {
                    remainingLinks = await this.db.workflowMedia.countLinksForMedia(mediaId);
                } else if (this.db?.workflowMedia?.findByMedia) {
                    const links = await this.db.workflowMedia.findByMedia(mediaId);
                    remainingLinks = Array.isArray(links) ? links.length : 0;
                }
                if (remainingLinks === 0) {
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
     * Sets workflow_media.role = "detail" and preserves technical step_id ("upload").
     */
    async setSheetMedia({ elementId, source, imageUrl, file, mediaId, projectId, userId }) {
        const traceId = randomUUID();
        const start = Date.now();

        crudOperationLog({ traceId, operation: "setSheetMedia", elementId });

        try {
            if (!userId || userId === "anonymous") {
                throw new CrudServiceError("Authentication required", {
                    statusCode: 401,
                    errorCode: "UNAUTHORIZED",
                    traceId,
                    operation: "setSheetMedia",
                });
            }

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
            if (!element) {
                throw new CrudServiceError(`Element not found: ${elementId}`, {
                    statusCode: 404,
                    errorCode: "NOT_FOUND",
                    traceId,
                    operation: "setSheetMedia",
                });
            }

            const wfId = element.workflow_id || elementId;
            const effectiveProjectId = projectId || element.project_id || null;

            const isAuthorized = await this.authService.verifyWorkflowOwnership(wfId, userId);
            if (!isAuthorized) {
                throw new CrudServiceError(`Element not found: ${elementId}`, {
                    statusCode: 404,
                    errorCode: "NOT_FOUND",
                    traceId,
                    operation: "setSheetMedia",
                });
            }

            if (projectId && element.project_id && element.project_id !== projectId) {
                throw new CrudServiceError(`Element not found: ${elementId}`, {
                    statusCode: 404,
                    errorCode: "NOT_FOUND",
                    traceId,
                    operation: "setSheetMedia",
                });
            }

            if (mediaId) {
                const attachResult = await this.workflowMediaService.attachMediaItems({
                    workflowId: wfId,
                    projectId: effectiveProjectId,
                    userId,
                    role: "detail",
                    maxAllowed: null,
                    setPrimary: true,
                    workflowType: "ELEMENT_SHEET",
                    items: [{ kind: "existing", mediaId }],
                });
                const attachedEntry = attachResult.attached?.[0];

                if (this.db.workflows?.updatePrimaryMedia && attachedEntry?.media?.id) {
                    await this.db.workflows.updatePrimaryMedia(wfId, attachedEntry.media.id).catch(() => null);
                }

                crudOperationLog({
                    traceId,
                    operation: "setSheetMedia",
                    status: "ok",
                    durationMs: Date.now() - start,
                    elementId,
                    mediaId,
                });

                return {
                    ok: true,
                    media: {
                        ...(attachedEntry?.media || {}),
                        url: attachedEntry?.media?.url,
                    },
                    url: attachedEntry?.media?.url,
                };
            }

            // New upload source: strictly enforce policy folder, ignoring any client folder parameter
            const uploadResult = await this.mediaUploadService.upload({
                files: [inputSource],
                policy: ELEMENT_SHEET_UPLOAD_POLICY,
                maxFiles: 1,
                userId,
            });

            const uploadedFile = (uploadResult.uploaded || uploadResult.files || [])[0];
            if (!uploadedFile) {
                throw new CrudServiceError("Upload failed to produce any file", {
                    statusCode: 500,
                    errorCode: "UPLOAD_FAILED",
                    traceId,
                    operation: "setSheetMedia",
                });
            }

            const attachResult = await this.workflowMediaService.attachMediaItems({
                workflowId: wfId,
                projectId: effectiveProjectId,
                userId,
                role: "detail",
                maxAllowed: null,
                setPrimary: true,
                workflowType: "ELEMENT_SHEET",
                items: [{ kind: "uploaded", uploadedFile, stepId: "upload" }],
            });

            const attachedEntry = attachResult.attached?.[0];
            const resolvedUrl = attachedEntry?.media?.url || uploadedFile.url;

            if (this.db.workflows?.updatePrimaryMedia && attachedEntry?.media?.id) {
                await this.db.workflows.updatePrimaryMedia(wfId, attachedEntry.media.id).catch(() => null);
            }

            crudOperationLog({
                traceId,
                operation: "setSheetMedia",
                status: "ok",
                durationMs: Date.now() - start,
                elementId,
                mediaId: attachedEntry?.media?.id,
            });

            return {
                ok: true,
                media: {
                    ...(attachedEntry?.media || {}),
                    url: resolvedUrl,
                },
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
