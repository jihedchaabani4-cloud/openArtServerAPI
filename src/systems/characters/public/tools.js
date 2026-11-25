/**
 * System 6: Characters — Public Tools Gateway (#characters/tools)
 *
 * Governed by:
 * - docs/architecture/constitution/01_business_systems_architecture.md (System 6)
 * - docs/architecture/constitution/02_architecture_rules_and_agent_guardrails.md
 *
 * Exposes inter-system plain DTO operations for character context extraction,
 * entity existence validation, and sheet result attachment.
 */

import * as identityTools from "#identity/tools";
import { getWorkflowVisualMedia } from "#media/tools";
import { CharacterRepository, characterRepository } from "../internal/db/CharacterRepository.js";
import { CharacterService } from "../internal/services/CharacterService.js";
import { CharacterMediaService, CHARACTER_MAX_DETAIL_MEDIA } from "../internal/services/CharacterMediaService.js";
import { CharacterGenerationService } from "../internal/services/CharacterGenerationService.js";
import {
    CharactersError,
    CharactersValidationError,
    CharactersNotFoundError,
    CharactersConflictError,
    CharactersUnauthorizedError,
} from "../internal/errors.js";
import { setCharacterServices } from "../internal/services/serviceAccessor.js";

export function configureCharacters(services = {}) {
    setCharacterServices(services);
}

// ── Inter-System Tools Functions ──────────────────────────────────────────────

const CHARACTER_VISUAL_ROLE_PRIORITY = Object.freeze([
    "sheet",
    "turnaround",
    "avatar",
    "detail",
    "reference",
    "output",
    "original",
]);
const SHEET_ROLES = new Set(["sheet", "turnaround", "avatar"]);

function extractValidHttpUrls(rawList) {
    if (!Array.isArray(rawList)) return [];
    const seen = new Set();
    const out = [];
    for (const item of rawList) {
        const url = typeof item === "string" ? item.trim() : "";
        if ((url.startsWith("http://") || url.startsWith("https://")) && !seen.has(url)) {
            seen.add(url);
            out.push(url);
        }
    }
    return out;
}

/**
 * Retrieves normalized prompt context (traits, description, visual references from `workflow_media`)
 * for a character.
 *
 * @param {object} input
 * @param {string} input.characterId - Target character or workflow UUID
 * @param {string} [input.userId] - Optional owner userId for access control assertion
 * @param {object} [input.workflowMediaRepository] - Optional repository override (testing)
 * @param {object} [input.mediaRepository] - Optional repository override (testing)
 * @returns {Promise<{ id: string, workflowId: string, name: string, description: string, traits: object, referenceMediaUrls: string[], sheetImages: string[], detailImages: string[] }>}
 */
export async function getCharacterPromptContext({
    characterId,
    userId = null,
    workflowMediaRepository = null,
    mediaRepository = null,
} = {}) {
    if (!characterId) {
        throw new CharactersValidationError("characterId is required to retrieve prompt context", {
            field: "characterId",
        });
    }

    if (userId) {
        await identityTools.assertOwns("character", characterId, userId);
    }

    const char = await characterRepository.findByCharacterId(characterId);
    if (!char) {
        throw new CharactersNotFoundError(`Character "${characterId}" not found`, { characterId });
    }

    const workflowId = char.workflow_id || char.id || characterId;
    const traits = char.traits && typeof char.traits === "object" ? char.traits : {};

    const visualMedia = await getWorkflowVisualMedia(workflowId, {
        preferredRoles: CHARACTER_VISUAL_ROLE_PRIORITY,
        workflowMediaRepository,
        mediaRepository,
    });

    let referenceMediaUrls = visualMedia.map((m) => m.url);
    let sheetImages = visualMedia
        .filter((m) => m.isPrimary || SHEET_ROLES.has(String(m.role || "").toLowerCase()))
        .map((m) => m.url);
    let detailImages = visualMedia
        .filter((m) => !sheetImages.includes(m.url))
        .map((m) => m.url);

    // Compatibility fallback only when workflow_media returned nothing and an in-memory mock supplies legacy field
    if (referenceMediaUrls.length === 0) {
        referenceMediaUrls = extractValidHttpUrls(char.reference_media_urls);
        sheetImages = [...referenceMediaUrls];
        detailImages = [];
    }

    return {
        id: char.id || characterId,
        workflowId,
        name: char.name || char.title || "",
        description: char.description || char.character_info || "",
        traits,
        referenceMediaUrls,
        sheetImages,
        detailImages,
    };
}

/**
 * Validates that a character exists and is accessible to the calling user.
 *
 * @param {object} input
 * @param {string} input.characterId
 * @param {string} [input.userId]
 * @returns {Promise<boolean>}
 */
export async function validateCharacterExists({ characterId, userId = null } = {}) {
    if (!characterId) {
        throw new CharactersValidationError("characterId is required for validation", {
            field: "characterId",
        });
    }

    const char = await characterRepository.findByCharacterId(characterId);
    if (!char) {
        throw new CharactersNotFoundError(`Character "${characterId}" not found`, { characterId });
    }

    if (userId) {
        await identityTools.assertOwns("character", characterId, userId);
    }

    return true;
}

/**
 * Attaches the generated character turnaround sheet result.
 *
 * @param {object} input
 * @param {string} input.characterId
 * @param {string} input.mediaId
 * @param {string} [input.sheetUrl]
 * @param {string} [input.userId]
 * @returns {Promise<object>}
 */
export async function attachCharacterSheetResult({ characterId, mediaId, sheetUrl = null, userId = null } = {}) {
    if (!characterId) {
        throw new CharactersValidationError("characterId is required", { field: "characterId" });
    }
    if (!mediaId) {
        throw new CharactersValidationError("mediaId is required", { field: "mediaId" });
    }

    if (userId) {
        await identityTools.assertOwns("character", characterId, userId);
    }

    const patch = {
        primary_media_id: mediaId,
        updated_at: new Date().toISOString(),
    };
    if (sheetUrl) {
        patch.sheet_url = sheetUrl;
    }

    return characterRepository.updateCharacterFields(characterId, patch);
}

// ── Facade & Service Re-exports ──────────────────────────────────────────────

export {
    CharacterService,
    CharacterMediaService,
    CharacterGenerationService,
    CHARACTER_MAX_DETAIL_MEDIA,
    CharacterRepository,
    characterRepository,
    CharactersError,
    CharactersValidationError,
    CharactersNotFoundError,
    CharactersConflictError,
    CharactersUnauthorizedError,
};

export default {
    getCharacterPromptContext,
    validateCharacterExists,
    attachCharacterSheetResult,
    CharacterService,
    CharacterMediaService,
    CharacterGenerationService,
    CHARACTER_MAX_DETAIL_MEDIA,
    CharacterRepository,
    characterRepository,
    CharactersError,
    CharactersValidationError,
    CharactersNotFoundError,
    CharactersConflictError,
    CharactersUnauthorizedError,
};
