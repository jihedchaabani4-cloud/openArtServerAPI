/**
 * Element Service
 * All element business logic: create, list, get, delete, and resolve @ElementName context.
 * V1 Simplified — direct save, no AI sheet generation.
 * Feature: 018-element-reference-system
 */

import { randomUUID } from "node:crypto";
import elementRepository from "../db/ElementRepository.js";
import { MediaRepository } from "../db/MediaRepository.js";
import { WorkflowRepository } from "../db/WorkflowRepository.js";
import { uploadMediaBatch } from "./mediaStorageService.js";
import { storageService } from "./StorageService.js";
import { workflowService } from "../container.js";

import { ElementAnalysisService } from "./ElementAnalysisService.js";

const mediaRepo    = new MediaRepository();
const workflowRepo = new WorkflowRepository();
const analysisService = new ElementAnalysisService();

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Validate element creation inputs. Throws with a human-readable message if invalid.
 */
function validateCreateInputs({ name, sourceImages, projectId }) {
    if (!projectId) {
        const err = new Error("projectId is required to create an element");
        err.statusCode = 400;
        throw err;
    }
    if (!name || typeof name !== "string" || name.trim().length === 0) {
        const err = new Error("Element name is required");
        err.statusCode = 400;
        throw err;
    }
    if (!Array.isArray(sourceImages) || sourceImages.length === 0) {
        const err = new Error("At least 1 reference image is required");
        err.statusCode = 400;
        throw err;
    }
    if (sourceImages.length > 6) {
        const err = new Error("Maximum 6 reference images allowed");
        err.statusCode = 400;
        throw err;
    }
}

// ─── Create Element ───────────────────────────────────────────────────────────

/**
 * Create and persist a new Element with its workflow container and media records.
 *
 * @param {Object} params
 * @param {string}   params.name           - Element name (required)
 * @param {string[]} params.sourceImages   - 1–6 image inputs (URL, base64, or Buffer)
 * @param {string}   [params.description]  - Optional user notes
 * @param {string}   params.projectId      - Project this element belongs to
 * @param {string[]} [params.tags]         - Optional tags
 * @param {string}   [params.userId]       - Authenticated user ID (for storage path)
 * @returns {Promise<Object>} Created element record with primary_media_url
 */
export async function createElement({ name, sourceImages, description, projectId, tags = [], userId, element_type, type }) {
    const traceId = randomUUID();
    const start   = Date.now();

    const elementType = element_type || type || "object";

    console.log(`[elementService] createElement start`, { traceId, operation: "createElement", name, projectId, elementType });

    try {
        // Step 1 — Validate
        validateCreateInputs({ name, sourceImages, projectId });

        const safeUserId = userId || "anonymous";

        // Step 2 — Upload only local/base64 images; pass http URLs through directly
        const storageUrls = await Promise.all(
            sourceImages.map(async (src) => {
                if (typeof src === "string" && (src.startsWith("http://") || src.startsWith("https://"))) {
                    return src; // Already hosted — skip re-upload (avoids RLS issues)
                }
                const [uploaded] = await uploadMediaBatch([src], { userId: safeUserId, projectId });
                return uploaded;
            })
        );

        // Step 3 — Create workflow container
        const workflow = await workflowRepo.createWorkflow({
            project_id:    projectId,
            workflow_type: "ELEMENT_SHEET",
            display_name:  name.trim(),
        });

        const workflow_id = workflow.id;

        // Step 4 — Create media records (one per reference image)
        const mediaRecords = [];
        for (let i = 0; i < storageUrls.length; i++) {
            const media = await mediaRepo.createMedia({
                workflow_id,
                project_id: projectId,
                url:        storageUrls[i],
                step_id:    "CAE",           // Create Asset — Element
                width:      1024,
                height:     1024,
                status:     "success",       // Canonical success state
            });
            mediaRecords.push(media);
        }

        const primaryMedia = mediaRecords[0];

        // Step 5 — Set primary_media_id on workflow
        await workflowRepo.updatePrimaryMedia(workflow_id, primaryMedia.id);

        // Step 6 — Insert element record
        const element = await elementRepository.create({
            workflow_id,
            primary_media_id: primaryMedia.id,
            name:             name.trim(),
            element_type:     elementType,
            description:      description?.trim() || null,
            source_images:    mediaRecords.map(m => m.id),
            tags,
        });



        // Step 7 — Trigger async Vision AI analysis to populate keywords and taste profile description
        analysisService.analyzeElement({
            projectId,
            workflowId: workflow_id,
            imageUrls: storageUrls,
            elementName: name.trim(),
            elementType,
        }).catch((err) => {
            console.warn(`[elementService] Background vision analysis error:`, err.message);
        });

        const durationMs = Date.now() - start;
        console.log(`[elementService] createElement success`, { traceId, operation: "createElement", durationMs, status: "success", elementId: element.id });

        const workflowObj = {
            id:                workflow_id,
            name:              workflow_id,
            project_id:        projectId,
            workflow_type:     "ELEMENT_SHEET",
            element_type:      elementType,
            tags:              [elementType],
            display_name:      name.trim(),
            primary_media_id:  primaryMedia.id,
            items:             mediaRecords,
            metadata: {
                displayName:   name.trim(),
                elementType:   elementType,
                createTime:    workflow.create_time || new Date().toISOString(),
            }
        };

        return {
            workflow: workflowObj,
            media: mediaRecords,
            element: {
                ...element,
                primary_media_url:    primaryMedia.url,
                source_images_count:  mediaRecords.length,
            }
        };



    } catch (err) {
        const durationMs = Date.now() - start;
        console.error(`[elementService] createElement error`, { traceId, operation: "createElement", durationMs, status: "error", errorCode: err.statusCode || 500, message: err.message });
        throw err;
    }
}

