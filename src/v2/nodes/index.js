import { executePromptBuilder } from "./promptBuilderNode.js";
import { executeImageGeneration } from "./imageGenerationNode.js";
import { executeVideoGeneration } from "./videoGenerationNode.js";
import { executeUpscale } from "./upscaleNode.js";
import { executeMediaTransform } from "./mediaTransformNode.js";

const registry = {
  "prompt-builder": executePromptBuilder,
  "image-generation": executeImageGeneration,
  "video-generation": executeVideoGeneration,
  "upscale": executeUpscale,
  "media-transform": executeMediaTransform,
};

/**
 * Dispatch node execution to the corresponding implementation.
 * @param {string} type The node type ID
 * @param {Object} resolvedInputs Inputs resolved from bindings
 * @param {Object} ctx Execution context
 * @returns {Promise<Object>} The node output
 */
export async function executeNode(type, resolvedInputs, ctx) {
  const executor = registry[type];
  if (!executor) {
    throw new Error(`No executor found for node type: ${type}`);
  }
  return executor(resolvedInputs, ctx);
}
