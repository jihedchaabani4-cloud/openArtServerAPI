/**
 * PromptService
 * @owns System 1: Generation & Workflows — prompt optimization, completion and translation.
 */
import { llmService } from "./LLMService.js";
import { createLogger } from "#shared";

const aiLogger = createLogger("ai");

export class PromptService {
    constructor() {
        this.modelFamily = "gemini-3.1-flash-lite";
    }

    async complete({ systemPrompt, userPrompt, temperature = 0.7, userId = null, options = {} }) {
        const resolvedUserId = userId || options.userId || null;
        return llmService.generateText({
            prompt: userPrompt,
            systemInstruction: systemPrompt,
            temperature,
            model: this.modelFamily,
            userId: resolvedUserId,
            options,
        });
    }

    async completeJSON({ systemPrompt, userPrompt, temperature = 0.7, userId = null, options = {} }) {
        const resolvedUserId = userId || options.userId || null;
        return llmService.generateJSON({
            prompt: userPrompt,
            systemInstruction: systemPrompt,
            temperature,
            model: this.modelFamily,
            userId: resolvedUserId,
            options,
        });
    }


    /**
     * optimizePrompt
     * 
     * Single-pass LLM call that:
     *  1. Detects the language (Arabic, French, Tunisian dialect, etc.)
     *  2. Translates to English if needed
     *  3. Fixes incomplete / broken words (typos, half-written words)
     *  4. Enriches the prompt with cinematic/visual details for AI generation
     *  5. Returns the improved prompt + metadata
     */
    async optimizePrompt(prompt, { mode = "image", style = "cinematic", userId = null } = {}) {
        if (!userId) {
            throw new Error("PromptService: authenticated userId is required for prompt optimization");
        }

        if (!prompt?.trim()) return {
            optimized: prompt,
            originalLanguage: "en",
            wasTranslated: false,
            wasEnhanced: false,
        };

        const modeHint = "for an AI image generation model (focus on visuals, lighting, composition, color palette, artistic style)";

        const systemPrompt = `
You are a world-class AI Prompt Engineer and professional multilingual translator, specialized in generative AI image and video creation.

You have EXPERT knowledge of:
- Tunisian Darija (Tunisian Arabic dialect) — including slang, mixed French-Arabic expressions, and regional idioms
- Modern Standard Arabic (MSA / Fusha)
- Maghrebi dialects (Algerian, Moroccan)
- French, English, and mixed multilingual inputs

YOUR TASKS (execute in strict order):

1. DETECT the language/dialect of the user's input with high precision.
   - Distinguish between: Tunisian Darija, MSA Arabic, French, English, mixed code-switching, or other.

2. TRANSLATE the SEMANTIC MEANING — not word-for-word — into fluent, natural English.
   - Preserve the user's INTENT and CREATIVE VISION above all.
   - If the user wrote "bnet" → understand it means "girls/women". If they wrote "mrigel" → "men/guys".
   - If they wrote "film" or "cinéma" in Darija context → understand it as a cinematic/movie scene.
   - Do NOT translate idioms literally. Translate their MEANING.

3. FIX incomplete words, typos, half-written expressions, or code-switching artifacts.

4. ENHANCE the translated result ${modeHint}.
   - Add rich visual descriptors: lighting conditions, mood, atmosphere, color grading, artistic style
   - Reference cinematic or artistic styles when appropriate (e.g. "golden hour lighting", "bokeh background", "cyberpunk aesthetic")
   - Keep the enhanced prompt under 150 words
   - NEVER replace the user's core idea with something else

5. Return ONLY a valid JSON object:
{
  "optimized_prompt": string,      // final English enhanced prompt ready for AI generation
  "original_language": string,     // detected language (e.g. "tn-darija", "ar", "fr", "en", "fr-ar-mixed")
  "was_translated": boolean,       // true if any translation was performed
  "was_enhanced": boolean,         // true if visual details were added
  "changes_summary": string        // brief summary of what changed (e.g. "Translated from Tunisian Darija, added cinematic lighting")
}

RULES:
- NEVER refuse. ALWAYS return a result, no matter how short or ambiguous the input.
- NEVER add NSFW or inappropriate content.
- If the input is already perfect English, still return it with minor cinematic enhancements.
- A single word like "قطوس" (Tunisian for cat) → translate as "cat" then enhance with visual details.
`;

        const userPrompt = `User input: "${prompt}"

Translate the semantic meaning and enhance it as a professional AI generation prompt.`;

        try {
            const options = { userId };
            const result = await this.completeJSON({ systemPrompt, userPrompt, temperature: 0.4, userId, options });
            const optimized = result.optimized_prompt || prompt;

            aiLogger.debug(
                {
                    originalLanguage: result.original_language || 'en',
                    wasTranslated: result.was_translated ?? false,
                    wasEnhanced: result.was_enhanced ?? false,
                    changesSummary: result.changes_summary || 'none',
                    optimizedPrompt: optimized,
                },
                `Prompt optimized: language=${result.original_language || 'unknown'}`
            );

            return {
                optimized,
                originalLanguage: result.original_language || "en",
                wasTranslated:    result.was_translated    ?? false,
                wasEnhanced:      result.was_enhanced      ?? false,
                changesSummary:   result.changes_summary   || "none",
            };
        } catch (e) {
            aiLogger.warn({ err: e }, `optimizePrompt failed: ${e.message}`);
            return {
                optimized:        prompt,
                originalLanguage: "unknown",
                wasTranslated:    false,
                wasEnhanced:      false,
                changesSummary:   "none",
            };
        }
    }

}

export const promptService = new PromptService();
export default PromptService;

