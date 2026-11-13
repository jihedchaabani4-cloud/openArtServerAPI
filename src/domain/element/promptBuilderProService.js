/**
 * Prompt Builder Pro Service
 * @owns System 1: Generation & Workflows
 * Assembles non-bleeding prompt payloads for gpt-image-2 / Flux.
 * Pure service: does not perform DB lookups directly. Elements are passed as plain DTOs.
 * Feature: 018-element-reference-system
 */

// ─── @ElementName Token Resolver ─────────────────────────────────────────────

/**
 * Extract all @TokenName mentions from a prompt string.
 * Matches @Word, @Multi Word (up to 4 words), @Quoted Name
 * @param {string} prompt
 * @returns {string[]} Array of matched token names (without @)
 */
export function extractElementTokens(prompt) {
    if (!prompt || typeof prompt !== "string") return [];
    // Match @"Quoted Name" or @SingleWord (letters, numbers, underscores)
    const matches = [...prompt.matchAll(/@"([^"]+)"|@([a-zA-Z0-9_]+)/g)];
    return matches.map(m => m[1] || m[2]);
}

/**
 * Strip @ElementName tokens from a prompt string.
 * @param {string} prompt
 * @returns {string}
 */
export function stripElementTokens(prompt) {
    if (!prompt || typeof prompt !== "string") return "";
    return prompt
        .replace(/@"[^"]+"/g, "")
        .replace(/@[a-zA-Z0-9_]+/g, "")
        .replace(/\s{2,}/g, " ")
        .trim();
}

// ─── Service Class ────────────────────────────────────────────────────────────

export class PromptBuilderProService {
    /**
     * Build a multi-element scene generation prompt payload.
     * Pure function: elements must be pre-resolved by caller.
     *
     * @param {Object} params
     * @param {string} params.userPrompt         - The main user scene description (may contain @ElementName)
     * @param {Array<Object>} [params.elements]  - Resolved element objects
     * @returns {Promise<{ compiled_prompt, reference_sheets, negative_prompt, referenceImages, contextNote, scenePrompt }>}
     */
    async buildMultiElementPayload({ userPrompt, elements = [] }) {
        if (!userPrompt || typeof userPrompt !== "string") {
            throw new Error("ERR_INVALID_PARAMS: userPrompt is required");
        }

        const promptParts     = [];
        const referenceSheets = [];
        const contextNotes    = [];
        const resolvedElements = [...elements];

        // ── Strip @tokens from scene prompt ──
        const scenePrompt = stripElementTokens(userPrompt);

        // ── Build prompt parts ──
        promptParts.push(`Main Scene: ${scenePrompt}`);

        resolvedElements.forEach((elem, index) => {
            const subjectIndex = index + 1;
            const elemName     = elem.name || `Element ${subjectIndex}`;
            const identityText = elem.description || elem.master_identity || elemName;
            const rulesArray   = elem.rules || elem.consistency_rules || [];
            const rulesStr     = Array.isArray(rulesArray) ? rulesArray.join(", ") : "";

            promptParts.push(
                `[Subject ${subjectIndex} - ${elemName}]: ${identityText}` +
                (rulesStr ? ` (Key Rules: ${rulesStr})` : "")
            );

            // Collect context notes from @token resolution
            if (elem._contextNote) contextNotes.push(elem._contextNote);

            // Collect reference images (from reference_images array or sheet_image/reference_sheet_url)
            const refImages = elem.reference_images || [];
            if (refImages.length > 0) {
                referenceSheets.push(...refImages);
            } else {
                const sheetUrl = elem.sheet_image || elem.reference_sheet_url;
                if (sheetUrl) referenceSheets.push(sheetUrl);
            }
        });

        promptParts.push("Global Style: Cohesive scene lighting, natural shadows, high resolution photorealistic composition.");

        const negativePrompt = "multi-panel split, grid layout, split screen, collage, frames, borders, watermark";
        const contextNote    = contextNotes.length > 0 ? contextNotes.join(" | ") : null;

        return {
            // Legacy fields (backward compat)
            compiled_prompt:  promptParts.join(" | "),
            reference_sheets: referenceSheets,
            negative_prompt:  negativePrompt,
            // V1 fields for @ElementName resolution
            referenceImages:  referenceSheets,
            contextNote,
            scenePrompt,
        };
    }

    /**
     * Synchronous version (no @token resolution) — preserved for backward compat.
     * @deprecated Use buildMultiElementPayload (async) for new code.
     */
    buildMultiElementPayloadSync({ userPrompt, elements = [] }) {
        if (!userPrompt || typeof userPrompt !== "string") {
            throw new Error("ERR_INVALID_PARAMS: userPrompt is required");
        }

        const promptParts     = [];
        const referenceSheets = [];

        promptParts.push(`Main Scene: ${userPrompt}`);

        elements.forEach((elem, index) => {
            const subjectIndex = index + 1;
            const elemName     = elem.name || `Element ${subjectIndex}`;
            const identityText = elem.description || elem.master_identity || elemName;
            const rulesArray   = elem.rules || elem.consistency_rules || [];
            const rulesStr     = Array.isArray(rulesArray) ? rulesArray.join(", ") : "";

            promptParts.push(
                `[Subject ${subjectIndex} - ${elemName}]: ${identityText}` +
                (rulesStr ? ` (Key Rules: ${rulesStr})` : "")
            );

            const sheetUrl = elem.sheet_image || elem.reference_sheet_url;
            if (sheetUrl) referenceSheets.push(sheetUrl);
        });

        promptParts.push("Global Style: Cohesive scene lighting, natural shadows, high resolution photorealistic composition.");

        return {
            compiled_prompt:  promptParts.join(" | "),
            reference_sheets: referenceSheets,
            negative_prompt:  "multi-panel split, grid layout, split screen, collage, frames, borders, watermark",
        };
    }
}

export default new PromptBuilderProService();
