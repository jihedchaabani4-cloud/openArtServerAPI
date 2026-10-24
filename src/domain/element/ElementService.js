/**
 * ElementService
 * Application / Domain Service for the AI Element Reference System — V1 Direct Save
 * Feature: 018-element-reference-system
 *
 * Clean Architecture Boundary:
 *   - Orchestrates Element lifecycle: create, read, update, delete, prompt-building.
 *   - Coordinates with ElementMediaService for storage/media DB rows.
 *   - Follows ADR-0007, ADR-0009, and ADR-0010:
 *       - Eliminates sourceImages from creation contract (images optional at creation).
 *       - workflow_media.is_primary is the single source of truth for Element Cover.
 *       - Reference images are dynamically derived from workflow_media with role = 'detail'.
 *       - Keeps public DTO compatible (source_images_count as alias for reference_images_count).
 */

import { randomUUID } from "node:crypto";
import { crudOperationLog, CrudServiceError } from "../../utils/crudOperationLog.js";
import { elementRepository } from "../../db/ElementRepository.js";
import { WorkflowRepository } from "../../db/WorkflowRepository.js";
import { MediaRepository } from "../../db/MediaRepository.js";
import { WorkflowMediaRepository } from "../../db/WorkflowMediaRepository.js";
import { ElementMediaService } from "./ElementMediaService.js";
import { ElementAnalysisService } from "./ElementAnalysisService.js";
import promptBuilderProService from "./promptBuilderProService.js";
import { createLogger } from "../../infrastructure/logging/index.js";

const logger = createLogger("element_service");

// ─── Default repos (singleton fallbacks) ──────────────────────────────────────

const defaultMediaRepo         = new MediaRepository();
const defaultWorkflowRepo      = new WorkflowRepository();
const defaultWorkflowMediaRepo = new WorkflowMediaRepository();

// ─── Input validation ──────────────────────────────────────────────────────────

function validateCreateInputs({ name, projectId, project_id }) {
    const pId = projectId || project_id;
    if (!pId) {
        throw new CrudServiceError("projectId is required to create an element", {
            statusCode: 400, errorCode: "VALIDATION_ERROR", operation: "createElement",
        });
    }
    if (!name || typeof name !== "string" || !name.trim()) {
        throw new CrudServiceError("Element name is required", {
            statusCode: 400, errorCode: "VALIDATION_ERROR", operation: "createElement",
        });
    }
}

// ─── Service class ─────────────────────────────────────────────────────────────

export class ElementService {
    /**
     * @param {Object} deps
     * @param {Object} deps.db                       - { elements, workflows, media, workflowMedia }
     * @param {Object} [deps.storageService]
     * @param {Object} [deps.workflowService]
     * @param {Object} [deps.mediaIngestionService]
     * @param {Object} [deps.mediaService]           - ElementMediaService instance
     * @param {Object} [deps.analysisService]        - ElementAnalysisService instance
     */
    constructor({
        db,
        storageService        = null,
        workflowService       = null,
        mediaIngestionService = null,
        mediaService          = null,
        elementMediaService   = null,
        analysisService       = null,
    } = {}) {
        this.db = {
            elements:      db?.elements      || elementRepository,
            workflows:     db?.workflows     || defaultWorkflowRepo,
            media:         db?.media         || defaultMediaRepo,
            workflowMedia: db?.workflowMedia || defaultWorkflowMediaRepo,
        };
        this.storageService        = storageService;
        this.workflowService       = workflowService;
        this.mediaIngestionService = mediaIngestionService;
        const resolvedMediaService = mediaService || elementMediaService;
        if (!resolvedMediaService) {
            throw new Error("ElementService requires mediaService (ElementMediaService)");
        }
        this.mediaService          = resolvedMediaService;
        this.analysisService = analysisService || new ElementAnalysisService();
    }

    // ── CREATE ─────────────────────────────────────────────────────────────────

