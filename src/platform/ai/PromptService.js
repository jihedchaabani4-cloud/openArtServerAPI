import { llmService } from "./LLMService.js";
import { createLogger } from "../../infrastructure/logging/index.js";

const aiLogger = createLogger("ai");

export class PromptService {
    constructor() {
        this.modelFamily = "gemini-3-flash";
    }

    async complete({ systemPrompt, userPrompt, temperature = 0.7, options = {} }) {
        return llmService.generateText({
            prompt: userPrompt,
            systemInstruction: systemPrompt,
            temperature,
            model: this.modelFamily,
            options,
        });
    }

    async completeJSON({ systemPrompt, userPrompt, temperature = 0.7, options = {} }) {
        return llmService.generateJSON({
            prompt: userPrompt,
            systemInstruction: systemPrompt,
            temperature,
            model: this.modelFamily,
            options,
        });
    }

    async checkPrompt(prompt) {
        const systemPrompt = `
            You are a Professional Image Prompt Moderator and Translator.
            
            YOUR TASKS:
            1. ONLY flag content that is EXPLICITLY SEXUAL, PORNOGRAPHIC, or contains extreme real-world gore.
            2. BE EXTREMELY LENIENT with all other topics. DO NOT flag political figures (e.g., "Donald Trump", "Putin"), celebrities, or controversial scenarios unless they are depict explicit sexual acts. 
            3. Creative, satirical, or descriptive prompts involving real people are 100% SAFE.
            4. Detect the language. If NOT English, translate it to high-quality English for image generation.
            5. Return a JSON object ONLY.
            
            JSON SCHEMA:
            {
                "is_safe": boolean,
                "rejection_reason": string | null, // explain briefly if flagged
                "language": string,
                "translated_prompt": string
            }
        `;

        const userPrompt = `Analyze and translate this prompt: "${prompt}"`;

        try {
            const result = await this.completeJSON({ systemPrompt, userPrompt });
            return {
                safe: result.is_safe,
                reason: result.rejection_reason,
                language: result.language,
                translatedPrompt: result.translated_prompt
            };
        } catch (e) {
            console.error("Prompt check failed, defaulting to safe:", e);
            return { safe: true, reason: null, language: "en", translatedPrompt: prompt };
        }
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
    async optimizePrompt(prompt, { mode = "image", style = "cinematic" } = {}) {
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
            const result = await this.completeJSON({ systemPrompt, userPrompt, temperature: 0.4 });
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

    async generateDnaFromPrompt(userPrompt) {
        const systemPrompt = `You are a Master Character Architect and Cinematographer. Your EXCLUSIVE goal is photorealistic human/character generation.
        Prioritize extreme macro-details, dermatological accuracy, and character soul.
        Return JSON object following ULTIMATE DNA v4.0 Schema including "professional_prompt" field.`;

        try {
            return await this.completeJSON({ systemPrompt, userPrompt, temperature: 0.5 });
        } catch (e) {
            console.error("DNA generation failed:", e);
            return null;
        }
    }

    async expandMinimalDna(minimalDna) {
        const systemPrompt = `You are a Master Character Architect. Your task is to expand a minimal character selector into a full, high-fidelity ULTIMATE DNA v4.0.
        Fill ALL fields with hyper-realistic, consistent, and detailed values. 
        Ensure the generated "professional_prompt" is a high-density visual description.
        Return ONLY valid JSON.`;

        const userPrompt = `Minimal Selector: ${JSON.stringify(minimalDna)}`;

        try {
            return await this.completeJSON({ systemPrompt, userPrompt, temperature: 0.4 });
        } catch (e) {
            console.error("DNA expansion failed:", e);
            return null;
        }
    }

    async processEditIntent(dna, userIntent) {
        const systemPrompt = `You are a Surgical Prompt Engineer. Modify ONLY the requested visual trait with hyper-realistic detail.
        Current DNA will be provided. User intent: "${userIntent}".
        TASK: Identify which fields to change. Generate a max 25-word surgical prompt focusing strictly on the material/texture of the change.
        Return JSON: { "dna_changes": {...}, "change_prompt": "..." }`;

        const userPrompt = `Current DNA: ${JSON.stringify(dna)}`;

        try {
            return await this.completeJSON({ systemPrompt, userPrompt });
        } catch (e) {
            console.error("Edit intent processing failed:", e);
            return { dna_changes: {}, change_prompt: "" };
        }
    }

    async generateProfessionalPromptFromDna(dna, userCommand = "") {
        const systemPrompt = `You are a High-Density AI Prompt Engineer for Photorealistic Portraits.
        Generate a HIGH-DENSITY, 100-TOKEN photographic prompt based on provided DNA.
        Rules: 80% tokens on face/skin/eyes/clothing, 20% on camera gear/lighting. Bokeh background.`;

        const userPrompt = `CHARACTER DNA: ${JSON.stringify(dna)} ${userCommand ? `Context: "${userCommand}"` : ""}`;

        try {
            return await this.complete({ systemPrompt, userPrompt, temperature: 0.7 });
        } catch (e) {
            console.error("Professional prompt generation failed:", e);
            return "";
        }
    }

    async generateNegativePrompt(prompt) {
        const systemPrompt = `
            You are a Professional Negative Prompt Engineer for diffusion models.
            Given a user's positive prompt, produce a concise comma-separated negative prompt that removes:
            low quality, blur, artifacts, extra limbs/fingers, bad anatomy, deformed, watermark, text, logo,
            oversaturation, color banding, jpeg artifacts, noise, low-res, duplicate, distortion.
            Return JSON only: { "negative": string }.
        `;
        const userPrompt = `Positive prompt: "${prompt}"`;
        try {
            const result = await this.completeJSON({ systemPrompt, userPrompt, temperature: 0.2 });
            return result.negative || "";
        } catch (e) {
            console.error("Negative prompt generation failed:", e);
            return "low quality, blurry, artifacts, extra fingers, bad anatomy, deformed, watermark, text, logo";
        }
    }

    async generateSceneVariations(basePrompt, count = 4) {
        const systemPrompt = `
            You are a Creative Storyboard Artist and AI Prompt Engineer.
            Your task is to take a base image prompt and generate ${count} distinct variations of it.
            
            VARIATION RULES:
            - Each variation must describe a different scene, angle, lighting, or context while keeping the core subject identical.
            - Ensure diverse compositions (e.g., macro shot, wide shot, Dutch angle, bird's eye view).
            - Vary time of day and atmosphere (e.g., neon-lit night, foggy morning, golden hour).
            - Keep each variation concise (under 50 words).
            - Return JSON: { "variations": [string, string, ...] }
        `;

        const userPrompt = `Base Prompt: "${basePrompt}"\nGenerate ${count} variations.`;

        try {
            const result = await this.completeJSON({ systemPrompt, userPrompt });
            return result.variations || Array(count).fill(basePrompt);
        } catch (e) {
            console.error("Scene variations generation failed:", e);
            return Array(count).fill(basePrompt);
        }
    }
}
