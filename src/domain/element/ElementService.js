/**
 * ElementService
 * Canonical owner of all Element entity operations, lifecycle, and domain orchestration.
 *
 * Boundaries:
 *   - ElementMediaService    → media uploads, reference images.
 *   - ElementAnalysisService → Vision AI multimodal analysis.
 *   - WorkflowService        → workflow lifecycle & cascade deletion.
 *   - ElementRepository      → element table persistence.
 *   - WorkflowRepository     → workflow table persistence.
 *
 * Elements are project-level assets — NEVER linked to a session_id.
 *
 * Feature: 018-element-reference-system
 */

import { randomUUID } from "node:crypto";
import { crudOperationLog, CrudServiceError } from "../../utils/crudOperationLog.js";
import { createLogger } from "../../infrastructure/logging/index.js";
import { ElementMediaService } from "./ElementMediaService.js";
import { ElementAnalysisService } from "./ElementAnalysisService.js";
import promptBuilderProService from "./promptBuilderProService.js";
import elementRepository from "../../db/ElementRepository.js";
import { WorkflowRepository } from "../../db/WorkflowRepository.js";
import { MediaRepository } from "../../db/MediaRepository.js";

const logger = createLogger("domain:element");

// ─── Default repos (singleton fallbacks) ──────────────────────────────────────

const defaultMediaRepo    = new MediaRepository();
const defaultWorkflowRepo = new WorkflowRepository();

// ─── Input validation ──────────────────────────────────────────────────────────

function validateCreateInputs({ name, sourceImages, projectId, project_id }) {
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
    if (!Array.isArray(sourceImages) || sourceImages.length === 0) {
        throw new CrudServiceError("At least 1 reference image is required", {
            statusCode: 400, errorCode: "VALIDATION_ERROR", operation: "createElement",
        });
    }
    if (sourceImages.length > 6) {
        throw new CrudServiceError("Maximum 6 reference images allowed", {
            statusCode: 400, errorCode: "VALIDATION_ERROR", operation: "createElement",
        });
    }
}

// ─── Service class ─────────────────────────────────────────────────────────────

export class ElementService {
    /**
     * @param {Object} deps
     * @param {Object} deps.db                       - { elements, workflows, media }
     * @param {Object} [deps.storageService]
     * @param {Object} [deps.workflowService]
     * @param {Object} [deps.mediaIngestionService]
     * @param {Object} [deps.mediaService]           - Pre-configured ElementMediaService
     * @param {Object} [deps.analysisService]        - Pre-configured ElementAnalysisService
     */
    constructor({ db, storageService, workflowService, mediaIngestionService, mediaService, analysisService } = {}) {
        this.db = db || {
            elements:  elementRepository,
            workflows: defaultWorkflowRepo,
            media:     defaultMediaRepo,
        };
        this.storageService          = storageService;
        this.workflowService         = workflowService;
        this.mediaIngestionService   = mediaIngestionService;

        this.mediaService   = mediaService || new ElementMediaService({
            db: this.db, storageService, mediaIngestionService, workflowService,
        });
        this.analysisService = analysisService || new ElementAnalysisService();
    }

    // ── CREATE ─────────────────────────────────────────────────────────────────

