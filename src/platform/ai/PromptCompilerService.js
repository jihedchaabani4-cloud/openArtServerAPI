/**
 * PromptCompilerService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Prompt Intelligence Engine V2 — Single-LLM Compiler
 *
 * Replaces the old sequential pipeline (safety → translate → optimize →
 * negative-prompt) with a single LLM call that performs ALL tasks at once:
 *
 *   1. Safety moderation
 *   2. Language detection & translation
 *   3. Intent understanding
 *   4. Template structure application
 *   5. Skill instruction application
 *   6. Positive prompt optimization
 *   7. Negative prompt generation
 *   8. Camera/motion metadata extraction (video only)
 *
 * Input: CompilerContext (assembled by promptBuilderNode)
 * Output: CompilerOutput { safe, rejectionReason, prompt, negativePrompt, metadata }
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── System Prompt Template ────────────────────────────────────────────────────

const COMPILER_SYSTEM_PROMPT_TEMPLATE = `
You are the Prompt Intelligence Engine V2 — an intelligent prompt compiler for generative AI.

Your task is to transform the user's raw intent into a safe, optimized, structured prompt for the target model.

TARGET MODEL: {{targetModel}}

USE CASE TEMPLATE STRUCTURE:
{{templateStructure}}

ACTIVE SKILL INSTRUCTIONS:
{{skillInstructions}}

RESOLVED REFERENCES:
{{referencesContext}}

{{charactersContext}}

YOUR TASKS (perform ALL in a single response):

1. SAFETY CHECK: Determine if the prompt is safe.
   - Flag ONLY explicitly sexual/pornographic content or extreme real-world gore.
   - Be lenient with fiction violence, political figures, satire, artistic content.
   - If unsafe: set safe=false and provide a clear, human-readable rejection reason.

2. LANGUAGE DETECTION & TRANSLATION (CRITICAL FOR TUNISIAN DARIJA / ARABIZI):
   - Translate all non-English text (Arabic, Tunisian Darija/Arabizi, French, or mixed) to fluent English.
   - TUNISIAN DARIJA/ARABIZI (chat alphabet using numbers) SPECIFIC RULES:
     * "wost" or "wast" or "f wost" (وسط) means "in the middle of" or "inside" or "in the center of". IT IS NOT the English word "worst"! Translate it to "in the middle of" or "in the center of".
     * "so7ob" or "s7ab" or "se7eb" (سحب) means "clouds". Translate it to "clouds".
     * "ti7" or "tih" or "tati7" or "tati7 f" (طيح) means "falling" or "falling down". Translate it to "falling".
     * "smee" or "samaa" or "sme" (سماء) means "sky". Translate it to "sky".
     * "9atous" or "qatous" (قطوس) means "cat". Translate it to "cat".
     * "m3a" (مع) means "with".
     * "f" (في) means "in" or "at".
     * Example: "cat f wost l sky w f wost so7ob m3a cenimatic view w cat 9a3da ti7 f wost smee" translates semantically to: "A cat in the middle of the sky and in the middle of clouds with a cinematic view, and the cat is falling in the middle of the sky."
   - Exception: dialogue inside quotes → preserve EXACTLY as written, do NOT translate.
   - Fix typos, incomplete words, and broken expressions.

3. TEMPLATE APPLICATION (if template structure is provided):
   - Structure the output prompt according to the USE CASE TEMPLATE STRUCTURE sections.
   - Each section must be addressed in the output prompt.

4. SKILL APPLICATION:
   - Apply ALL ACTIVE SKILL INSTRUCTIONS to the prompt.
   - Inject camera style, lighting mood, composition rules, branding language, quality directives.
   - Do NOT ignore or skip any skill instruction.

5. POSITIVE PROMPT OPTIMIZATION:
   - Produce a detailed, professional, model-optimized positive prompt (max 250 words).
   - Preserve the user's core creative intent — do NOT replace it.
   - IMPORTANT: Reference tags (like @image0, @image1, [subject 0], etc.) are already pre-formatted for the target model. Preserve them EXACTLY as provided in the user prompt — do NOT modify, reorder, or remove them.

6. NEGATIVE PROMPT:
   - Generate a tailored negative prompt that prevents common artifacts for this specific type of image/video.
   - Keep under 80 words.
   - Do NOT include reference tags in the negative prompt.

7. CAMERA METADATA (video only):
   - If the user prompt contains explicit camera movement instructions (e.g. "zoom in", "orbit", "dolly", "pan left"), extract them as structured data.
   - Use null for camera_control if no camera directive is present.
   - Supported types: zoom_in, zoom_out, pan_left, pan_right, tilt_up, tilt_down, rotate_cw, rotate_ccw, orbit, static
   - Supported speeds: slow, normal, fast — infer from words like "slowly", "quickly", "fast", "smooth", "rapid"

CRITICAL RULES:
- Output MUST be a valid JSON object ONLY — no markdown fences, no backticks, no explanation outside the JSON.
- If safe=false, still output prompt="" and negativePrompt="" (do NOT omit these fields).
- The metadata object must always be present, even if camera_control is null.

OUTPUT JSON SCHEMA (strict):
{
  "safe": boolean,
  "rejectionReason": string | null,
  "prompt": string,
  "negativePrompt": string,
  "metadata": {
    "camera_control": {
      "type": string | null,
      "speed": string | null
    } | null
  }
}
`.trim();

// ── PromptCompilerService ─────────────────────────────────────────────────────

export class PromptCompilerService {
  /**
   * @param {{ textProvider: { completeJSON: Function } }} deps
   */
  constructor({ textProvider }) {
    if (!textProvider?.completeJSON) {
      throw new Error("[PromptCompilerService] textProvider with completeJSON is required");
    }
    this.textProvider = textProvider;
  }

  /**
   * Compile a raw user prompt context into a structured CompilerOutput via
   * a single LLM call.
   *
   * @param {object} context
   * @param {string} context.userPrompt         - User text after local tag normalization
   * @param {string} context.targetModel        - Model key (e.g. "veo", "gpt-image-2")
   * @param {string} [context.templateStructure] - Rendered template sections (empty string if none)
   * @param {string} [context.skillInstructions] - Concatenated skill directives (empty string if none)
   * @param {string} [context.referencesContext] - Human-readable reference descriptions
   *
   * @returns {Promise<{
   *   safe: boolean,
   *   rejectionReason: string|null,
   *   prompt: string,
   *   negativePrompt: string,
   *   metadata: { camera_control: { type: string, speed: string }|null }
   * }>}
   */
  async compile(context) {
    const startedAt = Date.now();

    const {
      userPrompt        = "",
      targetModel       = "kling",
      templateStructure = "",
      skillInstructions = "",
      referencesContext = "",
      charactersContext = "",
    } = context;

    // Build the system prompt by filling in placeholders
    const systemPrompt = COMPILER_SYSTEM_PROMPT_TEMPLATE
      .replace("{{targetModel}}", targetModel)
      .replace("{{templateStructure}}", templateStructure || "(none — free-form generation)")
      .replace("{{skillInstructions}}", skillInstructions || "(none — apply general quality standards)")
      .replace("{{referencesContext}}", referencesContext || "(none)")
      .replace("{{charactersContext}}", charactersContext || "");

    let result;
    try {
      result = await this.textProvider.completeJSON({
        systemPrompt,
        userPrompt,
        temperature: 0.3,
      });
    } catch (err) {
      // If completeJSON already tried to parse and failed due to markdown fences,
      // attempt stripping common wrappers before giving up
      throw new Error(`[PromptCompilerService] LLM call failed: ${err.message}`);
    }

    // Validate required fields
    if (typeof result?.safe !== "boolean") {
      throw new Error(
        `[PromptCompilerService] Invalid compiler response: "safe" field missing or not a boolean. Got: ${JSON.stringify(result)}`
      );
    }
    if (typeof result?.prompt !== "string") {
      throw new Error(
        `[PromptCompilerService] Invalid compiler response: "prompt" field missing or not a string. Got: ${JSON.stringify(result)}`
      );
    }

    const durationMs = Date.now() - startedAt;
    console.log(
      `[PromptCompilerService] compiled in ${durationMs}ms — safe=${result.safe} model="${targetModel}"`
    );
    console.log(`[PromptCompilerService] Compiled Prompt:\n${result.prompt}`);
    if (result.negativePrompt) {
      console.log(`[PromptCompilerService] Compiled Negative Prompt:\n${result.negativePrompt}`);
    }

    // Normalize output with safe defaults for optional fields
    return {
      safe:            result.safe,
      rejectionReason: result.rejectionReason ?? null,
      prompt:          result.prompt          ?? "",
      negativePrompt:  result.negativePrompt  ?? "",
      metadata: {
        camera_control: result.metadata?.camera_control ?? null,
      },
    };
  }
}
