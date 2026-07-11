/**
 * Processor: applyCharacterTemplate
 * network: false
 *
 * Injects a human-readable description of each resolved character into
 * context.prompt as a structured character block. The existing prompt is
 * preserved and the character description is prepended.
 *
 * @param {import('../contracts/context.js').WorkflowContext} context
 * @param {Record<string, unknown>} parameters
 * @param {object} _deps
 * @returns {Promise<import('../contracts/context.js').WorkflowContext>}
 */
export async function run(context, parameters, _deps) {
  const characters = context.characters ?? [];
  if (characters.length === 0) return context;

  const characterBlock = characters
    .map((char) => {
      const traits =
        Array.isArray(char.traits) && char.traits.length > 0
          ? `, ${char.traits.join(", ")}`
          : "";
      return `[Character: ${char.name}${traits}] ${char.description || ""}`.trim();
    })
    .join(" | ");

  const basePrompt = context.prompt ?? "";
  const prompt = characterBlock
    ? `${characterBlock}\n${basePrompt}`.trim()
    : basePrompt;

  return { ...context, prompt };
}
