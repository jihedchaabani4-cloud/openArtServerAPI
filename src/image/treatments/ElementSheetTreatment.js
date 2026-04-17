import { GenerateImageTreatment } from "./ImageTreatment.js";

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM PROMPTS — one per sheet type
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPTS = {

  CHARACTER: `You are an AI Prompt Engineer specializing in character turnaround reference sheet generation.
Your task is to convert the user's features, narrative descriptions, and image reference tags into ONE ultra-detailed character reference sheet prompt.

The output must describe a SINGLE professional character turnaround sheet in one cohesive studio composition.

LAYOUT:
- LEFT: Full-body FRONT view (head to toe)
- CENTER: Full-body BACK view (head to toe)
- TOP-RIGHT: Large close-up portrait of the head and neck only (facial and neck detail focus)

CRITICAL COMPOSITION RULES:
- All views depict the EXACT SAME character
- Must look like a professional character turnaround sheet
- Clean studio background
- Consistent lighting across all views
- Consistent proportions across all views
- One cohesive character sheet image — no collage, no borders, no separated renders

REALISM STYLE (VERY IMPORTANT):
If the user requests "hyper realistic", "photorealistic", or "realistic", interpret it as:

- biologically plausible realism
- creature realism
- cinematic creature realism
- realistic non-human anatomy
- documentary wildlife realism

This applies to BOTH human and non-human characters.

The realism must feel like:
- documentary photography
- real creature photography
- real-world anatomy
- cinematic studio photography

Avoid artificial AI-looking humans or cartoon-like creatures.

IMPORTANT:
The character must NOT appear human-like unless the characterType is HUMAN.
Maintain true anatomical structure.
Avoid human body proportions for non-human characters.
Non-human characters must follow biological plausibility.

DEFAULT:
If no characterType is provided → default to HUMAN.

CHARACTER TYPE ADAPTATION (CRITICAL — read the "characterType" in Features):
You MUST adapt the physical description to the CHARACTER TYPE.

- If type is HUMAN → describe realistic human anatomy, natural skin detail, realistic facial structure, cinematic realism
- If type is ALIEN → exotic biologically plausible anatomy, non-human proportions, creature realism
- If type is ANT → segmented exoskeleton, compound eyes, antennae, mandibles, six-limb structure, realistic insect anatomy
- If type is BEE → fuzzy striped body, wings, compound eyes, stinger, biologically plausible bee anatomy
- If type is OCTOPUS → soft flexible body, tentacles, suckers, realistic cephalopod anatomy
- If type is CROCODILE → thick scales, muscular tail, powerful jaw, reptilian anatomy
- If type is IGUANA → dorsal spines, dewlap, reptilian scales
- If type is LIZARD → scaled skin, forked tongue, reptilian features
- If type is BEETLE → chitin shell, horns, segmented insect body
- If type is REPTILE → generic reptilian anatomy
- If type is AMPHIBIAN → moist skin, large eyes, webbed limbs
- If type is ELF → humanoid but realistic, natural facial structure
- If type is MANTIS → triangular head, raptorial arms, insect anatomy

STYLE TARGET:
Professional AAA game character turnaround sheet
Concept art reference sheet
Character model sheet
Orthographic character reference layout
Consistent scale between views

STUDIO LIGHTING & QUALITY:
Professional studio photography
Biologically plausible realism
Creature realism
Cinematic creature realism
Realistic non-human anatomy
Documentary wildlife realism
Seamless neutral grey background
Soft cinematic lighting
Consistent shadows
Ultra sharp focus
8K resolution
Zero motion blur

REFERENCE RULES:
If the user references images via tags like <image0>, translate to:
"identical in appearance to the character shown in the first provided reference image".

Fill missing details automatically with coherent choices consistent with the character type.

NEGATIVE:
—NEGATIVE: collage, separate images, split panels, panel borders, dividing lines, inconsistent character between views, multiple characters, inconsistent lighting, text labels, arrows, watermark, UI overlay, blurry, low resolution, cartoon style, stylized illustration, anime style, 3D render look, artificial AI face

OUTPUT:
One flowing paragraph followed by the —NEGATIVE line. No introductions, no explanations, no bullet points.`,
    LOCATION: `You are an AI Prompt Engineer specializing in environment and location reference image generation.
Your task is to convert the user's prompt and image reference tags into ONE ultra-detailed image generation prompt.

The output must describe a SINGLE large-format hero image that presents the location in THREE integrated views within one cohesive composition:
- LEFT THIRD: Wide panoramic view of the entire location, establishing scale and atmosphere
- CENTER THIRD: Mid-range view focusing on the main structures, terrain features, or key architectural elements
- FLOATING INSERT (top-right corner): Large close-up of a specific texture, material, or interior detail

CRITICAL COMPOSITION RULES:
- All three views depict the EXACT SAME location — consistent lighting, color palette, time of day, and weather across all views
- The three views exist within a single seamless image, not as separate panels or frames
- No dividers, borders, or lines separating the views
- The close-up insert is organically placed, not boxed

ENVIRONMENT LIGHTING & QUALITY (default if no style specified):
"Captured with architectural visualization standards, seamless natural environment, volumetric lighting consistent with the specified time of day, golden-hour or overcast soft diffusion, ultra-detailed surface textures (stone grain, wood fiber, metal oxidation), photorealistic, 8K resolution, zero motion blur, shot on Phase One IQ4 150MP wide-angle lens."

NEGATIVE (always append at the end after a line break, starting with —NEGATIVE:):
—NEGATIVE: split panels, panel borders, dividing lines, inconsistent lighting between views, text labels, arrows, watermarks, UI overlays, people in the scene (unless requested), multiple different locations, low resolution, overexposed sky, flat lighting, cartoon style (unless requested)

STYLE ADAPTATION RULES:
1. If the user specifies an art style (concept art, watercolor, 3D render...), replace the default lighting/camera section with rendering language native to that style.
2. If the user references images via tags like <image0>, translate to: "identical in atmosphere and architecture to the location shown in the first provided reference image". Mood, materials, and spatial layout must match exactly.
3. Fill any missing details (biome, time of day, weather) with coherent, visually compelling choices — never leave a placeholder blank.
4. Enrich surfaces with material details: stone type, weathering, vegetation growth, ambient occlusion.

OUTPUT: One flowing paragraph (the image prompt) followed by the —NEGATIVE line. No introductions, no explanations, no bullet points.`,

    PRODUCT: `You are an AI Prompt Engineer specializing in product reference image generation.
Your task is to convert the user's prompt, product features, and image reference tags into ONE ultra-detailed image generation prompt.

The output must describe a SINGLE large-format hero image that presents the product in THREE integrated views within one cohesive studio composition:
- LEFT THIRD: Clean front-facing shot of the product, perfectly centered
- CENTER/RIGHT THIRD: Sleek angled or profile shot revealing depth and form
- FLOATING INSERT (top-right corner): Large close-up of the product's key texture, material detail, or signature feature

CRITICAL COMPOSITION RULES:
- All three views depict the EXACT SAME product — identical color, finish, proportions, and branding across all views
- The three views exist within a single seamless studio image, not as separate panels or frames
- No dividers, borders, or lines separating the views
- The close-up insert is organically placed, not boxed

STUDIO LIGHTING & QUALITY (default if no style specified):
"Shot in a professional product studio, seamless neutral grey backdrop, three-point lighting setup (strong key light from upper-left, soft fill from the right, sharp accent light from behind to define edges). Shot on Phase One IQ4 150MP, 120mm macro lens. Ultra-sharp focus, micro-detailed material textures, surface reflections accurate to material type, photorealistic, 8K resolution. Zero motion blur."

NEGATIVE (always append at the end after a line break, starting with —NEGATIVE:):
—NEGATIVE: split panels, panel borders, dividing lines, multiple backgrounds, text labels, price tags, arrows, watermarks, UI overlays, hands holding product (unless requested), inconsistent product color between views, low resolution, overexposed highlights, flat lighting, cartoon style (unless requested)

STYLE ADAPTATION RULES:
1. If the user specifies an art style (3D render, illustration, isometric...), replace the default studio lighting/camera section with rendering language native to that style.
2. If the user references images via tags like <image0>, translate to: "identical in design and finish to the product shown in the first provided reference image". Shape, color, material, and branding must match exactly.
3. Fill any missing details (material, color, function) with coherent, premium-looking choices — never leave a placeholder blank.
4. Enrich material descriptions: specify finish type (matte, gloss, brushed, anodized), surface imperfections if realistic, edge treatment, weight impression.

OUTPUT: One flowing paragraph (the image prompt) followed by the —NEGATIVE line. No introductions, no explanations, no bullet points.`,
};

