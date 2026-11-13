/**
 * Legacy Re-export for character domain.
 * Canonical gateway now lives in src/systems/characters/public/tools.js (#characters/tools)
 * and src/systems/characters/public/api.js (#characters/api).
 */

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
    getCharacterPromptContext,
    validateCharacterExists,
    attachCharacterSheetResult,
} from "#characters/tools";
