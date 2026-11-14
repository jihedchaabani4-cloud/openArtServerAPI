import { executePromptBuilder }   from "./promptBuilderNode.js";
import { executeImageGeneration } from "./imageGenerationNode.js";
import { executeVideoGeneration } from "./videoGenerationNode.js";
import { executeLLM }             from "./llmNode.js";

import { registerNodeExecutor as registerMockNode } from "../../v3/core/testNodeExecutorRegistry.js";

const rawRegistry = {
  "prompt-builder":   executePromptBuilder,
  "image-generation": executeImageGeneration,
  "video-generation": executeVideoGeneration,
  "llm":              executeLLM,
};

export const registry = new Proxy(rawRegistry, {
  set(target, prop, value) {
    target[prop] = value;
    registerMockNode(prop, value);
    return true;
  },
});

export function registerNodeExecutor(type, fn) {
  registry[type] = fn;
}

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

