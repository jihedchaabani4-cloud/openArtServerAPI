import { imageGenerationV3 } from "./imageGenerationV3.js";
import { videoGenerationV3 } from "./videoGenerationV3.js";
import { characterSheetV3 } from "./characterSheetV3.js";
import { imageRelightV3 } from "./imageRelightV3.js";
import { imageAnglesV3 } from "./imageAnglesV3.js";
import { imageEditV3 } from "./imageEditV3.js";
import { imageRemoveBackgroundV3 } from "./imageRemoveBackgroundV3.js";

export const V3_WORKFLOWS = Object.freeze({
  [imageGenerationV3.id]: imageGenerationV3,
  [videoGenerationV3.id]: videoGenerationV3,
  [characterSheetV3.id]: characterSheetV3,
  [imageRelightV3.id]: imageRelightV3,
  [imageAnglesV3.id]: imageAnglesV3,
  [imageEditV3.id]: imageEditV3,
  [imageRemoveBackgroundV3.id]: imageRemoveBackgroundV3,
});

const aliasEntries = [];
for (const wf of Object.values(V3_WORKFLOWS)) {
  const aliases = Array.isArray(wf.aliases) ? wf.aliases : [];
  for (const alias of aliases) {
    if (alias && typeof alias === "string") {
      aliasEntries.push([alias, wf.id]);
    }
  }
}

export const V3_WORKFLOW_ALIASES = Object.freeze(Object.fromEntries(aliasEntries));

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
  imageRelightV3,
  imageAnglesV3,
  imageEditV3,
  imageRemoveBackgroundV3,
};