// ─── List Project Elements ────────────────────────────────────────────────────

/**
 * List all elements for a project, with cover thumbnail URL.
 * @param {string} projectId
 * @returns {Promise<Object[]>}
 */
export async function listProjectElements(projectId) {
    const traceId = randomUUID();
    const start   = Date.now();

    try {
        const elements = await elementRepository.list({ projectId });

        // Enrich each element with primary_media_url
        const enriched = await Promise.all(
            elements.map(async (el) => {
                const primaryUrl = await workflowRepo.getPrimaryMediaUrl(el.workflow_id);
                return {
                    id:                  el.id,
                    name:                el.name,
                    description:         el.description,
                    primary_media_url:   primaryUrl,
                    source_images_count: Array.isArray(el.source_images) ? el.source_images.length : 0,
                    tags:                el.tags || [],
                    workflow_id:         el.workflow_id,
                    created_at:          el.create_time,
                };
            })
        );

        const durationMs = Date.now() - start;
        console.log(`[elementService] listProjectElements`, { traceId, operation: "listProjectElements", durationMs, status: "success", count: enriched.length });

        return enriched;

    } catch (err) {
        console.error(`[elementService] listProjectElements error`, { traceId, operation: "listProjectElements", status: "error", message: err.message });
        throw err;
    }
}

// ─── Get Element By ID ────────────────────────────────────────────────────────

/**
 * Retrieve full element details including all reference image URLs.
 * @param {string} id
 * @returns {Promise<Object|null>}
 */
export async function getElementById(id) {
    const traceId = randomUUID();

    try {
        const element = await elementRepository.findById(id);
        if (!element) return null;

        // Fetch all media records for this element's workflow
        const mediaRecords = await mediaRepo.findByWorkflow(element.workflow_id);
        const referenceImages = mediaRecords.map(m => m.url).filter(Boolean);

        console.log(`[elementService] getElementById`, { traceId, operation: "getElementById", status: "success", elementId: id });

        return {
            ...element,
            reference_images:    referenceImages,
            primary_media_url:   referenceImages[0] || null,
            source_images_count: referenceImages.length,
        };

    } catch (err) {
        console.error(`[elementService] getElementById error`, { traceId, operation: "getElementById", status: "error", message: err.message });
        throw err;
    }
}

// ─── Delete Element ───────────────────────────────────────────────────────────

