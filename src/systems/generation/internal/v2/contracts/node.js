/**
 * @typedef {Object} FieldSchema
 * @property {string} type
 * @property {boolean} [required]
 * @property {unknown} [default]
 */

/**
 * @typedef {import('./executionGraph.js').RetryPolicy} RetryPolicy
 */

/**
 * @typedef {Object} NodeRegistryEntry
 * @property {boolean} skill_aware
 * @property {Record<string, FieldSchema>} inputs
 * @property {Record<string, FieldSchema>} outputs
 * @property {RetryPolicy} retry
 */

/** @typedef {Record<string, NodeRegistryEntry>} NodeRegistry */

export {};
