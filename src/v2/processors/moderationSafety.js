/**
 * Processor: moderationSafety
 * network: true
 *
 * Moderates the user prompt. Checks content safety and handles language translation.
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
  if (!deps?.promptService?.checkPrompt) {
    return context;
  }

  const result = await deps.promptService.checkPrompt(rawPrompt);
  
  if (result.safe === false) {
    const error = new Error(`Prompt rejected by safety filter: ${result.reason || "Unsafe content detected"}`);
    error.code = "UNSAFE_PROMPT";
    throw error;
  }

  // If translated to English, update the prompt
  if (result.translatedPrompt && result.translatedPrompt !== rawPrompt) {
    return {
      ...context,
      prompt: result.translatedPrompt,
      original_prompt: rawPrompt,
      detected_language: result.language || "unknown"
    };
  }

  return context;
}
