/**
 * Legacy Re-export for element domain.
 * Canonical gateway now lives in src/systems/elements/public/tools.js (#elements/tools)
 * and src/systems/elements/public/api.js (#elements/api).
 */

export {
    ElementService,
    ElementMediaService,
    ElementAnalysisService,
    ElementRepository,
    elementRepository,
    extractElementTokens,
    stripElementTokens,
    buildElementPromptContext,
    getElementContextForPrompt,
    ElementsError,
    ElementsValidationError,
    ElementsNotFoundError,
    ElementsConflictError,
    ElementsUnauthorizedError,
    getElementPromptContext,
    validateElementsExist,
} from "#elements/tools";