    /**
     * Create and persist a new Element with its workflow container and initial media records.
     */
    async createElement({ name, sourceImages, description, projectId, project_id, tags = [], userId, element_type, type }) {
        const traceId    = randomUUID();
        const start      = Date.now();
        const pId        = projectId || project_id;
        const elementType = element_type || type || "object";

        crudOperationLog({ traceId, operation: "createElement:start", name, projectId: pId, elementType });

        try {
            validateCreateInputs({ name, sourceImages, projectId: pId });
            const safeUserId = userId || "anonymous";

            // 1. Workflow container (session_id = null — Elements are NOT session-scoped)
            const workflow = await this.db.workflows.createWorkflow({
                project_id:    pId,
                session_id:    null,
                workflow_type: "ELEMENT_SHEET",
                display_name:  name.trim(),
                user_id:       userId || (safeUserId !== "anonymous" ? safeUserId : null),
            });

            // 2. Ingest all source images → media records
            const { mediaRecords, primaryMedia, storageUrls } = await this.mediaService.ingestElementSources({
                workflowId: workflow.id,
                sourceImages,
                projectId: pId,
                userId: safeUserId,
            });

            // 3. Persist element domain record
            const element = await this.db.elements.create({
                workflow_id:      workflow.id,
                primary_media_id: primaryMedia?.id || null,
                name:             name.trim(),
                element_type:     elementType,
                description:      description?.trim() || null,
                source_images:    mediaRecords.map((m) => m.id),
                tags,
            });

            // 4. Trigger Vision AI in background (non-blocking)
            if (this.analysisService && storageUrls.length > 0) {
                this.analysisService
                    .analyzeElement({ projectId, workflowId: workflow.id, imageUrls: storageUrls, elementName: name.trim(), elementType, userId: safeUserId })
                    .catch((err) => logger.warn({ message: err.message }, "[ElementService] Background vision analysis error"));
            }

            crudOperationLog({ traceId, operation: "createElement:success", status: "ok", durationMs: Date.now() - start, elementId: element.id, workflowId: workflow.id });

            return {
                element: { ...element, primary_media_url: primaryMedia?.url || null, source_images_count: mediaRecords.length },
                workflow: {
                    id:               workflow.id,
                    name:             workflow.id,
                    project_id:       projectId,
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
     * List all elements for a project with cover thumbnail URL.
     */
    async listProjectElements(projectId) {
        const traceId = randomUUID();
        const start   = Date.now();

        try {
            const elements = await this.db.elements.list({ projectId });

            const enriched = await Promise.all(
                elements.map(async (el) => {
                    const primaryUrl = el.workflow_id
                        ? await this.db.workflows.getPrimaryMediaUrl(el.workflow_id).catch(() => null)
                        : null;
                    return {
                        id:                   el.id,
                        name:                 el.name,
                        description:          el.description,
                        primary_media_url:    primaryUrl,
                        source_images_count:  Array.isArray(el.source_images) ? el.source_images.length : 0,
                        tags:                 el.tags || [],
                        workflow_id:          el.workflow_id,
                        created_at:           el.create_time,
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
     * Retrieve full element details with all reference image URLs.
     */
    async getElementById(id) {
        const traceId = randomUUID();

        try {
            const element = await this.db.elements.resolveRecord(id);
            if (!element) return null;

            const mediaRecords     = element.workflow_id
                ? await this.db.media.findByWorkflow(element.workflow_id).catch(() => [])
                : [];
            const referenceImages  = mediaRecords.map((m) => m.url).filter(Boolean);

            crudOperationLog({ traceId, operation: "getElementById", status: "ok", elementId: id });

            return {
                ...element,
                reference_images:     referenceImages,
                primary_media_url:    referenceImages[0] || null,
                source_images_count:  referenceImages.length,
            };
        } catch (err) {
            crudOperationLog({ traceId, operation: "getElementById", status: "error", message: err.message });
            throw err;
        }
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
    async updateElement(id, patchData = {}) {
        const traceId = randomUUID();
        const start   = Date.now();

        const existing = await this.db.elements.resolveRecord(id);
        if (!existing) {
            throw new CrudServiceError(`Element not found: ${id}`, {
                statusCode: 404, errorCode: "NOT_FOUND", traceId, operation: "updateElement",
            });
        }

        const allowedPatch = { ...patchData };

        // Normalize element_type if passed as type or elementType
        const resolvedType = patchData.element_type || patchData.type || patchData.elementType;
        if (resolvedType !== undefined) {
            allowedPatch.element_type = String(resolvedType).toLowerCase().trim();
        }
        delete allowedPatch.type;
        delete allowedPatch.elementType;

        const updated = await this.db.elements.update(id, allowedPatch);

        // Keep workflow.display_name in sync when name changes
        if (allowedPatch.name && existing.workflow_id && this.db.workflows?.updateFields) {
            const cleanName = String(allowedPatch.name).replace(/^@+/, "").trim();
            await this.db.workflows
                .updateFields(existing.workflow_id, { display_name: cleanName })
                .catch((err) => logger.warn({ message: err.message }, "[ElementService] sync workflow display_name warning"));
        }

        crudOperationLog({ traceId, operation: "updateElement", status: "ok", durationMs: Date.now() - start, id });
        return updated;
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
    storageService:       null,
    mediaIngestionService: null,
    workflowService:      null,
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

export default defaultInstance;
