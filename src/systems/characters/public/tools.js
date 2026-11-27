/**
 * System 6: Characters — Public Tools Gateway (#characters/tools)
 *
 * Sealed surface exposing ONLY inter-system plain DTO operations for character
 * context extraction & existence validation, composition-root service wiring,
 * and canonical Characters*Error classes.
 */

import * as identityTools from "#identity/tools";
import { getWorkflowVisualMedia } from "#media/tools";
import { CharacterRepository, characterRepository } from "../internal/db/CharacterRepository.js";
import { CharacterService } from "../internal/services/CharacterService.js";
import { CharacterMediaService } from "../internal/services/CharacterMediaService.js";
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

    const referenceMediaUrls = visualMedia.map((m) => m.url);
    const sheetImages = visualMedia
        .filter((m) => m.isPrimary || SHEET_ROLES.has(String(m.role || "").toLowerCase()))
        .map((m) => m.url);
    const detailImages = visualMedia
        .filter((m) => !sheetImages.includes(m.url))
        .map((m) => m.url);

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

// ── Sealed Public Surface Exports ─────────────────────────────────────────────

export {
    CharacterService,
    CharacterMediaService,
    CharacterRepository,
    CharactersError,
    CharactersValidationError,
    CharactersNotFoundError,
    CharactersConflictError,
    CharactersUnauthorizedError,
};
