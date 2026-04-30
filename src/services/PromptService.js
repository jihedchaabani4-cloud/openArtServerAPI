export class PromptService {
    /**
     * @param {import('../core/providers/BaseTextProvider').BaseTextProvider} textProvider
     */
    constructor(textProvider) {
        this.textProvider = textProvider;
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
            const result = await this.textProvider.completeJSON({ systemPrompt, userPrompt });
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
     *
     * @param {string} prompt - raw user input
     * @param {{ mode?: "image"|"video", style?: string }} [opts]
     * @returns {{ optimized: string, originalLanguage: string, wasTranslated: boolean, wasEnhanced: boolean }}
     */
    async optimizePrompt(prompt, { mode = "image", style = "cinematic" } = {}) {
        if (!prompt?.trim()) return {
            optimized: prompt,
            originalLanguage: "en",
            wasTranslated: false,
            wasEnhanced: false,
        };

                    const modeHint = mode === "video"
                        ? "for an AI video generation model (describe motion, camera, atmosphere)"
                        : "for an AI image generation model (describe visuals, lighting, composition, style)";

                    const systemPrompt = `
            You are an expert AI Prompt Engineer and multilingual translator specialized in generative AI.

            YOUR TASKS (in order):
            1. DETECT the language of the user's input (may be Arabic, Tunisian Darija, French, mixed, or English).
            2. TRANSLATE to fluent English if the input is not already English.
            3. FIX any incomplete or broken words, typos, or half-written expressions.
            4. ENHANCE the result ${modeHint}. Add descriptive visual details, lighting, mood, and style keywords — but preserve the user's core intent. Keep it under 120 words.
            5. Return ONLY a valid JSON object matching this schema:

            {
                "optimized_prompt": string,       // the final English, enhanced, clean prompt
                "original_language": string,      // detected language code (e.g. "ar", "fr", "en", "tn-darija")
                "was_translated": boolean,        // true if translation was needed
                "was_enhanced": boolean,          // true if you added or fixed content
                "changes_summary": string         // one-line summary of what you changed (or "none")
            }

            RULES:
            - NEVER refuse. Always return a result.
            - NEVER add inappropriate or NSFW content.
            - If input is already a perfect English prompt, still return it cleaned up with minor enhancements.
            - Keep the user's creative vision. Do not replace their idea with something else.
            - If the user wrote a single word or very short phrase, expand it into a descriptive prompt.
            `;

        const userPrompt = `User input: "${prompt}"`;

        try {
            const result = await this.textProvider.completeJSON({ systemPrompt, userPrompt, temperature: 0.5 });
            return {
                optimized:        result.optimized_prompt  || prompt,
                originalLanguage: result.original_language || "en",
                wasTranslated:    result.was_translated    ?? false,
                wasEnhanced:      result.was_enhanced      ?? false,
                changesSummary:   result.changes_summary   || "none",
            };
        } catch (e) {
            console.error("[PromptService] optimizePrompt failed:", e);
            return {
                optimized:        prompt,
                originalLanguage: "en",
                wasTranslated:    false,
                wasEnhanced:      false,
                changesSummary:   "none",
            };
        }
    }

    /** @deprecated — use optimizePrompt instead */
    async upscalePrompt(prompt, { style = "cinematic", quality = "ultra" } = {}) {
        return this.optimizePrompt(prompt, { style });
    }


    async generateDnaFromPrompt(userPrompt) {
        const systemPrompt = `You are a Master Character Architect and Cinematographer. Your EXCLUSIVE goal is photorealistic human/character generation.
        Prioritize extreme macro-details, dermatological accuracy, and character soul.
        Return JSON object following ULTIMATE DNA v4.0 Schema including "professional_prompt" field.`;

        try {
            return await this.textProvider.completeJSON({ systemPrompt, userPrompt, temperature: 0.5 });
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
            return await this.textProvider.completeJSON({ systemPrompt, userPrompt, temperature: 0.4 });
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
            return await this.textProvider.completeJSON({ systemPrompt, userPrompt });
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
            return await this.textProvider.complete({ systemPrompt, userPrompt, temperature: 0.7 });
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
            const result = await this.textProvider.completeJSON({ systemPrompt, userPrompt, temperature: 0.2 });
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
            const result = await this.textProvider.completeJSON({ systemPrompt, userPrompt });
            return result.variations || Array(count).fill(basePrompt);
        } catch (e) {
            console.error("Scene variations generation failed:", e);
            return Array(count).fill(basePrompt);
        }
    }

    async generateCameraPrompt(cameraText) {
        const systemPrompt = `
            You are a professional cinematographer and AI video prompt engineer specializing in camera motion and composition.

            Your task: Convert a user's natural-language camera instruction into two things:
            1. A "camera_prompt" — a short cinematic description (max 20 words) that can be appended to a video generation prompt to describe the camera motion or position. Use cinematic language: "slow dolly in", "aerial pull-back", "tracking shot left", "subtle handheld shake", "bird's-eye view", "low angle tilt up", etc.
            2. A "camera_control" object (optional) — structured control parameters if applicable.

            camera_control schema (use ONLY known values, leave null if unsure):
            {
                "type": "zoom_in" | "zoom_out" | "pan_left" | "pan_right" | "tilt_up" | "tilt_down" | "rotate_cw" | "rotate_ccw" | "static" | null,
                "speed": "slow" | "normal" | "fast" | null
            }

            Return ONLY valid JSON:
            {
                "camera_prompt": string,
                "camera_control": { "type": string | null, "speed": string | null }
            }
        `;
        const userPrompt = `Camera instruction: "${cameraText}"`;
        try {
            const result = await this.textProvider.completeJSON({ systemPrompt, userPrompt, temperature: 0.4 });
            return {
                cameraPrompt:   result.camera_prompt   || "",
                cameraControl:  result.camera_control  || null,
            };
        } catch (e) {
            console.error("Camera prompt generation failed:", e);
            return { cameraPrompt: cameraText, cameraControl: null };
        }
    }
}
