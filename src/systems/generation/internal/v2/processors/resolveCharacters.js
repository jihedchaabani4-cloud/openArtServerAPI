/**
 * Processor: resolveCharacters
 * network: false
 *
 * Reads `context.characters` (already set from inputs) and enriches each entry
 * with resolved display name, traits, and any extra metadata available at
 * build time. No network call — purely in-memory data shaping.
 *
 * @param {import('../contracts/context.js').WorkflowContext} context
 * @param {Record<string, unknown>} parameters — skill parameters
 * @param {object} _deps — injected services (unused here)
 * @returns {Promise<import('../contracts/context.js').WorkflowContext>}
 */
export async function run(context, parameters, _deps) {
  const characters = context.characters ?? [];

  const resolved = characters.map((char, index) => {
    if (typeof char === "string") {
      // Plain string reference — wrap into object
      return {
        id: `char_${index}`,
        name: char,
        traits: [],
        description: char,
      };
    }
    // Already an object — ensure required fields are present
    return {
      id: char.id ?? `char_${index}`,
      name: char.name ?? `Character ${index + 1}`,
      traits: Array.isArray(char.traits) ? char.traits : [],
      description: char.description ?? char.name ?? "",
      ...char,
    };
  });

  return { ...context, characters: resolved };
}
