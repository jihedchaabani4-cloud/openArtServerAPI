/**
 * Processor: optimizeVisualPrompt
 * network: true
 *
 * Translates Tunisian Darija, Arabic, French, and mixed multilingual inputs
 * and enriches the prompt with high-density visual details for image/video models.
 *
 * @param {import('../contracts/context.js').WorkflowContext} context
 * @param {Record<string, unknown>} parameters
 * @param {{ promptService?: object }} deps
 * @returns {Promise<import('../contracts/context.js').WorkflowContext>}
 */
export async function run(context, parameters, deps) {
  const rawPrompt = context.prompt ?? "";
  if (!rawPrompt) return context;

  // Fallback to pass through if promptService is not injected
  if (!deps?.promptService?.optimizePrompt) {
    return context;
  }

  const mode = "image";
  const style = context.style || "cinematic";

  const result = await deps.promptService.optimizePrompt(rawPrompt, { mode, style });

  if (result.optimized) {
    return {
      ...context,
      prompt: result.optimized,
      original_prompt: rawPrompt,
      detected_language: result.originalLanguage || "en",
      was_translated: result.wasTranslated || false,
      was_enhanced: result.wasEnhanced || false
    };
  }

  return context;
}
