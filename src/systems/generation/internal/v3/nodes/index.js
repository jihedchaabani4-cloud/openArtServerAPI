import { NodeRegistry } from "../core/NodeRegistry.js";
import { LoadMediaNode } from "./base/loadMediaNode.js";
import { ResolveRefsNode } from "./base/resolveRefsNode.js";
import { SafetyCheckNode } from "./base/safetyCheckNode.js";
import { LlmTextNode } from "./base/llmTextNode.js";
import { LlmVisionNode } from "./base/llmVisionNode.js";
import { PromptAssembleNode } from "./base/promptAssembleNode.js";
import { ImageGenerateNode } from "./base/imageGenerateNode.js";
import { ImageUpscaleNode } from "./base/imageUpscaleNode.js";
import { ImageRemoveBgNode } from "./base/imageRemoveBgNode.js";
import { VideoGenerateNode } from "./base/videoGenerateNode.js";
import { VideoUpscaleNode } from "./base/videoUpscaleNode.js";
import { SaveMediaNode } from "./base/saveMediaNode.js";
import { CropCharacterGridNode } from "./custom/cropCharacterGridNode.js";
import { ExtractVideoFrameNode } from "./custom/extractVideoFrameNode.js";
import { SaveCharacterSheetNode } from "./custom/saveCharacterSheetNode.js";

export const V3_BASE_NODES = Object.freeze([
  LoadMediaNode,
  ResolveRefsNode,
  SafetyCheckNode,
  LlmTextNode,
  LlmVisionNode,
  PromptAssembleNode,
  ImageGenerateNode,
  ImageUpscaleNode,
  ImageRemoveBgNode,
  VideoGenerateNode,
  VideoUpscaleNode,
  SaveMediaNode,
]);

export const V3_CUSTOM_NODES = Object.freeze([
  CropCharacterGridNode,
  ExtractVideoFrameNode,
  SaveCharacterSheetNode,
]);

export const ALL_V3_NODES = Object.freeze([...V3_BASE_NODES, ...V3_CUSTOM_NODES]);

/**
 * Creates a fresh, frozen `NodeRegistry` populated with all standard `base.*` and `custom.*` V3 nodes.
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
  LoadMediaNode,
  ResolveRefsNode,
  SafetyCheckNode,
  LlmTextNode,
  LlmVisionNode,
  PromptAssembleNode,
  ImageGenerateNode,
  ImageUpscaleNode,
  ImageRemoveBgNode,
  VideoGenerateNode,
  VideoUpscaleNode,
  SaveMediaNode,
  CropCharacterGridNode,
  ExtractVideoFrameNode,
  SaveCharacterSheetNode,
};
