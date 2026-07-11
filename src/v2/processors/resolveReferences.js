/**
 * Processor: resolveReferences
 * network: false
 *
 * Reads `context.references` (set from inputs) and tags each entry with a
 * resolved `role` and `url` so downstream processors can refer to them by
 * role name (e.g. "style_ref", "pose_ref"). No network call.
 *
 * @param {import('../contracts/context.js').WorkflowContext} context
 * @param {Record<string, unknown>} parameters
 * @param {object} _deps
 * @returns {Promise<import('../contracts/context.js').WorkflowContext>}
 */
export async function run(context, parameters, _deps) {
  const references = context.references ?? [];

  const resolved = references.map((ref, index) => {
    if (typeof ref === "string") {
      return { role: `ref_${index}`, url: ref };
    }
    return {
      role: ref.role ?? `ref_${index}`,
      url: ref.url ?? ref,
      ...ref,
    };
  });

  return { ...context, references: resolved };
}
