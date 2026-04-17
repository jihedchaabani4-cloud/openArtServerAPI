/**
 * ─── DnaTreatment ─────────────────────────────────────────────────────────────
 *
 * Responsible for:
 *   1. Receiving a character's features JSON + description from the frontend
 *   2. Calling the LLM to generate a rich, detailed DNA narrative
 *   3. Saving the DNA record to the `dna` table (linked to generation_config_id)
 *   4. Returning the created DNA object
 *
 * Usage:
 *   const dna = await dnaTreatment.create({
 *       generation_config_id,   // required — links DNA to the generation
 *       name,                   // e.g. "Zara - Alien Scout"
 *       type,                   // "CHARACTER" | "LOCATION" | "PRODUCT"
 *       features,               // { characterType, gender, race, age, build, ... }
 *       userDescription,        // optional free-text from the user
 *   });
 */

const SYSTEM_PROMPTS = {
    CHARACTER: `You are a creative-writing AI specializing in character lore and biology codexes.
Your task is to write a detailed, immersive DNA / Character Profile document for a fictional character based on the provided features and description.

STRUCTURE TO FOLLOW (in flowing prose, not bullet points):
1. ORIGIN & SPECIES — Describe the character's species or character type, their evolutionary background, and home environment.
2. PHYSICAL BLUEPRINT — Precise head-to-toe description: body structure, proportions, and distinctive physical traits.
3. BIOLOGICAL TRAITS — Unique physiological abilities, natural defenses, and senses.
4. PSYCHOLOGICAL PROFILE — Personality tendencies, instincts, and emotional range.
5. CULTURAL & SOCIAL IMPRINT — How their species typically organizes socially and how this individual fits.
6. SIGNATURE DETAIL — One ultra-specific, unique detail that makes them memorable.

RULES:
- Adapt every section to the CHARACTER TYPE (Human, Alien, Ant, etc.)
- Respond with pure prose only. No headers, no bullet points.
- Length: 200–350 words total.`,

    LOCATION: `You are a creative-writing AI specializing in world-building and environmental lore.
Your task is to write a detailed, atmospheric "Location Dossier" for a fictional setting.

FOCUS ON:
1. GEOGRAPHY & ATMOSPHERE — Describe the terrain, weather patterns, and the "vibe" of the air/environment.
2. ARCHITECTURAL / NATURAL FEATURES — Distinguishing structures, vegetation, or geological formations.
3. HISTORY & ENERGY — What happened here? Is the place sacred, abandoned, industrial, or magical?
4. SENSORY DETAILS — The smells, sounds, and tactile feelings of being there.

RULES:
- Respond with pure prose only. No headers, no bullet points.
- Length: 150–250 words total.`,

    PRODUCT: `You are a creative-writing AI specializing in futuristic industrial design and craftsmanship lore.
Your task is to write a professional "Product Specification & Origin" document.

FOCUS ON:
1. DESIGN PHILOSOPHY — The aesthetic intent and form factor of the product.
2. MATERIALS & CRAFTSMANSHIP — What is it made of? How was it manufactured? (e.g. Damascus titan-steel, hand-woven bio-fiber).
3. FUNCTIONAL PURPOSE — What is it for? How does it solve a problem or enhance the user?
4. RARITY & VALUE — Is it a common tool, a luxury artifact, or a one-of-a-kind prototype?

RULES:
- Respond with pure prose only. No headers, no bullet points.
- Length: 150–250 words total.`,
};

// ─────────────────────────────────────────────────────────────────────────────

export class DnaTreatment {
    constructor({ promptService, db }) {
        this.promptService = promptService;
        this.db = db;
    }

    // ─── Build the LLM user message ───────────────────────────────────────────
    _buildUserPrompt(features, userDescription) {
        let msg = "";

        if (features && Object.keys(features).length > 0) {
            msg += `Character Features:\n${JSON.stringify(features, null, 2)}\n\n`;
        }

        if (userDescription?.trim()) {
            msg += `User Description / Notes:\n${userDescription.trim()}\n`;
        }

        if (!msg.trim()) {
            msg = "No features provided. Generate a generic fascinating character DNA profile.";
        }

        return msg;
    }

    // ─── MAIN CREATE ─────────────────────────────────────────────────────────
    /**
     * @param {object} input
     * @param {string} input.generation_config_id  — required, FK to generation_config
     * @param {string} [input.name]                — display name for this DNA record
     * @param {string} [input.type]                — "CHARACTER" | "LOCATION" | "PRODUCT"
     * @param {object} [input.features]            — structured features from the frontend
     * @param {string} [input.userDescription]     — optional free-text description
     */
    async create(input) {
        const {
            generation_config_id,
            name            = "Untitled Character",
            type            = "CHARACTER",
            features        = {},
            userDescription = "",
        } = input;

        if (!generation_config_id) {
            throw new Error("[DnaTreatment] generation_config_id is required.");
        }

        console.log(`\n${"─".repeat(60)}`);
        console.log(`🧬 [DnaTreatment] Creating DNA for: "${name}" (${type})`);
        console.log(`   generation_config: ${generation_config_id}`);
        console.log(`   features keys:     ${Object.keys(features).join(", ") || "none"}`);

        // 1. Build LLM user prompt
        const userPrompt = this._buildUserPrompt(features, userDescription);
        const systemPrompt = SYSTEM_PROMPTS[type.toUpperCase()] || SYSTEM_PROMPTS.CHARACTER;

        // 2. Call LLM
        console.log(`\n🧠 [DnaTreatment] Calling LLM for ${type} DNA generation...`);
        const description = await this.promptService.textProvider.complete({
            systemPrompt,
            userPrompt,
            temperature: 0.75,
        });

        console.log(`✨ [DnaTreatment] DNA generated (${description.length} chars)`);

        // 3. Save to DB
        const dna = await this.db.dna.createDna({
            generation_config_id,
            name,
            type: type.toUpperCase(),
            description,
            traits: features,
        });

        console.log(`✅ [DnaTreatment] DNA saved → id: ${dna.id}`);
        console.log(`${"─".repeat(60)}\n`);

        return dna;
    }
}