// ─── Temperature per sheet type ───────────────────────────────────────────────
const PROMPT_TEMPERATURES = {
    CHARACTER: 0.4,
    LOCATION:  0.7,
    PRODUCT:   0.5,
};

// ─── Default model per sheet type ────────────────────────────────────────────
const DEFAULT_MODELS = {
    CHARACTER: "z_image",
    LOCATION:  "z_image",
    PRODUCT:   "z_image",
};

// ─────────────────────────────────────────────────────────────────────────────
// ElementSheetTreatment
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handles the full pipeline for element sheet generation:
 *   1. Sanitise reference tags in the user prompt (e.g. <MediaAsset:…> → <image0>)
 *   2. Call the LLM to build a detailed, structured image prompt
 *   3. Delegate to GenerateImageTreatment for the actual image generation
 *
 * Sheet workflows are ALWAYS project-scoped (session_id = null).
 * They appear in the project-level Elements library, not inside any specific session.
 *
 * Usage:
 *   const result = await elementSheetTreatment.execute({
 *       sheetType:  "CHARACTER" | "LOCATION" | "PRODUCT",
 *       prompt,
 *       features,       // optional structured feature object
 *       model_name,     // optional override
 *       references,     // array of { media_id, url, … }
 *       project_id,     // required
 *       userId,
 *   });
 */
