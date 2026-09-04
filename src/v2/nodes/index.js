import { executePromptBuilder }   from "./promptBuilderNode.js";
import { executeImageGeneration } from "./imageGenerationNode.js";
import { executeLLM }             from "./llmNode.js";

const registry = {
  "prompt-builder":   executePromptBuilder,
  "image-generation": executeImageGeneration,
  "llm":              executeLLM,
};

/**
 * Dispatch node execution to the corresponding implementation.
 */
export async function executeNode(type, resolvedInputs, ctx) {
  const executor = registry[type];
  if (!executor) {
    throw new Error(`No executor found for node type: ${type}`);
  }
  return executor(resolvedInputs, ctx);
}

