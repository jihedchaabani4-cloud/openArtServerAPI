/**
 * System 1: Generation & Workflows — Prompt Intelligence Module
 *
 * Encapsulates prompt optimization, skills, and LLM utilities.
 */

import { PromptService } from "../../../../platform/ai/PromptService.js";

export { PromptService };
export const promptService = new PromptService();
export { LLMService, llmService } from "../../../../platform/ai/LLMService.js";
export { PromptBuilderProService } from "#elements/tools";

// V2 Prompt Processors & Skills (each module exports `run`)
export * as enhancePromptProcessor from "../../../../v2/processors/enhancePrompt.js";
export * as generateNegativePromptProcessor from "../../../../v2/processors/generateNegativePrompt.js";
export * as moderationSafetyProcessor from "../../../../v2/processors/moderationSafety.js";
export * as optimizeVisualPromptProcessor from "../../../../v2/processors/optimizeVisualPrompt.js";
export * as applyCameraStyleProcessor from "../../../../v2/processors/applyCameraStyle.js";
export * as applyCharacterTemplateProcessor from "../../../../v2/processors/applyCharacterTemplate.js";
export * as applyCompositionProcessor from "../../../../v2/processors/applyComposition.js";
export * as applyPoseTemplateProcessor from "../../../../v2/processors/applyPoseTemplate.js";
export * as applySheetLayoutProcessor from "../../../../v2/processors/applySheetLayout.js";
export * as applyTypographyAreaProcessor from "../../../../v2/processors/applyTypographyArea.js";
export * as buildStoryboardLayoutProcessor from "../../../../v2/processors/buildStoryboardLayout.js";
export * as resolveCharactersProcessor from "../../../../v2/processors/resolveCharacters.js";
export * as resolveReferencesProcessor from "../../../../v2/processors/resolveReferences.js";