/**
 * Delete an element and its associated storage files.
 * DB cascade handles workflow + media record deletion via FK.
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function deleteElement(id, userId = null) {
    const traceId = randomUUID();
    const start   = Date.now();

    try {
        const { supabaseAdmin } = await import("../../lib/supabase.js");

        // Safely search for element by element.id OR workflow_id
        const { data: element } = await supabaseAdmin
            .from("element")
            .select("id, workflow_id")
            .or(`id.eq.${id},workflow_id.eq.${id}`)
            .maybeSingle();

        const targetWorkflowId = element?.workflow_id || id;

        // 1. Delete element domain record
        if (element) {
            await supabaseAdmin.from("element").delete().eq("id", element.id);
        }

        // 2. Delegate full workflow + media + storage cleanup to workflowService
        await workflowService.deleteWorkflow({ workflowId: targetWorkflowId, userId });

        const durationMs = Date.now() - start;
        console.log(`[elementService] deleteElement success`, { traceId, operation: "deleteElement", durationMs, status: "success", id });

        return true;
    } catch (err) {
        console.error(`[elementService] deleteElement error`, { traceId, operation: "deleteElement", status: "error", message: err.message });
        throw err;
    }
}


// ─── Get Element Context For Prompt ──────────────────────────────────────────

/**
 * Resolve an element by name or ID and return its generation context.
 * Used by promptBuilderProService to inject @ElementName references.
 *
 * @param {Object} params
 * @param {string} params.nameOrId - Element name (for @token resolution) or UUID
 * @param {string} params.projectId
 * @returns {Promise<Object|null>} { name, description, referenceImageUrls, contextNote } or null if not found
 */
export async function getElementContextForPrompt({ nameOrId, projectId }) {
    try {
        let element = null;

        // Try by ID first (if it looks like a UUID)
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nameOrId);
        if (isUuid) {
            element = await elementRepository.findById(nameOrId);
        }

        // Fall back to name lookup
        if (!element) {
            element = await elementRepository.findByName(nameOrId, projectId);
        }

        if (!element) {
            console.warn(`[elementService] getElementContextForPrompt: element not found`, { nameOrId, projectId });
            return null;
        }

        const mediaRecords = await mediaRepo.findByWorkflow(element.workflow_id);
        const referenceImageUrls = mediaRecords.map(m => m.url).filter(Boolean);

        const contextNote = element.description
            ? `Element Context (${element.name}): ${element.description}`
            : null;

        return {
            name:               element.name,
            description:        element.description || null,
            referenceImageUrls,
            contextNote,
        };

    } catch (err) {
        console.error(`[elementService] getElementContextForPrompt error`, { nameOrId, projectId, message: err.message });
        return null; // Graceful degradation — do not block generation
    }
}

export async function addImageToElement({ elementId, imageUrl, projectId, userId }) {
    // Validate elementId is a proper UUID before hitting the database
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!elementId || !UUID_REGEX.test(elementId)) {
        const err = new Error(`Invalid element ID: "${elementId}" — must be a valid UUID`);
        err.statusCode = 400;
        throw err;
    }

    let finalUrl = imageUrl;
    // Only upload if it's a local base64/blob — skip for already-hosted URLs
    if (imageUrl && (imageUrl.startsWith("data:") || imageUrl.startsWith("blob:"))) {
        try {
            const [uploadedUrl] = await uploadMediaBatch([imageUrl], {
                userId: userId || "anonymous",
                projectId,
            });
            if (uploadedUrl) finalUrl = uploadedUrl;
        } catch (storageErr) {
            console.warn("⚠️ Storage upload notice (using Data URL fallback):", storageErr.message);
            finalUrl = imageUrl;
        }
    }

    const media = await mediaRepo.createMedia({
        workflow_id: elementId,
        project_id: projectId,
        url: finalUrl,
        step_id: "CAE",
        width: 1024,
        height: 1024,
        status: "completed",
    });

    return media;
}

export default {
    createElement,
    listProjectElements,
    getElementById,
    deleteElement,
    getElementContextForPrompt,
    addImageToElement,
};
