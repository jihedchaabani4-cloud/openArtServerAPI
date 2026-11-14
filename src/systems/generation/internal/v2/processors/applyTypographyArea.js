/**
 * Processor: applyTypographyArea
 * network: false
 *
 * Reserves safe zones for title text and tagline areas in movie poster layouts.
 * Appends composition guidance that instructs the generator to leave clear space
 * at the top/bottom for typography overlays.
 *
 * @param {import('../contracts/context.js').WorkflowContext} context
 * @param {Record<string, unknown>} parameters — optional `title_position`
 * @param {object} _deps
 * @returns {Promise<import('../contracts/context.js').WorkflowContext>}
 */
export async function run(context, parameters, _deps) {
  const titlePosition = parameters?.title_position ?? "top";
  const taglinePosition = parameters?.tagline_position ?? "bottom";

  const typographyKeywords = [
    `clear ${titlePosition} area for title text`,
    `clear ${taglinePosition} area for tagline`,
    "negative space for typography",
    "poster layout",
  ];

  const basePrompt = context.prompt ?? "";
  const prompt = basePrompt
    ? `${basePrompt}, ${typographyKeywords.join(", ")}`
    : typographyKeywords.join(", ");

  return {
    ...context,
    prompt,
    typography: { titlePosition, taglinePosition },
  };
}
