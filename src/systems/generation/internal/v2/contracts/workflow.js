/**
 * @typedef {Object} WorkflowMetadata
 * @property {string} category
 * @property {string[]} tags
 * @property {string} author
 */

/**
 * @typedef {Object} JSONSchemaProperty
 * @property {string} type
 * @property {unknown} [default]
 * @property {JSONSchemaProperty} [items]
 */

/**
 * @typedef {Object} WorkflowInputSchema
 * @property {string[]} required
 * @property {Record<string, JSONSchemaProperty>} properties
 */

/**
 * @typedef {Object} WorkflowNodeConfig
 * @property {string} type
 * @property {string[]} [depends_on]
 * @property {Record<string, string>} [user_inputs]
 * @property {Record<string, string>} [inputs]
 * @property {Record<string, unknown>} [config]
 */

/**
 * @typedef {Object} WorkflowDefinition
 * @property {string} id
 * @property {string} name
 * @property {string} version
 * @property {string} description
 * @property {WorkflowMetadata} metadata
 * @property {WorkflowInputSchema} input_schema
 * @property {Record<string, WorkflowNodeConfig>} nodes
 * @property {Record<string, string>} outputs
 */

/** Parameter precedence (highest wins). See architecture §04.1 */
export const INPUT_PRECEDENCE = [
  "user_inputs",
  "inputs",
  "config",
  "skill_parameters",
  "skill_default",
  "node_default",
];

export {};
