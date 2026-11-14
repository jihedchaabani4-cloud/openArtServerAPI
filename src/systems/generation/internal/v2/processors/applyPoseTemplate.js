/**
 * Processor: applyPoseTemplate
 * network: false
 *
 * Injects view/pose instructions into the prompt based on context.views
 * (set from skill parameters). For character sheets this becomes e.g.
 * "front view, side view, back view" appended to the prompt.
 *
 * @param {import('../contracts/context.js').WorkflowContext} context
 * @param {Record<string, unknown>} parameters — expects `views` array
 * @param {object} _deps
 * @returns {Promise<import('../contracts/context.js').WorkflowContext>}
 */
export async function run(context, parameters, _deps) {
  // views come from skill parameters, fall back to context, then default
  const views =
    parameters?.views ??
    context.views ??
    ["front", "side", "back"];

  const viewList = Array.isArray(views) ? views : [views];
  if (viewList.length === 0) return context;

  const poseInstruction = viewList.map((v) => `${v} view`).join(", ");
  const basePrompt = context.prompt ?? "";
  const prompt = basePrompt
    ? `${basePrompt}, ${poseInstruction}`
    : poseInstruction;

  return { ...context, prompt, views: viewList };
}
