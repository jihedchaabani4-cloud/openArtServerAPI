/**
 * Processor: applyCameraStyle
 * network: false
 *
 * Injects camera angle and lens style instructions into the prompt.
 * Defaults to a neutral full-body shot appropriate for character sheets.
 * For storyboards, a custom camera style may be passed via parameters.
 *
 * @param {import('../contracts/context.js').WorkflowContext} context
 * @param {Record<string, unknown>} parameters — optional `camera_style` string
 * @param {object} _deps
 * @returns {Promise<import('../contracts/context.js').WorkflowContext>}
 */
export async function run(context, parameters, _deps) {
  const style =
    parameters?.camera_style ??
    context.cameraStyle ??
    "full body shot, neutral angle, studio lighting";

  const basePrompt = context.prompt ?? "";
  const prompt = basePrompt ? `${basePrompt}, ${style}` : style;

  return { ...context, prompt, cameraStyle: style };
}
