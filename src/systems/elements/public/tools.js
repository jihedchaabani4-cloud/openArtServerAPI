/**
 * System 7: Elements — Public Tools Gateway (#elements/tools)
 *
 * Governed by:
 * - docs/architecture/constitution/01_business_systems_architecture.md (System 7)
 * - docs/architecture/constitution/02_architecture_rules_and_agent_guardrails.md
 *
 * Exposes inter-system plain DTO operations for element prompt context extraction
 * and entity existence validation.
 */

import * as identityTools from "#identity/tools";
import { ElementRepository, elementRepository } from "../internal/db/ElementRepository.js";
import { ElementService, getElementContextForPrompt } from "../internal/services/ElementService.js";
import { ElementMediaService } from "../internal/services/ElementMediaService.js";
import { ElementAnalysisService } from "../internal/services/ElementAnalysisService.js";
import promptBuilderProService, { extractElementTokens, stripElementTokens, PromptBuilderProService } from "../internal/services/promptBuilderProService.js";
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


/**
 * Retrieves formatted element prompt context (traits, guidelines, reference media URLs).
 *
 * @param {object} input
 * @param {string[]} input.elementIds - Array of element or workflow UUIDs
 * @param {string} [input.userId] - Optional caller user ID for ownership validation
 * @returns {Promise<{ elements: Array<{ id: string, name: string, description: string, guidelines: string, referenceMediaUrls: string[] }>, referenceMediaUrls: string[] }>}
 */
export async function getElementPromptContext({ elementIds = [], userId = null } = {}) {
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

        const urls = Array.isArray(record.reference_images)
            ? record.reference_images.filter(Boolean)
            : (Array.isArray(record.reference_media_urls) ? record.reference_media_urls.filter(Boolean) : []);

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

// ── Facade & Service Re-exports ──────────────────────────────────────────────

export {
    ElementService,
    ElementMediaService,
    ElementAnalysisService,
    ElementRepository,
    elementRepository,
    extractElementTokens,
    stripElementTokens,
    PromptBuilderProService,
    promptBuilderProService,
    getElementContextForPrompt,
    ElementsError,
    ElementsValidationError,
    ElementsNotFoundError,
    ElementsConflictError,
    ElementsUnauthorizedError,
};

export default {
    getElementPromptContext,
    validateElementsExist,
    ElementService,
    ElementMediaService,
    ElementAnalysisService,
    ElementRepository,
    elementRepository,
    extractElementTokens,
    stripElementTokens,
    PromptBuilderProService,
    promptBuilderProService,
    getElementContextForPrompt,
    ElementsError,
    ElementsValidationError,
    ElementsNotFoundError,
    ElementsConflictError,
    ElementsUnauthorizedError,
};
