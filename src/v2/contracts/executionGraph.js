/**
 * @typedef {'none' | 'linear' | 'exponential'} BackoffStrategy
 */

/**
 * @typedef {Object} RetryPolicy
 * @property {number} max_attempts
 * @property {BackoffStrategy} backoff
 * @property {string} [fallback_provider]
 */

/**
 * @typedef {Object} ResolvedProcessor
 * @property {string} name
 * @property {boolean} network
 */

/**
 * @typedef {Object} ExecutionGraphNode
 * @property {string} id
 * @property {string} type
 * @property {Record<string, unknown>} resolved_inputs
 * @property {Record<string, string>} bindings
 * @property {RetryPolicy} retry_policy
 * @property {string[]} [skills]
 * @property {ResolvedProcessor[]} [resolved_processors]
 */

/**
 * @typedef {Object} ExecutionGraphEdge
 * @property {string} from
 * @property {string} to
 */

/**
 * @typedef {Object} ExecutionGraph
 * @property {string} workflow_id
 * @property {string} workflow_version
 * @property {ExecutionGraphNode[]} nodes
 * @property {ExecutionGraphEdge[]} edges
 * @property {string[][]} parallel_groups
 * @property {Record<string, string>} resolved_skill_versions
 */

export {};