    /**
     * Create and persist a new Element and its workflow container.
     * Initial images are optional. If supplied, they are attached via canonical workflow_media relations.
     */
    async createElement({ name, description, projectId, project_id, tags = [], userId, element_type, type, images, imageUrls, sourceImages }) {
        const traceId    = randomUUID();
        const start      = Date.now();
        const pId        = projectId || project_id;
        const elementType = element_type || type || "object";

        crudOperationLog({ traceId, operation: "createElement:start", name, projectId: pId, elementType });

        try {
            validateCreateInputs({ name, projectId: pId });
            const safeUserId = userId || "anonymous";

            const initialImages = Array.isArray(images)
                ? images
                : (Array.isArray(imageUrls) ? imageUrls : (Array.isArray(sourceImages) ? sourceImages : []));

            if (initialImages.length > 6) {
                throw new CrudServiceError("Maximum 6 reference images allowed", {
                    statusCode: 400, errorCode: "VALIDATION_ERROR", operation: "createElement",
                });
            }

            // 1. Workflow container
            const workflow = await this.db.workflows.createWorkflow({
                project_id:    pId,
                workflow_type: "ELEMENT_SHEET",
                display_name:  name.trim(),
                user_id:       userId || (safeUserId !== "anonymous" ? safeUserId : null),
            });

            // 2. Persist element domain record
            const element = await this.db.elements.create({
                workflow_id:      workflow.id,
                name:             name.trim(),
                element_type:     elementType,
                description:      description?.trim() || null,
                tags,
            });

            // 3. Attach initial images if provided
            let mediaRecords = [];
            let primaryMedia = null;
            let storageUrls = [];

            if (initialImages.length > 0) {
                if (this.mediaService?.ingestElementSources) {
                    const ingested = await this.mediaService.ingestElementSources({
                        workflowId: workflow.id,
                        sourceImages: initialImages,
                        projectId: pId,
                        userId: safeUserId,
                    });
                    mediaRecords = ingested.mediaRecords || [];
                    primaryMedia = ingested.primaryMedia || mediaRecords[0] || null;
                    storageUrls = ingested.storageUrls || [];
                } else if (this.mediaService?.addReferenceMedia) {
                    for (let i = 0; i < initialImages.length; i++) {
                        const added = await this.mediaService.addReferenceMedia({
                            elementId: element.id,
                            source: initialImages[i],
                            projectId: pId,
                            userId: safeUserId,
                        });
                        if (added?.media) {
                            mediaRecords.push(added.media);
                            if (i === 0) primaryMedia = added.media;
                            if (added.url) storageUrls.push(added.url);
                        }
                    }
                }
            }

            // 4. Background vision analysis if initial images were attached
            if (this.analysisService && storageUrls.length > 0) {
                this.analysisService
                    .analyzeElement({ projectId: pId, workflowId: workflow.id, imageUrls: storageUrls, elementName: name.trim(), elementType, userId: safeUserId })
                    .catch((err) => logger.warn({ message: err.message }, "[ElementService] Background vision analysis error"));
            }

            crudOperationLog({ traceId, operation: "createElement:success", status: "ok", durationMs: Date.now() - start, elementId: element.id, workflowId: workflow.id });

            return {
                element: {
                    ...element,
                    primary_media_id: primaryMedia?.id || null,
                    primary_media_url: primaryMedia?.url || null,
                    reference_images_count: mediaRecords.length,
                    source_images_count: mediaRecords.length,
                },
                workflow: {
                    id:               workflow.id,
                    name:             workflow.id,
                    project_id:       pId,
                    workflow_type:    "ELEMENT_SHEET",
                    element_type:     elementType,
                    tags:             [elementType],
                    display_name:     name.trim(),
                    primary_media_id: primaryMedia?.id || null,
                    items:            mediaRecords,
                    metadata: {
                        displayName: name.trim(),
                        elementType,
                        createTime:  workflow.create_time || new Date().toISOString(),
                    },
                },
                media: mediaRecords,
            };
        } catch (err) {
            crudOperationLog({ traceId, operation: "createElement:error", status: "error", durationMs: Date.now() - start, errorCode: err.statusCode || 500, message: err.message });
            throw err;
        }
    }

    // ── READ ───────────────────────────────────────────────────────────────────