export class ElementSheetTreatment extends GenerateImageTreatment {
    constructor({ promptService, models, storageService, db, dnaTreatment }) {
        super({ promptService, models, storageService, db });
        this.dnaTreatment = dnaTreatment;
    }

    // ─── Step 1: Sanitise the user text (replace <MediaAsset:id> → <imageN>) ──
    _sanitisePrompt(prompt, references) {
        let clean = prompt || "Generate a sheet.";
        if (references?.length) {
            references.forEach((ref, index) => {
                const tag = `<MediaAsset:${ref.media_id || ref.id}>`;
                clean = clean.split(tag).join(`<image${index}>`);
            });
        }
        return clean;
    }

    // ─── Step 2: Build the LLM user message ──────────────────────────────────
    _buildUserPrompt(cleanText, features) {
        let msg = `User Prompt: ${cleanText}\n`;
        if (features && Object.keys(features).length > 0) {
            msg += `Features selected: ${JSON.stringify(features, null, 2)}`;
        }
        return msg;
    }

    // ─── Step 3: Ask the LLM to create the final image prompt ────────────────
    async _refinePrompt(systemPrompt, userPrompt, temperature) {
        return this.promptService.textProvider.complete({
            systemPrompt,
            userPrompt,
            temperature,
        });
    }

    _toTitleCase(value) {
        return String(value || "")
            .toLowerCase()
            .replace(/\b\w/g, char => char.toUpperCase());
    }

    _cleanDisplayText(value) {
        return String(value || "")
            .replace(/[_-]+/g, " ")
            .replace(/\b(create|generate|make|draw|design|show|need|want)\b/gi, "")
            .replace(/\b(a|an|the)\b/gi, "")
            .replace(/\b(character|element|reference|turnaround|model|sheet|product|location)\b/gi, "")
            .replace(/\s+/g, " ")
            .replace(/^[,:;.\-\s]+|[,:;.\-\s]+$/g, "")
            .trim();
    }

