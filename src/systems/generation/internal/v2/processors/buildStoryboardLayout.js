/**
 * Processor: buildStoryboardLayout
 * network: false
 *
 * Adds storyboard panel grid layout instructions to the prompt. The number
 * of panels and their arrangement are derived from skill parameters.
 *
 * @param {import('../contracts/context.js').WorkflowContext} context
 * @param {Record<string, unknown>} parameters — expects `panel_count` (number)
 * @param {object} _deps
 * @returns {Promise<import('../contracts/context.js').WorkflowContext>}
 */
export async function run(context, parameters, _deps) {
  const panelCount = parameters?.panel_count ?? context.panelCount ?? 6;
  const cols = panelCount <= 4 ? 2 : 3;
  const rows = Math.ceil(panelCount / cols);

  const layoutKeywords = [
    "storyboard",
    `${cols}x${rows} panel grid`,
    "sequential panels",
    "cinematic framing",
    "panel borders",
    "black and white sketches",
  ];

  const basePrompt = context.prompt ?? "";
  const prompt = basePrompt
    ? `${basePrompt}, ${layoutKeywords.join(", ")}`
    : layoutKeywords.join(", ");

  return {
    ...context,
    prompt,
    panelCount,
    layout: `storyboard-${cols}x${rows}`,
  };
}