    /**
     * List all elements for a project with cover thumbnail URL resolved from is_primary.
     */
    async listProjectElements(projectId) {
        const traceId = randomUUID();
        const start   = Date.now();

        try {
            const elements = await this.db.elements.list({ projectId });

            const workflowIds = elements.map((el) => el.workflow_id).filter(Boolean);
            const detailCountsByWorkflow = new Map();
            if (workflowIds.length > 0 && this.db.workflowMedia?.findByWorkflowIds) {
                try {
                    const links = await this.db.workflowMedia.findByWorkflowIds(workflowIds);
                    for (const link of (links || [])) {
                        if (link.role === "detail" || !link.role) {
                            const count = detailCountsByWorkflow.get(link.workflow_id) || 0;
                            detailCountsByWorkflow.set(link.workflow_id, count + 1);
                        }
                    }
                } catch {
                    // Non-fatal fallback
                }
            }

            const enriched = await Promise.all(
                elements.map(async (el) => {
                    const primaryUrl = el.workflow_id
                        ? await this.db.workflows.getPrimaryMediaUrl(el.workflow_id).catch(() => null)
                        : null;
                    const count = detailCountsByWorkflow.get(el.workflow_id) || 0;
                    return {
                        id:                      el.id,
                        name:                    el.name,
                        description:             el.description,
                        primary_media_url:       primaryUrl,
                        reference_images_count:  count,
                        source_images_count:     count, // compatibility alias
                        tags:                    el.tags || [],
                        workflow_id:             el.workflow_id,
                        created_at:              el.create_time,
                    };
                })
            );

            crudOperationLog({ traceId, operation: "listProjectElements", status: "ok", durationMs: Date.now() - start, count: enriched.length });
            return enriched;
        } catch (err) {
            crudOperationLog({ traceId, operation: "listProjectElements", status: "error", durationMs: Date.now() - start, message: err.message });
            throw err;
        }
    }

    /**
     * Retrieve full element details with reference image URLs and cover resolved from is_primary.
     */
    async getElementById(id) {
        const traceId = randomUUID();

        try {
            const element = await this.db.elements.resolveRecord(id);
            if (!element) return null;

            const mediaRecords = element.workflow_id
                ? await this.db.media.findByWorkflow(element.workflow_id).catch(() => [])
                : [];
            const referenceImages = mediaRecords.map((m) => m.url).filter(Boolean);

            const primaryUrl = element.workflow_id
                ? await this.db.workflows.getPrimaryMediaUrl(element.workflow_id).catch(() => null)
                : null;

            crudOperationLog({ traceId, operation: "getElementById", status: "ok", elementId: id });

            return {
                ...element,
                reference_images:        referenceImages,
                primary_media_url:       primaryUrl,
                reference_images_count:  referenceImages.length,
                source_images_count:     referenceImages.length, // compatibility alias
            };
        } catch (err) {
            crudOperationLog({ traceId, operation: "getElementById", status: "error", message: err.message });
            throw err;
        }
    }

    /**
     * Explicitly set or switch the element's cover media via atomic primary RPC.
     */
    async setElementCover({ elementId, mediaId, userId }) {
        if (!mediaId) {
            throw new CrudServiceError("mediaId is required", { statusCode: 400, errorCode: "VALIDATION_ERROR" });
        }
        return this.updateElement(elementId, { primaryMediaId: mediaId }, userId);
    }

    /**
     * Generic workflow-level primary media setter for elements.
     */
    async setPrimaryMedia({ elementId, mediaId, userId }) {
        return this.setElementCover({ elementId, mediaId, userId });
    }

    /**
     * Resolve element by name or UUID and return generation context for prompt-building.
     */
    async getElementContextForPrompt({ nameOrId, projectId }) {
        try {
            const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            let element = UUID_RE.test(nameOrId)
                ? await this.db.elements.findById(nameOrId)
                : null;

            if (!element) {
                element = await this.db.elements.findByName(nameOrId, projectId);
            }
            if (!element) return null;

            const mediaRecords = element.workflow_id
                ? await this.db.media.findByWorkflow(element.workflow_id).catch(() => [])
                : [];

            return {
                name:              element.name,
                description:       element.description || null,
                referenceImageUrls: mediaRecords.map((m) => m.url).filter(Boolean),
                contextNote:       element.description
                    ? `Element Context (${element.name}): ${element.description}`
                    : null,
            };
        } catch (err) {
            logger.error({ nameOrId, projectId, message: err.message }, "[ElementService] getElementContextForPrompt error");
            return null;
        }
    }

    // ── UPDATE ─────────────────────────────────────────────────────────────────

