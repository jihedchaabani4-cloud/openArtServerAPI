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
      let traitList = [];
      if (Array.isArray(char.traits)) {
        traitList = char.traits.filter(Boolean);
      } else if (typeof char.traits === "object" && char.traits !== null) {
        const walk = (obj) => {
          for (const val of Object.values(obj)) {
            if (val && typeof val === "object") walk(val);
            else if (val && (typeof val === "string" || typeof val === "number")) {
              const str = String(val).trim();
              if (str) traitList.push(str);
            }
          }
        };
        walk(char.traits);
      }

      const traitsStr = traitList.length > 0 ? `, ${traitList.join(", ")}` : "";
      const charName = char.name ? `${char.name}` : "Character";
      return `[${charName}${traitsStr}] ${char.description || ""}`.trim();
    })
    .join(" | ");

  const basePrompt = context.prompt ?? "";
  const prompt = characterBlock
    ? `${characterBlock}\n${basePrompt}`.trim()
    : basePrompt;

  return { ...context, prompt };
}
