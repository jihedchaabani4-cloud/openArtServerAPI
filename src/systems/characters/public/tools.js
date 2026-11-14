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

import { identityTools } from "#identity/tools";
import {
    CharacterRepository,
    characterRepository,
} from "../internal/db/CharacterRepository.js";
import {
    CharacterService,
    CharacterMediaService,
    CharacterGenerationService,
    CHARACTER_MAX_DETAIL_MEDIA,
} from "../internal/services/index.js";
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

/**
 * Retrieves normalized prompt context (traits, description, references) for a character.
 *
 * @param {object} input
 * @param {string} input.characterId - Target character or workflow UUID
 * @param {string} [input.userId] - Optional owner userId for access control assertion
 * @returns {Promise<{ name: string, description: string, traits: object, referenceMediaUrls: string[] }>}
 */
export async function getCharacterPromptContext({ characterId, userId = null } = {}) {
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

    const traits = char.traits && typeof char.traits === "object" ? char.traits : {};
    const referenceMediaUrls = Array.isArray(char.reference_media_urls)
        ? char.reference_media_urls.filter(Boolean)
        : [];

    return {
        name: char.name || char.title || "",
        description: char.description || char.character_info || "",
        traits,
        referenceMediaUrls,
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
