/**
 * Processor: generateNegativePrompt
 * network: true
 *
 * Automatically generates a tailored negative prompt based on the positive prompt.
 *
 * @param {import('../contracts/context.js').WorkflowContext} context
 * @param {Record<string, unknown>} parameters
 * @param {{ promptService?: object }} deps
 * @returns {Promise<import('../contracts/context.js').WorkflowContext>}
 */
export async function run(context, parameters, deps) {
  // If negative prompt is already provided, skip generation to respect user input
  if (context.negative_prompt) {
    return context;
  }

  const rawPrompt = context.prompt ?? "";
  if (!rawPrompt) return context;

  // Fallback to default negative prompt if promptService is not injected
  if (!deps?.promptService?.generateNegativePrompt) {
    return {
      ...context,
      negative_prompt: "low quality, blurry, artifacts, extra fingers, bad anatomy, deformed, watermark, text, logo"
    };
  }

  const negative = await deps.promptService.generateNegativePrompt(rawPrompt);

  return {
    ...context,
    negative_prompt: negative || ""
  };
}
