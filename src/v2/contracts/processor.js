/**
 * @typedef {Object} ProcessorRegistryEntry
 * @property {string} name
 * @property {boolean} network
 * @property {string} [description]
 */

/** @typedef {Record<string, ProcessorRegistryEntry>} ProcessorRegistry */

/**
 * @typedef {import('./context.js').WorkflowContext} WorkflowContext
 */

/**
 * @typedef {Object} Processor
 * @property {string} name
 * @property {boolean} network
 * @property {(context: WorkflowContext, parameters: Record<string, unknown>, deps?: unknown) => Promise<WorkflowContext> | WorkflowContext} run
 */

export {};
