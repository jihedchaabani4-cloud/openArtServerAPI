/**
 * Processor: applyComposition
 * network: false
 *
 * Adds poster or scene composition instructions to the prompt.
 * Used primarily for movie poster and cinematic use cases.
 *
 * @param {import('../contracts/context.js').WorkflowContext} context
 * @param {Record<string, unknown>} parameters — optional `composition_style`
 * @param {object} _deps
 * @returns {Promise<import('../contracts/context.js').WorkflowContext>}
 */
export async function run(context, parameters, _deps) {
  const compositionStyle =
    parameters?.composition_style ??
    context.compositionStyle ??
    "rule of thirds, centered hero, dramatic depth of field";

  const basePrompt = context.prompt ?? "";
  const prompt = basePrompt
    ? `${basePrompt}, ${compositionStyle}`
    : compositionStyle;

  return { ...context, prompt, compositionStyle };
}
