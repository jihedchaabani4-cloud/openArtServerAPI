import { imageGenerationV3 } from "./imageGenerationV3.js";
import { videoGenerationV3 } from "./videoGenerationV3.js";
import { characterSheetV3 } from "./characterSheetV3.js";

export const V3_WORKFLOWS = Object.freeze({
  [imageGenerationV3.id]: imageGenerationV3,
  [videoGenerationV3.id]: videoGenerationV3,
  [characterSheetV3.id]: characterSheetV3,
});

const aliasEntries = [];
for (const wf of Object.values(V3_WORKFLOWS)) {
  const aliases = Array.isArray(wf.aliases)
    ? wf.aliases
    : Array.isArray(wf.contract?.aliases)
      ? wf.contract.aliases
      : [];
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

/**
 * Extracts normalized workflow contract metadata (`id`, `aliases`, `mediaType`, `mediaRole`, `saveType`, `requiredInputs`).
 */
export function getWorkflowContract(workflowOrId) {
  const wf =
    workflowOrId && typeof workflowOrId === "object"
      ? workflowOrId
      : getV3Workflow(workflowOrId);
  if (!wf || typeof wf !== "object") return null;
  const c = wf.contract && typeof wf.contract === "object" ? wf.contract : {};
  const mediaType =
    c.mediaType ||
    wf.mediaType ||
    (wf.category === "video" || String(wf.id || "").includes("video") ? "video" : "image");
  const mediaRole =
    c.mediaRole ||
    wf.mediaRole ||
    (wf.category === "character" || String(wf.id || "").includes("character") ? "sheet" : "output");
  const saveType =
    c.saveType ||
    wf.saveType ||
    (mediaRole === "sheet"
      ? "character_sheet"
      : mediaType === "video"
        ? "video_output"
        : "workflow_output");
  const requiredInputs = Array.isArray(c.requiredInputs)
    ? c.requiredInputs
    : Array.isArray(wf.requiredInputs)
      ? wf.requiredInputs
      : [];
  const aliases = Array.isArray(c.aliases)
    ? c.aliases
    : Array.isArray(wf.aliases)
      ? wf.aliases
      : [];

  return {
    id: wf.id,
    aliases,
    mediaType,
    mediaRole,
    saveType,
    requiredInputs,
  };
}

export {
  imageGenerationV3,
  videoGenerationV3,
  characterSheetV3,
};
