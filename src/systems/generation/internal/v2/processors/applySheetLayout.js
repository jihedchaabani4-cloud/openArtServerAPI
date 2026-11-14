/**
 * Processor: applySheetLayout
 * network: false
 *
 * Adds character-sheet specific layout instructions to the prompt:
 * white background, character sheet style, multiple views on a single canvas.
 *
 * @param {import('../contracts/context.js').WorkflowContext} context
 * @param {Record<string, unknown>} parameters
 * @param {object} _deps
 * @returns {Promise<import('../contracts/context.js').WorkflowContext>}
 */
export async function run(context, parameters, _deps) {
  const layoutKeywords = [
    "character sheet",
    "reference sheet",
    "white background",
    "multiple views",
    "concept art",
    "clean composition",
  ];

  const basePrompt = context.prompt ?? "";
  const prompt = basePrompt
    ? `${basePrompt}, ${layoutKeywords.join(", ")}`
    : layoutKeywords.join(", ");

  return {
    ...context,
    prompt,
    layout: "character-sheet",
  };
}