    /**
     * Partial update — only fields present in patchData are written to the DB.
     * Allowed: name, description, guidelines, primary_media_id.
     * Immutable (silently stripped): element_type, type, elementType.
     */
    /**
     * Partial update — only explicitly provided fields are updated.
     * Allowed entity fields: name, description, guidelines, tags.
     * Cover lifecycle: optional coverMediaId (preserves current Cover when omitted; clears Cover when null;
     * updates Cover atomically when provided as mediaId belonging to the workflow).
     * Omitted fields remain strictly unchanged.
     */
    async updateElement(id, patchData = {}, userId = null) {
        const traceId = randomUUID();
        const start   = Date.now();

        const existing = await this.db.elements.resolveRecord(id);
        if (!existing) {
            throw new CrudServiceError(`Element not found: ${id}`, {
                statusCode: 404, errorCode: "NOT_FOUND", traceId, operation: "updateElement",
            });
        }

        const wfId = existing.workflow_id;

        // 1. Cover / Primary media lifecycle via generic primaryMediaId (coverMediaId supported as alias)
        const requestedPrimaryMediaId = patchData.primaryMediaId !== undefined
            ? patchData.primaryMediaId
            : patchData.coverMediaId;

        let primaryMediaIdResult = undefined;

        if (requestedPrimaryMediaId !== undefined) {
            if (requestedPrimaryMediaId === null) {
                // Explicit null: clear the Cover
                if (wfId && this.workflowService?.clearPrimaryMedia) {
                    await this.workflowService.clearPrimaryMedia({ workflowId: wfId, userId });
                } else if (wfId && this.mediaService?.clearElementCover) {
                    await this.mediaService.clearElementCover({ workflowId: wfId });
                } else if (wfId && this.db.workflowMedia?.clearPrimaryMedia) {
                    await this.db.workflowMedia.clearPrimaryMedia({ workflowId: wfId });
                }
                primaryMediaIdResult = null;
            } else {
                const targetMediaId = String(requestedPrimaryMediaId).trim();
                // Validate membership in the same Element workflow
                const wfMedia = wfId
                    ? await (this.db.workflowMedia?.findByWorkflow?.(wfId)
                        || this.db.media?.findByWorkflow?.(wfId)
                        || [])
                    : [];

                const isLinked = wfMedia.some((m) => (m.media_id || m.id) === targetMediaId);
                if (!isLinked) {
                    throw new CrudServiceError(`Media ${targetMediaId} does not belong to element workflow ${wfId}`, {
                        statusCode: 400,
                        errorCode: "INVALID_MEDIA",
                        traceId,
                        operation: "updateElement",
                    });
                }

                if (wfId && this.workflowService?.setPrimaryMedia) {
                    await this.workflowService.setPrimaryMedia({ workflowId: wfId, mediaId: targetMediaId, userId });
                } else if (this.mediaService?.setElementCover) {
                    await this.mediaService.setElementCover({ workflowId: wfId, mediaId: targetMediaId });
                } else if (this.db.workflowMedia?.setPrimaryMedia) {
                    await this.db.workflowMedia.setPrimaryMedia({ workflowId: wfId, mediaId: targetMediaId });
                }
                primaryMediaIdResult = targetMediaId;
            }
        }

        // 2. Partial entity fields update
        const allowedPatch = {};

        if (patchData.name !== undefined) {
            allowedPatch.name = String(patchData.name).replace(/^@+/, "").trim();
        }
        if (patchData.description !== undefined) {
            allowedPatch.description = patchData.description == null
                ? null
                : String(patchData.description).trim() || null;
        }
        if (patchData.guidelines !== undefined) {
            allowedPatch.guidelines = patchData.guidelines == null
                ? ""
                : (Array.isArray(patchData.guidelines)
                    ? patchData.guidelines.map((g) => String(g).trim()).filter(Boolean).join("\n")
                    : String(patchData.guidelines).trim());
        }
        if (patchData.tags !== undefined) {
            allowedPatch.tags = Array.isArray(patchData.tags) ? patchData.tags : [];
        }

        const resolvedType = patchData.element_type ?? patchData.type ?? patchData.elementType;
        if (resolvedType !== undefined) {
            allowedPatch.element_type = String(resolvedType).toLowerCase().trim();
        }

        let updated = existing;
        if (Object.keys(allowedPatch).length > 0) {
            updated = (await this.db.elements.update(existing.id, allowedPatch)) || existing;
        }

        // Keep workflow.display_name in sync when name changes
        if (allowedPatch.name && wfId && this.db.workflows?.updateFields) {
            await this.db.workflows
                .updateFields(wfId, { display_name: allowedPatch.name })
                .catch((err) => logger.warn({ message: err.message }, "[ElementService] sync workflow display_name warning"));
        }

        // 3. Resolve primary_media_url dynamically from canonical workflow_media relation
        const primaryMediaUrl = (wfId && this.db.workflows?.getPrimaryMediaUrl)
            ? await this.db.workflows.getPrimaryMediaUrl(wfId).catch(() => null)
            : null;

        crudOperationLog({ traceId, operation: "updateElement", status: "ok", durationMs: Date.now() - start, id });

        return {
            ...existing,
            ...updated,
            primaryMediaId: primaryMediaIdResult !== undefined
                ? primaryMediaIdResult
                : (existing.primaryMediaId ?? existing.primary_media_id ?? undefined),
            primary_media_url: primaryMediaUrl,
        };
    }

