/**
 * WorkflowMediaService
 * Dedicated Platform Service owning workflow media associations:
 * - Setting and switching primary media for a workflow
 * - Detaching media variations into independent workflow containers
 * - Deleting single media records and cascading cleanup to storage and workflows
 * - Releasing workflow relations without deleting still-linked media
 * - Deleting orphan media that no longer belongs to any workflow
 *
 * Public methods:
 * - attachMediaItems(options)
 * - rollbackAttachedMedia(rollbackHandle)
 * - resolveOwnedSourceMedia(options)
 * - deleteMedia(options)
 * - releaseMedia(options)
 * - setPrimaryMedia(options)
 * - clearPrimaryMedia(options)
 * - createMediaInWorkflow(options)
 */

import { randomUUID } from "node:crypto";
import { assertMediaUsable } from "../../../lib/mediaGuards.js";
import { crudOperationLog, CrudServiceError } from "../../utils/crudOperationLog.js";
import { createLogger } from "../../infrastructure/logging/index.js";
import { createMediaInWorkflow } from "../../db/workflowMediaLinker.js";
import {
    QuotaError,
    ValidationError,
    isWorkflowReferenceQuotaError,
} from "../media-ingestion/MediaUploadErrors.js";

const logger = createLogger("database");

export class WorkflowMediaService {
    /**
     * @param {Object} deps
     * @param {Object} deps.db                 - Repository map (db.workflows, db.media, db.workflowMedia)
     * @param {Object} deps.storageService      - StorageService instance
     * @param {Object} [deps.authService]       - WorkflowAuthorizationService instance
     * @param {Object} [deps.mediaUploadService]- MediaUploadService instance
     */
    constructor({ db, storageService, authService = null, mediaUploadService = null }) {
        this.db = db;
        this.storageService = storageService;
        this.authService = authService;
        this.mediaUploadService = mediaUploadService;
    }

    async _discardStorage(keys = []) {
        const uniqueKeys = [...new Set((keys || []).filter(Boolean))];
        if (uniqueKeys.length === 0) return;
        try {
            if (this.mediaUploadService?.discard) {
                await this.mediaUploadService.discard(uniqueKeys);
            } else if (this.storageService?.deleteFiles) {
                await this.storageService.deleteFiles(uniqueKeys);
            } else if (this.storageService?.delete) {
                for (const k of uniqueKeys) {
                    await this.storageService.delete(k).catch(() => null);
                }
            }
        } catch (err) {
            crudOperationLog({
                operation: "WorkflowMediaService:discardStorage",
                status: "warning",
                message: err?.message,
            });
        }
    }

    /**
     * Link a media record to a workflow strictly in `public.workflow_media`.
     */
    async createMediaInWorkflow({ workflowId, workflow_id, mediaId, media_id, role, stepId, step_id, workflowType, workflow_type } = {}) {
        return createMediaInWorkflow(this.db, {
            workflowId,
            workflow_id,
            mediaId,
            media_id,
            role,
            stepId,
            step_id,
            workflowType,
            workflow_type,
            operation: "WorkflowMediaService:createMediaInWorkflow",
        });
    }

    /**
     * Assign media to a workflow strictly via `public.workflow_media` (never updates `media.workflow_id`).
     */
    async assignMediaToWorkflow(params = {}) {
        return this.createMediaInWorkflow(params);
    }

    /**
     * Resolves a media record by mediaId or workflowId, verifying ownership and project boundaries.
     * Throws 404 NOT_FOUND on missing or cross-tenant access.
     */
    async resolveOwnedSourceMedia({ mediaId, workflowId = null, userId = null, projectId = null, req = null } = {}) {
        const targetId = mediaId || workflowId;
        if (!targetId) {
            throw new CrudServiceError("mediaId or workflowId is required", {
                statusCode: 400,
                errorCode: "VALIDATION_ERROR",
            });
        }

        let sourceMedia = await this.db.media?.findById(targetId).catch(() => null);
        let sourceWf = null;
        if (!sourceMedia && this.db.media?.findMediaByIdOrWorkflow) {
            sourceMedia = await this.db.media.findMediaByIdOrWorkflow(targetId).catch(() => null);
        }
        if (!sourceMedia && this.db.media?.findByWorkflow) {
            const wfMedia = await this.db.media.findByWorkflow(targetId).catch(() => []);
            sourceMedia = wfMedia.find((m) => m.url && m.status !== "failed") || wfMedia[0] || null;
        }
        if (this.db.workflows?.getWorkflow) {
            sourceWf = await this.db.workflows.getWorkflow(targetId).catch(() => null);
            if (!sourceMedia && sourceWf?.primary_media_id) {
                sourceMedia = await this.db.media?.findById(sourceWf.primary_media_id).catch(() => null);
            }
        }
        if (!sourceMedia) {
            throw new CrudServiceError("Media not found", {
                statusCode: 404,
                errorCode: "NOT_FOUND",
                mediaId: targetId,
            });
        }

        // Verify workflow_media link presence and load parent workflow context if needed
        if (typeof this.db.workflowMedia?.findByMedia === "function") {
            const links = await this.db.workflowMedia.findByMedia(sourceMedia.id).catch(() => []);
            if (!Array.isArray(links) || links.length === 0) {
                throw new CrudServiceError("Media not found", {
                    statusCode: 404,
                    errorCode: "NOT_FOUND",
                    mediaId: sourceMedia.id,
                });
            }
            if (workflowId && !links.some((l) => (l.workflow_id || l.workflowId) === workflowId)) {
                throw new CrudServiceError("Media not found", {
                    statusCode: 404,
                    errorCode: "NOT_FOUND",
                    mediaId: sourceMedia.id,
                });
            }
            const linkedWfId = (workflowId && links.find((l) => (l.workflow_id || l.workflowId) === workflowId)?.workflow_id) || links[0]?.workflow_id;
            if (!sourceWf && linkedWfId && this.db.workflows?.getWorkflow) {
                sourceWf = await this.db.workflows.getWorkflow(linkedWfId).catch(() => null);
            }
        }

        // Ownership verification (cross-tenant)
        const ownerUserId = sourceMedia.user_id || sourceWf?.user_id;
        if (userId && userId !== "anonymous" && ownerUserId && ownerUserId !== userId) {
            throw new CrudServiceError("Media not found", {
                statusCode: 404,
                errorCode: "NOT_FOUND",
                mediaId: sourceMedia.id,
            });
        }

        // Project boundary verification (cross-project)
        const ownerProjectId = sourceMedia.project_id || sourceWf?.project_id;
        if (projectId && ownerProjectId && ownerProjectId !== projectId) {
            throw new CrudServiceError("Media not found", {
                statusCode: 404,
                errorCode: "NOT_FOUND",
                mediaId: sourceMedia.id,
            });
        }

        return sourceMedia;
    }

