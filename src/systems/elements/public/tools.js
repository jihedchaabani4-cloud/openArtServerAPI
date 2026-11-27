/**
 * System 7: Elements — Public Tools Gateway (#elements/tools)
 *
 * Sealed surface exposing ONLY inter-system DTO operations for element prompt
 * context extraction and existence validation, composition-root service/repo
 * constructors, and the 5 canonical Elements*Error classes.
 */

import * as identityTools from "#identity/tools";
import { getWorkflowVisualMedia } from "#media/tools";
import { ElementRepository, elementRepository } from "../internal/db/ElementRepository.js";
import { ElementService } from "../internal/services/ElementService.js";
import { ElementMediaService } from "../internal/services/ElementMediaService.js";
import { ElementAnalysisService } from "../internal/services/ElementAnalysisService.js";
import {
    ElementsError,
    ElementsValidationError,
    ElementsNotFoundError,
    ElementsConflictError,
    ElementsUnauthorizedError,
} from "../internal/errors.js";
import { setElementServices } from "../internal/services/serviceAccessor.js";

export function configureElements(services = {}) {
    setElementServices(services);
}

// ── Inter-System Tools Functions ──────────────────────────────────────────────

const ELEMENT_VISUAL_ROLE_PRIORITY = Object.freeze([
    "detail",
    "reference",
    "sheet",
    "output",
    "original",
]);

/**
 * Retrieves formatted element prompt context (traits, guidelines, visual reference URLs from `workflow_media`).
 *
 * @param {object} input
 * @param {string[]} input.elementIds - Array of element or workflow UUIDs
 * @param {string} [input.userId] - Optional caller user ID for ownership validation
 * @param {object} [input.workflowMediaRepository] - Optional repository override (testing)
 * @param {object} [input.mediaRepository] - Optional repository override (testing)
 * @returns {Promise<{ elements: Array<{ id: string, workflowId: string, name: string, description: string, guidelines: string, referenceMediaUrls: string[] }>, referenceMediaUrls: string[] }>}
 */
export async function getElementPromptContext({
    elementIds = [],
    userId = null,
    workflowMediaRepository = null,
    mediaRepository = null,
} = {}) {
    if (!Array.isArray(elementIds) || elementIds.length === 0) {
        return {
            elements: [],
            referenceMediaUrls: [],
        };
    }

    const elements = [];
    const allReferenceUrls = [];

    for (const elemId of elementIds) {
        if (!elemId) continue;

        if (userId) {
            await identityTools.assertOwnsAny(["element", "workflow"], elemId, userId);
        }

        const record = await elementRepository.resolveRecord(elemId);
        if (!record) {
            throw new ElementsNotFoundError(`Element "${elemId}" not found`, { elementId: elemId });
        }

        const workflowId = record.workflow_id || record.id;
        const visualMedia = await getWorkflowVisualMedia(workflowId, {
            preferredRoles: ELEMENT_VISUAL_ROLE_PRIORITY,
            workflowMediaRepository,
            mediaRepository,
        });

        const urls = visualMedia.map((m) => m.url);

        elements.push({
            id: record.id,
            workflowId: record.workflow_id,
            name: record.name || "",
            description: record.description || "",
            guidelines: record.guidelines || "",
            referenceMediaUrls: urls,
        });

        allReferenceUrls.push(...urls);
    }

    return {
        elements,
        referenceMediaUrls: [...new Set(allReferenceUrls)],
    };
}

/**
 * Validates that all given element IDs exist and belong to the user.
 *
 * @param {object} input
 * @param {string[]} input.elementIds
 * @param {string} [input.userId]
 * @returns {Promise<boolean>}
 */
export async function validateElementsExist({ elementIds = [], userId = null } = {}) {
    if (!Array.isArray(elementIds) || elementIds.length === 0) {
        throw new ElementsValidationError("elementIds must be a non-empty array", { field: "elementIds" });
    }

    for (const elemId of elementIds) {
        if (!elemId) {
            throw new ElementsValidationError("Invalid element ID in array", { field: "elementIds" });
        }

        if (userId) {
            await identityTools.assertOwnsAny(["element", "workflow"], elemId, userId);
        }

        const record = await elementRepository.resolveRecord(elemId);
        if (!record) {
            throw new ElementsNotFoundError(`Element "${elemId}" not found`, { elementId: elemId });
        }
    }

    return true;
}

// ── Sealed Public Surface Exports ─────────────────────────────────────────────

export {
    ElementService,
    ElementMediaService,
    ElementAnalysisService,
    ElementRepository,
    ElementsError,
    ElementsValidationError,
    ElementsNotFoundError,
    ElementsConflictError,
    ElementsUnauthorizedError,
};
