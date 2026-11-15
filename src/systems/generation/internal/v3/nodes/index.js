import { NodeRegistry } from "../core/NodeRegistry.js";
import { ResolveRefsNode } from "./base/resolveRefsNode.js";
import { LlmNode, LLM_SKILLS_REGISTRY, buildUnifiedLlmInstruction } from "./base/llmNode.js";
import { ImageGenerateNode } from "./base/imageGenerateNode.js";
import { VideoGenerateNode } from "./base/videoGenerateNode.js";
import { SaveMediaNode } from "./base/saveMediaNode.js";

export const V3_BASE_NODES = Object.freeze([
  ResolveRefsNode,
  LlmNode,
  ImageGenerateNode,
  VideoGenerateNode,
  SaveMediaNode,
]);

export const V3_CUSTOM_NODES = Object.freeze([]);

export const ALL_V3_NODES = Object.freeze([...V3_BASE_NODES]);

/**
 * Creates a fresh, frozen `NodeRegistry` populated with all 5 standard `base.*` V3 nodes.
 *
 * @param {Array<Object>} [extraNodes=[]]
 * @returns {NodeRegistry}
 */
export function createDefaultV3NodeRegistry(extraNodes = []) {
  const reg = new NodeRegistry(ALL_V3_NODES);
  if (Array.isArray(extraNodes) && extraNodes.length > 0) {
    reg.registerAll(extraNodes);
  }
  return reg.freeze();
}

export {
  ResolveRefsNode,
  LlmNode,
  LLM_SKILLS_REGISTRY,
  buildUnifiedLlmInstruction,
  ImageGenerateNode,
  VideoGenerateNode,
  SaveMediaNode,
};
