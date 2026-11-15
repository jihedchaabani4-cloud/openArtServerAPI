import { imageGenerationV3 } from "./imageGenerationV3.js";
import { videoGenerationV3 } from "./videoGenerationV3.js";
import { characterSheetV3 } from "./characterSheetV3.js";

export const V3_WORKFLOW_ALIASES = Object.freeze({
  "image-generation-v1": imageGenerationV3.id,
  "video-generation-v1": videoGenerationV3.id,
  "character-sheet-v1": characterSheetV3.id,
});

export const V3_WORKFLOWS = Object.freeze({
  [imageGenerationV3.id]: imageGenerationV3,
  [videoGenerationV3.id]: videoGenerationV3,
  [characterSheetV3.id]: characterSheetV3,
});

export function resolveV3WorkflowId(workflowId) {
  if (!workflowId || typeof workflowId !== "string") return null;
  return V3_WORKFLOW_ALIASES[workflowId] || workflowId;
}

export function getV3Workflow(workflowId) {
  if (!workflowId || typeof workflowId !== "string") return null;
  const resolvedId = resolveV3WorkflowId(workflowId);
  return V3_WORKFLOWS[resolvedId] || V3_WORKFLOWS[workflowId] || null;
}

export {
  imageGenerationV3,
  videoGenerationV3,
  characterSheetV3,
};
