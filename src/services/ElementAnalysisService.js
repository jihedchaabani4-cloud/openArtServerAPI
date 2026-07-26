/**
 * ElementAnalysisService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Generates an AI description (Taste Profile) for an Element by analyzing
 * its reference images using LLMService.
 *
 * Usage:
 *   import { ElementAnalysisService } from "./ElementAnalysisService.js";
 *
 *   const analysisService = new ElementAnalysisService();
 *
 *   const description = await analysisService.generateDescription({
 *     elementName: "Cyberpunk Character",
 *     elementType: "character",   // character | object | style | font | logo
 *     references: [
 *       "data:image/png;base64,...",
 *       "https://cdn.example.com/ref.jpg",
 *     ],
 *   });
 *
 *   // description → "A futuristic character defined by neon-lit textures..."
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { LLMService } from "../core/LLMService.js";

// ── Prompt templates per element type ─────────────────────────────────────────

const ELEMENT_TYPE_PROMPTS = {
  character: `You are analyzing reference images for an AI Generation Element of type "Character".
Synthesize a 2-4 sentence Taste Profile describing:
- Facial features, skin tone, hair style/color
- Clothing style and materials
- Lighting mood and cinematic atmosphere
- Overall visual aesthetic and art direction
Be specific, professional, and concise. Output plain text only.`,

  object: `You are analyzing reference images for an AI Generation Element of type "Object".
Synthesize a 2-4 sentence Taste Profile describing:
- Shape, form, and structural details
- Material, texture, and surface finish
- Lighting and rendering style
- Overall design language and aesthetic
Be specific, professional, and concise. Output plain text only.`,

  style: `You are analyzing reference images for an AI Generation Element of type "Style".
Synthesize a 2-4 sentence Taste Profile describing:
- Color palette and tonal range
- Visual mood and atmosphere
- Artistic technique and rendering approach
- Key aesthetic characteristics that define this style
Be specific, professional, and concise. Output plain text only.`,

  font: `You are analyzing reference images for an AI Generation Element of type "Font / Typography".
Synthesize a 2-4 sentence Taste Profile describing:
- Typeface classification (serif, sans-serif, display, etc.)
- Weight, spacing, and letterform characteristics
- Visual mood and intended use context
- Any decorative or stylistic features
Be specific, professional, and concise. Output plain text only.`,

  logo: `You are analyzing reference images for an AI Generation Element of type "Logo / Brand Mark".
Synthesize a 2-4 sentence Taste Profile describing:
- Shape language and composition
- Color palette and contrast
- Visual identity and brand personality
- Design style (minimalist, geometric, illustrative, etc.)
Be specific, professional, and concise. Output plain text only.`,
};

const DEFAULT_TYPE_PROMPT = `You are analyzing reference images for an AI Generation Element.
Synthesize a 2-4 sentence Taste Profile describing the visual aesthetic, mood, lighting, materials, and color palette.
Be specific, professional, and concise. Output plain text only.`;

// ── ElementAnalysisService ────────────────────────────────────────────────────

export class ElementAnalysisService {
  /**
   * @param {object} [opts]
   * @param {import("../core/LLMService.js").LLMService} [opts.llmService]
   *   Optional pre-configured LLMService instance (useful for testing/DI).
   */
  constructor(opts = {}) {
    this.llm = opts.llmService || new LLMService();
  }

  /**
   * Generate an AI Taste Profile description for an element.
   *
   * @param {object} params
   * @param {string}   params.elementName  - Human-readable element name
   * @param {string}   [params.elementType] - "character" | "object" | "style" | "font" | "logo"
   * @param {string[]} [params.references]  - Array of image URLs or base64 data URIs
   *
   * @returns {Promise<string>} Generated description text
   */
  async generateDescription({ elementName, elementType = "object", references = [] }) {
    const startedAt = Date.now();

    const systemInstructions =
      ELEMENT_TYPE_PROMPTS[elementType] || DEFAULT_TYPE_PROMPT;

    const userPrompt = `Element Name: "${elementName}"
Element Type: ${elementType}
${references.length > 0 ? `Reference Images: ${references.length} image(s) provided.` : "No reference images provided — generate a generic description based on the element type."}

Based on the above, generate a professional Taste Profile description for this element.`;

    console.log(
      `[ElementAnalysisService] generateDescription — element="${elementName}", type=${elementType}, refs=${references.length}`
    );

    const fullPrompt = `${systemInstructions}\n\n${userPrompt}`;

    const description = await this.llm.analyze({
      prompt: fullPrompt,
      references,
      mode: "text",
    });

    const durationMs = Date.now() - startedAt;
    console.log(
      `[ElementAnalysisService] Done in ${durationMs}ms — description length: ${description.length}`
    );

    return description;
  }
}