    /**
     * Atomically attach media items (both newly uploaded files and pre-existing Project Cache mediaId items)
     * to a workflow container with authoritative quota enforcement and automatic rollback.
     */
    async attachMediaItems({
        workflowId,
        projectId = null,
        userId,
        role = "detail",
        maxAllowed,
        items = [],
        setPrimary = false,
        workflowType = null,
        req = null,
    } = {}) {
        const traceId = randomUUID();
        const start = Date.now();

        // 1. Validate maxAllowed (must be null or integer >= 0)
        const isAllowedValid = maxAllowed === null || (typeof maxAllowed === "number" && Number.isInteger(maxAllowed) && maxAllowed >= 0);
        if (!isAllowedValid) {
            const uploadedKeys = items
                .filter((it) => it?.kind === "uploaded" && it?.uploadedFile?.storageKey)
                .map((it) => it.uploadedFile.storageKey);
            await this._discardStorage(uploadedKeys);
            throw new ValidationError(
                `Invalid maxAllowed value (${maxAllowed}): must be null or an integer >= 0.`,
                { statusCode: 400, code: "VALIDATION_ERROR" }
            );
        }

        // 2. Validate workflowId and userId
        if (!workflowId || typeof workflowId !== "string") {
            const uploadedKeys = items.filter((it) => it?.kind === "uploaded" && it?.uploadedFile?.storageKey).map((it) => it.uploadedFile.storageKey);
            await this._discardStorage(uploadedKeys);
            throw new ValidationError("workflowId is required", { statusCode: 400, code: "VALIDATION_ERROR" });
        }
        if (!userId) {
            const uploadedKeys = items.filter((it) => it?.kind === "uploaded" && it?.uploadedFile?.storageKey).map((it) => it.uploadedFile.storageKey);
            await this._discardStorage(uploadedKeys);
            throw new ValidationError("userId is required", { statusCode: 400, code: "VALIDATION_ERROR" });
        }

        // 3. Verify workflow ownership
        if (this.authService?.verifyWorkflowOwnership) {
            let isAuthorized = false;
            try {
                isAuthorized = await this.authService.verifyWorkflowOwnership(workflowId, userId, req);
            } catch (authErr) {
                // If authService threw an infrastructure error (e.g. no supabase client in mock/hermetic env),
                // fall back to repository check if available
                let wf = null;
                if (typeof this.db?.workflows?.getWorkflow === "function") {
                    wf = await this.db.workflows.getWorkflow(workflowId).catch(() => null);
                } else if (typeof this.db?.workflows?.findById === "function") {
                    wf = await this.db.workflows.findById(workflowId).catch(() => null);
                }
                if (wf) {
                    if (wf.user_id === userId) {
                        isAuthorized = true;
                    } else if (wf.project_id && typeof this.db?.projects?.findByUser === "function") {
                        const ownedProj = await this.db.projects.findByUser(userId, wf.project_id).catch(() => []);
                        isAuthorized = Array.isArray(ownedProj) && ownedProj.length > 0;
                    }
                }
            }
            if (!isAuthorized) {
                const uploadedKeys = items.filter((it) => it?.kind === "uploaded" && it?.uploadedFile?.storageKey).map((it) => it.uploadedFile.storageKey);
                await this._discardStorage(uploadedKeys);
                throw new CrudServiceError("Workflow not found", {
                    statusCode: 404,
                    errorCode: "NOT_FOUND",
                    workflowId,
                });
            }
        }

        // 4. Phase 1 Pre-flight: resolve and validate all "existing" items before ANY createMedia or attach
        const resolvedExisting = new Map();
        for (const item of items) {
            if (item.kind === "existing") {
                const mediaId = item.mediaId || item.media_id || item.workflowId || item.workflow_id;
                let resolvedMedia;
                try {
                    resolvedMedia = await this.resolveOwnedSourceMedia({
                        mediaId,
                        userId,
                        projectId,
                        req,
                    });
                } catch (existingErr) {
                    const uploadedKeys = items.filter((it) => it?.kind === "uploaded" && it?.uploadedFile?.storageKey).map((it) => it.uploadedFile.storageKey);
                    await this._discardStorage(uploadedKeys);
                    throw existingErr;
                }
                resolvedExisting.set(item, resolvedMedia);
            }
        }

        // 5. Inspect previous primary state before any attachments
        const currentPrimary = await this.db.workflowMedia?.getPrimaryMedia?.(workflowId).catch(() => null);
        const currentWf = await this.db.workflows?.findById?.(workflowId, "primary_media_id").catch(() => null);
        const previousPrimaryMediaId = currentPrimary?.media_id || currentPrimary?.id || currentWf?.primary_media_id || null;

        // 6. Build rollbackHandle tracking per-item state
        const rollbackHandle = {
            workflowId,
            role,
            previousPrimaryMediaId,
            primaryModified: false,
            primaryRestored: false,
            newPrimaryMediaId: null,
            entries: items.map((item) => ({
                kind: item.kind,
                mediaId: null,
                mediaCreatedInCall: false,
                linkCreatedInCall: false,
                is_existing: false,
                unlinked: false,
                unlinkFailed: false,
                mediaDeleted: false,
                discarded: false,
                storageKey: item.kind === "uploaded" ? (item.uploadedFile?.storageKey || null) : null,
            })),
        };

        const attached = [];
        try {
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                const entry = rollbackHandle.entries[i];

                if (item.kind === "uploaded") {
                    const uf = item.uploadedFile;
                    const mediaRecord = await this.db.media.createMedia({
                        project_id: projectId,
                        user_id: userId,
                        url: uf.url,
                        step_id: item.stepId || "upload",
                        width: uf.width,
                        height: uf.height,
                        format: uf.format,
                        status: "success",
                    });
                    entry.mediaId = mediaRecord.id;
                    entry.mediaCreatedInCall = true;

                    let attachRes;
                    try {
                        attachRes = await this.db.workflowMedia.attachReferenceMedia({
                            workflowId,
                            mediaId: mediaRecord.id,
                            role,
                            maxAllowed,
                        });
                    } catch (attachErr) {
                        if (isWorkflowReferenceQuotaError(attachErr)) {
                            throw new QuotaError(attachErr.message, {
                                statusCode: 400,
                                code: "LIMIT_EXCEEDED",
                                cause: attachErr,
                            });
                        }
                        throw attachErr;
                    }

                    entry.linkCreatedInCall = !attachRes.is_existing;
                    entry.is_existing = Boolean(attachRes.is_existing);
                    if (attachRes.is_primary) {
                        rollbackHandle.primaryModified = true;
                        rollbackHandle.newPrimaryMediaId = mediaRecord.id;
                    }

                    attached.push({
                        kind: "uploaded",
                        media: mediaRecord,
                        link: attachRes,
                        is_existing: Boolean(attachRes.is_existing),
                        is_primary: Boolean(attachRes.is_primary),
                        storageKey: uf.storageKey,
                    });
                } else {
                    // kind: "existing"
                    const sourceMedia = resolvedExisting.get(item);
                    let attachRes;
                    try {
                        attachRes = await this.db.workflowMedia.attachReferenceMedia({
                            workflowId,
                            mediaId: sourceMedia.id,
                            role,
                            maxAllowed,
                        });
                    } catch (attachErr) {
                        if (isWorkflowReferenceQuotaError(attachErr)) {
                            throw new QuotaError(attachErr.message, {
                                statusCode: 400,
                                code: "LIMIT_EXCEEDED",
                                cause: attachErr,
                            });
                        }
                        throw attachErr;
                    }

                    entry.mediaId = sourceMedia.id;
                    entry.linkCreatedInCall = !attachRes.is_existing;
                    entry.is_existing = Boolean(attachRes.is_existing);
                    if (attachRes.is_primary) {
                        rollbackHandle.primaryModified = true;
                        rollbackHandle.newPrimaryMediaId = sourceMedia.id;
                    }

                    attached.push({
                        kind: "existing",
                        media: sourceMedia,
                        link: attachRes,
                        is_existing: Boolean(attachRes.is_existing),
                        is_primary: Boolean(attachRes.is_primary),
                        storageKey: null,
                    });
                }
            }

            // 7. If setPrimary was requested, switch primary to the last attached item
            if (setPrimary && attached.length > 0) {
                const targetMediaId = attached[attached.length - 1].media.id;
                rollbackHandle.primaryModified = true;
                rollbackHandle.newPrimaryMediaId = targetMediaId;

                await this.db.workflowMedia?.setPrimaryMedia?.({ workflowId, mediaId: targetMediaId });
                if (this.db.workflows?.updatePrimaryMedia) {
                    await this.db.workflows.updatePrimaryMedia(workflowId, targetMediaId).catch(() => null);
                } else if (this.db.workflows?.updateFields) {
                    await this.db.workflows.updateFields(workflowId, { primary_media_id: targetMediaId }).catch(() => null);
                }
            }

            crudOperationLog({
                traceId,
                operation: "WorkflowMediaService:attachMediaItems:success",
                status: "ok",
                durationMs: Date.now() - start,
                workflowId,
                attachedCount: attached.length,
            });

            return { attached, rollbackHandle };
        } catch (err) {
            const rollbackResult = await this.rollbackAttachedMedia(rollbackHandle, { traceId });
            if (err && typeof err === "object") {
                err.rollbackResult = rollbackResult;
                err.rollbackHandle = rollbackHandle;
            }
            throw err;
        }
    }

    /**
     * Idempotent, non-throwing compensation protocol:
     * 1. Unlinks items where linkCreatedInCall === true (is_existing === false)
     * 2. Restores or clears primary media if modified in this call (before deleting media row)
     * 3. Deletes public.media rows for "uploaded" items only (never pre-existing media)
     * 4. Discards storage keys only when media row was confirmed deleted or never created
     */
    async rollbackAttachedMedia(rollbackHandle, { traceId = null } = {}) {
        const opTraceId = traceId || randomUUID();
        const start = Date.now();

        if (!rollbackHandle || !Array.isArray(rollbackHandle.entries)) {
            return {
                unlinkedMediaIds: [],
                deletedMediaIds: [],
                discardedStorageKeys: [],
                skippedStorageKeys: [],
                restoredPrimaryMediaId: null,
            };
        }

        const { workflowId, role, previousPrimaryMediaId, primaryModified, newPrimaryMediaId, entries } = rollbackHandle;

        const unlinkedMediaIds = [];
        const deletedMediaIds = [];
        const discardedStorageKeys = [];
        const skippedStorageKeys = [];
        let restoredPrimaryMediaId = null;
        let primaryRestoreFailed = false;
        let hasFatalError = false;

        try {

        // Step 1: Unlink items where a new link was created in this call
        for (const entry of entries) {
            if (entry.linkCreatedInCall && entry.mediaId && !entry.unlinked) {
                try {
                    await this.db.workflowMedia?.unlink?.({
                        workflowId,
                        mediaId: entry.mediaId,
                        role,
                    });
                    entry.unlinked = true;
                    unlinkedMediaIds.push(entry.mediaId);
                } catch (unlinkErr) {
                    entry.unlinkFailed = true;
                    crudOperationLog({
                        traceId: opTraceId,
                        operation: "rollbackAttachedMedia:unlink",
                        status: "warning",
                        workflowId,
                        mediaId: entry.mediaId,
                        message: unlinkErr?.message,
                    });
                }
            }
        }

        // Step 2: Restore or clear primary before deleting media row
        if (primaryModified && !rollbackHandle.primaryRestored) {
            try {
                let currentMatches = false;
                if (this.db.workflows?.conditionalRestorePrimaryMedia) {
                    const res = await this.db.workflows.conditionalRestorePrimaryMedia({
                        workflowId,
                        expectedPrimaryMediaId: newPrimaryMediaId,
                        restorePrimaryMediaId: previousPrimaryMediaId || null,
                    }).catch(() => null);
                    currentMatches = Boolean(res?.updated !== false);
                } else if (this.db.workflows?.findById) {
                    const wf = await this.db.workflows.findById(workflowId, "primary_media_id").catch(() => null);
                    const currentWfPrimary = wf?.primary_media_id || null;
                    if (!currentWfPrimary || currentWfPrimary === newPrimaryMediaId) {
                        if (this.db.workflows?.updatePrimaryMedia) {
                            await this.db.workflows.updatePrimaryMedia(workflowId, previousPrimaryMediaId || null).catch(() => null);
                        } else if (this.db.workflows?.updateFields) {
                            await this.db.workflows.updateFields(workflowId, { primary_media_id: previousPrimaryMediaId || null }).catch(() => null);
                        }
                        currentMatches = true;
                    }
                } else {
                    currentMatches = true;
                }

                if (currentMatches) {
                    if (previousPrimaryMediaId) {
                        if (this.db.workflowMedia?.setPrimaryMedia) {
                            await this.db.workflowMedia.setPrimaryMedia({ workflowId, mediaId: previousPrimaryMediaId });
                        }
                        restoredPrimaryMediaId = previousPrimaryMediaId;
                    } else {
                        if (this.db.workflowMedia?.clearPrimaryMedia) {
                            await this.db.workflowMedia.clearPrimaryMedia({ workflowId }).catch(() => null);
                        }
                        restoredPrimaryMediaId = null;
                    }
                } else {
                    restoredPrimaryMediaId = null;
                }
                rollbackHandle.primaryRestored = true;
            } catch (restoreErr) {
                primaryRestoreFailed = true;
                const primaryEntry = entries.find((e) => e.mediaId === newPrimaryMediaId);
                crudOperationLog({
                    traceId: opTraceId,
                    operation: "rollbackAttachedMedia:restorePrimary",
                    status: "error",
                    workflowId,
                    mediaId: newPrimaryMediaId,
                    storageKey: primaryEntry?.storageKey || null,
                    previousPrimaryMediaId,
                    message: `Primary restore failed; media stays attached and counts toward quota: ${restoreErr?.message}`,
                });
            }
        }

        // Step 3: Delete media rows (ONLY for "uploaded" items created in this call)
        for (const entry of entries) {
            if (entry.kind === "uploaded" && entry.mediaCreatedInCall && entry.mediaId && !entry.mediaDeleted) {
                // If this entry was the new primary and primary restore failed, or if unlink failed, skip deletion!
                const isFailedPrimary = entry.mediaId === newPrimaryMediaId && primaryRestoreFailed;
                if (entry.unlinkFailed || isFailedPrimary) {
                    entry.skipDiscard = true;
                    continue;
                }

                try {
                    await this.db.media?.deleteById?.(entry.mediaId);
                    entry.mediaDeleted = true;
                    deletedMediaIds.push(entry.mediaId);
                } catch (delErr) {
                    entry.skipDiscard = true;
                    crudOperationLog({
                        traceId: opTraceId,
                        operation: "rollbackAttachedMedia:deleteMedia",
                        status: "error",
                        workflowId,
                        mediaId: entry.mediaId,
                        storageKey: entry.storageKey,
                        message: `Media deleteById failed; storageKey preserved to avoid dangling DB pointer: ${delErr?.message}`,
                    });
                }
            }
        }

        // Step 4: Discard storage keys (ONLY for "uploaded" items confirmed deleted or never created)
        const keysToDiscard = [];
        for (const entry of entries) {
            if (entry.kind === "uploaded" && entry.storageKey && !entry.discarded) {
                const canDiscard = !entry.mediaCreatedInCall || entry.mediaDeleted === true;
                if (canDiscard && !entry.skipDiscard) {
                    keysToDiscard.push(entry.storageKey);
                    entry.discarded = true;
                    discardedStorageKeys.push(entry.storageKey);
                } else {
                    skippedStorageKeys.push(entry.storageKey);
                }
            }
        }

        if (keysToDiscard.length > 0) {
            await this._discardStorage(keysToDiscard);
        }

        if (skippedStorageKeys.length > 0) {
            crudOperationLog({
                traceId: opTraceId,
                operation: "attachMediaItems:rollbackSkipDiscard",
                status: "error",
                workflowId,
                skippedStorageKeys,
                message: "Storage discard skipped for items whose media row or unlink was not confirmed",
            });
        }

        } catch (fatalErr) {
            hasFatalError = true;
            crudOperationLog({
                traceId: opTraceId,
                operation: "rollbackAttachedMedia:fatal",
                status: "error",
                message: fatalErr?.message,
                workflowId,
            });
        }

        const anyUnlinkFailed = entries.some((e) => e.unlinkFailed);
        const anyMediaNotDeleted = entries.some((e) => e.kind === "uploaded" && e.mediaCreatedInCall && !e.mediaDeleted);
        const complete = !hasFatalError &&
            !primaryRestoreFailed &&
            !anyUnlinkFailed &&
            !anyMediaNotDeleted &&
            skippedStorageKeys.length === 0;

        crudOperationLog({
            traceId: opTraceId,
            operation: "rollbackAttachedMedia:done",
            status: "ok",
            durationMs: Date.now() - start,
            workflowId,
            complete,
            unlinkedCount: unlinkedMediaIds.length,
            deletedCount: deletedMediaIds.length,
            discardedCount: discardedStorageKeys.length,
            skippedCount: skippedStorageKeys.length,
        });

        return {
            complete,
            unlinkedMediaIds,
            deletedMediaIds,
            discardedStorageKeys,
            skippedStorageKeys,
            restoredPrimaryMediaId,
        };
    }

    /**
     * Clear the primary media designation for a workflow container.
     */
    async clearPrimaryMedia({ workflowId, userId, req = null }) {
        const traceId = randomUUID();
        const start = Date.now();

        crudOperationLog({ traceId, operation: "clearPrimaryMedia", workflowId });

        try {
            if (!workflowId) {
                throw new CrudServiceError("workflowId is required", {
                    statusCode: 400,
                    errorCode: "VALIDATION_ERROR",
                    traceId,
                    operation: "clearPrimaryMedia",
                });
            }

            if (userId && this.authService?.verifyWorkflowOwnership) {
                const wfOk = await this.authService.verifyWorkflowOwnership(workflowId, userId, req);
                if (!wfOk) {
                    crudOperationLog({
                        traceId,
                        operation: "clearPrimaryMedia",
                        status: "error",
                        userId,
                        resourceId: workflowId,
                        resourceType: "workflow",
                        errorCode: "NOT_FOUND",
                        message: "Workflow not found",
                    });
                    throw new CrudServiceError("Workflow not found", {
                        statusCode: 404,
                        errorCode: "NOT_FOUND",
                        traceId,
                        operation: "clearPrimaryMedia",
                    });
                }
            }

            if (this.db.workflowMedia?.clearPrimaryMedia) {
                await this.db.workflowMedia.clearPrimaryMedia({ workflowId });
            }

            crudOperationLog({
                traceId,
                operation: "clearPrimaryMedia",
                status: "ok",
                durationMs: Date.now() - start,
                workflowId,
            });

            return {
                workflow_id: workflowId,
                primary_media_id: null,
                primaryMediaId: null,
                is_primary: false,
            };
        } catch (err) {
            crudOperationLog({
                traceId,
                operation: "clearPrimaryMedia",
                status: "error",
                durationMs: Date.now() - start,
                errorCode: err.errorCode || 500,
                message: err.message,
            });
            throw err;
        }
    }

    /**
     * Set the primary media for a workflow container.
     */
    async setPrimaryMedia({ workflowId, mediaId, userId, req = null }) {
        const traceId = randomUUID();
        const start = Date.now();

        crudOperationLog({ traceId, operation: "setPrimaryMedia", workflowId, mediaId });

        try {
            if (mediaId === null) {
                return this.clearPrimaryMedia({ workflowId, userId, req });
            }
            if (!mediaId) {
                throw new CrudServiceError("media_id is required", {
                    statusCode: 400,
                    errorCode: "VALIDATION_ERROR",
                    traceId,
                    operation: "setPrimaryMedia",
                });
            }

            const [wfOk, mediaOk] = await Promise.all([
                this.authService.verifyWorkflowOwnership(workflowId, userId, req),
                this.authService.verifyMediaOwnership(mediaId, userId, req),
            ]);

            if (!wfOk) {
                crudOperationLog({
                    traceId,
                    operation: "setPrimaryMedia",
                    status: "error",
                    userId,
                    resourceId: workflowId,
                    resourceType: "workflow",
                    errorCode: "NOT_FOUND",
                    message: "Workflow not found",
                });
                throw new CrudServiceError("Workflow not found", {
                    statusCode: 404,
                    errorCode: "NOT_FOUND",
                    traceId,
                    operation: "setPrimaryMedia",
                });
            }
            if (!mediaOk) {
                crudOperationLog({
                    traceId,
                    operation: "setPrimaryMedia",
                    status: "error",
                    userId,
                    resourceId: mediaId,
                    resourceType: "media",
                    errorCode: "NOT_FOUND",
                    message: "Media not found",
                });
                throw new CrudServiceError("Media not found", {
                    statusCode: 404,
                    errorCode: "NOT_FOUND",
                    traceId,
                    operation: "setPrimaryMedia",
                });
            }

            await assertMediaUsable({ media_id: mediaId, workflow_id: workflowId }, { allowProcessing: true, db: this.db });

            if (this.db.workflowMedia?.setPrimaryMedia) {
                await this.db.workflowMedia.setPrimaryMedia({ workflowId, mediaId });
            }

            crudOperationLog({
                traceId,
                operation: "setPrimaryMedia",
                status: "ok",
                durationMs: Date.now() - start,
                workflowId,
                mediaId,
            });

            return {
                primary_media_id: mediaId,
                primaryMediaId: mediaId,
                media_id: mediaId,
                workflow_id: workflowId,
                is_primary: true,
            };
        } catch (err) {
            crudOperationLog({
                traceId,
                operation: "setPrimaryMedia",
                status: "error",
                durationMs: Date.now() - start,
                errorCode: err.errorCode || 500,
                message: err.message,
            });
            throw err;
        }
    }

    /**
     * Detach a media item into its own independent workflow container.
     */
    async detachMedia({ mediaId, projectId, displayName, userId, req = null }) {
        const traceId = randomUUID();
        const start = Date.now();

        crudOperationLog({ traceId, operation: "detachMedia", mediaId });

        try {
            if (!mediaId) {
                throw new CrudServiceError("media_id is required", {
                    statusCode: 400,
                    errorCode: "VALIDATION_ERROR",
                    traceId,
                    operation: "detachMedia",
                });
            }

            const isAuthorized = await this.authService.verifyMediaOwnership(mediaId, userId, req);
            if (!isAuthorized) {
                crudOperationLog({
                    traceId,
                    operation: "detachMedia",
                    status: "error",
                    userId,
                    resourceId: mediaId,
                    resourceType: "media",
                    errorCode: "NOT_FOUND",
                    message: "Media not found",
                });
                throw new CrudServiceError("Media not found", {
                    statusCode: 404,
                    errorCode: "NOT_FOUND",
                    traceId,
                    operation: "detachMedia",
                });
            }

            const { data: media, error: mediaErr } = await this.db.media.client()
                .from("media")
                .select("*")
                .eq("id", mediaId)
                .single();
            if (mediaErr) throw mediaErr;

            const status = (media.status || "").toString().toLowerCase();
            if (["processing", "pending", "uploading"].includes(status)) {
                throw new CrudServiceError("Cannot detach media while generation is in progress", {
                    statusCode: 403,
                    errorCode: "MEDIA_BUSY",
                    traceId,
                    operation: "detachMedia",
                });
            }

            let currentWorkflowId = null;
            if (this.db.workflowMedia?.findByMedia) {
                const links = await this.db.workflowMedia.findByMedia(mediaId).catch(() => []);
                currentWorkflowId = links[0]?.workflow_id || null;
            }
            const currentWorkflow = currentWorkflowId && this.db.workflows?.findById
                ? await this.db.workflows.findById(currentWorkflowId).catch(() => null)
                : null;

            const inferredProjectId = projectId || media.project_id || currentWorkflow?.project_id;
            const inferredUserId = userId || media.user_id || currentWorkflow?.user_id || null;
            const newName = displayName || currentWorkflow?.display_name || "Detached media";

            // 1. Create new standalone workflow container
            const newWorkflow = await this.db.workflows.createWorkflow({
                project_id: inferredProjectId,
                user_id: inferredUserId,
                display_name: newName,
            });

            // 2. Move workflow_media relation to the new workflow and sync project_id on media
            if (currentWorkflowId && this.db.workflowMedia?.unlink) {
                await this.db.workflowMedia.unlink({
                    workflowId: currentWorkflowId,
                    mediaId,
                }).catch(() => null);
            }
            await createMediaInWorkflow(this.db, {
                workflowId: newWorkflow.id,
                mediaId,
                stepId: media.step_id,
                operation: "detachMedia:linkWorkflowMedia",
            });
            await this.db.media.updateFields(mediaId, {
                project_id: inferredProjectId,
            });

            // 3. Set primary media on the new workflow
            if (this.db.workflowMedia?.setPrimaryMedia) {
                await this.db.workflowMedia.setPrimaryMedia({ workflowId: newWorkflow.id, mediaId });
            } else if (this.db.workflows?.updateFields) {
                await this.db.workflows.updateFields(newWorkflow.id, { primary_media_id: mediaId }).catch(() => null);
            }
            const updatedWorkflow = { ...newWorkflow, primary_media_id: mediaId, primaryMediaId: mediaId };

            // 4. If this was the primary media of the old workflow, clear primary pin (never auto-promote)
            if (currentWorkflowId) {
                if (this.db.workflowMedia?.clearPrimaryMedia) {
                    await this.db.workflowMedia.clearPrimaryMedia({ workflowId: currentWorkflowId }).catch(() => null);
                }
                if (this.db.workflows?.updatePrimaryMedia) {
                    await this.db.workflows.updatePrimaryMedia(currentWorkflowId, null).catch(() => null);
                }
                if (this.db.workflows?.updateFields) {
                    await this.db.workflows.updateFields(currentWorkflowId, {
                        primary_media_id: null,
                    }).catch(() => null);
                }
            }

            crudOperationLog({
                traceId,
                operation: "detachMedia",
                status: "ok",
                durationMs: Date.now() - start,
                mediaId,
                newWorkflowId: newWorkflow.id,
            });

            return { workflow: updatedWorkflow };
        } catch (err) {
            crudOperationLog({
                traceId,
                operation: "detachMedia",
                status: "error",
                durationMs: Date.now() - start,
                errorCode: err.errorCode || 500,
                message: err.message,
            });
            throw err;
        }
    }

    /**
     * Deletes a media row, its generation_config_reference rows, and its storage object.
     */
    async _deleteOrphanMedia(media) {
        if (!media?.id) return false;

        await this.db.media.deleteById(media.id);

        if (media.url) {
            await this.storageService.deleteByUrl(media.url).catch((storageErr) => {
                logger.warn(
                    {
                        mediaId: media.id,
                        storagePath: sanitizeStoragePath(media.url),
                        message: storageErr.message,
                    },
                    "orphan media: storage delete notice"
                );
            });
        }

        return true;
    }

    /**
     * Removes every workflow_media link for a workflow. Does not delete the workflow.
     * Media that still belongs to another workflow is kept.
     * Media with no remaining workflow is deleted (row + storage).
     */
    async releaseWorkflowMedia({ workflowId }) {
        if (!workflowId) {
            return { unlinkedMediaIds: [], deletedOrphanIds: [] };
        }

        const mediaItems = await this.db.media.findByWorkflow(workflowId).catch(() => []);
        const unlinkedMediaIds = [...new Set(mediaItems.map((m) => m.id).filter(Boolean))];

        if (this.db.workflows?.updatePrimaryMedia) {
            await this.db.workflows.updatePrimaryMedia(workflowId, null).catch(() => null);
        } else if (this.db.workflows?.updateFields) {
            await this.db.workflows.updateFields(workflowId, { primary_media_id: null }).catch(() => null);
        }

        const deletedOrphanIds = [];

        // Atomic unlink-and-reap protocol per media item
        if (typeof this.db.workflowMedia?.unlinkAndReapOrphan === "function") {
            for (const media of mediaItems) {
                if (!media?.id) continue;
                const reapResult = await this.db.workflowMedia.unlinkAndReapOrphan({
                    workflowId,
                    mediaId: media.id,
                });
                if (reapResult?.unlinked) {
                    if (reapResult.is_orphan) {
                        deletedOrphanIds.push(media.id);
                        if (this.db.media?.deleteById) {
                            await this.db.media.deleteById(media.id).catch(() => null);
                        }
                        const storageUrl = reapResult.storage_url || media.url;
                        if (storageUrl && this.storageService?.deleteByUrl) {
                            await this.storageService.deleteByUrl(storageUrl).catch((storageErr) => {
                                logger.warn(
                                    { mediaId: media.id, storagePath: sanitizeStoragePath(storageUrl), message: storageErr.message },
                                    "releaseWorkflowMedia: storage delete notice"
                                );
                            });
                        }
                    }
                }
            }
            // Cleanup any residual workflow associations without media items
            if (this.db.workflowMedia?.unlinkByWorkflow) {
                await this.db.workflowMedia.unlinkByWorkflow(workflowId).catch(() => null);
            }
            return { unlinkedMediaIds, deletedOrphanIds };
        }

        // Legacy sequential fallback for minimal mock harnesses
        if (this.db.workflowMedia?.unlinkByWorkflow) {
            await this.db.workflowMedia.unlinkByWorkflow(workflowId);
        }
        for (const media of mediaItems) {
            if (!media?.id) continue;

            const remainingLinks = this.db.workflowMedia?.countLinksForMedia
                ? await this.db.workflowMedia.countLinksForMedia(media.id).catch(() => 0)
                : 0;

            if (remainingLinks > 0) {
                continue;
            }

            await this._deleteOrphanMedia(media);
            deletedOrphanIds.push(media.id);
        }

        return { unlinkedMediaIds, deletedOrphanIds };
    }

    /**
     * Dry-run review utility that inspects candidate media rows against `workflow_media`
     * and lists candidate orphan media IDs and sanitized storage paths without performing any deletions.
     *
     * Safety gate: Strictly read-only (`dryRun: true`). Never mutates DB or storage.
     */
    async scanOrphanMediaDryRun({ projectId = null, limit = 500 } = {}) {
        let candidates = [];

        if (typeof this.db.media?.listAll === "function") {
            candidates = await this.db.media.listAll({ projectId, limit }).catch(() => []);
        } else if (projectId && typeof this.db.media?.findByProject === "function") {
            const res = await this.db.media.findByProject(projectId, { limit }).catch(() => []);
            candidates = Array.isArray(res) ? res : (res?.data || []);
        } else if (typeof this.db.media?.client === "function") {
            let query = this.db.media.client()
                .from("media")
                .select("id, url, project_id");
            if (projectId) {
                query = query.eq("project_id", projectId);
            }
            if (limit) {
                query = query.limit(limit);
            }
            const { data } = await query;
            candidates = data || [];
        }

        const orphanMediaIds = [];
        const orphanStoragePaths = [];

        for (const media of candidates) {
            if (!media?.id) continue;

            let linkCount = 0;
            if (typeof this.db.workflowMedia?.countLinksForMedia === "function") {
                linkCount = await this.db.workflowMedia.countLinksForMedia(media.id).catch(() => 0);
            } else if (typeof this.db.workflowMedia?.findByMedia === "function") {
                const links = await this.db.workflowMedia.findByMedia(media.id).catch(() => []);
                linkCount = Array.isArray(links) ? links.length : 0;
            }

            if (linkCount === 0) {
                orphanMediaIds.push(media.id);
                if (media.url) {
                    const cleanPath = sanitizeStoragePath(media.url);
                    if (cleanPath) {
                        orphanStoragePaths.push(cleanPath);
                    }
                }
            }
        }

        return {
            dryRun: true,
            orphanMediaIds,
            orphanStoragePaths,
            count: orphanMediaIds.length,
        };
    }

    /**
     * Delete a single media record, clean up its storage file, and update workflow status.
     *
     * When `workflowId` is supplied the method removes only the specific
     * workflow_media association.  The media row and storage file are deleted
     * only when no associations remain anywhere (orphan check).  When
     * `workflowId` is NOT supplied (legacy behaviour via DELETE /workflows/media/:id)
     * ALL associations are removed before the orphan check.
     */
    async deleteMedia({ mediaId, workflowId = null, userId, req = null }) {
        const traceId = randomUUID();
        const start = Date.now();

        crudOperationLog({ traceId, operation: "deleteMedia", mediaId, workflowId });

        try {
            if (!mediaId) {
                throw new CrudServiceError("media_id is required", {
                    statusCode: 400,
                    errorCode: "VALIDATION_ERROR",
                    traceId,
                    operation: "deleteMedia",
                });
            }

            // Cross-tenant refusal on mediaId: verify media ownership first so foreign media access returns 404
            // without leaking whether workflow context was present.
            if (userId && this.authService?.verifyMediaOwnership) {
                const mediaAuthorized = await this.authService.verifyMediaOwnership(mediaId, userId, req).catch(() => false);
                if (!mediaAuthorized) {
                    crudOperationLog({
                        traceId,
                        operation: "deleteMedia",
                        status: "error",
                        userId,
                        resourceId: mediaId,
                        resourceType: "media",
                        errorCode: "NOT_FOUND",
                        message: "Media not found",
                    });
                    throw new CrudServiceError("Media not found", {
                        statusCode: 404,
                        errorCode: "NOT_FOUND",
                        traceId,
                        operation: "deleteMedia",
                    });
                }
            }

            if (!workflowId) {
                throw new CrudServiceError("workflow_id is required", {
                    statusCode: 400,
                    errorCode: "VALIDATION_ERROR",
                    traceId,
                    operation: "deleteMedia",
                });
            }

            if (userId && this.authService?.verifyWorkflowOwnership) {
                const wfAuthorized = await this.authService.verifyWorkflowOwnership(workflowId, userId, req).catch(() => false);
                if (!wfAuthorized) {
                    crudOperationLog({
                        traceId,
                        operation: "deleteMedia",
                        status: "error",
                        userId,
                        resourceId: workflowId,
                        resourceType: "workflow",
                        errorCode: "NOT_FOUND",
                        message: "Workflow not found",
                    });
                    throw new CrudServiceError("Workflow not found", {
                        statusCode: 404,
                        errorCode: "NOT_FOUND",
                        traceId,
                        operation: "deleteMedia",
                    });
                }
            }

            const mediaRec = await this.db.media.findById(mediaId, "id, url");

            // Collect existing links BEFORE unlinking so we know which workflow
            // containers may become empty afterward.
            const existingLinks = this.db.workflowMedia?.findByMedia
                ? await this.db.workflowMedia.findByMedia(mediaId).catch(() => [])
                : [];
            const affectedWorkflowIds = [...new Set(existingLinks.map((row) => row?.workflow_id).filter(Boolean))];

            let isOrphan = false;
            let storageUrlToDelete = null;

            // 1. Atomic unlink and orphan evaluation in single transaction (concurrency-safe path)
            if (typeof this.db.workflowMedia?.unlinkAndReapOrphan !== "function") {
                throw new CrudServiceError("Media deletion service temporarily unavailable: atomic cleanup RPC is not installed", {
                    statusCode: 503,
                    errorCode: "SERVICE_UNAVAILABLE",
                    traceId,
                    operation: "deleteMedia",
                });
            }

            let reapResult;
            try {
                reapResult = await this.db.workflowMedia.unlinkAndReapOrphan({
                    workflowId,
                    mediaId,
                });
            } catch (err) {
                if (err.code === "RPC_UNAVAILABLE" || err.statusCode === 503) {
                    throw new CrudServiceError("Media deletion service temporarily unavailable: atomic cleanup RPC is not installed", {
                        statusCode: 503,
                        errorCode: "SERVICE_UNAVAILABLE",
                        traceId,
                        operation: "deleteMedia",
                    });
                }
                throw err;
            }

            if (!reapResult?.unlinked) {
                // Relation was already unlinked or media already removed concurrently
                return {
                    deleted: false,
                    media: null,
                    workflow_deleted: false,
                    next_primary_media_id: null,
                };
            }

            isOrphan = Boolean(reapResult.is_orphan);
            storageUrlToDelete = reapResult.storage_url || mediaRec?.url || null;

            // 2. Only delete the media record and storage when it has become a true orphan.
            if (!isOrphan) {
                crudOperationLog({
                    traceId,
                    operation: "deleteMedia",
                    status: "ok",
                    durationMs: Date.now() - start,
                    mediaId,
                    workflowId,
                    workflowDeleted: false,
                    note: "media preserved — still linked elsewhere",
                });

                // Check if the targeted workflow container should be cleaned up or primary_media cleared
                let workflowDeleted = false;
                if (workflowId && this.db.workflows) {
                    const remainingWfMedia = this.db.workflowMedia?.findByWorkflow
                        ? await this.db.workflowMedia.findByWorkflow(workflowId).catch(() => [])
                        : [];
                    if (remainingWfMedia.length === 0) {
                        const wfRec = await this.db.workflows?.findById
                            ? await this.db.workflows.findById(workflowId, "id, primary_media_id, workflow_type").catch(() => null)
                            : null;
                        const sidecarPreserved = await this._hasSidecarEntity(workflowId, wfRec).catch(() => false);
                        if (!sidecarPreserved && this.db.workflows?.deleteById) {
                            await this.db.workflows.deleteById(workflowId).catch((wfErr) => {
                                logger.warn({ workflowId, message: wfErr.message }, "deleteMedia: delete workflow notice");
                            });
                            workflowDeleted = true;
                        }
                    } else if (this.db.workflows?.findById && this.db.workflows?.updatePrimaryMedia) {
                        const wfRec = await this.db.workflows.findById(workflowId, "primary_media_id").catch(() => null);
                        if (wfRec?.primary_media_id === mediaId) {
                            await this.db.workflows.updatePrimaryMedia(workflowId, null).catch(() => null);
                        }
                    }
                }

                return {
                    deleted: false,
                    media: null,
                    workflow_deleted: workflowDeleted,
                    next_primary_media_id: null,
                };
            }

            // 3. Delete media record (only reached when isOrphan === true)
            // Note: If unlinkAndReapOrphan ran via RPC, the media record was already deleted in PostgreSQL.
            // If deleteById exists, ensure DB state is cleaned up in memory/mocks as well.
            let deleted = null;
            if (this.db.media?.deleteById) {
                deleted = await this.db.media.deleteById(mediaId).catch(() => null);
            }

            // 4. Delete storage file only if this media is now a true orphan
            if (isOrphan && storageUrlToDelete) {
                await this.storageService.deleteByUrl(storageUrlToDelete).catch((storageErr) => {
                    logger.warn(
                        {
                            mediaId,
                            storagePath: sanitizeStoragePath(storageUrlToDelete),
                            message: storageErr.message,
                        },
                        "deleteMedia: storage delete notice"
                    );
                });
            }

            let workflowDeleted = false;
            const nextPrimaryMediaId = null;

            // 6. Check remaining media on affected workflow containers
            for (const wfId of affectedWorkflowIds) {
                const remainingMedia = await this.db.media.findByWorkflow(wfId).catch(() => []);

                if (!remainingMedia || remainingMedia.length === 0) {
                    const workflowRecord = await this.db.workflows?.findById
                        ? await this.db.workflows.findById(wfId, "id, primary_media_id, workflow_type").catch(() => null)
                        : null;
                    const hasSidecar = await this._hasSidecarEntity(wfId, workflowRecord);

                    if (hasSidecar) {
                        // Preserve workflow container when a character or element sidecar is attached
                        if (this.db.workflowMedia?.clearPrimaryMedia) {
                            await this.db.workflowMedia.clearPrimaryMedia({ workflowId: wfId }).catch(() => null);
                        }
                        if (this.db.workflows?.updatePrimaryMedia) {
                            await this.db.workflows.updatePrimaryMedia(wfId, null).catch(() => null);
                        } else if (this.db.workflows?.updateFields) {
                            await this.db.workflows.updateFields(wfId, { primary_media_id: null }).catch(() => null);
                        }
                    } else {
                        // Empty plain workflow: delete workflow container
                        if (this.db.workflows?.deleteById) {
                            await this.db.workflows.deleteById(wfId).catch((wfErr) => {
                                logger.warn({ workflowId: wfId, message: wfErr.message }, "deleteMedia: delete workflow notice");
                            });
                        }
                        workflowDeleted = true;
                    }
                } else {
                    if (this.db.workflowMedia?.clearPrimaryMedia) {
                        await this.db.workflowMedia.clearPrimaryMedia({ workflowId: wfId }).catch(() => null);
                    }
                    if (this.db.workflows?.updatePrimaryMedia) {
                        await this.db.workflows.updatePrimaryMedia(wfId, null).catch(() => null);
                    } else if (this.db.workflows?.updateFields) {
                        await this.db.workflows.updateFields(wfId, { primary_media_id: null }).catch(() => null);
                    }
                }
            }

            crudOperationLog({
                traceId,
                operation: "deleteMedia",
                status: "ok",
                durationMs: Date.now() - start,
                mediaId,
                workflowDeleted,
            });

            return {
                deleted: true,
                media: deleted,
                workflow_deleted: workflowDeleted,
                next_primary_media_id: nextPrimaryMediaId,
            };
        } catch (err) {
            crudOperationLog({
                traceId,
                operation: "deleteMedia",
                status: "error",
                durationMs: Date.now() - start,
                errorCode: err.errorCode || 500,
                message: err.message,
            });
            throw err;
        }
    }

    /**
     * Checks whether a workflow container is referenced by a Character or Element sidecar entity,
     * or is typed as a character/element workflow.
     */
    async _hasSidecarEntity(workflowId, workflowRecord = null) {
        if (!workflowId) return false;

        const wfType = String(workflowRecord?.workflow_type || "").toUpperCase();
        if (
            wfType === "CHARACTER" ||
            wfType === "CHARACTER_SHEET" ||
            wfType === "ELEMENT" ||
            wfType === "ELEMENT_SHEET"
        ) {
            return true;
        }

        if (this.db.characters?.findByCharacterId) {
            const char = await this.db.characters.findByCharacterId(workflowId).catch(() => null);
            if (char) return true;
        } else if (this.db.characters?.findByWorkflowId) {
            const char = await this.db.characters.findByWorkflowId(workflowId).catch(() => null);
            if (char) return true;
        }

        if (this.db.elements?.findByWorkflowId) {
            const elem = await this.db.elements.findByWorkflowId(workflowId).catch(() => null);
            if (elem) return true;
        } else if (this.db.elements?.resolveRecord) {
            const elem = await this.db.elements.resolveRecord(workflowId).catch(() => null);
            if (elem) return true;
        }

        return false;
    }
}

/**
 * Strips query parameters, hash fragments, and host origins from a storage URL
 * so that signed tokens (`?token=...`) are never leaked in logs or dry-run reports.
 */
export function sanitizeStoragePath(rawUrl) {
    if (!rawUrl || typeof rawUrl !== "string") return "";
    const trimmed = rawUrl.trim();
    if (!trimmed) return "";
    try {
        if (/^https?:\/\//i.test(trimmed)) {
            const parsed = new URL(trimmed);
            return parsed.pathname || "";
        }
    } catch {
        // Fallback to query/hash stripping below
    }
    return trimmed.split(/[?#]/)[0];
}

export default WorkflowMediaService;
