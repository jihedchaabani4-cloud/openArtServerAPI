/**
 * @typedef {import('./node.js').FieldSchema} FieldSchema
 */

/**
 * @typedef {Object} SkillDefinition
 * @property {string} id
 * @property {string} version
 * @property {string[]} applies_to
 * @property {string} description
 * @property {Record<string, FieldSchema>} parameters_schema
 * @property {string[]} pipeline
 */

/** @typedef {Record<string, SkillDefinition>} SkillRegistry */

export {};