    // ── DELETE ─────────────────────────────────────────────────────────────────

    /**
     * Delete an element, its workflow, and all associated storage/media.
     */
    async deleteElement(id, userId = null) {
        const traceId = randomUUID();
        const start   = Date.now();

        try {
            const element = await this.db.elements.resolveRecord(id);
            const targetWorkflowId = element ? element.workflow_id : id;

            if (element) {
                await this.db.elements.deleteById(element.id);
            }

            if (targetWorkflowId) {
                if (this.workflowService) {
                    await this.workflowService.deleteWorkflow({ workflowId: targetWorkflowId, userId });
                } else {
                    await this.db.workflows.deleteById(targetWorkflowId);
                }
            }

            crudOperationLog({ traceId, operation: "deleteElement", status: "ok", durationMs: Date.now() - start, id });
            return true;
        } catch (err) {
            crudOperationLog({ traceId, operation: "deleteElement", status: "error", durationMs: Date.now() - start, message: err.message });
            throw err;
        }
    }

    // ── AI ANALYSIS ────────────────────────────────────────────────────────────

    /**
     * Trigger Vision AI analysis for an element (delegates to ElementAnalysisService).
     */
    async analyzeElement({ projectId, workflowId, imageUrls, elementName, elementType, userId = null }) {
        return this.analysisService.analyzeElement({
            projectId,
            workflowId,
            imageUrls,
            elementName: elementName || "Element",
            elementType: elementType || "object",
            userId,
        });
    }

    /**
     * Add a single reference image to an existing element.
     */
    async addImageToElement({ elementId, imageUrl, file, mediaId, projectId, userId }) {
        return this.mediaService.addReferenceMedia({ elementId, imageUrl, file, mediaId, projectId, userId });
    }

    // ── PROMPT BUILDING ────────────────────────────────────────────────────────

    /**
     * Resolve @ElementName tokens and build generation prompt payload.
     */
    async buildPromptPayload({ userPrompt, elements = [], elementIds = [], projectId }) {
        const resolvedElements = [...elements];

        for (const id of elementIds) {
            const elem = await this.db.elements.findById(id);
            if (elem) resolvedElements.push(elem);
        }

        return promptBuilderProService.buildMultiElementPayload({ userPrompt, elements: resolvedElements, projectId });
    }
}

// ─── Default singleton instance ────────────────────────────────────────────────

const defaultElementMediaService = new ElementMediaService({
    db: { elements: elementRepository, workflows: defaultWorkflowRepo, media: defaultMediaRepo },
    storageService:        null,
    mediaUploadService:    { upload: async () => ({ files: [], uploaded: [] }), discard: async () => ({}) },
    workflowMediaService:  { attachMediaItems: async () => ({ attached: [] }) },
    authService:           { verifyWorkflowOwnership: async () => false },
});

const defaultInstance = new ElementService({
    db: { elements: elementRepository, workflows: defaultWorkflowRepo, media: defaultMediaRepo },
    mediaService:    defaultElementMediaService,
    analysisService: new ElementAnalysisService(),
});

// ─── Named function exports (for controller imports) ──────────────────────────

export const createElement             = (params)         => defaultInstance.createElement(params);
export const listProjectElements       = (projectId)      => defaultInstance.listProjectElements(projectId);
export const getElementById            = (id)             => defaultInstance.getElementById(id);
export const updateElement             = (id, patchData)  => defaultInstance.updateElement(id, patchData);
export const deleteElement             = (id, userId)     => defaultInstance.deleteElement(id, userId);
export const analyzeElement            = (params)         => defaultInstance.analyzeElement(params);
export const getElementContextForPrompt = (params)        => defaultInstance.getElementContextForPrompt(params);
export const addImageToElement         = (params)         => defaultInstance.addImageToElement(params);
export const setElementCover           = (params)         => defaultInstance.setElementCover(params);
export const setPrimaryMedia           = (params)         => defaultInstance.setPrimaryMedia(params);

export default defaultInstance;
