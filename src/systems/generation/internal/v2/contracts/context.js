/**
 * @typedef {Object} Asset
 * @property {string} id
 * @property {'image' | 'video'} type
 * @property {string} url
 * @property {number} [width]
 * @property {number} [height]
 * @property {number} [duration]
 * @property {Record<string, unknown>} metadata
 */

/**
 * @typedef {Asset & { role: 'style' | 'pose' | 'background' | 'character' | 'generic' }} ReferenceAsset
 */

/**
 * @typedef {Object} CharacterAsset
 * @property {string} id
 * @property {string} name
 * @property {Record<string, unknown>} traits
 * @property {ReferenceAsset[]} [reference_images]
 */

/**
 * @typedef {Object} WorkflowContext
 * @property {string} prompt
 * @property {string} [finalPrompt]
 * @property {ReferenceAsset[]} references
 * @property {CharacterAsset[]} characters
 * @property {string} [style]
 * @property {unknown} [camera]
 * @property {unknown} [lighting]
 * @property {unknown} [layout]
 * @property {string[]} [views]
 * @property {string[]} [instructions]
 * @property {Record<string, unknown>} metadata
 */

/**
 * Deep-copy context for cross-node handoff (immutable across nodes).
 * @param {WorkflowContext} context
 * @returns {WorkflowContext}
 */
export function cloneWorkflowContext(context) {
  return structuredClone(context);
}

export {};