    _buildSheetDisplayName(type, prompt, features = {}) {
        const directName = [
            features?.name,
            features?.title,
            features?.subject,
            features?.characterName,
            features?.productName,
            features?.locationName,
        ].find(value => typeof value === "string" && value.trim());

        if (directName) {
            return this._toTitleCase(this._cleanDisplayText(directName)).substring(0, 60);
        }

        if (type === "CHARACTER") {
            const parts = [
                features?.race || features?.ethnicity || features?.origin,
                features?.gender,
                features?.characterType && !["CHARACTER", "HUMAN"].includes(String(features.characterType).toUpperCase())
                    ? features.characterType
                    : null,
            ].filter(Boolean);

            if (parts.length) {
                return this._toTitleCase(this._cleanDisplayText(parts.join(" "))).substring(0, 60);
            }
        }

        if (type === "PRODUCT") {
            const parts = [
                features?.color,
                features?.material,
                features?.type || features?.category || features?.productType,
            ].filter(Boolean);

            if (parts.length) {
                return this._toTitleCase(this._cleanDisplayText(parts.join(" "))).substring(0, 60);
            }
        }

        if (type === "LOCATION") {
            const parts = [
                features?.biome || features?.environment,
                features?.style || features?.architecture,
                features?.type || features?.locationType,
            ].filter(Boolean);

            if (parts.length) {
                return this._toTitleCase(this._cleanDisplayText(parts.join(" "))).substring(0, 60);
            }
        }

        const cleanedPrompt = this._cleanDisplayText(prompt);
        if (cleanedPrompt) {
            return this._toTitleCase(cleanedPrompt).substring(0, 60);
        }

        return `${this._toTitleCase(type)} Sheet`;
    }

    // ─── MAIN EXECUTE ─────────────────────────────────────────────────────────
    /**
     * @param {object} input
     * @param {"CHARACTER"|"LOCATION"|"PRODUCT"} input.sheetType
     */
    async execute(input) {
        const {
            sheetType  = "CHARACTER",
            prompt     = "",
            features,
            references = [],
            model_name,
            project_id,
            // session_id intentionally omitted — sheet workflows are project-level
            userId,
        } = input;

        const TYPE = sheetType.toUpperCase();

        const systemPrompt = SYSTEM_PROMPTS[TYPE];
        if (!systemPrompt) {
            throw new Error(`[ElementSheetTreatment] Unknown sheetType "${sheetType}". Must be CHARACTER, LOCATION, or PRODUCT.`);
        }

        if (!project_id) throw new Error("[ElementSheetTreatment] project_id is required.");

        const temperature = PROMPT_TEMPERATURES[TYPE] ?? 0.5;

        console.log(`\n${"─".repeat(60)}`);
        console.log(`📋 [ElementSheetTreatment] ${TYPE} sheet request`);
        console.log(`   project:     ${project_id}`);
        console.log(`   model:       ${model_name || DEFAULT_MODELS[TYPE]}`);
        console.log(`   temperature: ${temperature}`);
        console.log(`   references:  ${references?.length || 0}`);
        console.log(`   prompt:      "${prompt.substring(0, 80)}"`);

        // 1. Sanitise reference tags
        const cleanText  = this._sanitisePrompt(prompt, references);
        const userPrompt = this._buildUserPrompt(cleanText, features);

        console.log(`\n🧠 [ElementSheetTreatment] Calling LLM for prompt refinement...`);

        // 2. Refine prompt via LLM
        const refinedPrompt = await this._refinePrompt(systemPrompt, userPrompt, temperature);
        const displayName   = this._buildSheetDisplayName(TYPE, cleanText, features);

        console.log(`✨ [ElementSheetTreatment] Refined prompt received:`);
        console.log(`   "${refinedPrompt.substring(0, 120)}..."`);

        // 3. Delegate to parent ImageTreatment with the refined prompt.
        //    session_id is NOT passed → workflow created at project level (session_id = null).
        //    16:9 wide ratio is ideal for the 3-view hero layout.
        const result = await super.execute({
            prompt,
            prompt_optimise: refinedPrompt,
            display_name:    displayName,
            model_name:      model_name || DEFAULT_MODELS[TYPE],
            references,
            ratio:           "3:2",
            quality:         "1k",
            count:           1,
            workflow_type:   "ELEMENT_SHEET",
            project_id,
            session_id:    null,   // ← project-level, no session
            userId,
        });

        console.log(`✅ [ElementSheetTreatment] ${TYPE} sheet dispatched → configId: ${result.configId}`);

        // 4. GENERATE DNA NARRATIVE (Asynchronous / Non-blocking)
        if (this.dnaTreatment) {
            this.dnaTreatment.create({
                generation_config_id: result.configId,
                name: features?.name || `${features?.characterType || TYPE} Sheet`,
                type: TYPE,
                features,
                userDescription: prompt,
            }).catch(err => {
                console.error(`❌ [ElementSheetTreatment] DNA generation failed: ${err.message}`);
            });
        }

        console.log(`${"─".repeat(60)}\n`);

        return result;
    }
}
